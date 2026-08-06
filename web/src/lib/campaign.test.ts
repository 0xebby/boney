import {describe, it, expect} from "vitest";
import {
  utilization,
  nextTier,
  claimableRewards,
  isReclaimable,
  reclaimableFromView,
  reclaimAvailableIn,
  crossedTierCount,
  unsettledRewards,
  settledRewards,
  settlementPayout,
  tierProgressRatio,
} from "./campaign";
import {CAMPAIGN_STATUS} from "./types";

const base = {
  campaignId: BigInt(1),
  campaign: "0x1111111111111111111111111111111111111111" as `0x${string}`,
  project: "0x2222222222222222222222222222222222222222" as `0x${string}`,
  token: "0x3333333333333333333333333333333333333333" as `0x${string}`,
  rewardPool: BigInt(10_000),
  paidOut: BigInt(0),
  startTime: BigInt(1_000),
  endTime: BigInt(2_000),
  minReputation: BigInt(0),
  kpiCount: BigInt(1),
};

const TIERS = [
  {threshold: BigInt(10), reward: BigInt(100)},
  {threshold: BigInt(50), reward: BigInt(200)},
  {threshold: BigInt(100), reward: BigInt(500)},
];

describe("utilization", () => {
  it("is zero when nothing is paid", () => {
    expect(utilization({paidOut: BigInt(0), rewardPool: BigInt(10_000)})).toBe(0);
  });

  it("is the paid fraction", () => {
    expect(utilization({paidOut: BigInt(2_500), rewardPool: BigInt(10_000)})).toBe(0.25);
  });

  it("caps at 1 even when the ledger is over-drawn", () => {
    expect(utilization({paidOut: BigInt(12_000), rewardPool: BigInt(10_000)})).toBe(1);
  });

  it("guards a zero pool", () => {
    expect(utilization({paidOut: BigInt(1), rewardPool: BigInt(0)})).toBe(0);
  });
});

describe("nextTier", () => {
  it("returns the first un-crossed tier", () => {
    expect(nextTier(BigInt(7), TIERS)).toEqual({threshold: BigInt(10), reward: BigInt(100), index: 0});
    expect(nextTier(BigInt(10), TIERS)).toEqual({threshold: BigInt(50), reward: BigInt(200), index: 1});
  });

  it("returns null when the ladder is complete", () => {
    expect(nextTier(BigInt(200), TIERS)).toBeNull();
    expect(nextTier(BigInt(100), TIERS)).toBeNull();
  });
});

describe("claimableRewards", () => {
  it("sums crossed tiers only", () => {
    expect(claimableRewards(BigInt(9), TIERS)).toBe(BigInt(0));
    expect(claimableRewards(BigInt(10), TIERS)).toBe(BigInt(100));
    expect(claimableRewards(BigInt(50), TIERS)).toBe(BigInt(300));
    expect(claimableRewards(BigInt(100), TIERS)).toBe(BigInt(800));
  });
});

describe("isReclaimable", () => {
  const grace = 7 * 86_400;
  const endedAt = 5_000;

  it("cancelled campaigns are reclaimable immediately", () => {
    expect(isReclaimable("Cancelled", endedAt, 1_500, grace)).toBe(true);
  });

  it("ended campaigns need the grace window to pass", () => {
    // `Campaign.reclaimUnspent` reverts while `block.timestamp <= endedAt + CLAIM_GRACE`,
    // so the boundary second is still closed.
    expect(isReclaimable("Ended", endedAt, endedAt + grace - 1, grace)).toBe(false);
    expect(isReclaimable("Ended", endedAt, endedAt + grace, grace)).toBe(false);
    expect(isReclaimable("Ended", endedAt, endedAt + grace + 1, grace)).toBe(true);
  });

  it("measures grace from endedAt, not the scheduled endTime", () => {
    // A project that ends a campaign long after its scheduled window resets the clock.
    // Using endTime here would claim reclaimable while the contract still reverts.
    const scheduledEnd = 2_000;
    const actuallyEnded = 900_000;
    const now = scheduledEnd + grace + 1;

    expect(now).toBeGreaterThan(scheduledEnd + grace);
    expect(isReclaimable("Ended", actuallyEnded, now, grace)).toBe(false);
  });

  it("treats an unset endedAt as not reclaimable", () => {
    expect(isReclaimable("Ended", 0, 10_000_000, grace)).toBe(false);
  });

  it("active and pending campaigns are not reclaimable", () => {
    expect(isReclaimable("Active", endedAt, 10_000_000, grace)).toBe(false);
    expect(isReclaimable("Pending", endedAt, 10_000_000, grace)).toBe(false);
  });
});

