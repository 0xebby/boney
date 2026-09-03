import {isAddress} from "viem/utils";
import {
  decodeMeta,
  graphRequest,
  graphUnavailable,
  hexLower,
  META_SELECTION,
  paginate,
  subgraphUrl,
  toBigInt,
  GRAPH_PAGE_SIZE,
  SUBGRAPH_CHAINS,
  type GraphFetch,
  type GraphResult,
} from "./graph";
import {statusFromIndex, type CampaignStatus} from "./types";

/**
 * A promoter's indexed history — the read half of the BoneyCard's stage 2.
 *
 * This module fetches and decodes; it counts nothing. Every field the card shows (campaigns joined,
 * projects worked with, tiers crossed, referrals brought, earned-per-token, the milestone dates and the
 * bone level) is a fold over these rows, and that fold belongs in `boneycard.ts` where it can be pinned
 * by fixtures — the same split `promoters.ts` and `discovery.ts` use, and the reason nothing is
 * pre-aggregated in the subgraph either.
 *
 * ## Two round trips, and why the second is skippable
 *
 * `Credit` and `TierPayout` are keyed by `promoterId`, which is **per campaign**: a wallet promoting
 * three campaigns holds three unrelated ids. `Credit` carries only the id, so credits can only be
 * reached through `Promoter`, and that is one unavoidable hop:
 *
 *  1. `promoters(where: {wallet})` + `tierPayouts(where: {promoter: wallet})` + `_meta`
 *  2. `credits(where: {promoterId_in: ids})` + `kpis(where: {campaign_in: campaigns})`
 *
 * `tierPayouts` rides along in the first trip because `TierPayout.promoter` is the **wallet**, not the
 * id — it needs nothing from the hop. And when the first trip finds no memberships the second is not
 * sent at all: a wallet with no `Promoter` rows can have no credits, so the request would be a round
 * trip to prove an emptiness already established.
 *
 * ## Why the hop is safe
 *
 * `Promoter.wallet` is null for a row written by `PromoterRegistered` alone, so filtering on `wallet`
 * drops those rows — and the question is whether a dropped row could have credits. It cannot.
 * `Campaign.join()` writes `_promoterOf[promoterId]`, calls `registerPromoter`, and emits
 * `PromoterJoined` in **one transaction**; `_promoterOf` is written nowhere else; and
 * `reportUserAction` reverts `NoAttribution` on reading a zero promoter. So any `Credit` implies a join
 * that recorded the wallet, and `promoters(where: {wallet})` is complete for everything credit-bearing.
 *
 * The same argument covers `TierPayout`: settlement pays a promoter who joined. A payout whose campaign
 * has no membership row here would be a subgraph bug, so `campaign` is carried on the payout rather
 * than assumed — the fold can notice.
 *
 * It also matters that `Promoter` is never walked unfiltered: `registerPromoter` is permissionless by
 * design, so anyone can emit `PromoterRegistered` and create a wallet-less row pointing at a
 * non-campaign. The wallet filter excludes them for free.
 *
 * ## Nothing here may return zero on failure
 *
 * `GraphResult` is the contract: the caller cannot read rows without handling `unavailable` first. An
 * unreachable subgraph renders "history unavailable"; it must never be able to render "0 campaigns",
 * which is a claim about a person rather than a missing answer. `truncated` and `hasIndexingErrors`
 * carry the weaker version of the same warning — the counts are floors, not totals.
 */

/** A campaign as the history needs it. `CampaignView` is the on-chain read's shape; this is smaller. */
export type HistoryCampaign = {
  /** Lowercased campaign address — `Campaign.id`. */
  address: `0x${string}`;
  campaignId: bigint;
  project: `0x${string}`;
  token: `0x${string}`;
  name: string;
  status: CampaignStatus;
  /** Block timestamp of `CampaignCreated`. */
  createdAt: bigint;
};

