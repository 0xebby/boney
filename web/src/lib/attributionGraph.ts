import {GRAPH_PAGE_SIZE, graphRequest, hexLower, paginate, toBigInt} from "./graph";
import type {GraphFetch, GraphResult, Paged} from "./graph";
import type {AttributionEntry} from "./attributions";

/**
 * Attribution discovery via the subgraph.
 *
 * The `Touch` entity is keyed `<campaign>-<user>` and overwritten by any strictly newer `signedAt`,
 * so a row is the live attribution rather than a history — the same fact `touchOf` returns, for
 * every referral at once and with no block floor.
 *
 * Pure apart from the injected fetch; `useCampaignAttributions` owns the react-query wiring and the
 * log fallback.
 */

/** One `Touch` row as the subgraph returns it. */
export type RawTouch = {
  id?: unknown;
  user?: unknown;
  promoterId?: unknown;
  signedAt?: unknown;
  expiresAt?: unknown;
  blockNumber?: unknown;
  campaign?: {id?: unknown} | null;
};

/** The document. Filtered to the campaigns on screen and ordered by `id` for the cursor walk. */
export const TOUCHES_QUERY = `
query BoneyTouches($campaigns: [String!]!, $cursor: String!, $first: Int!) {
  touches(
    where: {campaign_in: $campaigns, id_gt: $cursor}
    orderBy: id
    orderDirection: asc
    first: $first
  ) {
    id
    user
    promoterId
    signedAt
    expiresAt
    blockNumber
    campaign { id }
  }
}`;

/**
 * Turns a raw row into an `AttributionEntry`, or `undefined` when it cannot be rendered.
 *
 * A row missing its campaign, referral or promoter id is dropped, matching how the log path drops a
 * log without its indexed args.
 *
 * @param raw One `touches` row from the subgraph.
 * @returns The decoded entry, or `undefined` when a required field is absent.
 */
export function decodeTouch(raw: RawTouch): AttributionEntry | undefined {
  const campaign = typeof raw.campaign?.id === "string" ? raw.campaign.id : undefined;
  const referral = typeof raw.user === "string" ? raw.user : undefined;
  const promoterId = typeof raw.promoterId === "string" ? raw.promoterId : undefined;
  if (!campaign || !referral || !promoterId) return undefined;

  return {
    campaign: hexLower(campaign as `0x${string}`),
    referral: hexLower(referral as `0x${string}`),
    promoterId: promoterId as `0x${string}`,
    signedAt: toBigInt(raw.signedAt),
    expiresAt: toBigInt(raw.expiresAt),
    blockNumber: toBigInt(raw.blockNumber),
  };
}

/** A row carrying the `id` `paginate` cursors on, alongside the decoded entry. */
type CursoredTouch = {id: string; entry: AttributionEntry | undefined};

/**
 * Every live attribution on one of `campaigns`, from the subgraph.
 *
 * @param input.url Subgraph endpoint, from `subgraphUrl`.
 * @param input.campaigns Campaign addresses to filter to; lowercased here, since subgraph ids are.
 * @param input.fetchImpl Injected fetch, for tests.
 * @param input.signal Abort signal propagated to each page.
 * @returns Entries plus `truncated` when the page cap was hit, or an unavailable result.
 */
export async function fetchTouchesFromGraph(input: {
  url: string;
  campaigns: readonly `0x${string}`[];
  fetchImpl?: GraphFetch;
  signal?: AbortSignal;
}): Promise<GraphResult<Paged<CursoredTouch>>> {
  const campaigns = input.campaigns.map((address) => hexLower(address));

  return paginate<CursoredTouch>((cursor) =>
    graphRequest<CursoredTouch[]>({
      url: input.url,
      query: TOUCHES_QUERY,
      variables: {campaigns, cursor, first: GRAPH_PAGE_SIZE},
      fetchImpl: input.fetchImpl,
      signal: input.signal,
      pick: (data) => {
        const rows = data.touches;
        if (!Array.isArray(rows)) return undefined;
        return rows.map((row) => {
          const raw = row as RawTouch;
          return {id: typeof raw.id === "string" ? raw.id : "", entry: decodeTouch(raw)};
        });
      },
    }),
  );
}

/**
 * The decoded entries from a paginated result, with undecodable rows dropped.
 *
 * @param paged The result of `fetchTouchesFromGraph`.
 * @returns Renderable entries in the order the subgraph returned them.
 */
export function touchEntries(paged: Paged<CursoredTouch>): AttributionEntry[] {
  return paged.rows.flatMap((row) => (row.entry ? [row.entry] : []));
}
