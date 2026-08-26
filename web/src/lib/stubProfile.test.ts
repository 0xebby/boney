import {describe, it, expect, afterEach, beforeEach} from "vitest";
import {
  DEFAULT_PINS,
  DEV_STUB_WALLET,
  derivedProfile,
  ethosResponseShape,
  stubBoneyScoreFor,
  stubEthosResponse,
  stubFiguresFor,
  stubHandleFor,
  stubPins,
} from "./stubProfile";
import {MAX_BONEY_SCORE, reachFromFollowers} from "./boneyscore";

/**
 * The fabricated profile served to allowlisted wallets.
 *
 * The number that matters is the dev wallet's: 24,620, which is what `ReputationRegistry.scoreOf`
 * already holds for it on Base Sepolia. Changing the pin silently repoints the fixture at a score the
 * chain does not agree with, and every campaign gate in the demo is calibrated against this figure.
 */

const UNPINNED = "0x1111111111111111111111111111111111111111" as const;

const originalEnv = {BONEY_STUB_PINS: process.env.BONEY_STUB_PINS};

beforeEach(() => {
  delete process.env.BONEY_STUB_PINS;
});

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("the dev wallet's pin", () => {
  it("is 2750 Ethos and 30,000 followers", () => {
    const figures = stubFiguresFor(DEV_STUB_WALLET);
    expect(figures.score).toBe(2750);
    expect(figures.followers).toBe(30_000);
    expect(figures.handle).toBe("dev_98405c");
  });

  /** The figure on chain. See the file docstring — this is not a free parameter. */
  it("composes to the 24,620 the chain holds", () => {
    expect(stubBoneyScoreFor(DEV_STUB_WALLET)).toBe(24_620);
    expect(7 * 2750 + 3 * reachFromFollowers(30_000)).toBe(24_620);
  });

  /**
   * Deliberately short of the ceiling. A maxed-out reach would hide any bug in the log normalisation,
   * because every large follower count clamps to the same value.
   */
  it("leaves room below the maximum", () => {
    expect(stubBoneyScoreFor(DEV_STUB_WALLET)).toBeLessThan(MAX_BONEY_SCORE);
    expect(reachFromFollowers(30_000)).toBeLessThan(2800);
  });

  it("is matched in any hex case", () => {
    const upper = `0x${DEV_STUB_WALLET.slice(2).toUpperCase()}`;
    expect(stubFiguresFor(upper).score).toBe(2750);
  });

  it("is the only committed pin", () => {
    expect(Object.keys(DEFAULT_PINS)).toEqual([DEV_STUB_WALLET]);
  });
});

describe("unpinned addresses", () => {
  it("derive a profile from their own bytes", () => {
    const figures = stubFiguresFor(UNPINNED);
    expect(figures.score).toBeGreaterThanOrEqual(600);
    expect(figures.score).toBeLessThanOrEqual(2650);
    expect(figures.followers).toBeGreaterThan(0);
    expect(figures.profileId).toBeGreaterThanOrEqual(10_000);
  });

  /** The `stub_` prefix is how a reader of an attest response tells a derived score from a pinned one. */
  it("are labelled stub_, not dev_", () => {
    expect(stubFiguresFor(UNPINNED).handle).toBe("stub_111111");
    expect(stubFiguresFor(DEV_STUB_WALLET).handle).not.toMatch(/^stub_/);
  });

  it("are stable across calls and independent of case", () => {
    const a = stubFiguresFor(UNPINNED);
    const b = stubFiguresFor(`0x${UNPINNED.slice(2).toUpperCase()}`);
    expect(b).toEqual(a);
  });

  it("spread across the rank ladder rather than clustering", () => {
    const counts = Array.from({length: 40}, (_, i) => {
      const address = `0x${String(i).padStart(40, "a")}`;
      return stubFiguresFor(address).followers;
    });

    // A single point would make the promoter directory useless for exercising ranks — the failure the
    // general stub's global --followers flag has and this does not.
    expect(new Set(counts).size).toBeGreaterThan(30);
    expect(Math.max(...counts) / Math.min(...counts)).toBeGreaterThan(100);
  });

  it("keep smart followers well below the total", () => {
    const {followers, smartFollowers} = stubFiguresFor(UNPINNED);
    expect(smartFollowers).toBeLessThan(followers);
  });
});

