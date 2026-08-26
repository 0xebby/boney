import {baseSepolia} from "./chains";

/**
 * The subgraph transport — a typed POST to `boney-indexer`, and the rules for when its answer may be
 * believed.
 *
 * First subgraph reader in the web app; `boneyMd/spec/09-offchain.md` records that the app "does not
 * read the subgraph today", and this file is what stops that being true.
 *
 * ## Why the app needs one at all
 *
 * A campaign stores no promoter list and `Campaign` exposes only point lookups, so `promoters.ts`
 * rebuilds membership from `PromoterJoined` logs — bounded by `MAX_WINDOWS` × `MAX_LOG_RANGE`, which
 * is 45,600 blocks, about 25 hours of Base. That is fine for "who is promoting this campaign now" and
 * useless for accumulated history, which is the half of the BoneyCard that has to reach back to a
 * promoter's first campaign.
 *
 * ## The one rule this module exists to enforce
 *
 * **A failed or partial read is never a zero.** Every count the card derives from this data is a
 * statement about a person — "0 campaigns, 0 tiers, 0 referrals" is not a neutral default, it is a
 * claim, and a fetch that did not complete has not earned the right to make one. So nothing here
 * returns an empty array on failure: `GraphResult` is a two-armed union and the caller cannot reach
 * the rows without first handling `unavailable`.
 *
 * That is also why a GraphQL response carrying **both** `data` and `errors` is treated as a failure
 * rather than as partial success. graph-node will happily return a filled `data` alongside an error
 * on one field, and folding that into counts yields numbers that are quietly too low — which is
 * strictly worse than saying "history unavailable", because it is wrong and looks right.
 *
 * Pure and React-free apart from `graphRequest`'s single `fetch`, which takes its implementation as
 * an argument so the tests need no network (decision F6).
 */

/**
 * Chains with a deployed subgraph.
 *
 * Base Sepolia only. This matters more than it looks: `wagmi.ts` lists anvil first, so a browser with
 * no wallet connected reads chain 31337, and a local fixture has no indexer behind it. Without this
 * check the card would report "history unavailable — network error" on anvil forever; with it, the
 * reason is `unsupported-chain` and the copy can say so.
 */
export const SUBGRAPH_CHAINS: readonly number[] = [baseSepolia.id];

/**
 * The Studio query endpoint.
 *
 * Studio URLs are per-account and per-deployment, so there is no sensible default to hard-code and a
 * wrong one would look exactly like an outage. Unset is therefore a first-class state
 * (`not-configured`), distinct from every failure — the card can then say "history is not wired up on
 * this deployment" rather than blaming a service that was never called.
 *
 * The endpoint needs no API key (`boneyMd/spec/09-offchain.md`), which is why it can be a
 * `NEXT_PUBLIC_` variable and be read from the browser at all.
 */
export function subgraphUrl(chainId: number | undefined): string | undefined {
  if (chainId === undefined || !SUBGRAPH_CHAINS.includes(chainId)) return undefined;
  const url = process.env.NEXT_PUBLIC_SUBGRAPH_URL?.trim();
  return url ? url : undefined;
}

/**
 * Why the subgraph could not be believed.
 *
 * Separated by cause because the copy differs and one of them is not an error at all:
 *
 *  - `not-configured` — no `NEXT_PUBLIC_SUBGRAPH_URL`. Nothing was attempted.
 *  - `unsupported-chain` — anvil, or any chain with no deployment. Also not an error.
 *  - `network` — `fetch` threw. Offline, DNS, CORS, aborted.
 *  - `http` — a non-2xx. Studio returns 401/429 here, which are worth distinguishing in a log.
 *  - `graphql` — 200 with `errors`, including the partial-data case.
 *  - `malformed` — 200, no `errors`, and `data` is not the shape asked for. A schema drift.
 */
export type GraphUnavailableReason =
  | "not-configured"
  | "unsupported-chain"
  | "network"
  | "http"
  | "graphql"
  | "malformed";

export type GraphUnavailable = {
  kind: "unavailable";
  reason: GraphUnavailableReason;
  /** Human-readable, safe to render. */
  message: string;
};

export type GraphOk<T> = {kind: "ok"; data: T};

export type GraphResult<T> = GraphOk<T> | GraphUnavailable;

export function graphUnavailable(
  reason: GraphUnavailableReason,
  message: string,
): GraphUnavailable {
  return {kind: "unavailable", reason, message};
}

/**
 * `_meta`, the subgraph's own account of how far behind it is.
 *
 * Only `block.number` and `hasIndexingErrors` are selected. `_Block_.timestamp` exists on current
 * graph-node but a field the deployment does not have fails *validation*, taking the whole document
 * with it — and the block number is all a lag figure needs, so the extra field would be risk for
 * nothing.
 *
 * `hasIndexingErrors` is surfaced rather than ignored because it means some handler threw and the
 * data behind it is incomplete in a way no count can detect. The card treats it the same way it
 * treats truncation: the numbers are lower bounds and must be labelled as such.
 */
