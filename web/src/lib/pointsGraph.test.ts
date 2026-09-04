import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {
  decodeCredits,
  decodeJoins,
  decodeKpis,
  decodeTouches,
  fetchPointsFromGraph,
  POINTS_CREDITS_PAGE_QUERY,
  POINTS_JOINS_PAGE_QUERY,
  POINTS_QUERY,
  POINTS_TOUCHES_PAGE_QUERY,
} from "./pointsGraph";
import {GRAPH_PAGE_SIZE, type GraphFetch} from "./graph";

/**
 * Leaderboard read tests.
 *
 * Four things are load-bearing and the rest is decode:
 *
 *  1. **A failed read is never an empty board.** Every unavailable arm has to stay unavailable all the
 *     way out, because a board rendering zeroes is a claim about the protocol rather than a gap.
 *  2. **A full page is continued, a short page is not.** One request per collection is the ordinary
 *     case; a wrong cursor would silently re-read page one and double every total.
 *  3. **A page cap surfaces as `truncated`,** so the surface can label its numbers floors.
 *  4. **`amountMode: null` decodes to `undefined`, not 0.** Mode 0 means "count each log"; null means
 *     the params are not an event-source blob at all, and `points.ts` scores those differently.
 */

const BASE_SEPOLIA = 84532;
const ANVIL = 31337;
const URL = "https://api.studio.thegraph.com/query/0/boney-indexer/version/latest";

const CAMPAIGN = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WALLET = "0xBbBbbBBbbBBBbbbbBBBbbbBbbBbbBbBBBbBbBBb1";
const PROMOTER_ID = `0x${"11".repeat(32)}`;

const rawJoin = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  promoterId: PROMOTER_ID,
  wallet: WALLET,
  ...over,
});

const rawTouch = (id: string, over: Record<string, unknown> = {}) => ({id, user: WALLET, ...over});

const rawCredit = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  kpiIndex: 0,
  promoterId: PROMOTER_ID,
  user: "0xcccccccccccccccccccccccccccccccccccccccc",
  amount: "9",
  campaign: {id: CAMPAIGN},
  ...over,
});

const rawKpi = (index: number, over: Record<string, unknown> = {}) => ({
  id: `${CAMPAIGN}-${index}`,
  kind: 2,
  amountMode: null,
  ...over,
});

const META = {block: {number: 45857000}, hasIndexingErrors: false};

const page = <T,>(make: (index: number) => T, count: number): T[] =>
  Array.from({length: count}, (_unused, index) => make(index));

type Call = {query: string; variables: Record<string, unknown>};

/** A `fetch` answering from a script, so the real orchestration runs against no network. */
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

const body = (over: Record<string, unknown> = {}) => ({
  data: {promoters: [], touches: [], credits: [], kpis: [], _meta: META, ...over},
});

const read = (responses: Array<{status?: number; body: unknown}>, chainId = BASE_SEPOLIA) => {
  const stub = stubGraph(responses);
  return {stub, result: fetchPointsFromGraph({chainId, fetchImpl: stub.fetchImpl})};
};

// `NEXT_PUBLIC_` variables are inlined into a browser bundle, but under vitest's node environment
// `subgraphUrl` reads the live `process.env`, so a test can set one.
const previousUrl = process.env.NEXT_PUBLIC_SUBGRAPH_URL;
beforeEach(() => {
  process.env.NEXT_PUBLIC_SUBGRAPH_URL = URL;
});
afterEach(() => {
  if (previousUrl === undefined) delete process.env.NEXT_PUBLIC_SUBGRAPH_URL;
  else process.env.NEXT_PUBLIC_SUBGRAPH_URL = previousUrl;
});

describe("fetchPointsFromGraph — preconditions", () => {
  it("blames the chain on anvil, not the configuration", async () => {
    const {stub, result} = read([], ANVIL);
    const settled = await result;

    expect(settled.kind).toBe("unavailable");
    if (settled.kind === "unavailable") expect(settled.reason).toBe("unsupported-chain");
    expect(stub.calls).toHaveLength(0);
  });

  it("blames the configuration when the indexed chain has no url", async () => {
    delete process.env.NEXT_PUBLIC_SUBGRAPH_URL;
    const {stub, result} = read([]);
    const settled = await result;

    expect(settled.kind).toBe("unavailable");
    if (settled.kind === "unavailable") expect(settled.reason).toBe("not-configured");
    expect(stub.calls).toHaveLength(0);
  });

  it("is unavailable with no chain at all", async () => {
    const stub = stubGraph([]);
    const settled = await fetchPointsFromGraph({chainId: undefined, fetchImpl: stub.fetchImpl});

    expect(settled.kind).toBe("unavailable");
    expect(stub.calls).toHaveLength(0);
  });
});

