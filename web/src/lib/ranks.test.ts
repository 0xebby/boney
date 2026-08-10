import {describe, it, expect} from "vitest";
import {
  RANKS,
  rankOf,
  rankById,
  ranksAscending,
  rankExamples,
  rankDistribution,
  minEthosAtFullReach,
  PURE_REACH_CEILING,
} from "./ranks";
import {
  boneyScore,
  reachFromFollowers,
  followersForReach,
  MAX_BONEY_SCORE,
  MAX_ETHOS,
  ETHOS_WEIGHT,
  REACH_WEIGHT,
} from "./boneyscore";

/**
 * Rank ladder tests.
 *
 * The load-bearing property is coverage: every score in 0..MAX_BONEY_SCORE must land in exactly one
 * band. A gap would make `rankOf` fall through to the lowest rank and silently mislabel a real
 * promoter; an overlap would make the label depend on scan order.
 */

describe("RANKS", () => {
  it("covers 0..MAX_BONEY_SCORE with no gap and no overlap", () => {
    const ascending = ranksAscending();
    expect(ascending[0].min).toBe(0);
    expect(ascending[ascending.length - 1].max).toBe(MAX_BONEY_SCORE);

    for (let i = 1; i < ascending.length; i++) {
      // Each band starts exactly one point above the previous one's end.
      expect(ascending[i].min).toBe(ascending[i - 1].max + 1);
    }
  });

  it("has a well-formed band at every rung", () => {
    for (const rank of RANKS) {
      expect(rank.max).toBeGreaterThanOrEqual(rank.min);
      expect(rank.id).toMatch(/^[a-z]+$/);
      expect(rank.name.length).toBeGreaterThan(0);
      expect(rank.blurb.length).toBeGreaterThan(0);
    }
  });

  it("uses unique ids", () => {
    expect(new Set(RANKS.map((r) => r.id)).size).toBe(RANKS.length);
  });

  it("derives every boundary from an Ethos band floor", () => {
    // The ladder's whole claim is that ranks are statements about trust. A boundary that is not a
    // multiple of ETHOS_WEIGHT would be an arbitrary number wearing a rank name.
    for (const rank of RANKS) {
      if (rank.ethosFloor === 0) continue;
      expect(rank.min).toBe(ETHOS_WEIGHT * rank.ethosFloor + 1);
    }
  });
});

describe("rankOf", () => {
  it("puts an unattested score in Drifter", () => {
    expect(rankOf(0).id).toBe("drifter");
  });

  it("treats a negative or non-finite score as unattested rather than throwing", () => {
    // Scores arrive from a bigint chain read; a malformed one should degrade, not crash a table.
    expect(rankOf(-1).id).toBe("drifter");
    expect(rankOf(NaN).id).toBe("drifter");
  });

  it("ranks the maximum score as Legend", () => {
    expect(rankOf(MAX_BONEY_SCORE).id).toBe("legend");
  });

  it("is exhaustive across the whole range", () => {
    // Every 100 points, plus both edges of every band.
    for (let score = 0; score <= MAX_BONEY_SCORE; score += 100) {
      expect(rankOf(score)).toBeDefined();
    }
    for (const rank of RANKS) {
      expect(rankOf(rank.min).id).toBe(rank.id);
      expect(rankOf(rank.max).id).toBe(rank.id);
    }
  });

  it("places the pure-reach ceiling below Netrunner", () => {
    /**
     * The property the ladder exists to express. 8,400 is both `ETHOS_WEIGHT * 1200` and
     * `REACH_WEIGHT * MAX_ETHOS`, so it is the most a zero-Ethos account can ever score. Netrunner
     * must start above it, or the "cannot be faked with followers" claim in its blurb is false.
     */
    expect(PURE_REACH_CEILING).toBe(REACH_WEIGHT * MAX_ETHOS);
    expect(PURE_REACH_CEILING).toBe(ETHOS_WEIGHT * 1200);
    expect(rankOf(PURE_REACH_CEILING).id).toBe("runner");
    expect(rankOf(PURE_REACH_CEILING + 1).id).toBe("netrunner");
  });

  it("flags exactly the bands reachable on followers alone", () => {
    for (const rank of RANKS) {
      expect(rank.reachOnly).toBe(rank.min <= PURE_REACH_CEILING);
    }
  });

  it("cannot rank a follower-only account above Runner", () => {
    // A zero-Ethos account with the largest audience the curve admits.
    const maxReachOnly = boneyScore({ethos: 0, reach: reachFromFollowers(10_000_000)});
    expect(rankOf(maxReachOnly).id).toBe("runner");
  });
});

