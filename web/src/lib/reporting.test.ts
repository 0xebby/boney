import {describe, it, expect} from "vitest";
import {
  latestTouches,
  buildKolTargets,
  splitAmount,
  nextTierSeed,
  planKolReport,
  type TouchEntry,
  type KolTarget,
} from "./reporting";
import type {RewardTier} from "./types";

const KOL_A = "0xAAaAaA00000000000000000000000000000000aA" as const;
const KOL_B = "0xBbBbBB00000000000000000000000000000000bB" as const;
const ID_A = "0x000000000000000000000000000000000000000000000000000000000000000a" as const;
const ID_B = "0x000000000000000000000000000000000000000000000000000000000000000b" as const;
const REF_1 = "0x1111111111111111111111111111111111111111" as const;
const REF_2 = "0x2222222222222222222222222222222222222222" as const;
const REF_3 = "0x3333333333333333333333333333333333333333" as const;

const NOW = 1_000;

function touch(over: Partial<TouchEntry> = {}): TouchEntry {
  return {
    referral: REF_1,
    promoterId: ID_A,
    signedAt: BigInt(500),
    expiresAt: BigInt(NOW + 500),
    blockNumber: BigInt(10),
    ...over,
  };
}

function tiers(...pairs: [bigint, bigint][]): RewardTier[] {
  return pairs.map(([threshold, reward]) => ({threshold, reward}) as RewardTier);
}

