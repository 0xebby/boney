import {describe, it, expect, beforeEach, afterEach} from "vitest";
import {
  campaignIdsOf,
  decodeCredits,
  decodeHistoryCampaign,
  decodeKpis,
  decodeMemberships,
  decodePayouts,
  fetchPromoterHistory,
  promoterIdsOf,
  CREDITS_AND_KPIS_QUERY,
  HISTORY_QUERY,
} from "./boneyHistory";
import {GRAPH_PAGE_SIZE, type GraphFetch} from "./graph";

/**
 * Promoter history tests.
 *
 * Three things are load-bearing and the rest is decode:
 *
 *  1. **The wallet reaches the filter lowercased.** graph-node compares `Bytes` byte-wise, so a
 *     checksummed address returns an empty list with no error — the card would read "0 campaigns" for
 *     a promoter with twenty and every layer above it would be working correctly.
 *  2. **A wallet with no memberships costs one round trip, not two,** and comes back `ok` and empty
 *     rather than `unavailable`. Joining nothing is a fact; failing to ask is not.
 *  3. **A failure on the second trip wins over the first trip's rows.** There is real data in hand at
 *     that point, and returning it would hand the card a confident, wrong, lower number.
 */

const WALLET_CHECKSUMMED = "0x2755A4A19B9B4D3b1e9Bd1cDe3b5DB2a0f9adcc2";
const WALLET = WALLET_CHECKSUMMED.toLowerCase();
const BASE_SEPOLIA = 84532;
const ANVIL = 31337;
const URL = "https://api.studio.thegraph.com/query/0/boney-indexer/version/latest";

const CAMPAIGN_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CAMPAIGN_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const PROMOTER_ID_A = `0x${"11".repeat(32)}`;
const PROMOTER_ID_B = `0x${"22".repeat(32)}`;

/** A `Campaign` selection as graph-node serialises it: BigInt as string, Int as number. */
const rawCampaign = (address: string, over: Record<string, unknown> = {}) => ({
  id: address,
  campaignId: "7",
  project: "0xcccccccccccccccccccccccccccccccccccccccc",
  token: "0xdddddddddddddddddddddddddddddddddddddddd",
  name: "SeedFive One",
  status: 1,
  createdAt: "1787000000",
  ...over,
});

const rawPromoter = (address: string, promoterId: string, over: Record<string, unknown> = {}) => ({
  id: `${address}-${promoterId}`,
  promoterId,
  reputation: "19494",
  joinedAtBlock: "45856700",
  campaign: rawCampaign(address),
  ...over,
});

const rawCredit = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  kpiIndex: 0,
  promoterId: PROMOTER_ID_A,
  user: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  amount: "1000000000000000000",
  timestamp: "1787000100",
  blockNumber: "45856800",
  campaign: {id: CAMPAIGN_A},
  ...over,
});

const rawPayout = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  kpiIndex: 0,
  tier: 2,
  paid: "27000000000000000000000",
  timestamp: "1787000200",
  blockNumber: "45856900",
  campaign: {id: CAMPAIGN_A},
  ...over,
});

const META = {block: {number: 45857000}, hasIndexingErrors: false};

type Call = {query: string; variables: Record<string, unknown>};

/**
 * A `fetch` that answers from a script.
 *
 * Deliberately drives the real `fetchPromoterHistory` rather than stubbing the orchestration, because
 * the orchestration — which trip carries which field, when the second is skipped, how the cursor
 * advances — is the thing worth testing.
 */
function stubGraph(responses: Array<{status?: number; body: unknown}>) {
  const calls: Call[] = [];
  let next = 0;

  const fetchImpl: GraphFetch = async (_url, init) => {
    const parsed = JSON.parse(init.body) as {query: string; variables: Record<string, unknown>};
    calls.push({query: parsed.query, variables: parsed.variables});
    const response = responses[next] ?? {status: 500, body: {}};
    next += 1;
    return {
      ok: (response.status ?? 200) < 400,
      status: response.status ?? 200,
      json: async () => response.body,
    };
  };

  return {fetchImpl, calls};
}

