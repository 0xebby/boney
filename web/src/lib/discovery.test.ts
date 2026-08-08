import {describe, it, expect} from "vitest";
import {
  rankPromoters,
  collectPromoters,
  filterPromoters,
  toggleRank,
  summarize,
  ALL_CAMPAIGNS,
  EMPTY_DISCOVERY_FILTERS,
} from "./discovery";
import {RANKS} from "./ranks";
import type {PromoterEntry, CampaignPromoters} from "./promoters";
import type {CampaignView} from "./types";

/**
 * Discovery tests.
 *
 * Fixtures use the real scores measured against the live APIs, so the bands these land in are the
 * ones a project would actually see rather than round numbers chosen to sit mid-band.
 */

const CAMPAIGN_A = "0xaaaa000000000000000000000000000000000001" as const;
const CAMPAIGN_B = "0xbbbb000000000000000000000000000000000002" as const;

function entry(
  promoter: string,
  reputation: number,
  campaign: string = CAMPAIGN_A,
  blockNumber = 100,
): PromoterEntry {
  return {
    campaign: campaign as `0x${string}`,
    promoter: promoter as `0x${string}`,
    promoterId: `0x${"11".repeat(32)}` as `0x${string}`,
    reputation: BigInt(reputation),
    blockNumber: BigInt(blockNumber),
  };
}

function view(campaign: string): CampaignView {
  return {
    campaignId: BigInt(1),
    campaign: campaign as `0x${string}`,
    project: `0x${"22".repeat(20)}` as `0x${string}`,
    token: `0x${"33".repeat(20)}` as `0x${string}`,
    rewardPool: BigInt(0),
    paidOut: BigInt(0),
    startTime: BigInt(0),
    endTime: BigInt(0),
    minReputation: BigInt(0),
    status: "Active",
    kpiCount: BigInt(1),
  };
}

function group(campaign: string, promoters: PromoterEntry[]): CampaignPromoters {
  return {view: view(campaign), promoters};
}

const BRAVE_RAF = "0x00000000000000000000000000000000000000a1";
const DARAK = "0x00000000000000000000000000000000000000a2";
const SIBEL = "0x00000000000000000000000000000000000000a3";

describe("rankPromoters", () => {
  it("attaches the right rank to each score", () => {
    const ranked = rankPromoters([
      entry(BRAVE_RAF, 14_435),
      entry(DARAK, 13_003),
      entry(SIBEL, 10_956),
    ]);

    expect(ranked.map((r) => r.rank.id)).toEqual(["samurai", "ronin", "netrunner"]);
  });

  it("sorts by score, highest first, whatever order the logs arrived in", () => {
    const ranked = rankPromoters([entry(SIBEL, 10_956), entry(BRAVE_RAF, 14_435)]);
    expect(ranked.map((r) => r.scoreAtJoin)).toEqual([14_435, 10_956]);
  });

  it("ranks an unattested promoter as Drifter rather than dropping them", () => {
    // A campaign with no minReputation admits score-0 wallets; they are real promoters.
    const ranked = rankPromoters([entry(DARAK, 0)]);
    expect(ranked[0].rank.id).toBe("drifter");
  });

  it("handles an empty directory", () => {
    expect(rankPromoters([])).toEqual([]);
  });
});

describe("collectPromoters", () => {
  const groups = [
    group(CAMPAIGN_A, [entry(BRAVE_RAF, 14_435, CAMPAIGN_A), entry(DARAK, 13_003, CAMPAIGN_A)]),
    group(CAMPAIGN_B, [entry(BRAVE_RAF, 9_000, CAMPAIGN_B), entry(SIBEL, 10_956, CAMPAIGN_B)]),
  ];

  it("returns only the selected campaign's promoters", () => {
    const rows = collectPromoters(groups, CAMPAIGN_B);
    expect(rows.map((r) => r.entry.promoter)).toEqual([SIBEL, BRAVE_RAF]);
  });

  it("matches a campaign address regardless of case", () => {
    // Addresses arrive checksummed from some sources and lowercase from others.
    expect(collectPromoters(groups, CAMPAIGN_B.toUpperCase())).toHaveLength(2);
  });

  it("collapses a wallet promoting several campaigns to one row", () => {
    const rows = collectPromoters(groups, ALL_CAMPAIGNS);
    expect(rows.filter((r) => r.entry.promoter === BRAVE_RAF)).toHaveLength(1);
    expect(rows).toHaveLength(3);
  });

  it("keeps the highest score when collapsing", () => {
    // brave_raf joined A at 14,435 and B at 9,000. Showing 9,000 would under-rank them on a page
    // whose whole purpose is ranking.
    const rows = collectPromoters(groups, ALL_CAMPAIGNS);
    const raf = rows.find((r) => r.entry.promoter === BRAVE_RAF);
    expect(raf?.scoreAtJoin).toBe(14_435);
    expect(raf?.rank.id).toBe("samurai");
  });

  it("returns nothing for a campaign with no promoters", () => {
    expect(collectPromoters([group(CAMPAIGN_A, [])], CAMPAIGN_A)).toEqual([]);
  });

  it("returns nothing for an unknown campaign rather than falling back to all", () => {
    // A stale ?campaign= in a shared URL must not silently widen to the whole marketplace.
    expect(collectPromoters(groups, "0xdead000000000000000000000000000000000000")).toEqual([]);
  });
});