describe("latestTouches", () => {
  it("keeps one row per referral", () => {
    const out = latestTouches([touch(), touch({referral: REF_2})]);
    expect(out).toHaveLength(2);
  });

  it("keeps the newest touch by signedAt, not by block", () => {
    // A superseding touch relayed in an earlier block still wins: the contract compares signedAt.
    const older = touch({promoterId: ID_A, signedAt: BigInt(500), blockNumber: BigInt(99)});
    const newer = touch({promoterId: ID_B, signedAt: BigInt(700), blockNumber: BigInt(10)});

    const out = latestTouches([older, newer]);
    expect(out).toHaveLength(1);
    expect(out[0]!.promoterId).toBe(ID_B);
  });

  it("is case-insensitive on the referral address", () => {
    const out = latestTouches([
      touch({referral: REF_1}),
      touch({referral: REF_1.toUpperCase() as `0x${string}`, signedAt: BigInt(900)}),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.signedAt).toBe(BigInt(900));
  });
});

describe("buildKolTargets", () => {
  const promoters = [
    {promoter: KOL_A, promoterId: ID_A},
    {promoter: KOL_B, promoterId: ID_B},
  ];

  it("groups referrals under the KOL their touch names", () => {
    const out = buildKolTargets(
      promoters,
      [touch({referral: REF_1, promoterId: ID_A}), touch({referral: REF_2, promoterId: ID_B})],
      NOW,
    );

    expect(out[0]!.live.map((r) => r.referral)).toEqual([REF_1]);
    expect(out[1]!.live.map((r) => r.referral)).toEqual([REF_2]);
  });

  it("lists a KOL with no touches, blocked rather than omitted", () => {
    const out = buildKolTargets(promoters, [touch({promoterId: ID_A})], NOW);

    expect(out).toHaveLength(2);
    expect(out[1]!.blocked).toMatch(/NoAttribution/);
  });

  it("separates an expired attribution from a missing one", () => {
    const out = buildKolTargets(
      promoters,
      [touch({promoterId: ID_A, expiresAt: BigInt(NOW - 1)})],
      NOW,
    );

    expect(out[0]!.live).toHaveLength(0);
    expect(out[0]!.blocked).toMatch(/expired/);
    expect(out[0]!.referrals).toHaveLength(1);
    expect(out[1]!.blocked).toMatch(/NoAttribution/);
  });

  it("does not credit a KOL whose referral re-signed under another KOL", () => {
    // The switch is the case that silently pays the wrong wallet if only block order is consulted.
    const out = buildKolTargets(
      promoters,
      [
        touch({referral: REF_1, promoterId: ID_A, signedAt: BigInt(500)}),
        touch({referral: REF_1, promoterId: ID_B, signedAt: BigInt(900)}),
      ],
      NOW,
    );

    expect(out[0]!.live).toHaveLength(0);
    expect(out[1]!.live.map((r) => r.referral)).toEqual([REF_1]);
  });

  it("orders a KOL's referrals newest touch first", () => {
    const out = buildKolTargets(
      promoters,
      [
        touch({referral: REF_1, signedAt: BigInt(500)}),
        touch({referral: REF_2, signedAt: BigInt(900)}),
      ],
      NOW,
    );

    expect(out[0]!.live.map((r) => r.referral)).toEqual([REF_2, REF_1]);
  });

  it("treats a pre-hydration clock as live rather than expired", () => {
    // nowSeconds === 0 is `useNow` before hydration; claiming every touch lapsed is the worse error.
    const out = buildKolTargets(promoters, [touch({expiresAt: BigInt(1)})], 0);
    expect(out[0]!.live).toHaveLength(1);
  });
});

describe("splitAmount", () => {
  it("splits evenly when it divides", () => {
    expect(splitAmount(BigInt(90), 3)).toEqual([BigInt(30), BigInt(30), BigInt(30)]);
  });

  it("gives the remainder to the last share so the sum is exact", () => {
    const out = splitAmount(BigInt(100), 3);
    expect(out.reduce((a, b) => a + b, BigInt(0))).toBe(BigInt(100));
    expect(out).toEqual([BigInt(33), BigInt(33), BigInt(34)]);
  });

  it("returns nothing for a non-positive count", () => {
    expect(splitAmount(BigInt(10), 0)).toEqual([]);
  });

  it("gives the whole amount to a single share", () => {
    expect(splitAmount(BigInt(7), 1)).toEqual([BigInt(7)]);
  });
});

describe("nextTierSeed", () => {
  const ladder = tiers([BigInt(10), BigInt(1_000)], [BigInt(50), BigInt(5_000)]);

  it("aims at the first uncrossed threshold", () => {
    expect(nextTierSeed(BigInt(0), ladder)).toMatchObject({index: 0, threshold: BigInt(10), delta: BigInt(10)});
    expect(nextTierSeed(BigInt(10), ladder)).toMatchObject({index: 1, threshold: BigInt(50), delta: BigInt(40)});
  });

  it("measures the delta from current progress, not from the previous threshold", () => {
    expect(nextTierSeed(BigInt(30), ladder)).toMatchObject({delta: BigInt(20)});
  });

  it("carries the tier's reward without mixing it into the delta", () => {
    // The seed is KPI units; `reward` is an 18-decimal token figure. Seeding the amount field with
    // the reward would report a payout as progress.
    const seed = nextTierSeed(BigInt(0), ladder);
    expect(seed).toMatchObject({delta: BigInt(10), reward: BigInt(1_000)});
  });

  it("is null once every tier is crossed", () => {
    expect(nextTierSeed(BigInt(50), ladder)).toBeNull();
    expect(nextTierSeed(BigInt(999), ladder)).toBeNull();
  });

  it("is null for a ladder with no tiers", () => {
    expect(nextTierSeed(BigInt(0), [])).toBeNull();
  });
});

describe("planKolReport", () => {
  function kol(over: Partial<KolTarget> = {}): KolTarget {
    const live = [
      {...touch({referral: REF_1}), status: "live" as const},
      {...touch({referral: REF_2}), status: "live" as const},
    ];
    return {promoter: KOL_A, promoterId: ID_A, referrals: live, live, ...over};
  }

  const credited = new Map([
    [REF_1.toLowerCase(), BigInt(5)],
    [REF_2.toLowerCase(), BigInt(0)],
  ]);

  const base = {kol: kol(), amount: BigInt(40), progress: BigInt(10), credited, aggregate: false};

  it("spreads the amount so the KOL advances by exactly that much", () => {
    const plan = planKolReport(base);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    expect(plan.totalDelta).toBe(BigInt(40));
    expect(plan.projectedProgress).toBe(BigInt(50));
    expect(plan.calls.map((c) => c.delta)).toEqual([BigInt(20), BigInt(20)]);
  });

  it("builds a cumulative newTotal from what each referral was already credited", () => {
    // The ABI takes a cumulative figure; sending the raw delta would revert NonMonotonic or
    // silently under-credit a referral that already has progress.
    const plan = planKolReport(base);
    if (!plan.ok) throw new Error("expected a plan");

    expect(plan.calls[0]).toMatchObject({referral: REF_1, newTotal: BigInt(25)});
    expect(plan.calls[1]).toMatchObject({referral: REF_2, newTotal: BigInt(20)});
  });

  it("treats an unseen referral as credited zero", () => {
    const plan = planKolReport({
      ...base,
      kol: kol({
        live: [{...touch({referral: REF_3}), status: "live"}],
      }),
    });
    if (!plan.ok) throw new Error("expected a plan");
    expect(plan.calls[0]!.newTotal).toBe(BigInt(40));
  });

  it("refuses an aggregate KPI", () => {
    const plan = planKolReport({...base, aggregate: true});
    expect(plan).toMatchObject({ok: false});
    if (plan.ok) return;
    expect(plan.reason).toMatch(/AggregateKpi/);
  });

  it("passes the KOL's own block through as the reason", () => {
    const plan = planKolReport({...base, kol: kol({live: [], blocked: "attribution expired"})});
    expect(plan).toMatchObject({ok: false, reason: "attribution expired"});
  });

  it("refuses a zero amount as a finished ladder, not a bad input", () => {
    const plan = planKolReport({...base, amount: BigInt(0)});
    expect(plan).toMatchObject({ok: false});
    if (plan.ok) return;
    expect(plan.reason).toMatch(/already crossed/);
  });

  it("drops referrals whose share rounds to zero", () => {
    // 1 unit across 2 referrals: the first share floors to 0 and must not become a wallet prompt
    // that credits nothing.
    const plan = planKolReport({...base, amount: BigInt(1)});
    if (!plan.ok) throw new Error("expected a plan");

    expect(plan.calls).toHaveLength(1);
    expect(plan.calls[0]).toMatchObject({referral: REF_2, delta: BigInt(1)});
    expect(plan.totalDelta).toBe(BigInt(1));
  });
});