describe("fetchPointsFromGraph — the ordinary read", () => {
  it("asks once for every collection and returns the fold's input", async () => {
    const {stub, result} = read([
      {
        body: body({
          promoters: [rawJoin("a")],
          touches: [rawTouch("t")],
          credits: [rawCredit("c")],
          kpis: [rawKpi(0)],
        }),
      },
    ]);
    const settled = await result;

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]!.query).toBe(POINTS_QUERY);
    expect(stub.calls[0]!.variables).toEqual({first: GRAPH_PAGE_SIZE});
    expect(settled.kind).toBe("ok");
    if (settled.kind !== "ok") return;
    expect(settled.data.input.joins).toHaveLength(1);
    expect(settled.data.input.touches).toHaveLength(1);
    expect(settled.data.input.credits).toHaveLength(1);
    expect(settled.data.input.kpis).toHaveLength(1);
    expect(settled.data.truncated).toBe(false);
    expect(settled.data.indexedBlock).toBe(BigInt(45857000));
    expect(settled.data.hasIndexingErrors).toBe(false);
  });

  /** A protocol nobody has acted in yet is an answer, not a failure. */
  it("returns an empty board as ok", async () => {
    const settled = await read([{body: body()}]).result;

    expect(settled.kind).toBe("ok");
    if (settled.kind !== "ok") return;
    expect(settled.data.input.joins).toEqual([]);
    expect(settled.data.truncated).toBe(false);
  });

  it("reports a lagging indexer rather than hiding it", async () => {
    const settled = await read([
      {body: body({_meta: {block: {number: 45000000}, hasIndexingErrors: true}})},
    ]).result;

    expect(settled.kind).toBe("ok");
    if (settled.kind !== "ok") return;
    expect(settled.data.hasIndexingErrors).toBe(true);
    expect(settled.data.indexedBlock).toBe(BigInt(45000000));
  });
});

describe("fetchPointsFromGraph — failures", () => {
  it("is unavailable when the response omits the load-bearing field", async () => {
    const settled = await read([{body: {data: {touches: [], credits: [], _meta: META}}}]).result;
    expect(settled.kind).toBe("unavailable");
  });

  it("is unavailable on a transport failure", async () => {
    const settled = await read([{status: 502, body: {}}]).result;
    expect(settled.kind).toBe("unavailable");
  });

  /** A 200 carrying `errors` is a failed read whatever else it carries. */
  it("is unavailable when a 200 carries GraphQL errors", async () => {
    const settled = await read([
      {body: {data: {promoters: [], touches: [], credits: [], kpis: [], _meta: META}, errors: [{message: "boom"}]}},
    ]).result;
    expect(settled.kind).toBe("unavailable");
  });

  /**
   * There are real rows in hand when a continuation fails, and returning them would hand the board a
   * confident, wrong, lower total for every wallet in the truncated collection.
   */
  it("lets a continuation failure win over the rows already read", async () => {
    const {stub, result} = read([
      {body: body({promoters: page((index) => rawJoin(`join-${index}`), GRAPH_PAGE_SIZE)})},
      {status: 500, body: {}},
    ]);
    const settled = await result;

    expect(stub.calls).toHaveLength(2);
    expect(settled.kind).toBe("unavailable");
  });
});

