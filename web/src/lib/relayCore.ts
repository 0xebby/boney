import {decodeEventLog, parseAbiItem, getAddress, toEventSelector, type AbiEvent, type Hex} from "viem";
import {AMOUNT_MODE, type AmountMode} from "./kpiSource";
import type {AttributionLookup} from "./attributionWindows";

/**
 * Turning raw event logs into the `reportBatch` calls `EventMetricKpiVerifier` will accept.
 *
 * The relayer's half of KPI verification. Where `indexerCore.ts` decides what a *project* may claim,
 * this decides what Boney will independently vouch for — and since a claim is capped at that number,
 * a bug here silently under- or over-credits every promoter on a campaign. So the same split applies:
 * `scripts/relay-kpi-metric.ts` is I/O (RPC pagination, key handling, transactions) and everything
 * that can be *wrong* lives here, where a fixture log can prove it.
 *
 * Pure and React-free (decision F6), like `indexerCore.ts` and `kpiSource.ts`.
 *
 * Two things here are not obvious and are the reason this is not just a `getLogs` loop:
 *
 *  - **Decoding is delegated to a real ABI decoder.** The config stores a full human-readable event
 *    signature, so `parseAbiItem` builds a real `AbiEvent` and viem decodes any shape — any param
 *    count, any mix of indexed and non-indexed, any uint width. The alternative, reading a fixed
 *    32-byte word out of `log.data`, breaks silently the moment a project's event layout differs from
 *    the one it was written against.
 *
 *  - **Activity nobody was attributed for must not count.** A promoter did not cause activity that
 *    predates their touch, so each log is resolved against the attribution windows in
 *    `attributionWindows.ts` — the same walk `AttributionRegistry.promoterAt` performs, and the same
 *    one `Campaign` uses to segment a report. Applying it here means the cap already excludes what a
 *    claim could never draw against.
 */

/** How matching events fold into a total. Mirrors `EventMetricKpiVerifier.Aggregation`. */
export const AGGREGATION = {
  /** Each matching log contributes 1. */
  count: 0,
  /** Each matching log contributes its decoded numeric param. */
  sum: 1,
} as const;

export type Aggregation = (typeof AGGREGATION)[keyof typeof AGGREGATION];

/** `EventMetricKpiVerifier.KpiConfig`, as read back off chain. */
export type KpiConfig = {
  targetContract: `0x${string}`;
  eventSignature: string;
  userParamIndex: number;
  valueParamIndex: number;
  aggregation: Aggregation;
  /**
   * Divisor the *contract* applies inside `verify`, not the relayer.
   *
   * Carried here only so the relayer can report it and cross-check it against the indexer's blob.
   * Totals pushed on chain stay raw — see `EventMetricKpiVerifier.KpiConfig.scale` for why keeping
   * the unscaled figure on chain is what lets this relayer hold no state of its own.
   */
  scale: bigint;
  windowStartBlock: bigint;
  windowEndBlock: bigint;
  configured: boolean;
};

/** A log reduced to what aggregation depends on. */
export type RelayLog = {
  topics: readonly Hex[];
  data: Hex;
  blockNumber: bigint;
};

/** One decoded log, before any attribution filtering. */
export type DecodedEvent = {
  /** Lowercased, so it can key a `Map` without checksum surprises. */
  user: string;
  /** 1 under `COUNT`, the decoded numeric param under `SUM`. */
  value: bigint;
  blockNumber: bigint;
};

// ── the event ────────────────────────────────────────────────────

/**
 * Builds a real ABI event from the stored human-readable signature.
 *
 * Throws rather than returning null: a signature that will not parse means the KPI is misconfigured
 * on chain, and every subsequent step would produce a confidently wrong number. Failing at startup
 * is the whole point.
 */
export function parseEventSignature(signature: string): {event: AbiEvent; topic0: Hex} {
  let event: AbiEvent;
  try {
    event = parseAbiItem(`event ${signature}`) as AbiEvent;
  } catch {
    throw new Error(
      `Could not parse the configured event signature: "${signature}".\n` +
        `Expected a full declaration with \`indexed\` keywords, e.g.\n` +
        `  Deposit(address indexed user, uint256 amount)`,
    );
  }
  if (event.type !== "event") throw new Error(`"${signature}" is not an event.`);

  return {event, topic0: toEventSelector(event)};
}

