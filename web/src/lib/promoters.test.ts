import {describe, it, expect} from "vitest";
import {
  planWindows,
  dedupePromoters,
  groupByCampaign,
  countPromoters,
  countDistinctPromoters,
  MAX_LOG_RANGE,
  MAX_WINDOWS,
  type PromoterEntry,
} from "./promoters";
import type {CampaignView} from "./types";

const CAMPAIGN_A = "0xAAaAaA00000000000000000000000000000000aA" as const;
const CAMPAIGN_B = "0xBbBbBB00000000000000000000000000000000bB" as const;
const PROMOTER_1 = "0x1111111111111111111111111111111111111111" as const;
const PROMOTER_2 = "0x2222222222222222222222222222222222222222" as const;

function entry(over: Partial<PromoterEntry> = {}): PromoterEntry {
  return {
    campaign: CAMPAIGN_A,
    promoter: PROMOTER_1,
    promoterId: "0xdead",
    reputation: BigInt(0),
    blockNumber: BigInt(100),
    ...over,
  };
}

function view(over: Partial<CampaignView> = {}): CampaignView {
  return {
    campaignId: BigInt(1),
    campaign: CAMPAIGN_A,
    project: PROMOTER_2,
    token: PROMOTER_2,
    rewardPool: BigInt(0),
    paidOut: BigInt(0),
    startTime: BigInt(0),
    endTime: BigInt(0),
    status: "Active",
    kpiCount: BigInt(1),
    minReputation: BigInt(0),
    ...over,
  } as CampaignView;
}

describe("planWindows", () => {
  it("covers a range smaller than one span in a single window", () => {
    const {windows, skippedBefore} = planWindows(BigInt(10), BigInt(50));
    expect(windows).toEqual([{from: BigInt(10), to: BigInt(50)}]);
    expect(skippedBefore).toBeUndefined();
  });

  it("returns nothing when the range is inverted", () => {
    expect(planWindows(BigInt(100), BigInt(10)).windows).toEqual([]);
  });

  it("covers a single-block range", () => {
    expect(planWindows(BigInt(7), BigInt(7)).windows).toEqual([{from: BigInt(7), to: BigInt(7)}]);
  });

  /**
   * The bug this guards: an overlapping boundary double-counts a join, a gap drops one. Neither
   * throws — the directory is just quietly wrong.
   */
  it("produces contiguous, non-overlapping windows", () => {
    const {windows} = planWindows(BigInt(0), BigInt(10_000), BigInt(1000));
    for (let i = 1; i < windows.length; i++) {
      expect(windows[i].from).toBe(windows[i - 1].to + BigInt(1));
    }
  });

  it("never exceeds the span in any window", () => {
    const span = BigInt(1000);
    const {windows} = planWindows(BigInt(3), BigInt(9_999), span);
    for (const w of windows) expect(w.to - w.from + BigInt(1)).toBeLessThanOrEqual(span);
  });

  it("ends exactly on the requested head", () => {
    const {windows} = planWindows(BigInt(0), BigInt(4321), BigInt(1000));
    expect(windows[windows.length - 1].to).toBe(BigInt(4321));
  });

  it("starts exactly on the requested floor", () => {
    const {windows} = planWindows(BigInt(77), BigInt(4321), BigInt(1000));
    expect(windows[0].from).toBe(BigInt(77));
  });

  /**
   * A range wider than the budget must report the gap. Silently returning the recent slice would
   * render a partial directory as if it were complete.
   */
  it("clamps an over-wide range to the most recent span and reports the gap", () => {
    const span = BigInt(100);
    const max = 3;
    const {windows, skippedBefore} = planWindows(BigInt(0), BigInt(999), span, max);

    expect(windows).toHaveLength(max);
    expect(windows[windows.length - 1].to).toBe(BigInt(999));
    expect(skippedBefore).toBe(BigInt(700));
    expect(windows[0].from).toBe(BigInt(700));
  });

  it("does not report a gap when the range fits exactly", () => {
    const {windows, skippedBefore} = planWindows(BigInt(0), BigInt(299), BigInt(100), 3);
    expect(windows).toHaveLength(3);
    expect(skippedBefore).toBeUndefined();
  });

  it("rejects a non-positive span rather than looping forever", () => {
    expect(() => planWindows(BigInt(0), BigInt(10), BigInt(0))).toThrow();
  });

  it("keeps the default span under the 2000-block RPC cap", () => {
    expect(MAX_LOG_RANGE).toBeLessThan(BigInt(2000));
    expect(MAX_WINDOWS).toBeGreaterThan(0);
  });
});