describe("fetchPointsFromGraph — pagination", () => {
  it("continues only the collection that came back full, cursored past its last row", async () => {
    const {stub, result} = read([
      {
        body: body({
          credits: page((index) => rawCredit(`credit-${String(index).padStart(4, "0")}`), GRAPH_PAGE_SIZE),
          touches: [rawTouch("t")],
        }),
      },
      {body: {data: {credits: [rawCredit("credit-last")]}}},
    ]);
    const settled = await result;

    expect(stub.calls.map((call) => call.query)).toEqual([POINTS_QUERY, POINTS_CREDITS_PAGE_QUERY]);
    expect(stub.calls[1]!.variables).toEqual({
      first: GRAPH_PAGE_SIZE,
      cursor: `credit-${String(GRAPH_PAGE_SIZE - 1).padStart(4, "0")}`,
    });
    expect(settled.kind).toBe("ok");
    if (settled.kind !== "ok") return;
    expect(settled.data.input.credits).toHaveLength(GRAPH_PAGE_SIZE + 1);
    expect(settled.data.truncated).toBe(false);
  });

  it("continues joins and touches on their own documents", async () => {
    const {stub, result} = read([
      {
        body: body({
          promoters: page((index) => rawJoin(`join-${index}`), GRAPH_PAGE_SIZE),
          touches: page((index) => rawTouch(`touch-${index}`), GRAPH_PAGE_SIZE),
        }),
      },
      {body: {data: {promoters: []}}},
      {body: {data: {touches: []}}},
    ]);
    const settled = await result;

    expect(stub.calls.map((call) => call.query)).toEqual([
      POINTS_QUERY,
      POINTS_JOINS_PAGE_QUERY,
      POINTS_TOUCHES_PAGE_QUERY,
    ]);
    expect(settled.kind).toBe("ok");
  });

  /** Without a cursor to advance past, another request re-reads the same page — flag, do not loop. */
  it("flags truncation instead of looping when the last row has no id", async () => {
    const {stub, result} = read([
      {body: body({promoters: page(() => rawJoin(""), GRAPH_PAGE_SIZE)})},
    ]);
    const settled = await result;

    expect(stub.calls).toHaveLength(1);
    expect(settled.kind).toBe("ok");
    if (settled.kind !== "ok") return;
    expect(settled.data.truncated).toBe(true);
  });

  /** KPIs are bounded by campaigns × KPIs each, so a full page is flagged rather than walked. */
  it("flags a full kpis page without asking for another", async () => {
    const {stub, result} = read([
      {body: body({kpis: page((index) => rawKpi(index), GRAPH_PAGE_SIZE)})},
    ]);
    const settled = await result;

    expect(stub.calls).toHaveLength(1);
    expect(settled.kind).toBe("ok");
    if (settled.kind !== "ok") return;
    expect(settled.data.truncated).toBe(true);
  });
});

describe("decoders", () => {
  it("lowercases every address so the fold can key on one form", () => {
    const [join] = decodeJoins([rawJoin("a")]);
    const [touch] = decodeTouches([rawTouch("t")]);

    expect(join!.wallet).toBe(WALLET.toLowerCase());
    expect(touch!.user).toBe(WALLET.toLowerCase());
  });

  it("decodes a credit's amount as a bigint and flattens its campaign", () => {
    const [credit] = decodeCredits([rawCredit("c", {amount: "12", kpiIndex: 2})]);

    expect(credit).toEqual({
      id: "c",
      campaign: CAMPAIGN,
      kpiIndex: 2,
      promoterId: PROMOTER_ID,
      user: "0xcccccccccccccccccccccccccccccccccccccccc",
      amount: BigInt(12),
    });
  });

  it("keeps a null amount mode distinct from mode 0", () => {
    const rows = decodeKpis([rawKpi(0), rawKpi(1, {amountMode: 0}), rawKpi(2, {amountMode: 1})]);

    expect(rows.map((row) => row.amountMode)).toEqual([undefined, 0, 1]);
  });

  it("lowercases a kpi id so the credit join key matches", () => {
    const [kpi] = decodeKpis([rawKpi(0, {id: `${CAMPAIGN.toUpperCase()}-0`})]);
    expect(kpi!.id).toBe(`${CAMPAIGN}-0`);
  });

  it("returns nothing for a selection that is not a list", () => {
    for (const raw of [undefined, null, {}, "rows"]) {
      expect(decodeJoins(raw)).toEqual([]);
      expect(decodeTouches(raw)).toEqual([]);
      expect(decodeCredits(raw)).toEqual([]);
      expect(decodeKpis(raw)).toEqual([]);
    }
  });
});