describe("filterPromoters", () => {
  const ranked = rankPromoters([
    entry(BRAVE_RAF, 14_435),
    entry(DARAK, 13_003),
    entry(SIBEL, 10_956),
  ]);

  it("passes everything through by default", () => {
    expect(filterPromoters(ranked, EMPTY_DISCOVERY_FILTERS)).toHaveLength(3);
  });

  it("treats an empty rank list as no filter, never as no results", () => {
    expect(filterPromoters(ranked, {ranks: [], minScore: 0})).toHaveLength(3);
  });

  it("keeps only the selected ranks", () => {
    const out = filterPromoters(ranked, {ranks: ["samurai", "netrunner"], minScore: 0});
    expect(out.map((r) => r.entry.promoter)).toEqual([BRAVE_RAF, SIBEL]);
  });

  it("applies a score floor", () => {
    const out = filterPromoters(ranked, {ranks: [], minScore: 13_003});
    expect(out.map((r) => r.scoreAtJoin)).toEqual([14_435, 13_003]);
  });

  it("intersects the two filters", () => {
    const out = filterPromoters(ranked, {ranks: ["samurai", "ronin"], minScore: 14_000});
    expect(out.map((r) => r.entry.promoter)).toEqual([BRAVE_RAF]);
  });
});

describe("toggleRank", () => {
  it("adds a rank that is absent and removes one that is present", () => {
    expect(toggleRank([], "ronin")).toEqual(["ronin"]);
    expect(toggleRank(["ronin"], "ronin")).toEqual([]);
    expect(toggleRank(["ronin", "fixer"], "ronin")).toEqual(["fixer"]);
  });

  it("does not mutate the input", () => {
    const before = ["ronin"];
    toggleRank(before, "fixer");
    expect(before).toEqual(["ronin"]);
  });
});

describe("summarize", () => {
  it("reports count, top and median", () => {
    const s = summarize(
      rankPromoters([entry(BRAVE_RAF, 14_435), entry(DARAK, 13_003), entry(SIBEL, 10_956)]),
    );
    expect(s.count).toBe(3);
    expect(s.topScore).toBe(14_435);
    expect(s.medianScore).toBe(13_003);
  });

  it("averages the middle pair on an even count", () => {
    const s = summarize(rankPromoters([entry(BRAVE_RAF, 14_435), entry(DARAK, 13_003)]));
    expect(s.medianScore).toBe(13_719);
  });

  it("uses the median so one outlier cannot misrepresent the field", () => {
    // Four ordinary promoters and one maxed-out account. A mean would read 8,187 and suggest a
    // stronger field than exists; the median stays with the four.
    const s = summarize(
      rankPromoters([
        entry(BRAVE_RAF, 1_000),
        entry(DARAK, 1_100),
        entry(SIBEL, 1_200),
        entry("0x00000000000000000000000000000000000000a4", 1_300),
        entry("0x00000000000000000000000000000000000000a5", 28_000),
      ]),
    );
    expect(s.medianScore).toBe(1_200);
  });

  it("is all zeroes on an empty slice rather than NaN", () => {
    const s = summarize([]);
    expect(s.count).toBe(0);
    expect(s.topScore).toBe(0);
    expect(s.medianScore).toBe(0);
  });

  it("keeps every band in the distribution so the legend does not reflow", () => {
    const s = summarize(rankPromoters([entry(BRAVE_RAF, 14_435)]));
    expect(s.distribution).toHaveLength(RANKS.length);
    expect(s.distribution.find((d) => d.rank.id === "samurai")?.count).toBe(1);
  });
});
