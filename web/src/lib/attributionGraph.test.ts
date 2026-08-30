import {describe, expect, it} from "vitest";
import type {GraphFetch} from "./graph";
import {
  TOUCHES_QUERY,
  decodeTouch,
  fetchTouchesFromGraph,
  touchEntries,
  type RawTouch,
} from "./attributionGraph";

const CAMPAIGN = "0x3945D484498F642b308d5C921965DECBF12C9323" as const;
const REFERRAL = "0x0b5bFad0000000000000000000000000000000a1" as const;
const PROMOTER_ID = "0xabc0000000000000000000000000000000000000000000000000000000000001" as const;

function row(over: Partial<RawTouch> = {}): RawTouch {
  return {
    id: `${CAMPAIGN.toLowerCase()}-${REFERRAL.toLowerCase()}`,
    user: REFERRAL,
    promoterId: PROMOTER_ID,
    signedAt: "1756400000",
    expiresAt: "1756403600",
    blockNumber: "46100000",
    campaign: {id: CAMPAIGN.toLowerCase()},
    ...over,
  };
}

/** A fetch stub answering every page with `rows`, recording the bodies it was sent. */
function stub(rows: RawTouch[][], sent: string[] = []): GraphFetch {
  let call = 0;
  return async (_url, init) => {
    sent.push(init.body);
    const touches = rows[call] ?? [];
    call += 1;
    return {ok: true, status: 200, json: async () => ({data: {touches}})};
  };
}

describe("decodeTouch", () => {
  it("decodes a complete row", () => {
    expect(decodeTouch(row())).toEqual({
      campaign: CAMPAIGN.toLowerCase(),
      referral: REFERRAL.toLowerCase(),
      promoterId: PROMOTER_ID,
      signedAt: BigInt(1756400000),
      expiresAt: BigInt(1756403600),
      blockNumber: BigInt(46100000),
    });
  });

  it("lowercases the addresses so they match the log path's keys", () => {
    const entry = decodeTouch(row());

    expect(entry?.campaign).toBe(CAMPAIGN.toLowerCase());
    expect(entry?.referral).toBe(REFERRAL.toLowerCase());
  });

  it("drops a row whose campaign is absent", () => {
    expect(decodeTouch(row({campaign: null}))).toBeUndefined();
  });

  it("drops a row whose referral is absent", () => {
    expect(decodeTouch(row({user: undefined}))).toBeUndefined();
  });

  it("drops a row whose promoter id is absent", () => {
    expect(decodeTouch(row({promoterId: null}))).toBeUndefined();
  });

  it("reads a missing expiry as zero rather than failing the row", () => {
    expect(decodeTouch(row({expiresAt: null}))?.expiresAt).toBe(BigInt(0));
  });
});

describe("fetchTouchesFromGraph", () => {
  it("returns the decoded rows", async () => {
    const result = await fetchTouchesFromGraph({
      url: "https://example.test/subgraph",
      campaigns: [CAMPAIGN],
      fetchImpl: stub([[row()]]),
    });

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(touchEntries(result.data)).toHaveLength(1);
    expect(result.data.truncated).toBe(false);
  });

  it("lowercases the campaign filter", async () => {
    const sent: string[] = [];
    await fetchTouchesFromGraph({
      url: "https://example.test/subgraph",
      campaigns: [CAMPAIGN],
      fetchImpl: stub([[]], sent),
    });

    // graph-node compares `Bytes` byte-wise, so a checksummed address matches nothing — and fails by
    // returning an empty list rather than an error.
    expect(sent[0]).toContain(CAMPAIGN.toLowerCase());
    expect(sent[0]).not.toContain(CAMPAIGN);
  });

  it("orders by id so the cursor walk is stable", () => {
    expect(TOUCHES_QUERY).toContain("orderBy: id");
    expect(TOUCHES_QUERY).toContain("id_gt: $cursor");
  });

  it("reports an empty result as a fact, not a failure", async () => {
    const result = await fetchTouchesFromGraph({
      url: "https://example.test/subgraph",
      campaigns: [CAMPAIGN],
      fetchImpl: stub([[]]),
    });

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(touchEntries(result.data)).toEqual([]);
  });

  it("surfaces an unavailable subgraph instead of an empty list", async () => {
    const failing: GraphFetch = async () => ({ok: false, status: 502, json: async () => null});

    const result = await fetchTouchesFromGraph({
      url: "https://example.test/subgraph",
      campaigns: [CAMPAIGN],
      fetchImpl: failing,
    });

    // The caller falls back to the log scan on anything other than `ok`; reporting a 502 as an empty
    // list would render "nobody is attributed".
    expect(result.kind).toBe("unavailable");
  });

  it("drops undecodable rows but keeps the rest of the page", async () => {
    const result = await fetchTouchesFromGraph({
      url: "https://example.test/subgraph",
      campaigns: [CAMPAIGN],
      fetchImpl: stub([[row(), row({user: null, id: "x-2"})]]),
    });

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.data.rows).toHaveLength(2);
    expect(touchEntries(result.data)).toHaveLength(1);
  });
});
