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
 * `kol.ts` mirrors `Campaign.join`. The contract is the boundary; this decides what is worth
 * sending.
 */

/** A log reduced to the three fields crediting depends on. */
export type IndexedLog = {
  topics: readonly Hex[];
  data: Hex;
  blockNumber: bigint;
  /** Block timestamp, needed for `TouchWindowVerifier` evidence. */
  timestamp: bigint;
};

/** One user's accumulated activity for a single KPI. */
export type ActorTotal = {
  user: `0x${string}`;
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
 * Folds logs into per-user totals.
 *
 * Scaling is applied to the *running total*, not to each log, so a hundred sub-scale deposits still
 * add up to credit. Scaling each log first would floor every one of them to zero and silently
 * credit nothing — a KOL's users could act all day and their progress would never move.
 *
 * Logs are sorted by block before folding so `actions` is chronological regardless of the order the
 * RPC returned pages in; `TouchWindowVerifier` compares each action's timestamp against a floor,
 * and out-of-order evidence would still verify but reads as corrupt.
 */
export function aggregateByActor(
  logs: readonly IndexedLog[],
  source: EventSource,
): Map<string, ActorTotal> {
  const scale = effectiveScale(source);
  const raw = new Map<string, {user: `0x${string}`; total: bigint; logs: IndexedLog[]}>();

  const ordered = [...logs].sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : 1));

  for (const log of ordered) {
    const user = actorFromTopic(log, source.actorTopic);
    if (!user) continue;
    const amount = rawAmount(log, source.amountMode);
    if (amount === null) continue;

    const key = user.toLowerCase();
    const entry = raw.get(key) ?? {user, total: BigInt(0), logs: []};
    entry.total += amount;
    entry.logs.push(log);
    raw.set(key, entry);
  }

  const out = new Map<string, ActorTotal>();
  for (const [key, entry] of raw) {
    const scaled = entry.total / scale;
    // Everything this user did still rounds to nothing. Reporting 0 would be a no-op the campaign
    // ignores anyway (`delta == 0` returns early), so it is not worth a transaction.
    if (scaled === BigInt(0)) continue;

    // Per-action amounts must sum to the scaled total, or `TouchWindowVerifier` sees evidence that
    // disagrees with the claim and reverts `EvidenceExceedsClaim`. Scaling each action
    // independently would not sum, so the total is apportioned and the remainder lands on the last
    // action — which is also the newest, and therefore the one most likely to clear the window
    // floor.
    const actions = apportion(entry.logs, scaled, scale);

    out.set(key, {
      user: entry.user,
      amount: scaled,
      actions,
      lastBlock: entry.logs[entry.logs.length - 1]!.blockNumber,
    });
  }

  return out;
}

/**
 * Splits a scaled total back across the logs that produced it, preserving the sum exactly.
 *
 * Each log gets its floor-scaled share; whatever the flooring dropped is added to the final entry.
 */
function apportion(
  logs: readonly IndexedLog[],
  scaledTotal: bigint,
  scale: bigint,
): {timestamp: bigint; amount: bigint}[] {
  const shares = logs.map((log) => {
    const amount = rawAmount(log, AMOUNT_MODE.dataWord0);
    return {timestamp: log.timestamp, raw: amount ?? BigInt(0)};
  });

  const out: {timestamp: bigint; amount: bigint}[] = [];
  let assigned = BigInt(0);

  for (let i = 0; i < shares.length; i++) {
    const share = i === shares.length - 1 ? scaledTotal - assigned : shares[i]!.raw / scale;
    assigned += share;
    out.push({timestamp: shares[i]!.timestamp, amount: share});
  }

  return out;
}

// ── deciding what to send ────────────────────────────────────────

export type ReportDecision =
  | {send: true; user: `0x${string}`; newTotal: bigint; actions: ActorTotal["actions"]}
  | {send: false; user: `0x${string}`; reason: string};

/**
 * Whether a user's totals are worth a `reportUserAction` call.
 *
 * Both refusals mirror named contract behavior:
 *
 *  - No live touch → `NoAttribution(user)` (`Campaign.sol:318`). Unattributed activity has no
 *    payee, and this is the constraint that makes "just index every mint on the contract"
 *    impossible: only users who clicked a tracking link and signed can ever be credited.
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
      user: total.user,
      reason: "no live attribution touch — Campaign would revert NoAttribution",
    };
  }
  if (total.amount <= alreadyCredited) {
    return {
      send: false,
      user: total.user,
      reason: `already credited ${alreadyCredited} of ${total.amount} — nothing new`,
    };
  }
  return {send: true, user: total.user, newTotal: total.amount, actions: total.actions};
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