/**
 * Checks the configured param indexes against the event before a single log is fetched.
 *
 * Both failures are silent otherwise. A `userParamIndex` pointing at a `uint256` yields garbage
 * addresses that match no attributed user, so the run reports nothing and looks merely quiet; a
 * `valueParamIndex` pointing at an address throws mid-run, after the RPC spend.
 */
export function validateParamIndexes(event: AbiEvent, config: KpiConfig): void {
  const userParam = event.inputs[config.userParamIndex];
  if (!userParam) {
    throw new Error(
      `userParamIndex ${config.userParamIndex} is out of range for "${event.name}" ` +
        `(${event.inputs.length} params).`,
    );
  }
  if (userParam.type !== "address") {
    throw new Error(
      `userParamIndex ${config.userParamIndex} points at a "${userParam.type}" param, expected "address".`,
    );
  }

  if (config.aggregation !== AGGREGATION.sum) return;

  const valueParam = event.inputs[config.valueParamIndex];
  if (!valueParam) {
    throw new Error(
      `valueParamIndex ${config.valueParamIndex} is out of range for "${event.name}" ` +
        `(${event.inputs.length} params).`,
    );
  }
  if (!valueParam.type.startsWith("uint")) {
    throw new Error(
      `valueParamIndex ${config.valueParamIndex} points at a "${valueParam.type}" param, ` +
        `which cannot be summed.`,
    );
  }
}

/**
 * Reads a decoded param by declaration position.
 *
 * viem returns named params as an object and unnamed ones as an array, and indexed params are not
 * distinguishable from the rest once decoded — which is exactly what makes declaration order the
 * right addressing scheme. Handles both shapes so a signature written without param names still
 * works.
 */
function argAt(event: AbiEvent, args: unknown, index: number): unknown {
  if (Array.isArray(args)) return args[index];
  const name = event.inputs[index]?.name;
  if (!name || typeof args !== "object" || args === null) return undefined;
  return (args as Record<string, unknown>)[name];
}

// ── scanning ─────────────────────────────────────────────────────

export type ScanRange =
  | {scan: true; fromBlock: bigint; toBlock: bigint}
  | {scan: false; reason: string};

/**
 * The block range this run should cover, or why there is nothing to do.
 *
 * **Resumes at `checkpoint + 1`.** The checkpoint is the last block the relayer has confirmed it fully
 * incorporated, and it is persisted on chain (`lastScannedBlock`, advanced inside the same transaction
 * that writes the totals), so it is exactly the watermark a resume needs — no local state file, and
 * nothing to lose.
 *
 * This has to match `nextTotals`, which adds this run's deltas onto the figure already stored. A full
 * rescan combined with an additive write counts the same activity once per cycle: with one deposit in
 * the window and a loop running every two minutes, the observed ceiling climbed 1 → 13 while the real
 * count stayed 1. Measured on the 08-21 fixture, not theorised. The two halves have to agree on
 * whether a scan produces a delta or a total, and the delta reading is the one that keeps a credited
 * range from being credited again.
 *
 * Scanning only new blocks also makes RPC spend flat per cycle rather than growing with campaign age.
 *
 * Three bounds still matter:
 *
 *  - **Never scan before `windowStartBlock`.** Activity before a campaign began tracking is out of
 *    scope, and on a first run the checkpoint sits below the window.
 *  - **Never scan past `windowEndBlock`.** `reportBatch` and `advanceCheckpoint` both reject a
 *    checkpoint beyond it, so a range that overshoots produces a run that does all the work and then
 *    reverts.
 *  - **Never rescan at or below the checkpoint.** That range is already folded into the stored totals.
 *
 * Also stays `confirmations` behind the head, so a reorg cannot strand a checkpoint on a block that
 * no longer exists — the checkpoint is monotonic on chain and cannot be walked back.
 *
 * The retry story this gives up, and why that is fine: an absolute total could be re-pushed freely,
 * because pushing the same number twice is a no-op. A delta cannot. What replaces it is atomicity —
 * `reportBatch` writes the totals and advances the checkpoint in one transaction, so a failed run
 * moves neither and a retry recomputes the identical delta over the identical range. The one case that
 * needs care is a run split across several transactions; see `planReportBatches`.
 */