describe("reclaimableFromView", () => {
  const grace = 7 * 86_400;

  it("stays false while the grace period could not have elapsed", () => {
    const ended = {...base, status: "Ended" as const};
    expect(reclaimableFromView(ended, Number(base.endTime) + grace, grace)).toBe(false);
  });

  it("is only a lower bound — endedAt may still be later", () => {
    // endTime <= endedAt, so this can read true while the contract would revert. The detail
    // view reads the real endedAt; this exists for the summary table's coarse badge only.
    const ended = {...base, status: "Ended" as const};
    expect(reclaimableFromView(ended, Number(base.endTime) + grace + 1, grace)).toBe(true);
  });

  it("cancelled is reclaimable without a window", () => {
    expect(reclaimableFromView({...base, status: "Cancelled"}, 0, grace)).toBe(true);
  });
});

describe("reclaimAvailableIn", () => {
  const grace = 7 * 86_400;

  it("counts down to the first open second", () => {
    expect(reclaimAvailableIn(1_000, 1_000 + grace, grace)).toBe(1);
    expect(reclaimAvailableIn(1_000, 1_000 + grace + 1, grace)).toBe(0);
  });
});

describe("crossedTierCount", () => {
  it("counts the crossed prefix of the ladder", () => {
    expect(crossedTierCount(BigInt(0), TIERS)).toBe(0);
    expect(crossedTierCount(BigInt(10), TIERS)).toBe(1);
    expect(crossedTierCount(BigInt(99), TIERS)).toBe(2);
    expect(crossedTierCount(BigInt(1_000), TIERS)).toBe(3);
  });
});

describe("unsettledRewards", () => {
  it("excludes tiers the contract already settled", () => {
    // All three crossed; the first two are already settled, so only the last is owed.
    expect(unsettledRewards(BigInt(100), TIERS, 2)).toBe(BigInt(500));
  });

  it("is zero when settlement has caught up with progress", () => {
    expect(unsettledRewards(BigInt(100), TIERS, 3)).toBe(BigInt(0));
  });

  it("pays the full ladder when nothing is settled", () => {
    expect(unsettledRewards(BigInt(100), TIERS, 0)).toBe(BigInt(800));
  });

  it("never goes negative if the counter runs past the crossed tiers", () => {
    // The contract advances the counter even on an exhausted pool, so settled can exceed
    // what progress alone would suggest after a pool top-up.
    expect(unsettledRewards(BigInt(10), TIERS, 3)).toBe(BigInt(0));
  });
});

describe("settledRewards", () => {
  it("sums the rewards of every settled tier", () => {
    expect(settledRewards(TIERS, 2)).toBe(BigInt(300));
    expect(settledRewards(TIERS, 3)).toBe(BigInt(800));
  });

  it("is zero before anything settles", () => {
    expect(settledRewards(TIERS, 0)).toBe(BigInt(0));
  });

  it("clamps a counter that runs past the end of the ladder", () => {
    // Guards against reading a stale/shorter ladder for an address whose chain state advanced
    // further; indexing past the end would otherwise throw on `tiers[i].reward`.
    expect(settledRewards(TIERS, 99)).toBe(BigInt(800));
  });

  it("splits earned from claimable so the two always reconcile", () => {
    // The invariant the promoter dashboard rests on: what has been paid plus what settling would
    // pay equals everything the crossed ladder is worth. If these ever drift the panel is either
    // hiding money or promising money twice.
    const progress = BigInt(100);
    for (const settled of [0, 1, 2, 3]) {
      expect(settledRewards(TIERS, settled) + unsettledRewards(progress, TIERS, settled)).toBe(
        claimableRewards(progress, TIERS),
      );
    }
  });
});


describe("settlementPayout", () => {
  it("caps the payout at the remaining pool and reports the shortfall", () => {
    const {payout, shortfall} = settlementPayout(BigInt(100), TIERS, 0, BigInt(300));
    expect(payout).toBe(BigInt(300));
    expect(shortfall).toBe(BigInt(500));
  });

  it("pays in full when the pool covers it", () => {
    const {payout, shortfall} = settlementPayout(BigInt(100), TIERS, 0, BigInt(10_000));
    expect(payout).toBe(BigInt(800));
    expect(shortfall).toBe(BigInt(0));
  });
});

describe("tierProgressRatio", () => {
  it("measures from the previous threshold, not from zero", () => {
    // 30 of the way from tier 0 (10) to tier 1 (50) is 20/40 = 0.5.
    expect(tierProgressRatio(BigInt(30), TIERS)).toBe(0.5);
  });

  it("is a plain fraction inside the first tier", () => {
    expect(tierProgressRatio(BigInt(5), TIERS)).toBe(0.5);
  });

  it("is complete once the ladder is finished", () => {
    expect(tierProgressRatio(BigInt(1_000), TIERS)).toBe(1);
  });
});

describe("status enum mirror", () => {
  it("keeps the exact Solidity order", () => {
    // Types.CampaignStatus { Pending, Active, Paused, Ended, Cancelled }
    expect(CAMPAIGN_STATUS).toEqual(["Pending", "Active", "Paused", "Ended", "Cancelled"]);
  });
});