const read = (responses: Array<{status?: number; body: unknown}>, over: Record<string, unknown> = {}) => {
  const stub = stubGraph(responses);
  return {
    stub,
    result: fetchPromoterHistory({
      chainId: BASE_SEPOLIA,
      wallet: WALLET_CHECKSUMMED,
      fetchImpl: stub.fetchImpl,
      ...over,
    }),
  };
};

// `NEXT_PUBLIC_` variables are inlined at build time in a browser bundle, but under vitest's node
// environment `subgraphUrl` reads the live `process.env`, so a test can set one.
const previousUrl = process.env.NEXT_PUBLIC_SUBGRAPH_URL;
beforeEach(() => {
  process.env.NEXT_PUBLIC_SUBGRAPH_URL = URL;
});
afterEach(() => {
  if (previousUrl === undefined) delete process.env.NEXT_PUBLIC_SUBGRAPH_URL;
  else process.env.NEXT_PUBLIC_SUBGRAPH_URL = previousUrl;
});

describe("fetchPromoterHistory — preconditions", () => {
  it("refuses a missing or malformed wallet without touching the network", async () => {
    for (const wallet of [undefined, "", "not-an-address", "0x1234"]) {
      const stub = stubGraph([]);
      const result = await fetchPromoterHistory({
        chainId: BASE_SEPOLIA,
        wallet,
        fetchImpl: stub.fetchImpl,
      });
      expect(result.kind, String(wallet)).toBe("unavailable");
      expect(stub.calls).toHaveLength(0);
    }
  });

  it("blames the chain on anvil, not the configuration", async () => {
    // `wagmi.ts` lists anvil first, so a browser with no wallet connected reads 31337 — and a local
    // fixture has no indexer behind it. Without this the card would report a network error forever.
    const stub = stubGraph([]);
    const result = await fetchPromoterHistory({
      chainId: ANVIL,
      wallet: WALLET,
      fetchImpl: stub.fetchImpl,
    });

    expect(result).toMatchObject({kind: "unavailable", reason: "unsupported-chain"});
    if (result.kind !== "unavailable") return;
    expect(result.message).toMatch(/Base Sepolia only/);
    expect(stub.calls).toHaveLength(0);
  });

  it("reports an unset URL as not-configured rather than as an outage", async () => {
    delete process.env.NEXT_PUBLIC_SUBGRAPH_URL;
    const {result} = read([]);
    expect(await result).toMatchObject({kind: "unavailable", reason: "not-configured"});
  });
});