export function resolveScanRange(input: {
  checkpoint: bigint;
  windowStartBlock: bigint;
  windowEndBlock: bigint;
  head: bigint;
  confirmations: bigint;
}): ScanRange {
  const {checkpoint, windowStartBlock, windowEndBlock, head, confirmations} = input;

  if (checkpoint >= windowEndBlock) {
    return {
      scan: false,
      reason:
        `report window fully scanned (checkpoint ${checkpoint} >= windowEndBlock ${windowEndBlock}) — ` +
        `this campaign's reporting period is over`,
    };
  }

  const safeHead = head > confirmations ? head - confirmations : BigInt(0);
  const toBlock = safeHead < windowEndBlock ? safeHead : windowEndBlock;

  if (windowStartBlock > toBlock) {
    return {scan: false, reason: `nothing new to scan yet (next block would be ${windowStartBlock})`};
  }

  // Nothing has been confirmed past the checkpoint, so there is no new activity to fold in. Under
  // additive totals this is not merely a saving — rescanning a range already folded in would add it a
  // second time.
  if (toBlock <= checkpoint) {
    return {
      scan: false,
      reason: `nothing new to scan yet (confirmed head ${toBlock} is not past checkpoint ${checkpoint})`,
    };
  }

  // Resume one past the checkpoint, but never before the window opens — on a first run the checkpoint
  // is below `windowStartBlock`.
  const resumeFrom = checkpoint + BigInt(1);
  const fromBlock = resumeFrom > windowStartBlock ? resumeFrom : windowStartBlock;

  return {scan: true, fromBlock, toBlock};
}

// ── decoding ─────────────────────────────────────────────────────

/**
 * Decodes matching logs into `(user, value, block)` triples.
 *
 * Aggregation is deliberately *not* done here: which logs count depends on per-user attribution
 * timestamps and per-block times, and both need a round trip. Folding first would mean folding logs
 * that turn out not to be creditable.
 *
 * A log that will not decode is skipped and counted rather than thrown on. Topic-0 filtering should
 * make it impossible, so a nonzero count is a signal worth surfacing, not a reason to abandon a run
 * that is otherwise correct.
 */
export function decodeUserEvents(
  logs: readonly RelayLog[],
  event: AbiEvent,
  config: KpiConfig,
): {decoded: DecodedEvent[]; undecodable: number} {
  const decoded: DecodedEvent[] = [];
  let undecodable = 0;

  for (const log of logs) {
    let args: unknown;
    try {
      ({args} = decodeEventLog({
        abi: [event],
        topics: log.topics as [Hex, ...Hex[]],
        data: log.data,
      }));
    } catch {
      undecodable++;
      continue;
    }

    const rawUser = argAt(event, args, config.userParamIndex);
    if (typeof rawUser !== "string") {
      undecodable++;
      continue;
    }

    let user: string;
    try {
      user = getAddress(rawUser).toLowerCase();
    } catch {
      undecodable++;
      continue;
    }

    let value = BigInt(1);
    if (config.aggregation === AGGREGATION.sum) {
      const rawValue = argAt(event, args, config.valueParamIndex);
      if (typeof rawValue !== "bigint") {
        undecodable++;
        continue;
      }
      value = rawValue;
    }

    decoded.push({user, value, blockNumber: log.blockNumber});
  }

  return {decoded, undecodable};
}

/** Every distinct block touched this run — one timestamp read each; many logs share a block. */
export function uniqueBlocks(decoded: readonly DecodedEvent[]): bigint[] {
  return [...new Set(decoded.map((d) => d.blockNumber))];
}

// ── attribution filtering ────────────────────────────────────────

