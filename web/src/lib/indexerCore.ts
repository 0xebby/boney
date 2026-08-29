import {getAddress, encodeAbiParameters, type Hex} from "viem";
import {AMOUNT_MODE, effectiveScale, type EventSource} from "./kpiSource";
import type {AttributionLookup} from "./attributionWindows";

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
  /** Block timestamp, needed to place the action inside an attribution window. */
  timestamp: bigint;
};

/** One credit-bearing action as `Campaign` reads it out of `evidence`. */
export type EvidenceAction = {blockNumber: bigint; timestamp: bigint; amount: bigint};

/** One referral's accumulated activity for a single KPI. */
export type ActorTotal = {
  referral: `0x${string}`;
  /** Post-scaling progress across every matched log. */
  amount: bigint;
  /** Per-log contributions, for evidence. Ordered by block. */
  actions: EvidenceAction[];
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
 * One credit-bearing action, decoded down to the fields crediting needs.
 *
 * The shape both sources reduce to before folding: `aggregateByActor` gets here by decoding raw logs,
 * `aggregateActions` by reading an indexer that already decoded them. `raw` is pre-scaling and already
 * mode-resolved — 1 under `count`, the payload value under `dataWord0` — which is what lets the fold
 * below stay unaware of amount modes entirely.
 */
export type DecodedAction = {blockNumber: bigint; timestamp: bigint; raw: bigint};

/** Per-referral accumulator, before scaling. */
type RawTotals = Map<
  string,
  {referral: `0x${string}`; actions: DecodedAction[]; lastBlock: bigint}
>;

/**
 * Folds logs into per-referral totals.
 *
 * Scaling is applied to the *running total*, not to each log, so a hundred sub-scale deposits still
 * add up to credit. Scaling each log first would floor every one of them to zero and silently
 * credit nothing — a promoter's referrals could act all day and their progress would never move.
 *
 * Logs are sorted by block before folding so `actions` is chronological regardless of the order the
 * RPC returned pages in. `Campaign.reportUserAction` rejects evidence whose block numbers go
 * backwards (`UnorderedEvidence`), because it walks the actions oldest first.
 *
 * ## `attribution` is not optional, deliberately
 *
 * Per-action attribution is the trickiest correctness rule in this repo
 * (`boneyMd/KPI_VERIFICATION.md` §8). `Campaign` credits each action to whoever held the referral at
 * that action's block, and skips the ones nobody held — so an action this fold keeps but the chain
 * would skip inflates `newTotal` above what can ever be credited, and every later run re-sends the
 * same unreachable figure. Applying the same rule here keeps the claim and the chain in agreement.
 *
 * Passing `null` opts out explicitly and is for diagnostics only — a scratch script asking "what is
 * on chain at all", where attribution is not the question. It is a required argument rather than an
 * optional one so that opting out is a visible decision at the call site instead of an omission.
 *
 * @param logs Matched logs for one KPI, in any order.
 * @param source Event source describing how to read an actor and an amount out of a log.
 * @param attribution Per-action attribution, or null to keep every log.
 * @returns Per-referral totals keyed by lowercased address.
 */
export function aggregateByActor(
  logs: readonly IndexedLog[],
  source: EventSource,
  attribution: AttributionLookup | null,
): Map<string, ActorTotal> {
  const raw: RawTotals = new Map();

  const ordered = [...logs].sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : 1));

  for (const log of ordered) {
    const referral = actorFromTopic(log, source.actorTopic);
    if (!referral) continue;
    const amount = rawAmount(log, source.amountMode);
    if (amount === null) continue;

    if (attribution && !attribution.at(referral, log.blockNumber, log.timestamp)) continue;

    accumulate(
      raw,
      referral,
      {blockNumber: log.blockNumber, timestamp: log.timestamp, raw: amount},
      log.blockNumber,
    );
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
 * `attribution` carries the same meaning and the same non-optionality as in `aggregateByActor`, and
 * matters here for a specific reason: the subgraph stores actions *deliberately unfiltered* — see the
 * "No attribution check" note in `subgraph/src/transfer.ts`, which defers the decision because a
 * promoter switch moves `signedAt` afterwards. That deferral is only sound if the consumer actually
 * applies the rule, and this is the consumer.
 *
 * @param actions Decoded actions for one KPI, in any order.
 * @param source Event source describing how an amount folds.
 * @param attribution Per-action attribution, or null to keep every action.
 * @returns Per-referral totals keyed by lowercased address.
 */
export function aggregateActions(
  actions: readonly {user: `0x${string}`; value: bigint; blockNumber: bigint; timestamp: bigint}[],
  source: EventSource,
  attribution: AttributionLookup | null,
): Map<string, ActorTotal> {
  const raw: RawTotals = new Map();

  const ordered = [...actions].sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : 1));

  for (const action of ordered) {
    if (attribution && !attribution.at(action.user, action.blockNumber, action.timestamp)) continue;

    const amount = source.amountMode === AMOUNT_MODE.count ? BigInt(1) : action.value;
    accumulate(
      raw,
      action.user,
      {blockNumber: action.blockNumber, timestamp: action.timestamp, raw: amount},
      action.blockNumber,
    );
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
 * Per-action amounts must sum to the scaled total, or the two disagree about what happened: the
 * chain's oldest-first walk would leave part of `newTotal` unattributed, and a verifier reading the
 * same evidence reverts `EvidenceExceedsClaim` when it sums higher. Scaling each action independently
 * would not sum, so the total is apportioned and the remainder lands on the final entry — which is
 * also the newest, and therefore the one held by the promoter attributed most recently.
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
): EvidenceAction[] {
  const out: EvidenceAction[] = [];
  let assigned = BigInt(0);

  for (let i = 0; i < actions.length; i++) {
    const share = i === actions.length - 1 ? scaledTotal - assigned : actions[i]!.raw / scale;
    assigned += share;
    out.push({
      blockNumber: actions[i]!.blockNumber,
      timestamp: actions[i]!.timestamp,
      amount: share,
    });
  }

  return out;
}