export type HistoryMembership = {
  campaign: HistoryCampaign;
  /** This wallet's id **in this campaign only**. Never leaves this module's callers' fold. */
  promoterId: `0x${string}`;
  /**
   * `ReputationRegistry.scoreOf` as it stood when `join()` ran — a dated figure, not a current score.
   * `discovery.ts` named the same value `scoreAtJoin` because attestations expire against their
   * schema's `maxAge` and `setSchemaWeight` reprices retroactively, so a promoter who joined at 19,494
   * can score 5,256 today having done nothing.
   */
  reputationAtJoin: bigint | undefined;
  /**
   * Block of `PromoterJoined`, or undefined for a `PromoterRegistered`-only row.
   *
   * A block, not a timestamp: `Promoter` indexes `joinedAtBlock` and no time. "Promoting since"
   * therefore needs one `getBlock` for the earliest of these — `Campaign.createdAt` is a lower bound
   * that would date a promoter to before they joined, and the earliest `Credit.timestamp` is an upper
   * bound that would date them to after.
   */
  joinedAtBlock: bigint | undefined;
};

export type HistoryCredit = {
  /** `<txHash>-<logIndex>`. The pagination cursor; lexicographic, not chronological. */
  id: string;
  campaign: `0x${string}`;
  kpiIndex: number;
  promoterId: `0x${string}`;
  /** The referred wallet. Distinct users are the card's "referrals brought". */
  user: `0x${string}`;
  /**
   * Raw KPI units, unscaled, as `ProgressCredited` emitted them.
   *
   * **Never sum these across campaigns.** One campaign's amount is a swap count, another's is raw wei,
   * another's a token total awaiting `Kpi.scale` — adding them produces a large meaningless number.
   * Amounts belong on per-campaign rows in their own units.
   */
  amount: bigint;
  timestamp: bigint;
  blockNumber: bigint;
};

export type HistoryPayout = {
  id: string;
  campaign: `0x${string}`;
  kpiIndex: number;
  tier: number;
  /** Released, which is less than the tier's configured reward when the pool ran short. */
  paid: bigint;
  timestamp: bigint;
  blockNumber: bigint;
};

export type HistoryKpi = {
  campaign: `0x${string}`;
  index: number;
  /** `Types.KpiKind` as an int — Mint / Swap / Deposit / Stake / Bridge / …, the specialization badge. */
  kind: number;
  /**
   * True for a campaign-wide KPI no promoter can ever score on: `reportUserAction` reverts
   * `AggregateKpi` before attribution, and `applyAggregateUpdate` moves `_totalProgress` and never
   * `_progress[promoter]`. The card marks these "not creditable" rather than counting them as a miss.
   */
  aggregate: boolean;
  /** Campaign-wide goal. Informational on chain — tiers drive payouts — so never a denominator. */
  target: bigint;
  verifier: `0x${string}`;
  /** Null when the KPI's params are not an event-source blob. Means "nothing observable", not an error. */
  source: `0x${string}` | null;
  topic0: `0x${string}` | null;
};

export type PromoterHistory = {
  wallet: `0x${string}`;
  memberships: HistoryMembership[];
  credits: HistoryCredit[];
  payouts: HistoryPayout[];
  kpis: HistoryKpi[];
  /** A page cap was hit. Counts over these rows are lower bounds; the card must say so. */
  truncated: boolean;
  /** From `_meta`. The card's footer states it so a lagging indexer is visible, not silent. */
  indexedBlock: bigint;
  /** A handler threw while indexing. The rows are incomplete in a way no count can detect. */
  hasIndexingErrors: boolean;
};

// ── documents ────────────────────────────────────────────────────

/**
 * Round trip 1 — memberships, payouts, and how far behind the indexer is.
 *
 * `$wallet` is a `Bytes` filter, so it must be lowercased before it is sent; see `hexLower`. Both
 * collections are ordered by `id` so a full page can be continued with the same cursor the paginator
 * uses.
 */
