import {getAddress, encodeAbiParameters, type Hex} from "viem";
import {AMOUNT_MODE, effectiveScale, type EventSource} from "./kpiSource";

/**
 * Turning raw event logs into the `reportUserAction` calls a campaign will accept.
 *
 * Pure and React-free (decision F6), and deliberately separate from `scripts/indexer.ts`: the
 * script is I/O — RPC pagination, key handling, transaction sending — while everything that can be
 * *wrong* lives here, where a fixture log can prove it. The failure this guards against is not a
 * crash; it is crediting the right number to the wrong wallet, or a cumulative total that drifts
 * from what the chain already recorded. Neither shows up in a smoke test.
 *
 * Every rule here mirrors a guard in `Campaign.reportUserAction` and names it, the same way
 * `promoter.ts` mirrors `Campaign.join`. The contract is the boundary; this decides what is worth
 * sending.
 *
 * Naming note: the contract calls the acting wallet `user` (`reportUserAction`, `userCreditedOf`),
 * and those ABI strings are load-bearing, so they stay. Everywhere else this codebase calls that
 * wallet a *referral* — someone who arrived through a promoter's link and signed a Touch.
 */

/** A log reduced to the three fields crediting depends on. */
export type IndexedLog = {
  topics: readonly Hex[];
  data: Hex;
  blockNumber: bigint;
  /** Block timestamp, needed for `TouchWindowVerifier` evidence. */
  timestamp: bigint;
};

/** One referral's accumulated activity for a single KPI. */
export type ActorTotal = {
  referral: `0x${string}`;
  /** Post-scaling progress across every matched log. */
  amount: bigint;
  /** Per-log contributions, for verifier evidence. Ordered by block. */
  actions: {timestamp: bigint; amount: bigint}[];
  /** Highest block that contributed, so a cursor can advance past it. */
  lastBlock: bigint;
};

/**
 * Reads the actor address out of an indexed topic.
 *
 * A topic is a 32-byte word; an address occupies the low 20 bytes. Returns null when the topic is
 * absent (the log is a different event with fewer topics) or malformed, so one odd log is skipped
 * rather than aborting a run.
 */
export function actorFromTopic(log: IndexedLog, actorTopic: 1 | 2 | 3): `0x${string}` | null {
  const topic = log.topics[actorTopic];
  if (!topic || topic.length !== 66) return null;

  try {
    return getAddress(`0x${topic.slice(26)}`);
  } catch {
    return null;
  }
}

/**
 * The raw (pre-scaling) amount one log contributes.
 *
 * `count` mode ignores the payload entirely — for "how many mints", where the event's data is a
 * token id that would be nonsense to sum. `dataWord0` reads the first 32-byte word, which is where
 * a single-value event like `Deposit(address indexed dst, uint256 wad)` puts its number.
 */
export function rawAmount(log: IndexedLog, mode: EventSource["amountMode"]): bigint | null {
  if (mode === AMOUNT_MODE.count) return BigInt(1);

  // "0x" plus at least one 32-byte word.
  if (log.data.length < 66) return null;
  try {
    return BigInt(log.data.slice(0, 66));
  } catch {
    return null;
  }
}

/**
 * One credit-bearing action, decoded down to the two fields crediting needs.
 *
 * The shape both sources reduce to before folding: `aggregateByActor` gets here by decoding raw logs,
 * `aggregateActions` by reading an indexer that already decoded them. `raw` is pre-scaling and already
 * mode-resolved — 1 under `count`, the payload value under `dataWord0` — which is what lets the fold
 * below stay unaware of amount modes entirely.
 */
export type DecodedAction = {timestamp: bigint; raw: bigint};

/** Per-referral accumulator, before scaling. */
type RawTotals = Map<
  string,
  {referral: `0x${string}`; actions: DecodedAction[]; lastBlock: bigint}
>;

/**
 * Per-actor earliest creditable block timestamp, keyed by lowercased address.
 *
 * The floor for a user is `max(touchOf(campaign, user).signedAt, campaign.startTime)`: activity is
 * only creditable once the user is attributed *and* the campaign has begun tracking. An actor absent
 * from the map has no live touch and is dropped entirely, matching `Campaign.reportUserAction`
 * reverting `NoAttribution` for them.
 */
export type ActorFloors = ReadonlyMap<string, bigint>;