describe("fetchPromoterHistory — the two round trips", () => {
  const fullRead = () =>
    read([
      {body: {data: {promoters: [rawPromoter(CAMPAIGN_A, PROMOTER_ID_A)], tierPayouts: [rawPayout("tx-1")], _meta: META}}},
      {body: {data: {credits: [rawCredit("tx-2")], kpis: [{id: `${CAMPAIGN_A}-0`, index: 0, kind: 1, aggregate: false, target: "500", verifier: "0xa0eee1757a1a01d987b0c638c6703e0ba83baa69", source: null, topic0: null, campaign: {id: CAMPAIGN_A}}]}}},
    ]);

  it("sends the wallet lowercased", async () => {
    // The silent-failure guard, and the reason this test exists at all: a checksummed Bytes filter
    // returns an empty list with no error.
    const {stub, result} = fullRead();
    await result;

    expect(stub.calls[0].variables.wallet).toBe(WALLET);
    expect(stub.calls[0].variables.wallet).not.toBe(WALLET_CHECKSUMMED);
  });

  it("asks for memberships, payouts and _meta in one document", async () => {
    const {stub, result} = fullRead();
    await result;

    expect(stub.calls[0].query).toBe(HISTORY_QUERY);
    expect(stub.calls[0].query).toContain("promoters(where: {wallet: $wallet}");
    // `TierPayout.promoter` is the wallet, not the per-campaign id, so payouts need nothing from the
    // hop and ride along in the first trip.
    expect(stub.calls[0].query).toContain("tierPayouts(where: {promoter: $wallet}");
    expect(stub.calls[0].query).toContain("_meta");
  });

  it("carries the promoter ids and campaigns from the first trip into the second", async () => {
    const {stub, result} = fullRead();
    await result;

    expect(stub.calls).toHaveLength(2);
    expect(stub.calls[1].query).toBe(CREDITS_AND_KPIS_QUERY);
    expect(stub.calls[1].variables.promoterIds).toEqual([PROMOTER_ID_A]);
    expect(stub.calls[1].variables.campaigns).toEqual([CAMPAIGN_A]);
  });

  it("decodes the whole payload, strings and all", async () => {
    const {result} = fullRead();
    const history = await result;

    expect(history.kind).toBe("ok");
    if (history.kind !== "ok") return;
    expect(history.data.memberships).toHaveLength(1);
    expect(history.data.memberships[0].reputationAtJoin).toBe(BigInt(19494));
    expect(history.data.credits[0].amount).toBe(BigInt("1000000000000000000"));
    expect(history.data.payouts[0].paid).toBe(BigInt("27000000000000000000000"));
    expect(history.data.kpis[0].target).toBe(BigInt(500));
    expect(history.data.indexedBlock).toBe(BigInt(45857000));
    expect(history.data.truncated).toBe(false);
    expect(history.data.hasIndexingErrors).toBe(false);
  });

  it("deduplicates the campaign filter when a wallet holds two ids in one campaign", async () => {
    // A wallet has one id per campaign, so this is defensive rather than expected — but a duplicated
    // `campaign_in` entry is a wasted comparison on every row, and the dedupe is one Set.
    const {stub, result} = read([
      {
        body: {
          data: {
            promoters: [
              rawPromoter(CAMPAIGN_A, PROMOTER_ID_A),
              rawPromoter(CAMPAIGN_A, PROMOTER_ID_B),
              rawPromoter(CAMPAIGN_B, PROMOTER_ID_B),
            ],
            tierPayouts: [],
            _meta: META,
          },
        },
      },
      {body: {data: {credits: [], kpis: []}}},
    ]);
    await result;

    expect(stub.calls[1].variables.campaigns).toEqual([CAMPAIGN_A, CAMPAIGN_B]);
    expect(stub.calls[1].variables.promoterIds).toEqual([PROMOTER_ID_A, PROMOTER_ID_B]);
  });
});

describe("fetchPromoterHistory — the empty and failing cases", () => {
  it("skips the second trip entirely for a wallet that has joined nothing", async () => {
    // `Credit` is keyed by promoterId, so with no memberships there is nothing the second trip could
    // find. Sending it would spend a round trip proving an emptiness already established.
    const {stub, result} = read([
      {body: {data: {promoters: [], tierPayouts: [], _meta: META}}},
    ]);
    const history = await result;

    expect(stub.calls).toHaveLength(1);
    expect(history.kind).toBe("ok");
    if (history.kind !== "ok") return;
    expect(history.data.memberships).toEqual([]);
    expect(history.data.credits).toEqual([]);
    expect(history.data.kpis).toEqual([]);
    // Still reports how far the indexer has got: an empty history is only trustworthy if the reader
    // can see the subgraph is current.
    expect(history.data.indexedBlock).toBe(BigInt(45857000));
  });

  it("returns unavailable — not an empty history — when the first trip fails", async () => {
    const {result} = read([{status: 502, body: "<html>bad gateway</html>"}]);
    const history = await result;

    expect(history).toMatchObject({kind: "unavailable", reason: "http"});
  });

  it("lets a second-trip failure win over the first trip's real rows", async () => {
    // The dangerous one. Memberships and payouts are in hand, so returning them with `credits: []`
    // would render "2 campaigns, 0 actions verified" — a specific, wrong claim about a promoter who
    // may have thousands.
    const {result} = read([
      {body: {data: {promoters: [rawPromoter(CAMPAIGN_A, PROMOTER_ID_A)], tierPayouts: [], _meta: META}}},
      {body: {errors: [{message: "query timed out"}]}},
    ]);
    const history = await result;

    expect(history).toMatchObject({kind: "unavailable", reason: "graphql"});
  });

  it("rejects a first trip missing `promoters` as a schema drift", async () => {
    const {result} = read([{body: {data: {tierPayouts: [], _meta: META}}}]);
    expect(await result).toMatchObject({kind: "unavailable", reason: "malformed"});
  });

  it("flags truncation when a credits page comes back full", async () => {
    const page = Array.from({length: GRAPH_PAGE_SIZE}, (_, i) =>
      rawCredit(`tx-${String(i).padStart(5, "0")}`),
    );
    const {result} = read([
      {body: {data: {promoters: [rawPromoter(CAMPAIGN_A, PROMOTER_ID_A)], tierPayouts: [], _meta: META}}},
      {body: {data: {credits: page, kpis: []}}},
      {body: {data: {credits: [rawCredit("tx-99999")]}}},
    ]);
    const history = await result;

    expect(history.kind).toBe("ok");
    if (history.kind !== "ok") return;
    expect(history.data.credits).toHaveLength(GRAPH_PAGE_SIZE + 1);
    // Walked to the end, so not truncated — the flag is about hitting the page *cap*, not about
    // having paginated at all.
    expect(history.data.truncated).toBe(false);
  });

  it("carries hasIndexingErrors through, because no count can detect it", async () => {
    const {result} = read([
      {
        body: {
          data: {
            promoters: [],
            tierPayouts: [],
            _meta: {block: {number: 1}, hasIndexingErrors: true},
          },
        },
      },
    ]);
    const history = await result;

    expect(history.kind).toBe("ok");
    if (history.kind !== "ok") return;
    expect(history.data.hasIndexingErrors).toBe(true);
  });
});