export const HISTORY_QUERY = `query PromoterHistory($wallet: Bytes!, $first: Int!) {
  promoters(where: {wallet: $wallet}, first: $first, orderBy: id, orderDirection: asc) {
    id
    promoterId
    reputation
    joinedAtBlock
    campaign { id campaignId project token name status createdAt }
  }
  tierPayouts(where: {promoter: $wallet}, first: $first, orderBy: id, orderDirection: asc) {
    id
    kpiIndex
    tier
    paid
    timestamp
    blockNumber
    campaign { id }
  }
  ${META_SELECTION}
}`;

/**
 * Round trip 2 — credited actions and the KPI shapes behind them.
 *
 * `campaign_in` takes `String` rather than `Bytes`: it filters a *relation*, so its values are entity
 * ids. They are lowercased addresses, which is the same string either way, but the declared type has to
 * match or the document fails validation.
 */
export const CREDITS_AND_KPIS_QUERY = `query PromoterCredits($promoterIds: [Bytes!]!, $campaigns: [String!]!, $first: Int!, $cursor: ID!) {
  credits(where: {promoterId_in: $promoterIds, id_gt: $cursor}, first: $first, orderBy: id, orderDirection: asc) {
    id
    kpiIndex
    promoterId
    user
    amount
    timestamp
    blockNumber
    campaign { id }
  }
  kpis(where: {campaign_in: $campaigns}, first: $first, orderBy: id, orderDirection: asc) {
    id
    index
    kind
    aggregate
    target
    verifier
    source
    topic0
    campaign { id }
  }
}`;

/** Continuation of a full `credits` page. Same filter, no `kpis` — those arrived with the first page. */
export const CREDITS_PAGE_QUERY = `query PromoterCreditsPage($promoterIds: [Bytes!]!, $first: Int!, $cursor: ID!) {
  credits(where: {promoterId_in: $promoterIds, id_gt: $cursor}, first: $first, orderBy: id, orderDirection: asc) {
    id
    kpiIndex
    promoterId
    user
    amount
    timestamp
    blockNumber
    campaign { id }
  }
}`;

/** Continuation of a full `tierPayouts` page. */
export const PAYOUTS_PAGE_QUERY = `query PromoterPayoutsPage($wallet: Bytes!, $first: Int!, $cursor: ID!) {
  tierPayouts(where: {promoter: $wallet, id_gt: $cursor}, first: $first, orderBy: id, orderDirection: asc) {
    id
    kpiIndex
    tier
    paid
    timestamp
    blockNumber
    campaign { id }
  }
}`;

// ── decoding ─────────────────────────────────────────────────────

type RawRelation = {id?: unknown} | null | undefined;
type RawRow = Record<string, unknown>;

const asHex = (raw: unknown, fallback = "0x"): `0x${string}` =>
  typeof raw === "string" && raw.startsWith("0x") ? (raw as `0x${string}`) : (fallback as `0x${string}`);

const asOptionalHex = (raw: unknown): `0x${string}` | null =>
  typeof raw === "string" && raw.startsWith("0x") ? (raw as `0x${string}`) : null;

const asInt = (raw: unknown): number => (typeof raw === "number" && Number.isFinite(raw) ? raw : 0);

const relationId = (raw: RawRelation): `0x${string}` => asHex(raw?.id);

/**
 * Decode a campaign.
 *
 * A null `status` maps to `Pending`, which is not a fallback but the correct answer: the constructor
 * sets `Pending` and `StatusChanged` only fires on a transition, so the subgraph has nothing to record
 * until the first one. `statusFromIndex` shares the ordering with `Types.CampaignStatus`.
 */
export function decodeHistoryCampaign(raw: RawRow | null | undefined): HistoryCampaign {
  return {
    address: asHex(raw?.id),
    campaignId: toBigInt(raw?.campaignId),
    project: asHex(raw?.project),
    token: asHex(raw?.token),
    name: typeof raw?.name === "string" ? raw.name : "",
    status: statusFromIndex(typeof raw?.status === "number" ? raw.status : 0),
    createdAt: toBigInt(raw?.createdAt),
  };
}

