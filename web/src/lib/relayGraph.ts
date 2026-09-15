import {getAddress, type AbiEvent, type Hex} from "viem";
import {
  GRAPH_PAGE_SIZE,
  graphRequest,
  hexLower,
  type GraphFetch,
  type GraphResult,
} from "./graph";
import {
  attributionLookup,
  buildAttributionWindows,
  type AttributionWindow,
  type TouchLog,
} from "./attributionWindows";
import {matchesTopicFilter, type EventSource} from "./kpiSource";
import {
  aggregateDeltas,
  decodeUserEvents,
  type DecodedEvent,
  type KpiConfig,
  type RelayLog,
} from "./relayCore";

export const RELAY_GRAPH_DEFAULT_MAX_PAGES = 100;

type RawKpi = {
  source?: unknown;
  topic0?: unknown;
  actorTopic?: unknown;
  amountMode?: unknown;
  scale?: unknown;
  filterTopic?: unknown;
  filterValue?: unknown;
};

type RawCoverage = RawKpi & {
  valueParamIndex?: unknown;
  eventShape?: unknown;
  coverageStartBlock?: unknown;
  supported?: unknown;
};

type RawTouch = Record<string, unknown>;
type RawAction = Record<string, unknown>;

const HEALTH_QUERY = `query RelayHealth { _meta { block { number hash } hasIndexingErrors } }`;

export type RelayGraphMeta = {
  indexedBlock: bigint;
  blockHash: Hex;
};

export type RelayGraphCoverage = {
  source: `0x${string}`;
  topic0: Hex;
  actorTopic: number;
  valueParamIndex: number;
  amountMode: number;
  scale: bigint;
  filterTopic: number;
  filterValue: Hex;
  eventShape: string;
  coverageStartBlock: bigint;
  supported: boolean;
};

export type RelayGraphHistory = {
  snapshot: bigint;
  snapshotHash: Hex;
  touches: TouchLog[];
  logs: RelayLog[];
  timestamps: bigint[];
  actionIds: string[];
  coverage: RelayGraphCoverage;
};

export type RelayGraphFold = RelayGraphHistory & {
  decoded: DecodedEvent[];
  attributionWindows: Map<string, AttributionWindow[]>;
  deltas: Map<string, bigint>;
  excludedPreAttribution: number;
  unattributed: string[];
};

function fail(message: string): never {
  throw new Error(`Relay subgraph rejected the pass: ${message}`);
}

function object(raw: unknown, label: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail(`${label} is malformed.`);
  return raw as Record<string, unknown>;
}

function array(raw: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(raw)) fail(`${label} is malformed.`);
  return raw.map((row, index) => object(row, `${label}[${index}]`));
}

function string(raw: unknown, label: string): string {
  if (typeof raw !== "string" || raw.length === 0) fail(`${label} is malformed.`);
  return raw;
}

function integer(raw: unknown, label: string, allowZero = true): bigint {
  if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "bigint") {
    fail(`${label} is malformed.`);
  }
  let value: bigint;
  try {
    value = BigInt(raw);
  } catch {
    fail(`${label} is malformed.`);
  }
  if (value < BigInt(0) || (!allowZero && value === BigInt(0))) fail(`${label} is malformed.`);
  return value;
}

function safeNumber(raw: unknown, label: string): number {
  const value = integer(raw, label);
  const number = Number(value);
  if (!Number.isSafeInteger(number)) fail(`${label} is out of range.`);
  return number;
}