/**
 * Merges adjacent actions until the list fits `Campaign.MAX_EVIDENCE_ACTIONS`.
 *
 * A merged entry carries the block and timestamp of the *newest* action folded into it, so it
 * resolves to the promoter who held the referral at that point. Same-block actions merge first,
 * which is lossless; beyond that the fold is coarse and can move an older action's amount onto a
 * later promoter, so it only runs when the list would otherwise be rejected outright.
 *
 * @param actions Evidence actions, oldest first.
 * @param limit Maximum entries the campaign will accept.
 * @returns The same total, in at most `limit` entries.
 */
export function foldToLimit(
  actions: readonly EvidenceAction[],
  limit: number,
): EvidenceAction[] {
  if (limit <= 0) throw new Error("evidence limit must be positive");
  if (actions.length <= limit) return [...actions];

  // Same-block actions are indistinguishable to the chain's walk, so collapsing them loses nothing.
  const byBlock: EvidenceAction[] = [];
  for (const action of actions) {
    const last = byBlock[byBlock.length - 1];
    if (last && last.blockNumber === action.blockNumber) {
      last.amount += action.amount;
      if (action.timestamp > last.timestamp) last.timestamp = action.timestamp;
      continue;
    }
    byBlock.push({...action});
  }
  if (byBlock.length <= limit) return byBlock;

  // Still too long: fold runs of consecutive actions, each onto its newest member.
  const perGroup = Math.ceil(byBlock.length / limit);
  const out: EvidenceAction[] = [];
  for (let i = 0; i < byBlock.length; i += perGroup) {
    const group = byBlock.slice(i, i + perGroup);
    const newest = group[group.length - 1]!;
    let amount = BigInt(0);
    for (const action of group) amount += action.amount;
    out.push({blockNumber: newest.blockNumber, timestamp: newest.timestamp, amount});
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
 * The one refusal mirrors named contract behavior: a total no greater than what is already credited
 * makes `Campaign` return early on `delta == 0`, and a *lower* total reverts `NonMonotonic`.
 * `newTotal` is cumulative, not a delta, so re-indexing the same range must be a no-op rather than
 * double-crediting.
 *
 * Whether the referral is attributed *now* is deliberately not a condition. `Campaign` credits each
 * evidence action to whoever held the referral at that action's block, so a report can pay a promoter
 * whose touch has since been superseded — and gating on the live touch is exactly what would drop
 * that credit. Actions nobody held were already dropped upstream by `AttributionLookup`.
 */
export function decideReport(total: ActorTotal, alreadyCredited: bigint): ReportDecision {
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
 * Encodes `Types.Action[]` for the `evidence` argument.
 *
 * Sent for every KPI, not only the ones naming a verifier: `Campaign` decodes it itself to credit
 * each action to whoever held the referral at that action's block. A report with empty evidence falls
 * back to crediting whoever holds the touch now.
 *
 * @param actions Evidence actions, oldest first and non-decreasing by block.
 * @returns ABI-encoded `Types.Action[]`.
 */
export function encodeActions(actions: readonly EvidenceAction[]): Hex {
  return encodeAbiParameters(
    [
      {
        type: "tuple[]",
        components: [
          {type: "uint64", name: "blockNumber"},
          {type: "uint64", name: "timestamp"},
          {type: "uint256", name: "amount"},
        ],
      },
    ],
    [
      actions.map((a) => ({
        blockNumber: a.blockNumber,
        timestamp: a.timestamp,
        amount: a.amount,
      })),
    ],
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