export type GraphMeta = {
  indexedBlock: bigint;
  hasIndexingErrors: boolean;
};

export const META_SELECTION = "_meta { block { number } hasIndexingErrors }";

type RawMeta = {block?: {number?: number | string} | null; hasIndexingErrors?: boolean} | null;

export function decodeMeta(raw: RawMeta): GraphMeta {
  return {
    indexedBlock: toBigInt(raw?.block?.number),
    hasIndexingErrors: raw?.hasIndexingErrors === true,
  };
}

/**
 * How far behind the chain the subgraph is, in blocks.
 *
 * Clamped at zero rather than allowed to go negative. The two numbers come from different sources —
 * `_meta` from graph-node, the head from an RPC — and on Base, where blocks are two seconds apart, an
 * indexer that is genuinely current routinely reports one block *ahead* of a cached `eth_blockNumber`.
 * Rendering "-1 blocks behind" for the healthy case would be an odd way to describe it.
 */
export function graphLag(indexedBlock: bigint, chainHead: bigint | undefined): bigint | undefined {
  if (chainHead === undefined) return undefined;
  const lag = chainHead - indexedBlock;
  return lag > BigInt(0) ? lag : BigInt(0);
}

/**
 * Parse a subgraph scalar into a bigint.
 *
 * The Graph serialises `BigInt` as a JSON **string** — `"1000000000000000000"`, not a number — because
 * the values routinely exceed `Number.MAX_SAFE_INTEGER`. So every amount, block number and timestamp
 * arrives as text and has to be parsed, and a decoder that forgot would produce `NaN` or, worse, a
 * silently rounded 18-decimal token amount.
 *
 * Anything unparseable becomes 0. That is safe *here* and only here: this is a field-level default
 * inside a response that already succeeded, not a stand-in for a failed request — the failure case is
 * `GraphResult.unavailable`, several levels up, and it is the one the card renders.
 */
export function toBigInt(raw: unknown): bigint {
  if (typeof raw === "bigint") return raw;
  if (typeof raw === "number") return Number.isFinite(raw) ? BigInt(Math.trunc(raw)) : BigInt(0);
  if (typeof raw === "string" && raw.trim() !== "") {
    try {
      return BigInt(raw.trim());
    } catch {
      return BigInt(0);
    }
  }
  return BigInt(0);
}

/**
 * Lowercase a hex value for a `Bytes` filter.
 *
 * The single most dangerous line in this module. graph-node compares `Bytes` byte-wise, so a
 * checksummed address in a `where` clause matches **nothing** — and it fails by returning an empty
 * list, not an error. A card built on that reads "0 campaigns" for a promoter with twenty, and every
 * layer above would be working correctly.
 *
 * Every address reaching a filter goes through here. Wallets arrive checksummed from wagmi
 * (`useAccount().address`), so this is not a hypothetical.
 */
export function hexLower<T extends string>(value: T): Lowercase<T> {
  return value.toLowerCase() as Lowercase<T>;
}

/** The subset of `fetch` this module uses, so a test can pass a function instead of a server. */
export type GraphFetch = (
  url: string,
  init: {method: string; headers: Record<string, string>; body: string; signal?: AbortSignal},
) => Promise<{ok: boolean; status: number; json: () => Promise<unknown>}>;

/**
 * Fold an HTTP status and a parsed GraphQL body into a result.
 *
 * Pure and separate from the fetch because this is where the judgement lives: which shapes count as
 * an answer, and which are failures wearing a 200. Testable without a server, which is the point.
 *
 * `pick` pulls the caller's shape out of `data`, returning `undefined` if the payload is not what was
 * asked for. That distinguishes a schema drift (`malformed`) from a legitimately empty result — an
 * empty `promoters` array is a *fact* about a wallet that has joined nothing, and must not be reported
 * as a failure.
 */
export function classifyGraphBody<T>(
  status: number,
  body: unknown,
  pick: (data: Record<string, unknown>) => T | undefined,
): GraphResult<T> {
  if (status < 200 || status >= 300) {
    return graphUnavailable(
      "http",
      status === 429
        ? "The subgraph is rate-limiting requests. History will be back shortly."
        : `The subgraph returned HTTP ${status}.`,
    );
  }

  const envelope = body as {data?: unknown; errors?: unknown} | null;

  // Checked before `data`, deliberately. graph-node returns a populated `data` alongside a
  // field-level error, and folding that into counts produces figures that are quietly too low.
  const errors = envelope?.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const first = errors[0] as {message?: unknown} | null;
    const detail = typeof first?.message === "string" ? first.message : "unspecified error";
    return graphUnavailable("graphql", `The subgraph rejected the query: ${detail}`);
  }

  const data = envelope?.data;
  if (!data || typeof data !== "object") {
    return graphUnavailable("malformed", "The subgraph returned no data.");
  }

  const picked = pick(data as Record<string, unknown>);
  if (picked === undefined) {
    return graphUnavailable(
      "malformed",
      "The subgraph returned a payload this build does not understand.",
    );
  }

  return {kind: "ok", data: picked};
}