export type AggregateResult = {
  /** Lowercased user => creditable delta from this run's logs. */
  deltas: Map<string, bigint>;
  /** Logs dropped because nobody held attribution when they happened. */
  excludedPreAttribution: number;
  /** Users skipped entirely for having no touch at all. */
  unattributed: string[];
};

/**
 * Folds decoded logs into per-user deltas, keeping only what a promoter actually earned.
 *
 * Two exclusions, both of which would otherwise raise the ceiling above what any promoter can be
 * credited:
 *
 *  - **No touch at all** — the activity belongs to no promoter and never will.
 *  - **No promoter held the user at that action's block** — the action predates their first touch,
 *    or falls in a gap after one lapsed. `Campaign` skips exactly these actions when it segments a
 *    report, so a ceiling that included them could never be drawn against.
 *
 * Attribution is resolved per action rather than against the live touch, so work done under a
 * superseded touch still counts — that work is retroactively creditable on chain, and flooring on
 * the current `signedAt` would starve it.
 *
 * A block with no known timestamp is treated as unresolved and excluded, because the alternative is
 * assuming it fell inside a window.
 */
export function aggregateDeltas(input: {
  decoded: readonly DecodedEvent[];
  /** Attribution as the chain would resolve it, from `attributionLookup`. */
  attribution: AttributionLookup;
  blockTimestamps: Map<bigint, bigint>;
}): AggregateResult {
  const {decoded, attribution, blockTimestamps} = input;

  const deltas = new Map<string, bigint>();
  const unattributed = new Set<string>();
  let excludedPreAttribution = 0;

  for (const {user, value, blockNumber} of decoded) {
    if (!attribution.known(getAddress(user))) {
      unattributed.add(user);
      continue;
    }

    const eventTimestamp = blockTimestamps.get(blockNumber);
    if (
      eventTimestamp === undefined ||
      !attribution.at(getAddress(user), blockNumber, eventTimestamp)
    ) {
      excludedPreAttribution++;
      continue;
    }

    deltas.set(user, (deltas.get(user) ?? BigInt(0)) + value);
  }

  return {deltas, excludedPreAttribution, unattributed: [...unattributed]};
}

/**
 * Adds this run's deltas onto the totals already stored on chain.
 *
 * Cumulative because `verifiedTotals` is cumulative — the relayer reads the stored figure back and
 * adds to it, which is what keeps it stateless. Raw and unscaled: the contract divides by `scale`
 * inside `verify`, and pre-dividing here would lose every sub-scale run.
 */
export function nextTotals(
  deltas: Map<string, bigint>,
  current: Map<string, bigint>,
): {users: `0x${string}`[]; totals: bigint[]} {
  const users: `0x${string}`[] = [];
  const totals: bigint[] = [];

  for (const [user, delta] of deltas) {
    users.push(getAddress(user));
    totals.push((current.get(user) ?? BigInt(0)) + delta);
  }

  return {users, totals};
}

// ── batching ─────────────────────────────────────────────────────

export type ReportBatch = {
  users: `0x${string}`[];
  totals: bigint[];
  /** Checkpoint this transaction should carry. */
  checkpoint: bigint;
};

/**
 * Splits a run into transactions, advancing the checkpoint only on the last one.
 *
 * This is the part that makes a partially failed run safe to retry. If every transaction carried the
 * new checkpoint, a run that died halfway would leave the checkpoint claiming a range whose later
 * totals were never stored, and the monotonic guard on chain means it can never be walked back — the
 * gap would be permanent. Holding the old checkpoint until the final transaction means a failure
 * leaves it untouched, and re-running recomputes the identical delta over the identical range.
 *
 * ## Why splitting is refused rather than performed
 *
 * That retry story only holds while a run is a *single* transaction. Totals are additive
 * (`nextTotals` = stored + delta), so re-reporting a batch is not a no-op the way re-pushing an
 * absolute total was. With more than one transaction there is no safe checkpoint to carry:
 *
 *  - old checkpoint on the non-final batches — batch 1 commits, batch 2 fails, the retry rescans the
 *    same range and adds batch 1's delta on top of the value it already wrote. Double credit, and it
 *    inflates the very ceiling the guarded verifier exists to enforce.
 *  - new checkpoint on every batch — batch 1 commits and moves the watermark past a range whose
 *    remaining users were never reported. Their activity is unreachable for the rest of the epoch.
 *
 * Both are silent. So a run that will not fit in one transaction throws instead, which is recoverable
 * (narrow the range and re-run) where the alternatives are not. The correct shape when this becomes
 * real is to split by **block sub-range** rather than by user: each transaction then covers a range it
 * fully incorporated and carries that range's own end as its checkpoint, which is self-consistent and
 * retry-safe at any width. `size` is 200 and the live fixtures report one or two users, so this is a
 * guard against a future run, not a limitation anyone is hitting.
 */