/**
 * Folds logs into per-referral totals.
 *
 * Scaling is applied to the *running total*, not to each log, so a hundred sub-scale deposits still
 * add up to credit. Scaling each log first would floor every one of them to zero and silently
 * credit nothing — a promoter's referrals could act all day and their progress would never move.
 *
 * Logs are sorted by block before folding so `actions` is chronological regardless of the order the
 * RPC returned pages in; `TouchWindowVerifier` compares each action's timestamp against a floor,
 * and out-of-order evidence would still verify but reads as corrupt.
 *
 * ## `floors` is not optional, deliberately
 *
 * Per-user attribution filtering is the trickiest correctness rule in this repo
 * (`boneyMd/KPI_VERIFICATION.md` §8): without it, activity a user performed *before* they were ever
 * attributed credits a promoter who did not cause it, and activity from before the campaign existed
 * credits one that was not running. `relayCore.aggregateDeltas` has enforced it since it shipped;
 * this fold did not, so the relayer and the two callers of this function disagreed about what a
 * referral was owed — the exact disagreement `useObservedActions` says must be impossible.
 *
 * Passing `null` opts out explicitly and is for diagnostics only — a scratch script asking "what is
 * on chain at all", where attribution is not the question. It is a required argument rather than an
 * optional one so that opting out is a visible decision at the call site instead of an omission.
 *
 * A log whose timestamp is unresolved (`0`) is dropped rather than assumed to clear the floor, the
 * same way the relayer treats a block it could not resolve.
 */
export function aggregateByActor(
  logs: readonly IndexedLog[],
  source: EventSource,
  floors: ActorFloors | null,
): Map<string, ActorTotal> {
  const raw: RawTotals = new Map();

  const ordered = [...logs].sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : 1));

  for (const log of ordered) {
    const referral = actorFromTopic(log, source.actorTopic);
    if (!referral) continue;
    const amount = rawAmount(log, source.amountMode);
    if (amount === null) continue;

    if (floors) {
      const floor = floors.get(referral.toLowerCase());
      if (floor === undefined || floor === BigInt(0)) continue;
      if (log.timestamp === BigInt(0) || log.timestamp < floor) continue;
    }

    accumulate(raw, referral, {timestamp: log.timestamp, raw: amount}, log.blockNumber);
  }

  return foldActions(raw, effectiveScale(source));
}

/**
 * Folds already-decoded actions into per-referral totals.
 *
 * The indexed counterpart of `aggregateByActor`: a subgraph hands back `(user, value, timestamp)`
 * rather than topics and data, so there is nothing to decode — but everything after decoding must
 * behave identically, or the same referral gets a different figure depending on which path the app
 * happened to take. Both funnel into `foldActions` for exactly that reason.
 *
 * `value` is raw and unscaled, as the subgraph stores it. The amount mode is applied here rather than
 * upstream because `count` is a property of the KPI, not of the log: the same `Transfer` counts as 1
 * for one campaign and contributes its `value` for another.
 *
 * `floors` carries the same meaning and the same non-optionality as in `aggregateByActor`, and matters
 * here for a specific reason: the subgraph stores actions *deliberately unfiltered* — see the
 * "No attribution check" note in `subgraph/src/transfer.ts`, which defers the decision because a
 * promoter switch moves `signedAt` afterwards. That deferral is only sound if the consumer actually
 * applies the floor, and this is the consumer.
 */
export function aggregateActions(
  actions: readonly {user: `0x${string}`; value: bigint; blockNumber: bigint; timestamp: bigint}[],
  source: EventSource,
  floors: ActorFloors | null,
): Map<string, ActorTotal> {
  const raw: RawTotals = new Map();

  const ordered = [...actions].sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : 1));

  for (const action of ordered) {
    if (floors) {
      const floor = floors.get(action.user.toLowerCase());
      if (floor === undefined || floor === BigInt(0)) continue;
      if (action.timestamp === BigInt(0) || action.timestamp < floor) continue;
    }

    const amount = source.amountMode === AMOUNT_MODE.count ? BigInt(1) : action.value;
    accumulate(raw, action.user, {timestamp: action.timestamp, raw: amount}, action.blockNumber);
  }

  return foldActions(raw, effectiveScale(source));
}

function accumulate(
  raw: RawTotals,
  referral: `0x${string}`,
  action: DecodedAction,
  blockNumber: bigint,
): void {
  const key = referral.toLowerCase();
  const entry = raw.get(key) ?? {referral, actions: [], lastBlock: blockNumber};
  entry.actions.push(action);
  if (blockNumber > entry.lastBlock) entry.lastBlock = blockNumber;
  raw.set(key, entry);
}

/**
 * Scales each referral's running total and splits it back across the actions that produced it.
 *
 * The only place the scaling rule lives, so the log-scanning and indexed paths cannot disagree about
 * what a referral is owed.
 */
function foldActions(raw: RawTotals, scale: bigint): Map<string, ActorTotal> {
  const out = new Map<string, ActorTotal>();

  for (const [key, entry] of raw) {
    let total = BigInt(0);
    for (const action of entry.actions) total += action.raw;

    const scaled = total / scale;
    // Everything this referral did still rounds to nothing. Reporting 0 would be a no-op the
    // campaign ignores anyway (`delta == 0` returns early), so it is not worth a transaction.
    if (scaled === BigInt(0)) continue;

    out.set(key, {
      referral: entry.referral,
      amount: scaled,
      actions: apportion(entry.actions, scaled, scale),
      lastBlock: entry.lastBlock,
    });
  }

  return out;
}

