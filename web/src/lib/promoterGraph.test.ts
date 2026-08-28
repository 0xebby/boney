import {describe, expect, it} from "vitest";
import type {GraphFetch} from "./graph";
import {GRAPH_MAX_PAGES, GRAPH_PAGE_SIZE} from "./graph";
import {
  PROMOTERS_QUERY,
  decodePromoter,
  fetchPromotersFromGraph,
  promoterEntries,
  type RawPromoter,
} from "./promoterGraph";

const CAMPAIGN = "0x6427217ea49EddeB51471005830962a6f0Df8e24" as const;
const WALLET = "0x98405C5776a63547E7CB16000ba04ca53d9FB2f8" as const;
const PROMOTER_ID = "0xabc0000000000000000000000000000000000000000000000000000000000001" as const;

function row(over: Partial<RawPromoter> = {}): RawPromoter {
  return {
    id: `${CAMPAIGN.toLowerCase()}-${PROMOTER_ID}`,
    promoterId: PROMOTER_ID,
    wallet: WALLET,
    reputation: "24620",
    joinedAtBlock: "45900000",
    campaign: {id: CAMPAIGN.toLowerCase()},
    ...over,
  };
}

/** A fetch stub answering every page with `rows`, recording the bodies it was sent. */
function stub(rows: RawPromoter[][], sent: string[] = []): GraphFetch {
  let call = 0;
  return async (_url, init) => {
    sent.push(init.body);
    const promoters = rows[call] ?? [];
    call += 1;
    return {ok: true, status: 200, json: async () => ({data: {promoters}})};
  };
}

describe("decodePromoter", () => {
  it("decodes a complete row", () => {
    const entry = decodePromoter(row());

    expect(entry).toEqual({
      campaign: CAMPAIGN.toLowerCase(),
      promoter: WALLET.toLowerCase(),
      promoterId: PROMOTER_ID,
      reputation: BigInt(24620),
      blockNumber: BigInt(45900000),
    });
  });

  it("lowercases the addresses so they match the log path's keys", () => {
    // `dedupePromoters` and `groupByCampaign` key on lowercased addresses. A checksummed value here
    // would produce a second row for a promoter the log scan already found.
    const entry = decodePromoter(row());

    expect(entry?.campaign).toBe(CAMPAIGN.toLowerCase());
    expect(entry?.promoter).toBe(WALLET.toLowerCase());
  });

  it("drops a row whose wallet is absent", () => {
    // `PromoterRegistered` creates the row before `PromoterJoined` supplies the wallet.
    expect(decodePromoter(row({wallet: null}))).toBeUndefined();
  });

  it("drops a row whose campaign is absent", () => {
    expect(decodePromoter(row({campaign: null}))).toBeUndefined();
  });

  it("drops a row whose promoter id is absent", () => {
    expect(decodePromoter(row({promoterId: undefined}))).toBeUndefined();
  });

  it("reads a missing reputation as zero rather than failing the row", () => {
    const entry = decodePromoter(row({reputation: null}));

    expect(entry?.reputation).toBe(BigInt(0));
  });
});

describe("fetchPromotersFromGraph", () => {
  it("returns the decoded rows", async () => {
    const result = await fetchPromotersFromGraph({
      url: "https://example.test/subgraph",
      campaigns: [CAMPAIGN],
      fetchImpl: stub([[row()]]),
    });

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(promoterEntries(result.data)).toHaveLength(1);
    expect(result.data.truncated).toBe(false);
  });

  it("lowercases the campaign filter", async () => {
    const sent: string[] = [];
    await fetchPromotersFromGraph({
      url: "https://example.test/subgraph",
      campaigns: [CAMPAIGN],
      fetchImpl: stub([[]], sent),
    });

    // graph-node compares `Bytes` byte-wise, so a checksummed address matches nothing — and fails by
    // returning an empty list rather than an error, which is the bug this directory already had once.
    expect(sent[0]).toContain(CAMPAIGN.toLowerCase());
    expect(sent[0]).not.toContain(CAMPAIGN);
  });

  it("asks for joined promoters only", () => {
    expect(PROMOTERS_QUERY).toContain("wallet_not: null");
  });

  it("reports an empty result as a fact, not a failure", async () => {
    const result = await fetchPromotersFromGraph({
      url: "https://example.test/subgraph",
      campaigns: [CAMPAIGN],
      fetchImpl: stub([[]]),
    });

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(promoterEntries(result.data)).toEqual([]);
  });

  it("surfaces an unavailable subgraph instead of an empty directory", async () => {
    const failing: GraphFetch = async () => ({
      ok: false,
      status: 502,
      json: async () => null,
    });

    const result = await fetchPromotersFromGraph({
      url: "https://example.test/subgraph",
      campaigns: [CAMPAIGN],
      fetchImpl: failing,
    });

    // The caller falls back to the log scan on anything other than `ok`; reporting a 502 as an empty
    // list would silently replace a partial directory with no directory.
    expect(result.kind).toBe("unavailable");
  });

  it("drops undecodable rows but keeps the rest of the page", async () => {
    const result = await fetchPromotersFromGraph({
      url: "https://example.test/subgraph",
      campaigns: [CAMPAIGN],
      fetchImpl: stub([[row(), row({wallet: null, id: "x-2"})]]),
    });

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.data.rows).toHaveLength(2);
    expect(promoterEntries(result.data)).toHaveLength(1);
  });

  it("reports truncation when every page comes back full", async () => {
    // The flag the directory renders its "this is a floor" note from. A membership list longer than
    // the page budget must arrive labelled, because the alternative is a clipped list that reads as
    // the whole network.
    const full = Array.from({length: GRAPH_MAX_PAGES}, (_, page) =>
      Array.from({length: GRAPH_PAGE_SIZE}, (_, i) => row({id: `page${page}-${i}`})),
    );

    const result = await fetchPromotersFromGraph({
      url: "https://example.test/subgraph",
      campaigns: [CAMPAIGN],
      fetchImpl: stub(full),
    });

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.data.truncated).toBe(true);
    expect(result.data.rows).toHaveLength(GRAPH_MAX_PAGES * GRAPH_PAGE_SIZE);
  });
});