export function planReportBatches(input: {
  users: readonly `0x${string}`[];
  totals: readonly bigint[];
  size: number;
  newCheckpoint: bigint;
}): ReportBatch[] {
  const {users, totals, size, newCheckpoint} = input;

  if (users.length !== totals.length) {
    throw new Error(`users/totals length mismatch: ${users.length} vs ${totals.length}`);
  }
  if (size <= 0) throw new Error("batch size must be positive");

  // Nothing to report, but the scanned range still should not be walked again.
  if (users.length === 0) {
    return [{users: [], totals: [], checkpoint: newCheckpoint}];
  }

  if (users.length > size) {
    throw new Error(
      `${users.length} users with creditable activity exceeds the ${size}-per-transaction limit. ` +
        `Splitting by user is unsafe with additive totals — see planReportBatches. Narrow the scanned ` +
        `range (report over fewer blocks at a time) and re-run.`,
    );
  }

  return [{users: [...users], totals: [...totals], checkpoint: newCheckpoint}];
}

// ── drift guard ──────────────────────────────────────────────────

/**
 * Maps an indexer `actorTopic` onto a declaration-order param index.
 *
 * The two halves address the same parameter in different coordinate systems, which is the whole
 * reason they can silently disagree. `actorTopic` is 1-based over the `topics` array and counts only
 * *indexed* params (`topics[0]` is the signature, so the first indexed param is topic 1).
 * `userParamIndex` is 0-based over *every* param in declaration order. They coincide only when every
 * leading param happens to be indexed.
 *
 * Aave's `Supply(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount,
 * uint16 indexed referralCode)` is the case that shows the difference: `onBehalfOf` is the second
 * indexed param (topic 2) but the third declared one (param index 2 by coincidence here), while
 * `referralCode` is topic 3 and param 4.
 *
 * @returns the declaration index, or null when the event has no such indexed param.
 */
export function actorTopicToParamIndex(event: AbiEvent, actorTopic: number): number | null {
  if (!Number.isInteger(actorTopic) || actorTopic < 1) return null;

  let seen = 0;
  for (const [index, input] of event.inputs.entries()) {
    if (!input.indexed) continue;
    seen += 1;
    if (seen === actorTopic) return index;
  }
  return null;
}

/**
 * Whether the verifier's config and the indexer's event-source blob describe the same event.
 *
 * The two halves read their configuration from different places — the relayer from
 * `EventMetricKpiVerifier.kpiConfigs`, the indexer from `KpiSpec.params` — so they can drift. The
 * failure mode is quiet and expensive: the project claims progress from one event while Boney
 * verifies a different one, so the cap sits at 0 and every report is a silent no-op. Checked at
 * startup instead, where it is one comparison.
 *
 * Returns a human-readable complaint, or null when the two agree.
 */