/**
 * Splits a scaled total back across the actions that produced it, preserving the sum exactly.
 *
 * Per-action amounts must sum to the scaled total, or `TouchWindowVerifier` sees evidence that
 * disagrees with the claim and reverts `EvidenceExceedsClaim`. Scaling each action independently would
 * not sum, so the total is apportioned and the remainder lands on the final entry — which is also the
 * newest, and therefore the one most likely to clear the window floor.
 *
 * Shares come from each action's own `raw`, which is already mode-resolved. That matters: an earlier
 * version re-read the log's data word here regardless of mode, so a `count` KPI split a total of *n
 * events* across shares derived from token amounts — producing a first share in the millions and a
 * negative remainder on the last. It summed correctly, which is why it went unnoticed, but a negative
 * `uint256` cannot be encoded and the evidence was unusable.
 */
function apportion(
  actions: readonly DecodedAction[],
  scaledTotal: bigint,
  scale: bigint,
): {timestamp: bigint; amount: bigint}[] {
  const out: {timestamp: bigint; amount: bigint}[] = [];
  let assigned = BigInt(0);

  for (let i = 0; i < actions.length; i++) {
    const share = i === actions.length - 1 ? scaledTotal - assigned : actions[i]!.raw / scale;
    assigned += share;
    out.push({timestamp: actions[i]!.timestamp, amount: share});
  }

  return out;
}

// ── deciding what to send ────────────────────────────────────────

export type ReportDecision =
  | {send: true; referral: `0x${string}`; newTotal: bigint; actions: ActorTotal["actions"]}
  | {send: false; referral: `0x${string}`; reason: string};

/**
 * Whether a referral's totals are worth a `reportUserAction` call.
 *
 * Both refusals mirror named contract behavior:
 *
 *  - No live touch → `NoAttribution(user)` (`Campaign.sol:318`). Unattributed activity has no
 *    payee, and this is the constraint that makes "just index every mint on the contract"
 *    impossible: only wallets that clicked a tracking link and signed can ever be credited.
 *  - Not greater than what is already credited → `Campaign` returns early on `delta == 0`, and a
 *    *lower* total reverts `NonMonotonic`. `newTotal` is cumulative, not a delta, so re-indexing
 *    the same range must be a no-op rather than double-crediting.
 */
export function decideReport(
  total: ActorTotal,
  attributed: boolean,
  alreadyCredited: bigint,
): ReportDecision {
  if (!attributed) {
    return {
      send: false,
      referral: total.referral,
      reason: "no live attribution touch — Campaign would revert NoAttribution",
    };
  }
  if (total.amount <= alreadyCredited) {
    return {
      send: false,
      referral: total.referral,
      reason: `already credited ${alreadyCredited} of ${total.amount} — nothing new`,
    };
  }
  return {send: true, referral: total.referral, newTotal: total.amount, actions: total.actions};
}

/**
 * Encodes `TouchWindowVerifier.Action[]` for the `evidence` argument.
 *
 * Only meaningful when the KPI names a verifier; a KPI with `verifier == address(0)` has its
 * evidence ignored entirely (`Campaign.sol:325`), so the caller passes `"0x"` there rather than
 * paying calldata for a blob nothing reads.
 */
export function encodeActions(actions: readonly {timestamp: bigint; amount: bigint}[]): Hex {
  return encodeAbiParameters(
    [
      {
        type: "tuple[]",
        components: [
          {type: "uint64", name: "timestamp"},
          {type: "uint256", name: "amount"},
        ],
      },
    ],
    [actions.map((a) => ({timestamp: a.timestamp, amount: a.amount}))],
  );
}

// ── block range pagination ───────────────────────────────────────

/**
 * Splits a block range into chunks an RPC will accept.
 *
 * Base's public endpoint rejects `eth_getLogs` spanning more than 2000 blocks with
 * `-32602: query exceeds max block range 2000` — observed, not assumed. Ranges are inclusive at
 * both ends, so a chunk of `size` blocks spans `from` to `from + size - 1`.
 */
export function blockChunks(
  fromBlock: bigint,
  toBlock: bigint,
  size: bigint,
): {from: bigint; to: bigint}[] {
  if (toBlock < fromBlock) return [];
  if (size <= BigInt(0)) throw new Error("chunk size must be positive");

  const out: {from: bigint; to: bigint}[] = [];
  for (let from = fromBlock; from <= toBlock; from += size) {
    const to = from + size - BigInt(1);
    out.push({from, to: to > toBlock ? toBlock : to});
  }
  return out;
}
