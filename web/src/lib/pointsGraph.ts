import {
  decodeMeta,
  graphRequest,
  graphUnavailable,
  META_SELECTION,
  paginate,
  subgraphUrl,
  toBigInt,
  GRAPH_PAGE_SIZE,
  SUBGRAPH_CHAINS,
  type GraphFetch,
  type GraphResult,
} from "./graph";
import type {PointsCredit, PointsInput, PointsJoin, PointsKpi, PointsTouch} from "./points";

/**
 * The leaderboard's read — every scoreable row in the protocol, from the subgraph.
 *
 * This module fetches and decodes; `points.ts` owns the scoring. The subgraph indexes from the
 * CampaignRegistry's deployment block, so these rows cover the protocol's whole history and the board
 * needs no backfill.
 *
 * Nothing here returns zeroed rows for a failed read: `GraphResult` is a two-armed union and a board
 * that renders 0 points for everyone is a claim, not a missing answer.
 */

/** A join row with the `id` pagination cursors on. */
export type GraphJoin = PointsJoin & {id: string};

/** An attribution row with the `id` pagination cursors on. */
export type GraphTouch = PointsTouch & {id: string};

/** A credit row with the `id` pagination cursors on. */
export type GraphCredit = PointsCredit & {id: string};

/** Everything the fold needs, plus how far the read can be trusted. */
export type PointsSnapshot = {
  input: PointsInput;
  /** A page cap was hit. Every total is then a floor rather than a sum. */
  truncated: boolean;
  /** From `_meta`, so a lagging indexer is visible rather than silent. */
  indexedBlock: bigint;
  /** A handler threw while indexing; the rows are incomplete in a way no total can detect. */
  hasIndexingErrors: boolean;
};

// ── documents ────────────────────────────────────────────────────

const JOIN_FIELDS = "id promoterId wallet";
const TOUCH_FIELDS = "id user";
const CREDIT_FIELDS = "id kpiIndex promoterId user amount campaign { id }";

/**
 * The first page of all four collections, plus the indexer's own position.
 *
 * `wallet_not: null` drops rows written by `PromoterRegistered` alone. That event carries only the
 * promoter id, so the row exists before `PromoterJoined` fills the wallet in, and a wallet-less row
 * names nobody to award points to.
 */
export const POINTS_QUERY = `query BoneyPoints($first: Int!) {
  promoters(where: {wallet_not: null}, first: $first, orderBy: id, orderDirection: asc) { ${JOIN_FIELDS} }
  touches(first: $first, orderBy: id, orderDirection: asc) { ${TOUCH_FIELDS} }
  credits(first: $first, orderBy: id, orderDirection: asc) { ${CREDIT_FIELDS} }
  kpis(first: $first, orderBy: id, orderDirection: asc) { id kind amountMode }
  ${META_SELECTION}
}`;

/** Continuation of a full `promoters` page. */
export const POINTS_JOINS_PAGE_QUERY = `query BoneyPointsJoins($first: Int!, $cursor: ID!) {
  promoters(where: {wallet_not: null, id_gt: $cursor}, first: $first, orderBy: id, orderDirection: asc) { ${JOIN_FIELDS} }
}`;

/** Continuation of a full `touches` page. */
export const POINTS_TOUCHES_PAGE_QUERY = `query BoneyPointsTouches($first: Int!, $cursor: ID!) {
  touches(where: {id_gt: $cursor}, first: $first, orderBy: id, orderDirection: asc) { ${TOUCH_FIELDS} }
}`;

/** Continuation of a full `credits` page. */
export const POINTS_CREDITS_PAGE_QUERY = `query BoneyPointsCredits($first: Int!, $cursor: ID!) {
  credits(where: {id_gt: $cursor}, first: $first, orderBy: id, orderDirection: asc) { ${CREDIT_FIELDS} }
}`;

// ── decoding ─────────────────────────────────────────────────────

type RawRow = Record<string, unknown>;

const asId = (raw: unknown): string => (typeof raw === "string" ? raw : "");

const asHex = (raw: unknown): string =>
  typeof raw === "string" && raw.startsWith("0x") ? raw.toLowerCase() : "";

const asInt = (raw: unknown): number => (typeof raw === "number" && Number.isFinite(raw) ? raw : 0);

/**
 * Decode join rows.
 *
 * @param raw The `promoters` selection.
 * @returns One row per campaign a wallet has joined, wallet-less rows already excluded by the filter.
 */
export function decodeJoins(raw: unknown): GraphJoin[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((row: RawRow) => ({
    id: asId(row?.id),
    promoterId: asHex(row?.promoterId),
    wallet: asHex(row?.wallet),
  }));
}

/**
 * Decode attribution rows.
 *
 * @param raw The `touches` selection.
 * @returns One row per `(campaign, user)` pair, which is what makes a re-signature unscoreable.
 */
export function decodeTouches(raw: unknown): GraphTouch[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((row: RawRow) => ({id: asId(row?.id), user: asHex(row?.user)}));
}