describe("dedupePromoters", () => {
  it("keeps one row per campaign and wallet", () => {
    const out = dedupePromoters([
      entry({blockNumber: BigInt(200)}),
      entry({blockNumber: BigInt(100)}),
    ]);
    expect(out).toHaveLength(1);
  });

  it("keeps the earliest join when a log is seen twice", () => {
    const out = dedupePromoters([
      entry({blockNumber: BigInt(200)}),
      entry({blockNumber: BigInt(100)}),
    ]);
    expect(out[0].blockNumber).toBe(BigInt(100));
  });

  it("treats the same wallet in a different campaign as a separate membership", () => {
    const out = dedupePromoters([entry(), entry({campaign: CAMPAIGN_B})]);
    expect(out).toHaveLength(2);
  });

  it("matches wallets case-insensitively", () => {
    const out = dedupePromoters([
      entry({promoter: PROMOTER_1}),
      entry({promoter: PROMOTER_1.toLowerCase() as `0x${string}`}),
    ]);
    expect(out).toHaveLength(1);
  });
});

describe("groupByCampaign", () => {
  it("attaches promoters to their campaign", () => {
    const groups = groupByCampaign([view()], [entry()]);
    expect(groups[0].promoters).toHaveLength(1);
  });

  it("keeps a campaign nobody has joined, rather than dropping it", () => {
    const groups = groupByCampaign([view({campaign: CAMPAIGN_B})], []);
    expect(groups).toHaveLength(1);
    expect(groups[0].promoters).toEqual([]);
  });

  it("does not leak one campaign's promoters into another", () => {
    const groups = groupByCampaign(
      [view({campaign: CAMPAIGN_A}), view({campaign: CAMPAIGN_B, campaignId: BigInt(2)})],
      [entry({campaign: CAMPAIGN_B})],
    );
    expect(groups[0].promoters).toEqual([]);
    expect(groups[1].promoters).toHaveLength(1);
  });

  it("orders promoters by join block, earliest first", () => {
    const groups = groupByCampaign(
      [view()],
      [
        entry({promoter: PROMOTER_2, blockNumber: BigInt(500)}),
        entry({promoter: PROMOTER_1, blockNumber: BigInt(100)}),
      ],
    );
    expect(groups[0].promoters.map((p) => p.promoter)).toEqual([PROMOTER_1, PROMOTER_2]);
  });

  it("matches campaign addresses case-insensitively", () => {
    const groups = groupByCampaign(
      [view({campaign: CAMPAIGN_A.toLowerCase() as `0x${string}`})],
      [entry({campaign: CAMPAIGN_A})],
    );
    expect(groups[0].promoters).toHaveLength(1);
  });
});

describe("counts", () => {
  it("counts every membership row", () => {
    const groups = groupByCampaign(
      [view({campaign: CAMPAIGN_A}), view({campaign: CAMPAIGN_B, campaignId: BigInt(2)})],
      [entry({campaign: CAMPAIGN_A}), entry({campaign: CAMPAIGN_B})],
    );
    expect(countPromoters(groups)).toBe(2);
  });

  /** A wallet promoting three campaigns is one promoter, not three — the tile says "Promoters". */
  it("counts a wallet in two campaigns as one distinct promoter", () => {
    const groups = groupByCampaign(
      [view({campaign: CAMPAIGN_A}), view({campaign: CAMPAIGN_B, campaignId: BigInt(2)})],
      [entry({campaign: CAMPAIGN_A}), entry({campaign: CAMPAIGN_B})],
    );
    expect(countDistinctPromoters(groups)).toBe(1);
  });

  it("counts nothing for an empty directory", () => {
    expect(countPromoters([])).toBe(0);
    expect(countDistinctPromoters([])).toBe(0);
  });
});