describe("minEthosAtFullReach", () => {
  /**
   * These tests exist because the ladder's names imply more trust than its boundaries require.
   * `reachOnly` only marks the bands a *zero*-Ethos account clears; every band above it is still
   * reachable on far less credibility than its `ethosFloor` suggests, because a maximal audience is
   * worth 8,400 points. Pinning the real floors keeps /docs from drifting back to the old claim.
   */
  it("is zero for exactly the reachOnly bands", () => {
    for (const rank of RANKS) {
      expect(minEthosAtFullReach(rank) === 0).toBe(rank.reachOnly);
    }
  });

  it("is always at or below the credibility the band is named for", () => {
    for (const rank of RANKS) {
      const {ethosAlone} = rankExamples(rank);
      if (rank.min === 0) continue;
      expect(minEthosAtFullReach(rank)).toBeLessThanOrEqual(ethosAlone);
    }
  });

  it("admits a questionable profile into Samurai on audience alone", () => {
    // The case that motivated the column: an "exemplary"-sounding rank taking an Ethos of 801.
    const samurai = rankById("samurai")!;
    expect(minEthosAtFullReach(samurai)).toBe(801);
    expect(rankOf(boneyScore({ethos: 801, reach: MAX_ETHOS})).id).toBe("samurai");
  });

  it("lets a merely-known profile reach Legend with a maximal audience", () => {
    const legend = rankById("legend")!;
    expect(minEthosAtFullReach(legend)).toBe(1401);
    expect(rankOf(boneyScore({ethos: 1401, reach: MAX_ETHOS})).id).toBe("legend");
    // One point of credibility less and the top band is out of reach at any audience size.
    expect(rankOf(boneyScore({ethos: 1400, reach: MAX_ETHOS})).id).not.toBe("legend");
  });

  it("returns a floor that actually clears the band at full reach", () => {
    for (const rank of RANKS) {
      if (rank.min === 0) continue;
      const score = boneyScore({ethos: minEthosAtFullReach(rank), reach: MAX_ETHOS});
      expect(score).toBeGreaterThanOrEqual(rank.min);
    }
  });
});

describe("rankById", () => {
  it("finds a known rank", () => {
    expect(rankById("ronin")?.name).toBe("Ronin");
  });

  it("returns undefined for an unknown id, so a stale URL filter degrades to no filter", () => {
    expect(rankById("netwatch")).toBeUndefined();
  });
});

describe("rankExamples", () => {
  it("reports the Ethos score that reaches a floor with no audience", () => {
    const netrunner = rankById("netrunner")!;
    const {ethosAlone} = rankExamples(netrunner);
    expect(boneyScore({ethos: ethosAlone, reach: 0})).toBeGreaterThanOrEqual(netrunner.min);
  });

  it("reports followers-alone only where it is actually possible", () => {
    for (const rank of RANKS) {
      const {followersAlone} = rankExamples(rank);
      if (rank.min > PURE_REACH_CEILING) {
        expect(followersAlone).toBeNull();
      } else {
        expect(followersAlone).not.toBeNull();
        // The stated audience must genuinely clear the floor.
        expect(boneyScore({ethos: 0, reach: reachFromFollowers(followersAlone!)})).toBeGreaterThanOrEqual(
          rank.min,
        );
      }
    }
  });

  it("offers a mixed neutral-Ethos route where one exists", () => {
    const fixer = rankById("fixer")!;
    const {mixed} = rankExamples(fixer);
    expect(mixed).not.toBeNull();
    expect(
      boneyScore({ethos: mixed!.ethos, reach: reachFromFollowers(mixed!.followers)}),
    ).toBeGreaterThanOrEqual(fixer.min);
  });

  it("offers no mixed route for ranks a neutral profile cannot reach at any audience", () => {
    // Neutral Ethos caps out at 9,100 + 8,400 = 17,500. Samurai starts at 14,001, Ghost at 15,401,
    // Oracle at 16,801 — all reachable. Legend starts at 18,201, which is not.
    expect(rankExamples(rankById("legend")!).mixed).toBeNull();
  });
});