export function describeConfigDrift(input: {
  event: AbiEvent;
  verifierTopic0: Hex;
  verifierTarget: `0x${string}`;
  verifierScale: bigint;
  verifierAggregation: Aggregation;
  verifierUserParamIndex: number;
  indexerTopic0: Hex | undefined;
  indexerSource: `0x${string}` | undefined;
  indexerScale: bigint | undefined;
  indexerAmountMode: AmountMode | undefined;
  indexerActorTopic: number | undefined;
}): string | null {
  const {event, verifierTopic0, verifierTarget, verifierScale, verifierAggregation} = input;
  const {verifierUserParamIndex, indexerTopic0, indexerSource} = input;
  const {indexerScale, indexerAmountMode, indexerActorTopic} = input;

  // A KPI with no event-source blob is not indexer-driven, so there is nothing to disagree with.
  if (!indexerTopic0 || !indexerSource) return null;

  if (indexerTopic0.toLowerCase() !== verifierTopic0.toLowerCase()) {
    return (
      `event mismatch: the verifier is configured for topic0 ${verifierTopic0}, ` +
      `but the KPI's params name ${indexerTopic0}`
    );
  }

  if (getAddress(indexerSource) !== getAddress(verifierTarget)) {
    return (
      `source mismatch: the verifier watches ${verifierTarget}, ` +
      `but the KPI's params name ${indexerSource}`
    );
  }

  // The actor is the worst of these to get wrong, because both halves keep working and simply credit
  // *different wallets*. A `Transfer` KPI pointed at `to` on one side and `from` on the other means
  // the project claims for recipients while Boney only ever observed senders, so `min(claim,
  // observed)` is 0 for every user and nothing is ever credited — no revert, no error, just progress
  // that never moves. It is also the one field that cannot be repaired after the fact: `actorTopic`
  // lives in the immutable `KpiSpec.params`, so a mismatch means recreating the campaign.
  if (indexerActorTopic !== undefined) {
    const indexerParamIndex = actorTopicToParamIndex(event, indexerActorTopic);
    const indexedCount = event.inputs.filter((i) => i.indexed).length;

    if (indexerParamIndex === null) {
      return (
        `actor mismatch: the KPI's params credit topics[${indexerActorTopic}], but "${event.name}" ` +
        `has only ${indexedCount} indexed param(s), so that topic is empty and no wallet can ever ` +
        `resolve from it`
      );
    }

    if (indexerParamIndex !== verifierUserParamIndex) {
      const verifierName = event.inputs[verifierUserParamIndex]?.name ?? "?";
      const indexerName = event.inputs[indexerParamIndex]?.name ?? "?";
      return (
        `actor mismatch: the verifier credits param ${verifierUserParamIndex} ("${verifierName}"), ` +
        `but the KPI's params credit topics[${indexerActorTopic}] which is param ` +
        `${indexerParamIndex} ("${indexerName}") — the two halves would credit different wallets, ` +
        `so nothing would ever be creditable`
      );
    }
  }

  // Aggregation is the disagreement that changes the *unit* rather than the magnitude: a count of
  // events and a sum of token values are not the same quantity, so neither number means what the
  // other half thinks it does. Checked because it actually happened — `SeedDemo` encoded `count` in
  // `params` while configuring the verifier for `SUM`, and the two other comparisons here both
  // passed. The indexer then folded 1 per log, divided by the 1e18 token scale, floored every
  // referral to zero, and reported nothing at all, while Boney observed real volume. Silent on both
  // sides: no revert, just progress bars that never moved.
  if (indexerAmountMode !== undefined) {
    const verifierFold = verifierAggregation === AGGREGATION.sum ? "SUM" : "COUNT";
    const indexerFold = indexerAmountMode === AMOUNT_MODE.dataWord0 ? "SUM" : "COUNT";
    if (verifierFold !== indexerFold) {
      return (
        `aggregation mismatch: the verifier folds by ${verifierFold}, ` +
        `but the KPI's params fold by ${indexerFold} — these are different quantities, not a ` +
        `different magnitude of the same one`
      );
    }
  }

  // Scale disagreement does not misattribute anything, but it does mis-denominate the cap, so a
  // correct claim gets trimmed to a fraction of itself or capped far too loosely.
  const effectiveVerifier = verifierScale === BigInt(0) ? BigInt(1) : verifierScale;
  const effectiveIndexer =
    indexerScale === undefined || indexerScale === BigInt(0) ? BigInt(1) : indexerScale;
  if (effectiveVerifier !== effectiveIndexer) {
    return (
      `scale mismatch: the verifier divides by ${effectiveVerifier}, ` +
      `but the KPI's params divide by ${effectiveIndexer}`
    );
  }

  return null;
}