/**
 * Decode memberships.
 *
 * `reputation` and `joinedAtBlock` are nullable in the schema and stay nullable here rather than
 * collapsing to 0. A promoter who joined an ungated campaign has a genuine reputation of 0, and a row
 * with no join at all has none — reporting both as 0 would erase the distinction the card needs to
 * decide whether it is looking at a membership or an artefact.
 */
export function decodeMemberships(raw: unknown): HistoryMembership[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((row: RawRow) => ({
    campaign: decodeHistoryCampaign(row?.campaign as RawRow),
    promoterId: asHex(row?.promoterId),
    reputationAtJoin: row?.reputation == null ? undefined : toBigInt(row.reputation),
    joinedAtBlock: row?.joinedAtBlock == null ? undefined : toBigInt(row.joinedAtBlock),
  }));
}

export function decodeCredits(raw: unknown): HistoryCredit[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((row: RawRow) => ({
    id: typeof row?.id === "string" ? row.id : "",
    campaign: relationId(row?.campaign as RawRelation),
    kpiIndex: asInt(row?.kpiIndex),
    promoterId: asHex(row?.promoterId),
    user: asHex(row?.user),
    amount: toBigInt(row?.amount),
    timestamp: toBigInt(row?.timestamp),
    blockNumber: toBigInt(row?.blockNumber),
  }));
}

export function decodePayouts(raw: unknown): HistoryPayout[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((row: RawRow) => ({
    id: typeof row?.id === "string" ? row.id : "",
    campaign: relationId(row?.campaign as RawRelation),
    kpiIndex: asInt(row?.kpiIndex),
    tier: asInt(row?.tier),
    paid: toBigInt(row?.paid),
    timestamp: toBigInt(row?.timestamp),
    blockNumber: toBigInt(row?.blockNumber),
  }));
}

export function decodeKpis(raw: unknown): HistoryKpi[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((row: RawRow) => ({
    campaign: relationId(row?.campaign as RawRelation),
    index: asInt(row?.index),
    kind: asInt(row?.kind),
    aggregate: row?.aggregate === true,
    target: toBigInt(row?.target),
    verifier: asHex(row?.verifier),
    source: asOptionalHex(row?.source),
    topic0: asOptionalHex(row?.topic0),
  }));
}

/** Distinct campaign ids across the memberships, lowercased, for the `campaign_in` filter. */
export function campaignIdsOf(memberships: readonly HistoryMembership[]): string[] {
  return [...new Set(memberships.map((m) => hexLower(m.campaign.address)))];
}

/** Distinct promoter ids across the memberships, lowercased, for the `promoterId_in` filter. */
export function promoterIdsOf(memberships: readonly HistoryMembership[]): string[] {
  return [...new Set(memberships.map((m) => hexLower(m.promoterId)))];
}

// ── the read ─────────────────────────────────────────────────────

/**
 * Fetch one wallet's indexed history.
 *
 * Never throws and never returns zeroed rows for a failed read — see the module note. `fetchImpl` is an
 * injection point so the tests exercise the real orchestration (two trips, the skip, the pagination)
 * without a network.
 */