describe("rankDistribution", () => {
  it("counts promoters into their bands", () => {
    // Real scores from the accounts checked against the live APIs: two unattested wallets, then
    // @sibeleth (10,956), @darak_eth (13,003) and @brave_raf (14,435) — which land three rungs
    // apart despite looking like a tight cluster of numbers.
    const dist = rankDistribution([0, 0, 10_956, 13_003, 14_435]);
    const byId = Object.fromEntries(dist.map((d) => [d.rank.id, d.count]));
    expect(byId.drifter).toBe(2);
    expect(byId.netrunner).toBe(1); // 10,956 — 8,401..11,200
    expect(byId.ronin).toBe(1); //     13,003 — 12,601..14,000
    expect(byId.samurai).toBe(1); //   14,435 — 14,001..15,400
  });

  it("keeps empty bands so the legend does not reflow as promoters join", () => {
    const dist = rankDistribution([]);
    expect(dist).toHaveLength(RANKS.length);
    expect(dist.every((d) => d.count === 0)).toBe(true);
  });
});

describe("followersForReach", () => {
  it("returns the smallest audience that clears the target reach", () => {
    // Not exact equality: follower counts are integers, so most reach values are unattainable.
    // What the discovery page needs is a floor it can advertise honestly — clear the bar, and no
    // smaller number does.
    for (const reach of [100, 400, 1_000, 1_594, 2_098, 2_747, MAX_ETHOS]) {
      const followers = followersForReach(reach);
      expect(reachFromFollowers(followers)).toBeGreaterThanOrEqual(reach);
      if (followers > 0) {
        expect(reachFromFollowers(followers - 1)).toBeLessThan(reach);
      }
    }
  });

  it("names the gap at the bottom of the curve", () => {
    // 1 follower already scores 120, so a reach of 100 belongs to no audience. Asking for it must
    // return the 1 follower that clears it, not 0 — a rank floor of "0 followers" would be a lie.
    expect(followersForReach(100)).toBe(1);
    expect(reachFromFollowers(1)).toBe(120);
    expect(reachFromFollowers(0)).toBe(0);
  });

  it("is unattainable above the ceiling", () => {
    expect(followersForReach(MAX_ETHOS + 1)).toBe(Infinity);
  });

  it("needs nobody for zero reach", () => {
    expect(followersForReach(0)).toBe(0);
    expect(followersForReach(-5)).toBe(0);
  });
});

describe("documented rank invariants", () => {
  // /docs states each rank starts one point above ETHOS_WEIGHT × its Ethos band floor. The offset
  // is what keeps the reachOnly claim true; without it a rank floor would be exactly reachable by
  // a zero-credibility account with a maximum audience.
  it("starts every scored rank one point past its trust-only score", () => {
    for (const rank of RANKS) {
      if (rank.min === 0 || rank.ethosFloor === 0) continue;
      expect(rank.min).toBe(ETHOS_WEIGHT * rank.ethosFloor + 1);
    }
  });

  it("puts the first unfakeable rank exactly one point past pure reach", () => {
    const netrunner = rankById("netrunner");
    expect(netrunner?.min).toBe(PURE_REACH_CEILING + 1);
    expect(netrunner?.reachOnly).toBe(false);
    // The rank below it must still be reach-clearable, or the boundary is in the wrong place.
    expect(rankById("runner")?.reachOnly).toBe(true);
  });

  it("recommends a gate that is a real rank floor", () => {
    // /docs recommends ETHOS_WEIGHT × 1800 + 1 as a practical default and calls it Ronin's floor.
    expect(rankOf(ETHOS_WEIGHT * 1800 + 1).id).toBe("ronin");
    expect(rankById("ronin")?.min).toBe(ETHOS_WEIGHT * 1800 + 1);
  });
});