/**
 * POST one GraphQL document.
 *
 * Never throws. A transport that threw would push the fail-soft rule out to every call site, and the
 * one place it must not be forgotten is the one where a thrown error would be caught by react-query
 * and rendered as an empty card.
 */
export async function graphRequest<T>(input: {
  url: string;
  query: string;
  variables?: Record<string, unknown>;
  pick: (data: Record<string, unknown>) => T | undefined;
  fetchImpl?: GraphFetch;
  signal?: AbortSignal;
}): Promise<GraphResult<T>> {
  const doFetch = input.fetchImpl ?? (globalThis.fetch as unknown as GraphFetch | undefined);
  if (!doFetch) {
    return graphUnavailable("network", "No fetch implementation is available.");
  }

  let status: number;
  let body: unknown;
  try {
    const response = await doFetch(input.url, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({query: input.query, variables: input.variables ?? {}}),
      signal: input.signal,
    });
    status = response.status;
    try {
      body = await response.json();
    } catch {
      // A 502 from a gateway is HTML, not JSON. Classified by status below; `body` stays null so a
      // 200 with an unreadable body lands on `malformed`.
      body = null;
    }
  } catch (error) {
    return graphUnavailable(
      "network",
      error instanceof Error && error.name === "AbortError"
        ? "The history request was cancelled."
        : "Could not reach the subgraph.",
    );
  }

  return classifyGraphBody(status, body, input.pick);
}

/**
 * Rows per page.
 *
 * 1,000 is graph-node's hard ceiling on `first`; asking for more is an error, not a larger page.
 */
export const GRAPH_PAGE_SIZE = 1000;

/**
 * Pages per collection.
 *
 * A cap rather than an unbounded loop, for the same reason `promoters.ts` caps its log windows: this
 * runs in a browser against a shared endpoint, and one wallet's card must not be able to fire a
 * hundred requests. 10 pages is 10,000 rows, far past any real promoter, and hitting it sets
 * `truncated` so the counts are labelled as lower bounds rather than presented as totals.
 */
export const GRAPH_MAX_PAGES = 10;

export type Paged<T> = {
  rows: T[];
  /** A page cap was hit. Every count derived from `rows` is a floor, not a total. */
  truncated: boolean;
};

/**
 * Walk a collection with an `id_gt` cursor.
 *
 * Cursored rather than `skip`-based because graph-node caps `skip` at 5,000 and because a cursor is
 * stable against rows arriving mid-walk. It orders by `id`, which for `Credit` and `TierPayout` is
 * `<txHash>-<logIndex>` — lexicographic, so **not** chronological. That is fine for pagination, which
 * needs only a total order, but it means anything time-ordered (the milestone list, "promoting since")
 * has to sort on `timestamp` after the fact and must not lean on arrival order.
 *
 * `seed` is a first page already in hand. It exists so a collection can ride along in a combined
 * document — the history read asks for memberships, payouts and `_meta` in one POST — and then only
 * pay for further requests if that page came back full. For every realistic promoter the seed *is* the
 * whole collection and this function makes no request at all.
 */
export async function paginate<T extends {id: string}>(
  fetchPage: (cursor: string) => Promise<GraphResult<T[]>>,
  seed?: readonly T[],
): Promise<GraphResult<Paged<T>>> {
  const rows: T[] = [];
  let cursor = "";
  // The seed counts against the page budget: it is a page that was already fetched.
  let budget = GRAPH_MAX_PAGES;

  if (seed) {
    rows.push(...seed);
    budget -= 1;
    if (seed.length < GRAPH_PAGE_SIZE) return {kind: "ok", data: {rows, truncated: false}};
    const last = seed[seed.length - 1];
    if (!last?.id) return {kind: "ok", data: {rows, truncated: true}};
    cursor = last.id;
  }

  for (let page = 0; page < budget; page += 1) {
    const result = await fetchPage(cursor);
    if (result.kind !== "ok") return result;

    rows.push(...result.data);

    // A short page is the last page. Only a full one can have more behind it.
    if (result.data.length < GRAPH_PAGE_SIZE) {
      return {kind: "ok", data: {rows, truncated: false}};
    }

    const last = result.data[result.data.length - 1];
    // Defensive: without a cursor to advance past, another request would re-read the same page
    // forever. Report what was read and flag it rather than looping.
    if (!last?.id) return {kind: "ok", data: {rows, truncated: true}};
    cursor = last.id;
  }

  return {kind: "ok", data: {rows, truncated: true}};
}
