import {getAddress, encodeAbiParameters, type Hex} from "viem";
import {
  AMOUNT_MODE,
  effectiveScale,
  matchesTopicFilter,
  topicFilterArray,
  type EventSource,
} from "./kpiSource";
import type {AttributionLookup} from "./attributionWindows";

/**
 * Turns raw event logs into the `reportUserAction` calls a campaign will accept.
 */
export type IndexedLog = {
  topics: readonly Hex[];
  data: Hex;
  blockNumber: bigint;
  timestamp: bigint;
};

export type EvidenceAction = {blockNumber: bigint; timestamp: bigint; amount: bigint};

export type ActorTotal = {
  referral: `0x${string}`;
  amount: bigint;
  actions: EvidenceAction[];
  lastBlock: bigint;
};

/**
 * Reads the actor address out of an indexed topic.
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
 * Scaling applies to the running total rather than to each log, so sub-scale actions still add up
 * to credit. `attribution` is required rather than optional so that opting out is visible at the
 * call site; passing null keeps every log and is for diagnostics only.
 *
 * @param logs Logs from the KPI's source contract, in any order.
 * @param source Event source describing which event to keep, and how to read an actor and an amount
 *               out of it.
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
    if (log.topics[0]?.toLowerCase() !== source.topic0.toLowerCase()) continue;
    if (!matchesTopicFilter(log, source)) continue;

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

/**
 * Splits a referral's evidence across the promoters who held it, as `Campaign._tally` does.
 * @param referral The wallet the actions belong to.
 * @param actions Evidence actions for that referral, oldest first.
 * @param attribution Per-action attribution, as the chain would resolve it.
 * @returns Amount per promoter id, keyed lowercase. Actions nobody held are dropped.
 */
export function tallyByPromoter(
  referral: `0x${string}`,
  actions: readonly EvidenceAction[],
  attribution: AttributionLookup,
): Map<string, bigint> {
  const out = new Map<string, bigint>();

  for (const action of actions) {
    const promoterId = attribution.at(referral, action.blockNumber, action.timestamp);
    if (!promoterId) continue;

    const key = promoterId.toLowerCase();
    out.set(key, (out.get(key) ?? BigInt(0)) + action.amount);
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
 * @param total The referral's accumulated activity for one KPI.
 * @param alreadyCredited Progress the campaign has already credited this referral.
 * @returns A decision carrying the cumulative total and evidence, or the reason for skipping.
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
 * Identity of the `eth_getLogs` request a KPI's source implies over one block range.
 * @param source Event source the KPI names.
 * @param fromBlock First block of the range.
 * @param toBlock Last block of the range.
 * @returns A key equal for two scans exactly when their log requests are identical.
 */
export function logScanKey(source: EventSource, fromBlock: bigint, toBlock: bigint): string {
  return [
    source.source.toLowerCase(),
    source.topic0.toLowerCase(),
    source.filterTopic ?? 0,
    source.filterValue?.toLowerCase() ?? "",
    fromBlock,
    toBlock,
  ].join("|");
}

export type RawLog = {
  topics: readonly Hex[];
  data: Hex;
  blockNumber: Hex;
  blockTimestamp?: Hex;
};

export type LogRequest = {
  address: `0x${string}`;
  fromBlock: Hex;
  toBlock: Hex;
  topics: (Hex | Hex[] | null)[];
};

/**
 * Builds the `eth_getLogs` request for one event over one block range.
 * @param address Contract whose logs are wanted.
 * @param topic0 Event signature hash to match.
 * @param source Event source carrying the indexed-topic filter, or null when there is none.
 * @param fromBlock First block of the range.
 * @param toBlock Last block of the range.
 * @returns The request's single parameter object.
 */
export function logRequest(
  address: `0x${string}`,
  topic0: Hex,
  source: EventSource | null,
  fromBlock: bigint,
  toBlock: bigint,
): LogRequest {
  return {
    address,
    fromBlock: `0x${fromBlock.toString(16)}`,
    toBlock: `0x${toBlock.toString(16)}`,
    topics: [topic0.toLowerCase() as Hex, ...(source ? topicFilterArray(source) : [])],
  };
}

/**
 * Splits a block range into chunks an RPC will accept.
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
