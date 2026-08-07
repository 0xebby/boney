import {describe, it, expect} from "vitest";
import {
  reachFromFollowers,
  boneyScore,
  ethosLevel,
  explainScore,
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
 * `SeedLocal.s.sol`'s ETHOS_WEIGHT/REACH_WEIGHT, a KOL sees one score in the UI and is rejected on
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

  it("matches the seeded KOL fixtures", () => {
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

  it("still scores a KOL whose follower lookup failed, on Ethos alone", () => {
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
