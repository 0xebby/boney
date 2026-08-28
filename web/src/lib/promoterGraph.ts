import {GRAPH_PAGE_SIZE, graphRequest, hexLower, paginate, toBigInt} from "./graph";
import type {GraphFetch, GraphResult, Paged} from "./graph";
import type {PromoterEntry} from "./promoters";

/**
 * Promoter discovery via the subgraph.
 *
 * The log scan in `promoters.ts` covers `MAX_WINDOWS * MAX_LOG_RANGE` blocks and clamps to the newest
 * span, so on a chain much older than that window a promoter who joined earlier is absent from the
 * directory while every point lookup still finds them. The subgraph indexes `PromoterJoined` from the
 * campaign's first block, so this source has no block floor.
 *
 * Pure apart from the injected fetch: the query text, the decode and the shaping are all testable by
 * fixture, and `useCampaignPromoters` owns the react-query wiring and the fallback.
 */

/** One `Promoter` row as the subgraph returns it. */
export type RawPromoter = {
  id?: unknown;
  promoterId?: unknown;
  wallet?: unknown;
  reputation?: unknown;
  joinedAtBlock?: unknown;
  campaign?: {id?: unknown} | null;
};

/**
 * The document. Filtered to the campaigns on screen and ordered by `id` for the cursor walk.
 *
 * `wallet_not: null` drops rows created by `PromoterRegistered` alone. That event carries only the
 * promoter id, so the row exists before `PromoterJoined` fills the wallet in, and a directory cannot
 * render a member it has no address for.
 */
export const PROMOTERS_QUERY = `
query BoneyPromoters($campaigns: [String!]!, $cursor: String!, $first: Int!) {
  promoters(
    where: {campaign_in: $campaigns, wallet_not: null, id_gt: $cursor}
    orderBy: id
    orderDirection: asc
    first: $first
  ) {
    id
    promoterId
    wallet
    reputation
    joinedAtBlock
    campaign { id }
  }
}`;

/**
 * Turns a raw row into a `PromoterEntry`, or `undefined` when it cannot be rendered.
 *
 * A row missing its campaign, wallet or promoter id is dropped rather than shown with holes, matching
 * how the log path drops a log without its indexed args.
 *
 * @param raw One `promoters` row from the subgraph.
 * @returns The decoded entry, or `undefined` when a required field is absent.
 */
export function decodePromoter(raw: RawPromoter): PromoterEntry | undefined {
  const campaign = typeof raw.campaign?.id === "string" ? raw.campaign.id : undefined;
  const wallet = typeof raw.wallet === "string" ? raw.wallet : undefined;
  const promoterId = typeof raw.promoterId === "string" ? raw.promoterId : undefined;
  if (!campaign || !wallet || !promoterId) return undefined;

  return {
    campaign: hexLower(campaign as `0x${string}`),
    promoter: hexLower(wallet as `0x${string}`),
    promoterId: promoterId as `0x${string}`,
    reputation: toBigInt(raw.reputation),
    blockNumber: toBigInt(raw.joinedAtBlock),
  };
}

/** A row carrying the `id` `paginate` cursors on, alongside the decoded entry. */
type CursoredPromoter = {id: string; entry: PromoterEntry | undefined};

/**
 * Every promoter who joined one of `campaigns`, from the subgraph.
 *
 * @param input.url Subgraph endpoint, from `subgraphUrl`.
 * @param input.campaigns Campaign addresses to filter to; lowercased here, since subgraph ids are.
 * @param input.fetchImpl Injected fetch, for tests.
 * @param input.signal Abort signal propagated to each page.
 * @returns Entries plus `truncated` when the page cap was hit, or an unavailable result.
 */
export async function fetchPromotersFromGraph(input: {
  url: string;
  campaigns: readonly `0x${string}`[];
  fetchImpl?: GraphFetch;
  signal?: AbortSignal;
}): Promise<GraphResult<Paged<CursoredPromoter>>> {
  const campaigns = input.campaigns.map((address) => hexLower(address));

  return paginate<CursoredPromoter>((cursor) =>
    graphRequest<CursoredPromoter[]>({
      url: input.url,
      query: PROMOTERS_QUERY,
      variables: {campaigns, cursor, first: GRAPH_PAGE_SIZE},
      fetchImpl: input.fetchImpl,
      signal: input.signal,
      pick: (data) => {
        const rows = data.promoters;
        if (!Array.isArray(rows)) return undefined;
        return rows.map((row) => {
          const raw = row as RawPromoter;
          return {id: typeof raw.id === "string" ? raw.id : "", entry: decodePromoter(raw)};
        });
      },
    }),
  );
}

/**
 * The decoded entries from a paginated result, with undecodable rows dropped.
 *
 * @param paged The result of `fetchPromotersFromGraph`.
 * @returns Renderable entries in the order the subgraph returned them.
 */
export function promoterEntries(paged: Paged<CursoredPromoter>): PromoterEntry[] {
  return paged.rows.flatMap((row) => (row.entry ? [row.entry] : []));
}