describe("BONEY_STUB_PINS", () => {
  it("pins a wallet the defaults do not cover", () => {
    process.env.BONEY_STUB_PINS = `${UNPINNED}:1500:5000`;
    const figures = stubFiguresFor(UNPINNED);

    expect(figures.score).toBe(1500);
    expect(figures.followers).toBe(5000);
    expect(figures.handle).toBe(stubHandleFor(UNPINNED));
  });

  it("overrides a committed default", () => {
    process.env.BONEY_STUB_PINS = `${DEV_STUB_WALLET}:100:200`;
    expect(stubFiguresFor(DEV_STUB_WALLET).score).toBe(100);
  });

  it("takes several, comma-separated", () => {
    process.env.BONEY_STUB_PINS = `${UNPINNED}:1500:5000, 0x2222222222222222222222222222222222222222:1600:6000`;
    expect(Object.keys(stubPins())).toHaveLength(3);
  });

  /**
   * Skipped rather than fatal, unlike the script's `--pin`: this is read inside a request on a deploy,
   * where exiting over a typo in an env var would take the whole site down. The committed default
   * still applies, so the failure mode is "the extra pin did nothing".
   */
  it("skips a malformed entry without throwing", () => {
    process.env.BONEY_STUB_PINS = `nonsense,0x123:1:2,${UNPINNED}:1500:abc`;
    expect(() => stubPins()).not.toThrow();
    expect(Object.keys(stubPins())).toEqual([DEV_STUB_WALLET]);
  });
});

describe("the Ethos wire shape", () => {
  /**
   * `fetchEthosProfile` refuses a null `profileId` — that is its sybil guard — so a synthesised
   * profile that omitted one would be rejected by the very code it exists to feed.
   */
  it("carries a non-null profileId and a claimed status", () => {
    const body = stubEthosResponse(DEV_STUB_WALLET) as Record<string, unknown>;
    expect(body.profileId).toBeGreaterThan(0);
    expect(body.status).toBe("ACTIVE");
  });

  /** `xHandleOf` prefers `username`, so the handle has to be there or reach silently reads zero. */
  it("carries the handle as username", () => {
    const body = stubEthosResponse(DEV_STUB_WALLET) as Record<string, unknown>;
    expect(body.username).toBe("dev_98405c");
    expect(body.userkeys).toContain(`address:${DEV_STUB_WALLET}`);
  });

  it("lowercases the address in the userkey regardless of input case", () => {
    const body = stubEthosResponse(`0x${DEV_STUB_WALLET.slice(2).toUpperCase()}`) as Record<
      string,
      unknown
    >;
    expect(body.userkeys).toContain(`address:${DEV_STUB_WALLET}`);
  });

  /** The script overrides pins from argv, which this module cannot see, so it passes its own figures. */
  it("serialises figures handed to it rather than re-deriving them", () => {
    const body = ethosResponseShape(UNPINNED, {
      score: 42,
      followers: 1,
      smartFollowers: 0,
      profileId: 7,
      handle: "dev_custom",
    }) as Record<string, unknown>;

    expect(body.score).toBe(42);
    expect(body.username).toBe("dev_custom");
    expect(body.profileId).toBe(7);
  });
});

describe("derivedProfile", () => {
  it("is deterministic", () => {
    expect(derivedProfile("abc")).toEqual(derivedProfile("abc"));
  });

  it("separates an address key from a handle key", () => {
    expect(derivedProfile(UNPINNED)).not.toEqual(derivedProfile(`handle:${UNPINNED}`));
  });
});