/**
 * Decode credit rows.
 *
 * @param raw The `credits` selection.
 * @returns One row per `ProgressCredited`, its amount a delta in the KPI's own units.
 */
export function decodeCredits(raw: unknown): GraphCredit[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((row: RawRow) => ({
    id: asId(row?.id),
    campaign: asHex((row?.campaign as RawRow | null | undefined)?.id),
    kpiIndex: asInt(row?.kpiIndex),
    promoterId: asHex(row?.promoterId),
    user: asHex(row?.user),
    amount: toBigInt(row?.amount),
  }));
}

/**
 * Decode KPI units.
 *
 * `amountMode` stays `undefined` when the schema holds null — the KPI's params are not an event-source
 * blob, which is a fact about the KPI rather than a mode of 0.
 *
 * @param raw The `kpis` selection.
 * @returns One row per KPI, keyed by `<campaign>-<index>`.
 */
export function decodeKpis(raw: unknown): PointsKpi[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((row: RawRow) => ({
    id: asId(row?.id).toLowerCase(),
    kind: asInt(row?.kind),
    amountMode: row?.amountMode == null ? undefined : asInt(row.amountMode),
  }));
}

// ── the read ─────────────────────────────────────────────────────

/**
 * Fetch every scoreable row in the protocol.
 *
 * One combined request, then a continuation per collection that came back full. `fetchImpl` is an
 * injection point so the orchestration is testable without a network.
 *
 * @param input.chainId Chain to read; only chains with a deployed subgraph can answer.
 * @param input.fetchImpl Injected fetch, for tests.
 * @param input.signal Abort signal propagated to every page.
 * @returns The fold's input plus truncation and indexer state, or an unavailable result.
 */
export async function fetchPointsFromGraph(input: {
  chainId: number | undefined;
  fetchImpl?: GraphFetch;
  signal?: AbortSignal;
}): Promise<GraphResult<PointsSnapshot>> {
  const url = subgraphUrl(input.chainId);
  if (!url) {
    return input.chainId !== undefined && !SUBGRAPH_CHAINS.includes(input.chainId)
      ? graphUnavailable("unsupported-chain", "The leaderboard is indexed for Base Sepolia only.")
      : graphUnavailable("not-configured", "No subgraph is configured for this deployment.");
  }

  const common = {url, fetchImpl: input.fetchImpl, signal: input.signal};

  const first = await graphRequest({
    ...common,
    query: POINTS_QUERY,
    variables: {first: GRAPH_PAGE_SIZE},
    pick: (data) => {
      // `promoters` is the load-bearing field: absent means a shape this build does not understand,
      // while an empty array is the ordinary answer for a protocol nobody has joined yet.
      if (!Array.isArray(data.promoters)) return undefined;
      return {
        joins: decodeJoins(data.promoters),
        touches: decodeTouches(data.touches),
        credits: decodeCredits(data.credits),
        kpis: decodeKpis(data.kpis),
        // KPIs are bounded by campaigns × KPIs per campaign, so a full page implies a scale at which
        // one more request changes nothing. Flagged rather than walked.
        kpisPageFull: Array.isArray(data.kpis) && data.kpis.length >= GRAPH_PAGE_SIZE,
        meta: decodeMeta(data._meta as Parameters<typeof decodeMeta>[0]),
      };
    },
  });
  if (first.kind !== "ok") return first;

  const joins = await paginate<GraphJoin>(
    (cursor) =>
      graphRequest({
        ...common,
        query: POINTS_JOINS_PAGE_QUERY,
        variables: {first: GRAPH_PAGE_SIZE, cursor},
        pick: (data) => (Array.isArray(data.promoters) ? decodeJoins(data.promoters) : undefined),
      }),
    first.data.joins,
  );
  if (joins.kind !== "ok") return joins;

  const touches = await paginate<GraphTouch>(
    (cursor) =>
      graphRequest({
        ...common,
        query: POINTS_TOUCHES_PAGE_QUERY,
        variables: {first: GRAPH_PAGE_SIZE, cursor},
        pick: (data) => (Array.isArray(data.touches) ? decodeTouches(data.touches) : undefined),
      }),
    first.data.touches,
  );
  if (touches.kind !== "ok") return touches;

  const credits = await paginate<GraphCredit>(
    (cursor) =>
      graphRequest({
        ...common,
        query: POINTS_CREDITS_PAGE_QUERY,
        variables: {first: GRAPH_PAGE_SIZE, cursor},
        pick: (data) => (Array.isArray(data.credits) ? decodeCredits(data.credits) : undefined),
      }),
    first.data.credits,
  );
  if (credits.kind !== "ok") return credits;

  return {
    kind: "ok",
    data: {
      input: {
        joins: joins.data.rows,
        touches: touches.data.rows,
        credits: credits.data.rows,
        kpis: first.data.kpis,
      },
      truncated:
        joins.data.truncated ||
        touches.data.truncated ||
        credits.data.truncated ||
        first.data.kpisPageFull,
      indexedBlock: first.data.meta.indexedBlock,
      hasIndexingErrors: first.data.meta.hasIndexingErrors,
    },
  };
}