describe("decoders", () => {
  it("maps a null campaign status to Pending, which is what the chain says", async () => {
    // `Campaign.status` is absent until the first `StatusChanged`, and the constructor sets Pending
    // (`Campaign.sol:203`) — so null is the correct answer, not a fallback.
    expect(decodeHistoryCampaign(rawCampaign(CAMPAIGN_A, {status: null})).status).toBe("Pending");
    expect(decodeHistoryCampaign(rawCampaign(CAMPAIGN_A, {status: 3})).status).toBe("Ended");
  });

  it("keeps a null reputation distinct from a reputation of zero", async () => {
    // A promoter who joined an ungated campaign has a genuine 0; a `PromoterRegistered`-only row has
    // none. Collapsing both to 0 would erase the difference between a membership and an artefact.
    const [nulled, zeroed] = decodeMemberships([
      rawPromoter(CAMPAIGN_A, PROMOTER_ID_A, {reputation: null, joinedAtBlock: null}),
      rawPromoter(CAMPAIGN_B, PROMOTER_ID_B, {reputation: "0", joinedAtBlock: "0"}),
    ]);

    expect(nulled.reputationAtJoin).toBeUndefined();
    expect(nulled.joinedAtBlock).toBeUndefined();
    expect(zeroed.reputationAtJoin).toBe(BigInt(0));
    expect(zeroed.joinedAtBlock).toBe(BigInt(0));
  });

  it("flattens the campaign relation to its address", async () => {
    expect(decodeCredits([rawCredit("tx-1")])[0].campaign).toBe(CAMPAIGN_A);
    expect(decodePayouts([rawPayout("tx-1")])[0].campaign).toBe(CAMPAIGN_A);
  });

  it("keeps a null KPI event source null rather than zeroing it", async () => {
    // Null means "nothing observable" — a KPI whose params are not an event-source blob. A zero
    // address would read as a real contract that never fires.
    const [kpi] = decodeKpis([
      {index: 2, kind: 1, aggregate: true, target: "0", verifier: "0x00", source: null, topic0: null, campaign: {id: CAMPAIGN_A}},
    ]);
    expect(kpi.source).toBeNull();
    expect(kpi.topic0).toBeNull();
    expect(kpi.aggregate).toBe(true);
  });

  it("survives a non-array where a collection was expected", async () => {
    for (const raw of [undefined, null, {}, "nope"]) {
      expect(decodeMemberships(raw), String(raw)).toEqual([]);
      expect(decodeCredits(raw), String(raw)).toEqual([]);
      expect(decodePayouts(raw), String(raw)).toEqual([]);
      expect(decodeKpis(raw), String(raw)).toEqual([]);
    }
  });

  it("lowercases the filter values it derives", async () => {
    const memberships = decodeMemberships([
      rawPromoter(CAMPAIGN_A.toUpperCase().replace("0X", "0x"), PROMOTER_ID_A),
    ]);
    expect(campaignIdsOf(memberships)).toEqual([CAMPAIGN_A]);
    expect(promoterIdsOf(memberships)).toEqual([PROMOTER_ID_A]);
  });
});
