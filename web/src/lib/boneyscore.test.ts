import {describe, it, expect} from "vitest";
import {
  reachFromFollowers,
  followersForReach,
  daysUntilExpiry,
  combineFreshness,
  EXPIRY_NOTICE_DAYS,
  boneyScore,
  ethosLevel,
  explainScore,
  scoreSplit,
  SCHEMA_ETHOS,
  SCHEMA_REACH,
  SCHEMA_FOLLOWERS,
  ETHOS_WEIGHT,
  REACH_WEIGHT,
  MAX_ETHOS,
  MAX_BONEY_SCORE,
} from "./boneyscore";

/**
 * BoneyScore arithmetic tests.
 *
 * The weights and the reach curve are consensus-critical in the weak sense that the attestor signs
 * values computed here and `Campaign.join()` gates on the sum. If this drifts from
 * `SeedLocal.s.sol`'s ETHOS_WEIGHT/REACH_WEIGHT, a promoter sees one score in the UI and is rejected on
 * another. The fixed points below are the same ones documented in `plan.md`.
 */

describe("reachFromFollowers", () => {
  it("maps zero followers to zero reach", () => {
    // Not a floor of 1200 or similar: a wallet with no audience contributes no reach at all,
    // otherwise every fresh account starts partway to a gate.
    expect(reachFromFollowers(0)).toBe(0);
  });

  it("reproduces the documented curve", () => {
    expect(reachFromFollowers(1_000)).toBe(1_200);
    expect(reachFromFollowers(8_500)).toBe(1_571);
    expect(reachFromFollowers(24_000)).toBe(1_752);
    expect(reachFromFollowers(100_000)).toBe(2_000);
    expect(reachFromFollowers(1_000_000)).toBe(2_400);
  });

  it("caps at the Ethos ceiling so reach can never outrank the trust term", () => {
    expect(reachFromFollowers(10_000_000)).toBe(MAX_ETHOS);
    expect(reachFromFollowers(10_000_000_000)).toBe(MAX_ETHOS);
  });

  it("is monotonic", () => {
    let previous = -1;
    for (const n of [0, 1, 10, 100, 1_000, 10_000, 100_000, 1_000_000, 10_000_000]) {
      const reach = reachFromFollowers(n);
      expect(reach).toBeGreaterThanOrEqual(previous);
      previous = reach;
    }
  });

  it("returns an integer, since the value is attested as a uint256", () => {
    for (const n of [1, 7, 999, 12_345, 987_654]) {
      expect(Number.isInteger(reachFromFollowers(n))).toBe(true);
    }
  });

  it("treats negative and non-finite counts as no reach rather than propagating NaN", () => {
    // A failed follower lookup must degrade to 0, not poison the score with NaN — the attestor
    // signs this number.
    expect(reachFromFollowers(-5)).toBe(0);
    expect(reachFromFollowers(Number.NaN)).toBe(0);
    // Infinity fails closed at 0 rather than capping at MAX_ETHOS. It is not a real follower count:
    // it arrives when an upstream payload carries something like `1e999`, and `fetchFollowers`'s
    // `count > 0` guard passes it straight through. Reading corrupted data as *maximum* reach would
    // hand out full marks for garbage, so the guard rejects it before the curve caps it.
    expect(reachFromFollowers(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("boneyScore", () => {
  it("weights trust over reach 70/30", () => {
    expect(ETHOS_WEIGHT).toBe(7);
    expect(REACH_WEIGHT).toBe(3);
  });

  it("matches the seeded promoter fixtures", () => {
    // These exact totals are asserted on chain by the seed script and the Foundry test.
    expect(boneyScore({ethos: 2_034, reach: 1_752})).toBe(19_494);
    expect(boneyScore({ethos: 1_450, reach: 1_571})).toBe(14_863);
  });

  it("scores an unattested wallet at zero", () => {
    expect(boneyScore({ethos: 0, reach: 0})).toBe(0);
  });

  it("tops out at MAX_BONEY_SCORE", () => {
    expect(boneyScore({ethos: MAX_ETHOS, reach: MAX_ETHOS})).toBe(MAX_BONEY_SCORE);
    expect(MAX_BONEY_SCORE).toBe(28_000);
  });

  it("still scores a promoter whose follower lookup failed, on Ethos alone", () => {
    // Decision 3 in plan.md: reach degrades to 0 rather than blocking attestation.
    expect(boneyScore({ethos: 2_034, reach: 0})).toBe(14_238);
  });
});

describe("ethosLevel", () => {
  it("labels the bands", () => {
    expect(ethosLevel(2_034)).toBe("exemplary");
    expect(ethosLevel(1_450)).toBe("known");
    expect(ethosLevel(1_200)).toBe("neutral");
    expect(ethosLevel(0)).toBe("untrusted");
  });

  it("labels the Ethos baseline as neutral, not as a passing grade", () => {
    // 1200 is what Ethos returns for an address it has never seen. It must not read as earned.
    expect(ethosLevel(1_200)).toBe("neutral");
  });
});

describe("explainScore", () => {
  it("splits the total into its two contributions", () => {
    const out = explainScore({ethos: 2_034, reach: 1_752});
    expect(out.total).toBe(19_494);
    expect(out.ethosPoints).toBe(14_238);
    expect(out.reachPoints).toBe(5_256);
    expect(out.ethosPoints + out.reachPoints).toBe(out.total);
    expect(out.level).toBe("exemplary");
  });
});

describe("daysUntilExpiry", () => {
  const now = 1_800_000_000;
  const day = 86_400;

  it("stays quiet outside the notice window", () => {
    // A score good for another four months is not news. Warning that early trains people to
    // ignore the banner, so it must read as nothing at all.
    expect(daysUntilExpiry(now + 120 * day, now)).toBeUndefined();
    expect(daysUntilExpiry(now + (EXPIRY_NOTICE_DAYS + 1) * day, now)).toBeUndefined();
  });

  it("speaks up on the window boundary", () => {
    expect(daysUntilExpiry(now + EXPIRY_NOTICE_DAYS * day, now)).toBe(EXPIRY_NOTICE_DAYS);
  });

  it("counts down whole days, rounding toward the nearer deadline", () => {
    // 3.9 days left reads as 3, not 4: a promoter told "4 days" on the last afternoon would be misled.
    expect(daysUntilExpiry(now + Math.floor(3.9 * day), now)).toBe(3);
    expect(daysUntilExpiry(now + day, now)).toBe(1);
  });

  it("reports 0 on the final day rather than going quiet", () => {
    expect(daysUntilExpiry(now + 60, now)).toBe(0);
  });

  it("treats already-expired as not a countdown", () => {
    // `hasExpired` carries that case with different copy; a countdown of 0 would collide with the
    // genuine last-day warning.
    expect(daysUntilExpiry(now - day, now)).toBeUndefined();
    expect(daysUntilExpiry(now, now)).toBeUndefined();
  });

  it("treats a never-expiring schema as silent", () => {
    // 0 is the registry's sentinel for "no window", not a timestamp in 1970.
    expect(daysUntilExpiry(0, now)).toBeUndefined();
    expect(daysUntilExpiry(undefined, now)).toBeUndefined();
  });
});

describe("combineFreshness", () => {
  const fresh = {fresh: true, expiresAt: 2_000, updatedAt: 1_000};
  const expired = {fresh: false, expiresAt: 1_500, updatedAt: 1_000};
  const neverAttested = {fresh: false, expiresAt: 0, updatedAt: 0};

  /**
   * The regression. `isValueFresh` and `expiresAtOf` were added to the registry after the first
   * deployments, so an older one reverts them and every part arrives null. That must read as "this
   * registry has no opinion", not as "expired" — prompting a re-verify against a registry that
   * cannot expire anything would send a promoter in a loop.
   */
  it("reports no support when the registry cannot answer at all", () => {
    expect(combineFreshness([null, null])).toEqual({
      hasExpired: false,
      freshnessSupported: false,
    });
  });

  it("treats an empty part list the same way", () => {
    expect(combineFreshness([]).freshnessSupported).toBe(false);
  });

  it("works off whichever schemas did answer", () => {
    // A partial answer is still an answer; one unreadable schema must not blind the other.
    const out = combineFreshness([expired, null]);
    expect(out.freshnessSupported).toBe(true);
    expect(out.hasExpired).toBe(true);
  });

  it("flags an expired attestation", () => {
    expect(combineFreshness([fresh, expired]).hasExpired).toBe(true);
  });

  it("does not flag a wallet that simply never attested", () => {
    // A never-attested record reads stale too, but the instruction is "verify", not "re-verify".
    expect(combineFreshness([neverAttested]).hasExpired).toBe(false);
  });

  it("warns on the soonest expiry across schemas", () => {
    // Reach expires on a shorter window than Ethos, so it is the one that needs the warning.
    const out = combineFreshness([
      {fresh: true, expiresAt: 9_000, updatedAt: 1_000},
      {fresh: true, expiresAt: 3_000, updatedAt: 1_000},
    ]);
    expect(out.expiresAt).toBe(3_000);
  });

  it("has no expiry date when every schema is non-expiring", () => {
    // maxAge 0 is the registry's sentinel for "never expires", surfaced as 0 from expiresAtOf.
    const out = combineFreshness([{fresh: true, expiresAt: 0, updatedAt: 1_000}]);
    expect(out.freshnessSupported).toBe(true);
    expect(out.expiresAt).toBeUndefined();
    expect(out.hasExpired).toBe(false);
  });
});

describe("followersForReach", () => {
  it("round-trips against reachFromFollowers", () => {
    // The two are inverses, and the discovery page uses this one to state a rank's follower floor.
    // If they drift, a rank's advertised threshold stops matching who actually lands in it.
    for (const followers of [1_000, 8_500, 24_000, 250_000, 7_300_000]) {
      const reach = reachFromFollowers(followers);
      expect(reachFromFollowers(followersForReach(reach))).toBe(reach);
    }
  });
});

describe("schema names", () => {
  /*
   * These strings are the one part of this module that is not arithmetic, and the one part a unit
   * test can still get wrong in a way that only shows up on chain: schema ids are `keccak256(name)`,
   * so a rename silently repoints every read at a schema no registry has ever registered, and
   * `valueOf` answers 0 for an unknown id exactly as it does for an unattested wallet. Nothing
   * throws. Both deployed registries register these three names, verified from their
   * `SchemaRegistered` logs, and `SeedLocal.s.sol` registers the same strings.
   */
  it("matches the names registered on chain", () => {
    expect(SCHEMA_ETHOS).toBe("ETHOS_SCORE");
    expect(SCHEMA_REACH).toBe("X_REACH");
    expect(SCHEMA_FOLLOWERS).toBe("X_FOLLOWERS");
  });
});

describe("scoreSplit", () => {
  it("splits a real promoter's score into trust and reach", () => {
    // Defi_Scribbler on Base Sepolia: Ethos 1,367 and 26,329 followers -> reach 1,768.
    const split = scoreSplit({ethos: 1_367, reach: reachFromFollowers(26_329)});
    expect(split.total).toBe(14_873);
    expect(split.ethosPoints).toBe(9_569);
    expect(split.reachPoints).toBe(5_304);
    expect(split.trustPct).toBe(64);
    expect(split.reachPct).toBe(36);
  });

  it("always sums to 100 so a row never reads 63/38", () => {
    // reachPct is derived rather than rounded independently. Rounding both halves lets a row show
    // a split that does not sum to 100, which destroys the only thing the pair communicates.
    for (const ethos of [1, 7, 333, 1_367, 2_099, 2_800]) {
      for (const reach of [0, 1, 991, 1_768, 2_800]) {
        const split = scoreSplit({ethos, reach});
        if (split.total > 0) expect(split.trustPct + split.reachPct).toBe(100);
      }
    }
  });

  it("reports a pure-reach account as 0% trust", () => {
    // The case the reachOnly marker exists for: no credibility at all, carried entirely by audience.
    const split = scoreSplit({ethos: 0, reach: MAX_ETHOS});
    expect(split.trustPct).toBe(0);
    expect(split.reachPct).toBe(100);
    expect(split.total).toBe(REACH_WEIGHT * MAX_ETHOS);
  });

  it("reports a no-audience account as 100% trust", () => {
    const split = scoreSplit({ethos: MAX_ETHOS, reach: 0});
    expect(split.trustPct).toBe(100);
    expect(split.reachPct).toBe(0);
    expect(split.total).toBe(ETHOS_WEIGHT * MAX_ETHOS);
  });

  it("returns zeroes for an unattested wallet rather than dividing by zero", () => {
    // A wallet with no record is not "all reach" — the caller must be able to tell the two apart.
    const split = scoreSplit({ethos: 0, reach: 0});
    expect(split).toEqual({total: 0, ethosPoints: 0, reachPoints: 0, trustPct: 0, reachPct: 0});
  });

  it("agrees with explainScore and boneyScore on the same inputs", () => {
    // Three functions computing the same arithmetic; a divergence means the table and the join
    // panel would disagree about the same promoter.
    const parts = {ethos: 1_950, reach: 1_204};
    const split = scoreSplit(parts);
    const explained = explainScore(parts);
    expect(split.total).toBe(boneyScore(parts));
    expect(split.ethosPoints).toBe(explained.ethosPoints);
    expect(split.reachPoints).toBe(explained.reachPoints);
  });

  it("puts a maxed-out account at the documented 70/30", () => {
    // The weighting the whole design rests on, visible only when both inputs are at ceiling.
    const split = scoreSplit({ethos: MAX_ETHOS, reach: MAX_ETHOS});
    expect(split.total).toBe(MAX_BONEY_SCORE);
    expect(split.trustPct).toBe(70);
    expect(split.reachPct).toBe(30);
  });
});
