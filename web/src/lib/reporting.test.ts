import {describe, it, expect} from "vitest";
import {
  latestTouches,
  earliestSignedAt,
  buildKolTargets,
  describeCeiling,
  splitAmount,
  nextTierSeed,
  planKolReport,
  planObservedReport,
  type TouchEntry,
  type KolTarget,
  type ObservedReferral,
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

describe("earliestSignedAt", () => {
  it("keeps the oldest touch per referral, not the newest", () => {
    const out = earliestSignedAt([
      touch({signedAt: BigInt(500), promoterId: ID_A}),
      touch({signedAt: BigInt(900), promoterId: ID_B}),
    ]);
    expect(out.get(REF_1.toLowerCase())).toBe(BigInt(500));
  });

  it("is keyed lowercase, so a checksummed log matches a lowercased lookup", () => {
    const out = earliestSignedAt([touch({referral: REF_2, signedAt: BigInt(700)})]);
    expect(out.get(REF_2.toLowerCase())).toBe(BigInt(700));
  });

  it("tracks referrals independently", () => {
    const out = earliestSignedAt([
      touch({referral: REF_1, signedAt: BigInt(500)}),
      touch({referral: REF_2, signedAt: BigInt(800)}),
    ]);
    expect(out.get(REF_1.toLowerCase())).toBe(BigInt(500));
    expect(out.get(REF_2.toLowerCase())).toBe(BigInt(800));
  });

  it("omits a referral with no touch at all", () => {
    expect(earliestSignedAt([]).has(REF_1.toLowerCase())).toBe(false);
  });

  /**
   * The campaign-2 regression. A referral moves from promoter A to B after A was credited 3. Keying
   * the floor to the *current* touch makes B's recomputed total equal what A already banked, so
   * `Campaign` credits `newTotal - _userCredited` = 0 and B can never earn. The earliest touch keeps
   * the total cumulative across both eras, so B is credited exactly its own 3.
   */
  it("keeps a switched referral's total cumulative across both promoters", () => {
    const history = [
      touch({signedAt: BigInt(500), promoterId: ID_A}),
      touch({signedAt: BigInt(900), promoterId: ID_B}),
    ];
    const floor = earliestSignedAt(history).get(REF_1.toLowerCase())!;
    const live = latestTouches(history);

    // Who gets credited comes from the latest touch; from when counts comes from the earliest.
    expect(live[0]!.promoterId).toBe(ID_B);
    expect(floor).toBe(BigInt(500));

    // Six actions spread across both eras, three of them before B took over. Measured from the
    // earliest touch all six count, so newTotal is 6 against A's banked 3 -> B is credited 3.
    const actionTimes = [BigInt(600), BigInt(700), BigInt(800), BigInt(950), BigInt(960), BigInt(970)];
    const cumulative = actionTimes.filter((t) => t >= floor).length;
    const alreadyCreditedUnderA = 3;
    expect(cumulative).toBe(6);
    expect(cumulative - alreadyCreditedUnderA).toBe(3);

    // Measured from the live touch instead, only three count and B is credited nothing.
    const fromLatest = actionTimes.filter((t) => t >= live[0]!.signedAt).length;
    expect(fromLatest - alreadyCreditedUnderA).toBe(0);
  });
});

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

describe("planObservedReport", () => {
  function kol(over: Partial<KolTarget> = {}): KolTarget {
    const live = [
      {...touch({referral: REF_1}), status: "live" as const},
      {...touch({referral: REF_2}), status: "live" as const},
    ];
    return {promoter: KOL_A, promoterId: ID_A, referrals: live, live, ...over};
  }

  function seen(...pairs: [`0x${string}`, bigint][]): Map<string, ObservedReferral> {
    return new Map(
      pairs.map(([referral, observed]) => [
        referral.toLowerCase(),
        {referral, observed, actions: [{timestamp: BigInt(NOW), amount: observed}]},
      ]),
    );
  }

  const credited = new Map([
    [REF_1.toLowerCase(), BigInt(5)],
    [REF_2.toLowerCase(), BigInt(0)],
  ]);

  const base = {
    kol: kol(),
    observed: seen([REF_1, BigInt(12)], [REF_2, BigInt(3)]),
    credited,
    aggregate: false,
    hasSource: true,
    progress: BigInt(5),
  };

  it("credits the observed total, not a tier threshold", () => {
    // The whole point: the figures come from the logs. A ladder is never consulted, so a report
    // cannot be aimed at a payout.
    const plan = planObservedReport(base);
    if (!plan.ok) throw new Error("expected a plan");

    expect(plan.calls.map((c) => c.newTotal)).toEqual([BigInt(12), BigInt(3)]);
    expect(plan.totalDelta).toBe(BigInt(10)); // 12 - 5 already credited, plus 3 - 0
    expect(plan.projectedProgress).toBe(BigInt(15));
  });

  it("reports nothing for a KOL whose referrals have not acted", () => {
    const plan = planObservedReport({...base, observed: new Map()});
    expect(plan).toMatchObject({ok: false});
    if (plan.ok) return;
    expect(plan.reason).toMatch(/no KPI actions observed/);
  });

  it("refuses a KPI with no event source rather than inventing a figure", () => {
    const plan = planObservedReport({...base, hasSource: false});
    expect(plan).toMatchObject({ok: false});
    if (plan.ok) return;
    expect(plan.reason).toMatch(/no event source/);
  });

  it("is idempotent once everything observed is credited", () => {
    // `newTotal` is cumulative, so a second click over the same logs has nothing to send — the same
    // property that makes re-running the indexer safe.
    const plan = planObservedReport({
      ...base,
      credited: new Map([
        [REF_1.toLowerCase(), BigInt(12)],
        [REF_2.toLowerCase(), BigInt(3)],
      ]),
    });
    expect(plan).toMatchObject({ok: false});
    if (plan.ok) return;
    expect(plan.reason).toMatch(/already credited/);
  });

  it("distinguishes 'nothing new' from 'nothing happened'", () => {
    const nothingNew = planObservedReport({
      ...base,
      observed: seen([REF_1, BigInt(5)]),
      credited: new Map([[REF_1.toLowerCase(), BigInt(5)]]),
    });
    if (nothingNew.ok) throw new Error("expected a refusal");
    expect(nothingNew.reason).toMatch(/already credited/);

    const nothingHappened = planObservedReport({...base, observed: new Map()});
    if (nothingHappened.ok) throw new Error("expected a refusal");
    expect(nothingHappened.reason).toMatch(/not .*observed|no KPI actions/);
  });

  it("skips a referral with partial credit but keeps the others", () => {
    const plan = planObservedReport({
      ...base,
      credited: new Map([
        [REF_1.toLowerCase(), BigInt(12)],
        [REF_2.toLowerCase(), BigInt(1)],
      ]),
    });
    if (!plan.ok) throw new Error("expected a plan");

    expect(plan.calls).toHaveLength(1);
    expect(plan.calls[0]).toMatchObject({referral: REF_2, newTotal: BigInt(3), delta: BigInt(2)});
  });

  it("ignores activity from a wallet that is not a live referral of this KOL", () => {
    // Observed totals are folded from logs filtered by referral, but a stale map entry must not
    // become a call: `reportUserAction` would revert NoAttribution for a wallet this KOL never had.
    const plan = planObservedReport({
      ...base,
      kol: kol({live: [{...touch({referral: REF_1}), status: "live"}]}),
      observed: seen([REF_1, BigInt(12)], [REF_3, BigInt(99)]),
    });
    if (!plan.ok) throw new Error("expected a plan");

    expect(plan.calls).toHaveLength(1);
    expect(plan.calls[0]!.referral).toBe(REF_1);
  });

  it("carries per-action evidence through for a verifier-gated KPI", () => {
    const plan = planObservedReport(base);
    if (!plan.ok) throw new Error("expected a plan");
    expect(plan.calls[0]!.actions).toEqual([{timestamp: BigInt(NOW), amount: BigInt(12)}]);
  });

  it("refuses an aggregate KPI", () => {
    const plan = planObservedReport({...base, aggregate: true});
    expect(plan).toMatchObject({ok: false});
    if (plan.ok) return;
    expect(plan.reason).toMatch(/AggregateKpi/);
  });

  it("passes the KOL's own block through as the reason", () => {
    const plan = planObservedReport({
      ...base,
      kol: kol({live: [], blocked: "attribution expired"}),
    });
    expect(plan).toMatchObject({ok: false, reason: "attribution expired"});
  });
});

/**
 * The ceiling readout exists for one specific failure: a gated KPI whose relayer has not run credits
 * nothing, and `Campaign` returns early rather than reverting — so the report transaction *succeeds*
 * and the only symptom is a progress bar that never moves. Verified on Base Sepolia: a claim of 12
 * confirmed successfully and left progress at 0.
 */
describe("describeCeiling", () => {
  const base = {gated: true, configured: true, ceiling: BigInt(50), measured: BigInt(12)};

  it("stays quiet for a KPI nothing caps", () => {
    expect(describeCeiling({...base, gated: false})).toEqual({kind: "ungated"});
  });

  /** A relayer delay is temporary; a missing config never resolves. The panel must not conflate them. */
  it("separates a missing config from an idle relayer", () => {
    expect(describeCeiling({...base, configured: false, ceiling: BigInt(0)})).toEqual({
      kind: "unconfigured",
    });
    expect(describeCeiling({...base, ceiling: BigInt(0)})).toEqual({kind: "blocked"});
  });

  it("reports a ceiling below the measurement as capped, with both figures", () => {
    expect(describeCeiling({...base, ceiling: BigInt(5), measured: BigInt(12)})).toEqual({
      kind: "capped",
      ceiling: BigInt(5),
      measured: BigInt(12),
    });
  });

  it("clears when the ceiling covers the measurement", () => {
    expect(describeCeiling(base)).toEqual({kind: "clear", ceiling: BigInt(50)});
  });

  /** `min(claim, ceiling)` credits the claim in full at equality, so this must not read as capped. */
  it("treats an exactly-equal ceiling as clear, not capped", () => {
    const r = describeCeiling({...base, ceiling: BigInt(12), measured: BigInt(12)});
    expect(r).toEqual({kind: "clear", ceiling: BigInt(12)});
  });

  /** An ungated KPI is quiet even with no config, since no ceiling applies either way. */
  it("prefers ungated over unconfigured when both hold", () => {
    expect(describeCeiling({gated: false, configured: false, ceiling: BigInt(0), measured: BigInt(9)}))
      .toEqual({kind: "ungated"});
  });
});
