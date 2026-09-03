import {describe, expect, it} from "vitest";
import {
  countDistinctReferrals,
  countLiveAttributions,
  currentAttributions,
  groupByPromoter,
  promoterKey,
  type AttributionEntry,
} from "./attributions";

const CAMPAIGN = "0x3945D484498F642b308d5C921965DECBF12C9323" as const;
const OTHER = "0xcB0De2b27A8C41e26C7699f302d81937Fa9b3C6e" as const;
const REFERRAL = "0x0b5bFad0000000000000000000000000000000a1" as const;
const REFERRAL_2 = "0x5a597273000000000000000000000000000000b2" as const;
const PROMOTER_A = "0xaa00000000000000000000000000000000000000000000000000000000000001" as const;
const PROMOTER_B = "0xbb00000000000000000000000000000000000000000000000000000000000002" as const;

function entry(over: Partial<AttributionEntry> = {}): AttributionEntry {
  return {
    campaign: CAMPAIGN,
    referral: REFERRAL,
    promoterId: PROMOTER_A,
    signedAt: BigInt(1_000),
    expiresAt: BigInt(5_000),
    blockNumber: BigInt(100),
    ...over,
  };
}

describe("currentAttributions", () => {
  it("keeps the newest touch per campaign and referral", () => {
    const reduced = currentAttributions([
      entry(),
      entry({promoterId: PROMOTER_B, signedAt: BigInt(2_000), blockNumber: BigInt(200)}),
    ]);

    expect(reduced).toHaveLength(1);
    expect(reduced[0]?.promoterId).toBe(PROMOTER_B);
  });

  it("keeps an older touch when nothing supersedes it", () => {
    const reduced = currentAttributions([
      entry({promoterId: PROMOTER_B, signedAt: BigInt(2_000)}),
      entry({signedAt: BigInt(1_000)}),
    ]);

    expect(reduced[0]?.promoterId).toBe(PROMOTER_B);
  });

  it("breaks a signedAt tie on the later block", () => {
    const reduced = currentAttributions([
      entry({blockNumber: BigInt(100)}),
      entry({promoterId: PROMOTER_B, blockNumber: BigInt(101)}),
    ]);

    expect(reduced[0]?.promoterId).toBe(PROMOTER_B);
  });

  it("keys on the campaign as well as the referral", () => {
    const reduced = currentAttributions([entry(), entry({campaign: OTHER})]);

    expect(reduced).toHaveLength(2);
  });

  it("treats casing as the same pair", () => {
    const reduced = currentAttributions([
      entry(),
      entry({
        referral: REFERRAL.toLowerCase() as `0x${string}`,
        promoterId: PROMOTER_B,
        signedAt: BigInt(2_000),
      }),
    ]);

    expect(reduced).toHaveLength(1);
    expect(reduced[0]?.promoterId).toBe(PROMOTER_B);
  });
});

describe("promoterKey", () => {
  it("lowercases both halves", () => {
    expect(promoterKey(CAMPAIGN, PROMOTER_A)).toBe(
      `${CAMPAIGN.toLowerCase()}:${PROMOTER_A.toLowerCase()}`,
    );
  });

  it("separates the same promoter id on two campaigns", () => {
    expect(promoterKey(CAMPAIGN, PROMOTER_A)).not.toBe(promoterKey(OTHER, PROMOTER_A));
  });
});

describe("groupByPromoter", () => {
  it("groups referrals under the promoter they name", () => {
    const grouped = groupByPromoter([
      entry(),
      entry({referral: REFERRAL_2, promoterId: PROMOTER_B}),
    ]);

    expect(grouped.get(promoterKey(CAMPAIGN, PROMOTER_A))).toHaveLength(1);
    expect(grouped.get(promoterKey(CAMPAIGN, PROMOTER_B))).toHaveLength(1);
  });

  it("orders a promoter's referrals newest signature first", () => {
    const grouped = groupByPromoter([
      entry({referral: REFERRAL, signedAt: BigInt(1_000)}),
      entry({referral: REFERRAL_2, signedAt: BigInt(3_000)}),
    ]);

    const rows = grouped.get(promoterKey(CAMPAIGN, PROMOTER_A)) ?? [];
    expect(rows.map((r) => r.referral)).toEqual([REFERRAL_2, REFERRAL]);
  });

  it("returns no key for a promoter with nothing attributed", () => {
    const grouped = groupByPromoter([entry()]);

    expect(grouped.get(promoterKey(CAMPAIGN, PROMOTER_B))).toBeUndefined();
  });
});

describe("countLiveAttributions", () => {
  it("counts only the attributions still inside their window", () => {
    const rows = [entry({expiresAt: BigInt(5_000)}), entry({referral: REFERRAL_2, expiresAt: BigInt(1_500)})];

    expect(countLiveAttributions(rows, 2_000)).toBe(1);
  });

  it("counts everything before the clock is live", () => {
    // `useNow` reports 0 until hydration, and claiming every attribution lapsed for one frame is the
    // worse error.
    const rows = [entry({expiresAt: BigInt(1)})];

    expect(countLiveAttributions(rows, 0)).toBe(1);
  });
});

describe("countDistinctReferrals", () => {
  it("counts a wallet attributed on two campaigns once", () => {
    expect(countDistinctReferrals([entry(), entry({campaign: OTHER})])).toBe(1);
  });

  it("ignores casing", () => {
    const lower = entry({referral: REFERRAL.toLowerCase() as `0x${string}`, campaign: OTHER});

    expect(countDistinctReferrals([entry(), lower])).toBe(1);
  });
});