export async function fetchPromoterHistory(input: {
  chainId: number | undefined;
  wallet: string | undefined;
  fetchImpl?: GraphFetch;
  signal?: AbortSignal;
}): Promise<GraphResult<PromoterHistory>> {
  if (!input.wallet || !isAddress(input.wallet, {strict: false})) {
    return graphUnavailable("not-configured", "No wallet to read a history for.");
  }

  const url = subgraphUrl(input.chainId);
  if (!url) {
    // Two causes, one message each, and neither is an error the user can act on by retrying.
    return input.chainId !== undefined && !SUBGRAPH_CHAINS.includes(input.chainId)
      ? graphUnavailable("unsupported-chain", "Campaign history is indexed for Base Sepolia only.")
      : graphUnavailable("not-configured", "No subgraph is configured for this deployment.");
  }

  const wallet = hexLower(input.wallet as `0x${string}`);
  const common = {url, fetchImpl: input.fetchImpl, signal: input.signal};

  const first = await graphRequest({
    ...common,
    query: HISTORY_QUERY,
    variables: {wallet, first: GRAPH_PAGE_SIZE},
    pick: (data) => {
      // `promoters` is the load-bearing field: absent means a shape this build does not understand,
      // whereas an empty array is the ordinary answer for a wallet that has joined nothing.
      if (!Array.isArray(data.promoters)) return undefined;
      return {
        memberships: decodeMemberships(data.promoters),
        payouts: decodePayouts(data.tierPayouts),
        meta: decodeMeta(data._meta as Parameters<typeof decodeMeta>[0]),
      };
    },
  });
  if (first.kind !== "ok") return first;

  const {memberships, meta} = first.data;

  // The payouts arrived with round trip 1; `paginate` continues only if that page came back full.
  const payouts = await paginate<HistoryPayout>(
    async (cursor) =>
      graphRequest({
        ...common,
        query: PAYOUTS_PAGE_QUERY,
        variables: {wallet, first: GRAPH_PAGE_SIZE, cursor},
        pick: (data) => (Array.isArray(data.tierPayouts) ? decodePayouts(data.tierPayouts) : undefined),
      }),
    first.data.payouts,
  );
  if (payouts.kind !== "ok") return payouts;

  // No memberships means no promoterId, and `Credit` is keyed by promoterId — so there is nothing the
  // second trip could find. Sending it anyway would spend a round trip proving an emptiness the first
  // trip already established.
  if (memberships.length === 0) {
    return {
      kind: "ok",
      data: {
        wallet,
        memberships,
        credits: [],
        payouts: payouts.data.rows,
        kpis: [],
        truncated: payouts.data.truncated,
        indexedBlock: meta.indexedBlock,
        hasIndexingErrors: meta.hasIndexingErrors,
      },
    };
  }

  const promoterIds = promoterIdsOf(memberships);
  const campaigns = campaignIdsOf(memberships);

  const second = await graphRequest({
    ...common,
    query: CREDITS_AND_KPIS_QUERY,
    variables: {promoterIds, campaigns, first: GRAPH_PAGE_SIZE, cursor: ""},
    pick: (data) => {
      if (!Array.isArray(data.credits)) return undefined;
      return {
        credits: decodeCredits(data.credits),
        kpis: decodeKpis(data.kpis),
        // A full KPI page is flagged rather than walked: KPIs are bounded by campaigns × KPIs per
        // campaign, so 1,000 already implies a wallet in a hundred campaigns, and a specialization
        // badge is not worth ten more requests. Truncation makes the badges a floor, which they can be.
        kpisPageFull: Array.isArray(data.kpis) ? data.kpis.length >= GRAPH_PAGE_SIZE : false,
      };
    },
  });
  if (second.kind !== "ok") return second;

  const credits = await paginate<HistoryCredit>(
    async (cursor) =>
      graphRequest({
        ...common,
        query: CREDITS_PAGE_QUERY,
        variables: {promoterIds, first: GRAPH_PAGE_SIZE, cursor},
        pick: (data) => (Array.isArray(data.credits) ? decodeCredits(data.credits) : undefined),
      }),
    second.data.credits,
  );
  if (credits.kind !== "ok") return credits;

  return {
    kind: "ok",
    data: {
      wallet,
      memberships,
      credits: credits.data.rows,
      payouts: payouts.data.rows,
      kpis: second.data.kpis,
      truncated: credits.data.truncated || payouts.data.truncated || second.data.kpisPageFull,
      indexedBlock: meta.indexedBlock,
      hasIndexingErrors: meta.hasIndexingErrors,
    },
  };
}
