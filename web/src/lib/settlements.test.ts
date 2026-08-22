import {describe, it, expect} from "vitest";
import {
  buildPromoterRows,
  countOrphanPayouts,
  foldSettlements,
  totalPaid,
  unaccountedPaid,
  type SettlementEntry,
} from "./settlements";

const ALICE = "0xAAaa000000000000000000000000000000000001" as const;
const BOB = "0xBbBB000000000000000000000000000000000002" as const;
const CAROL = "0xCccC000000000000000000000000000000000003" as const;

function settled(overrides: Partial<SettlementEntry> = {}): SettlementEntry {
  return {
    promoter: ALICE,
    kpiIndex: 0,
    tier: 0,
    paid: BigInt(100),
    blockNumber: BigInt(1000),
    ...overrides,
  };
}

function joined(promoter: `0x${string}`, blockNumber: number, reputation = 0) {
  return {
    promoter,
    promoterId: `0x${"11".repeat(32)}` as `0x${string}`,
    reputation: BigInt(reputation),
    blockNumber: BigInt(blockNumber),
  };
}

describe("foldSettlements", () => {
  it("sums a promoter's tiers across KPIs", () => {
    const payouts = foldSettlements([
      settled({tier: 0, paid: BigInt(100)}),
      settled({tier: 1, paid: BigInt(250)}),
      settled({kpiIndex: 1, tier: 0, paid: BigInt(50), blockNumber: BigInt(1200)}),
    ]);

    expect(payouts.get(ALICE.toLowerCase())).toEqual({
      promoter: ALICE.toLowerCase(),
      paid: BigInt(400),
      tiers: 3,
      lastBlock: BigInt(1200),
    });
  });

  it("keys promoters case-insensitively", () => {
    const payouts = foldSettlements([
      settled({promoter: ALICE}),
      settled({promoter: ALICE.toLowerCase() as `0x${string}`, tier: 1}),
    ]);

    expect(payouts.size).toBe(1);
    expect(payouts.get(ALICE.toLowerCase())?.paid).toBe(BigInt(200));
  });

  /*
    A tier settles exactly once on chain — `_settledTiers` only advances — so a duplicate is an
    overlapping scan window or a reorg replay, and counting it twice would overstate a payout the
    project is reconciling against its own bank balance.
  */
  it("counts a tier once even when the scan sees it twice", () => {
    const payouts = foldSettlements([
      settled({blockNumber: BigInt(1000)}),
      settled({blockNumber: BigInt(1001)}),
    ]);

    expect(payouts.get(ALICE.toLowerCase())).toEqual({
      promoter: ALICE.toLowerCase(),
      paid: BigInt(100),
      tiers: 1,
      lastBlock: BigInt(1000),
    });
  });

  it("records a clipped payout at what was actually paid", () => {
    // `_settle` pays min(reward, remaining) and settles the tier anyway — see `PoolExhausted`.
    const payouts = foldSettlements([settled({paid: BigInt(0)}), settled({tier: 1, paid: BigInt(7)})]);

    expect(payouts.get(ALICE.toLowerCase())?.paid).toBe(BigInt(7));
    expect(payouts.get(ALICE.toLowerCase())?.tiers).toBe(2);
  });

  it("returns an empty map for no logs", () => {
    expect(foldSettlements([]).size).toBe(0);
    expect(totalPaid(foldSettlements([]))).toBe(BigInt(0));
  });
});

describe("unaccountedPaid", () => {
  it("reports what the scan's floor left out", () => {
    const payouts = foldSettlements([settled({paid: BigInt(100)})]);

    expect(unaccountedPaid(BigInt(400), payouts)).toBe(BigInt(300));
    expect(unaccountedPaid(BigInt(100), payouts)).toBe(BigInt(0));
  });

  it("never reports a negative shortfall", () => {
    const payouts = foldSettlements([settled({paid: BigInt(100)})]);

    expect(unaccountedPaid(BigInt(0), payouts)).toBe(BigInt(0));
  });
});

describe("buildPromoterRows", () => {
  it("keeps promoters who have earned nothing", () => {
    const rows = buildPromoterRows([joined(ALICE, 10), joined(BOB, 20)], foldSettlements([]));

    expect(rows.map((r) => r.promoter)).toEqual([ALICE, BOB]);
    expect(rows.every((r) => r.paid === BigInt(0) && r.tiers === 0)).toBe(true);
  });

  it("orders by amount paid, then by seniority", () => {
    const payouts = foldSettlements([
      settled({promoter: BOB, paid: BigInt(500)}),
      settled({promoter: CAROL, paid: BigInt(500), kpiIndex: 1}),
      settled({promoter: ALICE, paid: BigInt(900)}),
    ]);

    const rows = buildPromoterRows(
      [joined(CAROL, 30), joined(ALICE, 10), joined(BOB, 20)],
      payouts,
    );

    // Alice paid most; Bob and Carol tie on 500 and fall back to who joined first.
    expect(rows.map((r) => r.promoter)).toEqual([ALICE, BOB, CAROL]);
  });

  it("carries the settled tier count onto the row", () => {
    const payouts = foldSettlements([
      settled({promoter: BOB, tier: 0, paid: BigInt(10)}),
      settled({promoter: BOB, tier: 1, paid: BigInt(20)}),
    ]);

    expect(buildPromoterRows([joined(BOB, 5)], payouts)[0]).toMatchObject({
      paid: BigInt(30),
      tiers: 2,
    });
  });
});

describe("countOrphanPayouts", () => {
  it("counts payouts to wallets the join scan never saw", () => {
    const payouts = foldSettlements([
      settled({promoter: ALICE}),
      settled({promoter: BOB, kpiIndex: 1}),
    ]);

    expect(countOrphanPayouts([joined(ALICE, 10)], payouts)).toBe(1);
    expect(countOrphanPayouts([joined(ALICE, 10), joined(BOB, 20)], payouts)).toBe(0);
  });
});
