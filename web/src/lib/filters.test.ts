import {describe, it, expect} from "vitest";
import {
  filterCampaigns,
  isJoinable,
  summarize,
  EMPTY_FILTERS,
  type CampaignFilters,
} from "./filters";
import type {CampaignView} from "./types";

function view(overrides: Partial<CampaignView> = {}): CampaignView {
  return {
    campaignId: BigInt(0),
    campaign: "0x1111111111111111111111111111111111111111",
    project: "0x2222222222222222222222222222222222222222",
    token: "0x3333333333333333333333333333333333333333",
    rewardPool: BigInt(10_000),
    paidOut: BigInt(0),
    startTime: BigInt(1_000),
    endTime: BigInt(2_000),
    minReputation: BigInt(0),
    status: "Active",
    kpiCount: BigInt(1),
    ...overrides,
  };
}

const ROWS: CampaignView[] = [
  view({campaignId: BigInt(0), status: "Active", minReputation: BigInt(2_500), rewardPool: BigInt(50_000), paidOut: BigInt(10_000)}),
  view({campaignId: BigInt(1), status: "Active", minReputation: BigInt(0), rewardPool: BigInt(12_000)}),
  view({campaignId: BigInt(2), status: "Pending", minReputation: BigInt(5_000), rewardPool: BigInt(8_000)}),
  view({campaignId: BigInt(3), status: "Ended", minReputation: BigInt(0), rewardPool: BigInt(5_000), paidOut: BigInt(5_000)}),
];

function filters(overrides: Partial<CampaignFilters> = {}): CampaignFilters {
  return {...EMPTY_FILTERS, ...overrides};
}

function ids(rows: CampaignView[]): number[] {
  return rows.map((r) => Number(r.campaignId));
}

describe("isJoinable", () => {
  it("admits anyone when the minimum is zero", () => {
    expect(isJoinable({status: "Active", minReputation: BigInt(0)}, BigInt(0))).toBe(true);
  });

  it("gates on reputation", () => {
    const gated = {status: "Active" as const, minReputation: BigInt(5_000)};
    expect(isJoinable(gated, BigInt(4_999))).toBe(false);
    expect(isJoinable(gated, BigInt(5_000))).toBe(true);
    expect(isJoinable(gated, BigInt(9_000))).toBe(true);
  });

  it("allows joining a Pending campaign, so promoters can prepare links pre-launch", () => {
    expect(isJoinable({status: "Pending", minReputation: BigInt(0)}, BigInt(0))).toBe(true);
  });

  it("rejects terminal and paused campaigns", () => {
    for (const status of ["Ended", "Cancelled", "Paused"] as const) {
      expect(isJoinable({status, minReputation: BigInt(0)}, BigInt(10_000))).toBe(false);
    }
  });
});

describe("filterCampaigns", () => {
  it("returns everything by default", () => {
    expect(ids(filterCampaigns(ROWS, EMPTY_FILTERS, BigInt(0)))).toEqual([0, 1, 2, 3]);
  });

  it("filters by status", () => {
    expect(ids(filterCampaigns(ROWS, filters({status: "Active"}), BigInt(0)))).toEqual([0, 1]);
    expect(ids(filterCampaigns(ROWS, filters({status: "Ended"}), BigInt(0)))).toEqual([3]);
  });

  it("filters to joinable given a reputation score", () => {
    // Score 3,000 clears campaign 0 (2,500) and 1 (0) but not 2 (5,000); 3 is Ended.
    expect(ids(filterCampaigns(ROWS, filters({joinableOnly: true}), BigInt(3_000)))).toEqual([0, 1]);
    expect(ids(filterCampaigns(ROWS, filters({joinableOnly: true}), BigInt(0)))).toEqual([1]);
    expect(ids(filterCampaigns(ROWS, filters({joinableOnly: true}), BigInt(9_000)))).toEqual([0, 1, 2]);
  });

  it("searches by campaign id exactly", () => {
    expect(ids(filterCampaigns(ROWS, filters({search: "2"}), BigInt(0)))).toEqual([2]);
  });

  /**
   * A numeric query must not fall through to an address substring match: every hex address
   * contains "2", so a substring search on `2` would return every campaign and make the
   * control useless.
   */
  it("treats a numeric query as an id, never an address substring", () => {
    const rows = [
      view({campaignId: BigInt(0), campaign: "0x2222222222222222222222222222222222222222"}),
      view({campaignId: BigInt(7), campaign: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd"}),
    ];
    expect(ids(filterCampaigns(rows, filters({search: "2"}), BigInt(0)))).toEqual([]);
    expect(ids(filterCampaigns(rows, filters({search: "7"}), BigInt(0)))).toEqual([7]);
  });

  it("ignores a too-short non-numeric query rather than matching everything", () => {
    expect(filterCampaigns(ROWS, filters({search: "ab"}), BigInt(0))).toEqual([]);
  });

  it("searches by address substring, case-insensitively", () => {
    const rows = [view({campaignId: BigInt(9), campaign: "0xAAaaBBBB11112222333344445555666677778888"})];
    expect(ids(filterCampaigns(rows, filters({search: "aaaabbbb"}), BigInt(0)))).toEqual([9]);
    expect(ids(filterCampaigns(rows, filters({search: "0xAAAA"}), BigInt(0)))).toEqual([9]);
  });

  it("returns nothing when the search matches nothing", () => {
    expect(filterCampaigns(ROWS, filters({search: "0xdeadbeef"}), BigInt(0))).toEqual([]);
  });

  it("ignores surrounding whitespace in the search", () => {
    expect(ids(filterCampaigns(ROWS, filters({search: "  1  "}), BigInt(0)))).toEqual([1]);
  });

  it("combines filters conjunctively", () => {
    const f = filters({status: "Active", joinableOnly: true});
    expect(ids(filterCampaigns(ROWS, f, BigInt(2_500)))).toEqual([0, 1]);
    expect(ids(filterCampaigns(ROWS, f, BigInt(0)))).toEqual([1]);
  });

  it("does not mutate the input array", () => {
    const before = [...ROWS];
    filterCampaigns(ROWS, filters({status: "Active"}), BigInt(0));
    expect(ROWS).toEqual(before);
  });
});

describe("summarize", () => {
  it("aggregates pools, payouts and active count", () => {
    const s = summarize(ROWS);
    expect(s.count).toBe(4);
    expect(s.activeCount).toBe(2);
    expect(s.totalPool).toBe(BigInt(75_000));
    expect(s.totalPaidOut).toBe(BigInt(15_000));
  });

  it("handles an empty list", () => {
    expect(summarize([])).toEqual({
      count: 0,
      activeCount: 0,
      totalPool: BigInt(0),
      totalPaidOut: BigInt(0),
    });
  });

  it("sums with bigint, not float", () => {
    const huge = BigInt("9007199254740993"); // beyond Number.MAX_SAFE_INTEGER
    const s = summarize([view({rewardPool: huge}), view({rewardPool: huge})]);
    expect(s.totalPool).toBe(huge * BigInt(2));
  });
});