function hex(raw: unknown, label: string, bytes?: number): Hex {
  const value = string(raw, label);
  const pattern = bytes === undefined
    ? /^0x(?:[0-9a-fA-F]{2})*$/
    : new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`);
  if (!pattern.test(value)) fail(`${label} is malformed.`);
  return value.toLowerCase() as Hex;
}

function address(raw: unknown, label: string): `0x${string}` {
  try {
    return getAddress(string(raw, label));
  } catch {
    fail(`${label} is malformed.`);
  }
}

function bool(raw: unknown, label: string): boolean {
  if (typeof raw !== "boolean") fail(`${label} is malformed.`);
  return raw;
}

function unwrap<T>(result: GraphResult<T>, label: string): T {
  if (result.kind === "unavailable") fail(`${label}: ${result.message}`);
  return result.data;
}

function decodeMeta(raw: unknown): RelayGraphMeta {
  const meta = object(raw, "_meta");
  if (bool(meta.hasIndexingErrors, "_meta.hasIndexingErrors")) {
    fail("_meta reports indexing errors.");
  }
  const block = object(meta.block, "_meta.block");
  return {
    indexedBlock: integer(block.number, "_meta.block.number"),
    blockHash: hex(block.hash, "_meta.block.hash", 32),
  };
}

/** Reads strict subgraph health before selecting a snapshot. */
export async function readRelayGraphMeta(input: {
  url: string;
  fetchImpl?: GraphFetch;
}): Promise<RelayGraphMeta> {
  const result = await graphRequest({
    url: input.url,
    query: HEALTH_QUERY,
    fetchImpl: input.fetchImpl,
    pick: (data) => data._meta,
  });
  return decodeMeta(unwrap(result, "health query failed"));
}

/** Selects a finalized snapshot and refuses a lagging graph. */
export function relayGraphSnapshot(input: {
  indexedBlock: bigint;
  head: bigint;
  confirmations: bigint;
  windowEndBlock: bigint;
  checkpoint: bigint;
}): bigint | null {
  const safeHead = input.head > input.confirmations
    ? input.head - input.confirmations
    : BigInt(0);
  const target = safeHead < input.windowEndBlock ? safeHead : input.windowEndBlock;
  if (input.indexedBlock < target) {
    fail(`indexed block ${input.indexedBlock} is behind required block ${target}.`);
  }
  if (target <= input.checkpoint) return null;
  return target;
}

const PAGE_QUERY = `query RelayPage(
  $snapshot: Int!, $campaign: Bytes!, $kpiId: ID!, $coverageId: ID!,
  $source: Bytes!, $topic0: Bytes!, $fromBlock: BigInt!, $toBlock: BigInt!,
  $touchCursor: ID!, $actionCursor: ID!, $first: Int!
) {
  _meta(block: { number: $snapshot }) { block { number hash } hasIndexingErrors }
  kpi(id: $kpiId, block: { number: $snapshot }) {
    source topic0 actorTopic amountMode scale filterTopic filterValue
  }
  sourceCoverage(id: $coverageId, block: { number: $snapshot }) {
    source topic0 actorTopic valueParamIndex amountMode scale filterTopic filterValue
    eventShape coverageStartBlock supported
  }
  touchHistories(
    first: $first, orderBy: id, orderDirection: asc,
    where: { campaign: $campaign, blockNumber_lte: $toBlock, id_gt: $touchCursor },
    block: { number: $snapshot }
  ) { id campaign user promoterId signedAt expiresAt blockNumber timestamp txHash logIndex }
  kpiActions(
    first: $first, orderBy: id, orderDirection: asc,
    where: { source: $source, topic0: $topic0, blockNumber_gte: $fromBlock,
      blockNumber_lte: $toBlock, id_gt: $actionCursor },
    block: { number: $snapshot }
  ) { id source topic0 topic1 topic2 topic3 data user value blockNumber timestamp txHash logIndex eventShape }
}`;

function normalizedCommitment(raw: RawKpi, label: string) {
  return {
    source: address(raw.source, `${label}.source`),
    topic0: hex(raw.topic0, `${label}.topic0`, 32),
    actorTopic: safeNumber(raw.actorTopic, `${label}.actorTopic`),
    amountMode: safeNumber(raw.amountMode, `${label}.amountMode`),
    scale: integer(raw.scale, `${label}.scale`),
    filterTopic: raw.filterTopic == null ? 0 : safeNumber(raw.filterTopic, `${label}.filterTopic`),
    filterValue: raw.filterValue == null ? "0x" as Hex : hex(raw.filterValue, `${label}.filterValue`),
  };
}

function decodeCoverage(raw: unknown): RelayGraphCoverage {
  const row = object(raw, "sourceCoverage") as RawCoverage;
  return {
    ...normalizedCommitment(row, "sourceCoverage"),
    valueParamIndex: safeNumber(row.valueParamIndex, "sourceCoverage.valueParamIndex"),
    eventShape: string(row.eventShape, "sourceCoverage.eventShape"),
    coverageStartBlock: integer(row.coverageStartBlock, "sourceCoverage.coverageStartBlock"),
    supported: bool(row.supported, "sourceCoverage.supported"),
  };
}

function sameHex(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function validateCoverage(input: {
  kpi: unknown;
  coverage: RelayGraphCoverage;
  config: KpiConfig;
  source: EventSource | null;
  topic0: Hex;
  fromBlock: bigint;
}): void {
  const kpi = normalizedCommitment(object(input.kpi, "kpi") as RawKpi, "kpi");
  const expectedSource = input.source?.source ?? input.config.targetContract;
  const expectedActor = input.source?.actorTopic ?? 0;
  const expectedMode = input.source?.amountMode ?? input.config.aggregation;
  const expectedScale = input.source?.scale ?? input.config.scale;
  const expectedFilterTopic = input.source?.filterTopic ?? 0;
  const expectedFilterValue = input.source?.filterValue ?? "0x";
  const commitments = [kpi, input.coverage];

  for (const [index, row] of commitments.entries()) {
    const label = index === 0 ? "kpi" : "coverage";
    if (!sameHex(row.source, expectedSource) || !sameHex(row.topic0, input.topic0)) {
      fail(`${label} source commitment does not match the on-chain configuration.`);
    }
    if (row.actorTopic !== expectedActor || row.amountMode !== expectedMode) {
      fail(`${label} actor or amount mode does not match the on-chain configuration.`);
    }
    if (row.scale !== expectedScale || row.filterTopic !== expectedFilterTopic) {
      fail(`${label} scale or filter topic does not match the on-chain configuration.`);
    }
    if (!sameHex(row.filterValue, expectedFilterValue)) {
      fail(`${label} filter value does not match the on-chain configuration.`);
    }
  }
  if (!input.coverage.supported) fail("the indexed event shape is unsupported.");
  if (input.coverage.valueParamIndex !== input.config.valueParamIndex) {
    fail("coverage value parameter does not match the verifier configuration.");
  }
  if (input.coverage.coverageStartBlock > input.fromBlock) {
    fail(`coverage begins at ${input.coverage.coverageStartBlock}, after required block ${input.fromBlock}.`);
  }
}

function decodeTouch(row: RawTouch, snapshot: bigint): {id: string; touch: TouchLog} {
  const id = string(row.id, "touch.id");
  const blockNumber = integer(row.blockNumber, `touch ${id}.blockNumber`);
  if (blockNumber > snapshot) fail(`touch ${id} is beyond the snapshot.`);
  integer(row.timestamp, `touch ${id}.timestamp`, false);
  hex(row.txHash, `touch ${id}.txHash`, 32);
  safeNumber(row.logIndex, `touch ${id}.logIndex`);
  return {
    id,
    touch: {
      user: address(row.user, `touch ${id}.user`),
      promoterId: hex(row.promoterId, `touch ${id}.promoterId`, 32),
      signedAt: integer(row.signedAt, `touch ${id}.signedAt`),
      expiresAt: integer(row.expiresAt, `touch ${id}.expiresAt`, false),
      blockNumber,
    },
  };
}

function decodeAction(input: {
  row: RawAction;
  snapshot: bigint;
  fromBlock: bigint;
  source: `0x${string}`;
  topic0: Hex;
  event: AbiEvent;
  config: KpiConfig;
  eventSource: EventSource | null;
  coverage: RelayGraphCoverage;
}): {id: string; identity: string; log: RelayLog; timestamp: bigint} {
  const {row} = input;
  const id = string(row.id, "action.id");
  const blockNumber = integer(row.blockNumber, `action ${id}.blockNumber`);
  if (blockNumber < input.fromBlock || blockNumber > input.snapshot) {
    fail(`action ${id} is outside the requested range.`);
  }
  if (!sameHex(address(row.source, `action ${id}.source`), input.source)) {
    fail(`action ${id} has the wrong source.`);
  }
  if (!sameHex(hex(row.topic0, `action ${id}.topic0`, 32), input.topic0)) {
    fail(`action ${id} has the wrong topic0.`);
  }
  if (string(row.eventShape, `action ${id}.eventShape`) !== input.coverage.eventShape) {
    fail(`action ${id} has the wrong event shape.`);
  }
  const txHash = hex(row.txHash, `action ${id}.txHash`, 32);
  const logIndex = safeNumber(row.logIndex, `action ${id}.logIndex`);
  const timestamp = integer(row.timestamp, `action ${id}.timestamp`, false);
  const topics: Hex[] = [input.topic0];
  const indexedCount = input.event.inputs.filter((param) => param.indexed).length;
  for (let index = 1; index <= indexedCount; index += 1) {
    topics.push(hex(row[`topic${index}`], `action ${id}.topic${index}`, 32));
  }
  const log: RelayLog = {topics, data: hex(row.data, `action ${id}.data`), blockNumber};
  if (input.eventSource && !matchesTopicFilter(log, input.eventSource)) {
    fail(`action ${id} fails the configured topic filter.`);
  }
  const decoded = decodeUserEvents([log], input.event, input.config);
  if (decoded.undecodable !== 0 || decoded.decoded.length !== 1) fail(`action ${id} cannot be decoded.`);
  const action = decoded.decoded[0]!;
  if (address(row.user, `action ${id}.user`).toLowerCase() !== action.user) {
    fail(`action ${id} disagrees with its normalized user.`);
  }
  if (integer(row.value, `action ${id}.value`) !== action.value) {
    fail(`action ${id} disagrees with its normalized value.`);
  }
  return {id, identity: `${txHash}:${logIndex}`, log, timestamp};
}

function ensureCursor(rows: readonly Record<string, unknown>[], previous: string, label: string): string {
  let cursor = previous;
  for (const row of rows) {
    const id = string(row.id, `${label}.id`);
    if (id <= cursor) fail(`${label} cursor is not strictly increasing.`);
    cursor = id;
  }
  return cursor;
}

function coverageId(campaign: `0x${string}`, kpiIndex: bigint): string {
  return `${hexLower(campaign)}-${kpiIndex}`;
}

/** Reads and validates one complete, snapshot-pinned relay range. */
export async function readRelayGraphHistory(input: {
  url: string;
  campaign: `0x${string}`;
  kpiIndex: bigint;
  snapshot: bigint;
  expectedHash: Hex;
  fromBlock: bigint;
  event: AbiEvent;
  topic0: Hex;
  config: KpiConfig;
  source: EventSource | null;
  maxPages?: number;
  fetchImpl?: GraphFetch;
}): Promise<RelayGraphHistory> {
  const maxPages = input.maxPages ?? RELAY_GRAPH_DEFAULT_MAX_PAGES;
  if (!Number.isSafeInteger(maxPages) || maxPages <= 0) fail("page ceiling must be positive.");
  if (input.snapshot > BigInt(Number.MAX_SAFE_INTEGER)) fail("snapshot exceeds GraphQL Int range.");
  let touchCursor = "";
  let actionCursor = "";
  let touchesDone = false;
  let actionsDone = false;
  const touches: TouchLog[] = [];
  const logs: RelayLog[] = [];
  const timestamps: bigint[] = [];
  const actionIds: string[] = [];
  const identities = new Set<string>();
  let coverage: RelayGraphCoverage | undefined;

  for (let page = 0; page < maxPages; page += 1) {
    const result = await graphRequest({
      url: input.url,
      query: PAGE_QUERY,
      variables: {
        snapshot: Number(input.snapshot),
        campaign: hexLower(input.campaign),
        kpiId: coverageId(input.campaign, input.kpiIndex),
        coverageId: coverageId(input.campaign, input.kpiIndex),
        source: hexLower(input.config.targetContract),
        topic0: hexLower(input.topic0),
        fromBlock: input.fromBlock.toString(),
        toBlock: input.snapshot.toString(),
        touchCursor,
        actionCursor,
        first: GRAPH_PAGE_SIZE,
      },
      fetchImpl: input.fetchImpl,
      pick: (data) => data,
    });
    const data = unwrap(result, `page ${page + 1} failed`);
    const meta = decodeMeta(data._meta);
    if (meta.indexedBlock !== input.snapshot || !sameHex(meta.blockHash, input.expectedHash)) {
      fail(`page ${page + 1} metadata does not match the pinned RPC snapshot.`);
    }
    if (!coverage) {
      coverage = decodeCoverage(data.sourceCoverage);
      validateCoverage({
        kpi: data.kpi,
        coverage,
        config: input.config,
        source: input.source,
        topic0: input.topic0,
        fromBlock: input.fromBlock,
      });
    }

    const touchRows = touchesDone ? [] : array(data.touchHistories, "touchHistories");
    const actionRows = actionsDone ? [] : array(data.kpiActions, "kpiActions");
    touchCursor = ensureCursor(touchRows, touchCursor, "touchHistories");
    actionCursor = ensureCursor(actionRows, actionCursor, "kpiActions");
    for (const row of touchRows) touches.push(decodeTouch(row, input.snapshot).touch);
    for (const row of actionRows) {
      const action = decodeAction({
        row,
        snapshot: input.snapshot,
        fromBlock: input.fromBlock,
        source: input.config.targetContract,
        topic0: input.topic0,
        event: input.event,
        config: input.config,
        eventSource: input.source,
        coverage,
      });
      if (identities.has(action.identity)) fail(`duplicate action identity ${action.identity}.`);
      identities.add(action.identity);
      logs.push(action.log);
      timestamps.push(action.timestamp);
      actionIds.push(action.identity);
    }
    touchesDone ||= touchRows.length < GRAPH_PAGE_SIZE;
    actionsDone ||= actionRows.length < GRAPH_PAGE_SIZE;
    if (touchesDone && actionsDone) {
      return {
        snapshot: input.snapshot,
        snapshotHash: meta.blockHash,
        touches,
        logs,
        timestamps,
        actionIds,
        coverage,
      };
    }
  }
  fail(`page ceiling ${maxPages} was reached before both collections ended.`);
}

/** Applies the existing ABI and attribution fold to validated graph history. */
export function foldRelayGraphHistory(input: {
  history: RelayGraphHistory;
  event: AbiEvent;
  config: KpiConfig;
  campaignStartTime: bigint;
}): RelayGraphFold {
  const decoded = decodeUserEvents(input.history.logs, input.event, input.config);
  if (decoded.undecodable !== 0 || decoded.decoded.length !== input.history.logs.length) {
    fail("validated history changed shape during decoding.");
  }
  const attributionWindows = buildAttributionWindows(input.history.touches);
  const timestamps = new Map<bigint, bigint>();
  for (const [index, action] of decoded.decoded.entries()) {
    const timestamp = input.history.timestamps[index];
    if (timestamp === undefined) fail(`action block ${action.blockNumber} has no timestamp.`);
    const existing = timestamps.get(action.blockNumber);
    if (existing !== undefined && existing !== timestamp) {
      fail(`action block ${action.blockNumber} has conflicting timestamps.`);
    }
    timestamps.set(action.blockNumber, timestamp);
  }
  const aggregate = aggregateDeltas({
    decoded: decoded.decoded,
    attribution: attributionLookup(attributionWindows, input.campaignStartTime),
    blockTimestamps: timestamps,
  });
  return {
    ...input.history,
    decoded: decoded.decoded,
    attributionWindows,
    ...aggregate,
  };
}
