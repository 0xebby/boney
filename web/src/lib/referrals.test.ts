import {describe, it, expect} from "vitest";
import {
  classifyTouch,
  sortReferrals,
  countLive,
  ZERO_ID,
  type ReferredCampaign,
} from "./referrals";
import type {CampaignView} from "./types";

const PROMOTER_ID = `0x${"ab".repeat(32)}` as `0x${string}`;
const OTHER_ID = `0x${"cd".repeat(32)}` as `0x${string}`;

const NOW = 1_786_000_000;

function view(over: Partial<CampaignView> = {}): CampaignView {
  return {
    campaignId: BigInt(1),
    campaign: `0x${"11".repeat(20)}` as `0x${string}`,
    project: `0x${"22".repeat(20)}` as `0x${string}`,
    token: `0x${"33".repeat(20)}` as `0x${string}`,
    rewardPool: BigInt(1000),
    paidOut: BigInt(0),
    status: "Active",
    startTime: BigInt(NOW - 1000),
    endTime: BigInt(NOW + 1000),
    ...over,
  } as CampaignView;
}

function row(over: Partial<ReferredCampaign> = {}): ReferredCampaign {
  return {
    view: view(),
    promoterId: PROMOTER_ID,
    signedAt: BigInt(NOW - 500),
    expiresAt: BigInt(NOW + 500),
    ...over,
  };
}

describe("classifyTouch", () => {
  it("reports none for a null read", () => {
    expect(classifyTouch(null, NOW)).toBe("none");
  });

  it("reports none for an empty slot", () => {
    expect(classifyTouch({promoterId: ZERO_ID, expiresAt: BigInt(0)}, NOW)).toBe("none");
  });

  it("reports live while the window is open", () => {
    expect(classifyTouch({promoterId: PROMOTER_ID, expiresAt: BigInt(NOW + 1)}, NOW)).toBe("live");
  });

  it("reports expired once the window has passed", () => {
    expect(classifyTouch({promoterId: PROMOTER_ID, expiresAt: BigInt(NOW - 1)}, NOW)).toBe(
      "expired",
    );
  });

  it("treats the exact expiry second as expired", () => {
    // Mirrors the contract, which credits only while `block.timestamp < expiresAt`.
    expect(classifyTouch({promoterId: PROMOTER_ID, expiresAt: BigInt(NOW)}, NOW)).toBe("expired");
  });

  it("treats a stopped clock as live rather than expired", () => {
    // `useNow` returns 0 until hydration; every row must not flash "expired" for that frame.
    expect(classifyTouch({promoterId: PROMOTER_ID, expiresAt: BigInt(NOW)}, 0)).toBe("live");
  });

  it("checks the empty slot before expiry", () => {
    // An empty struct has expiresAt 0, which would otherwise read as expired.
    expect(classifyTouch({promoterId: ZERO_ID, expiresAt: BigInt(0)}, NOW)).toBe("none");
  });
});

describe("sortReferrals", () => {
  it("puts live attributions ahead of expired ones", () => {
    const expired = row({signedAt: BigInt(NOW - 10), expiresAt: BigInt(NOW - 5)});
    const live = row({signedAt: BigInt(NOW - 900), expiresAt: BigInt(NOW + 900)});

    const sorted = sortReferrals([expired, live], NOW);
    expect(sorted[0]).toBe(live);
    expect(sorted[1]).toBe(expired);
  });

  it("orders same-status rows by most recently signed", () => {
    const older = row({signedAt: BigInt(NOW - 900), expiresAt: BigInt(NOW + 100)});
    const newer = row({signedAt: BigInt(NOW - 100), expiresAt: BigInt(NOW + 100)});

    expect(sortReferrals([older, newer], NOW)).toEqual([newer, older]);
  });

  it("does not mutate its input", () => {
    const rows = [
      row({signedAt: BigInt(NOW - 10), expiresAt: BigInt(NOW - 5)}),
      row({signedAt: BigInt(NOW - 900), expiresAt: BigInt(NOW + 900)}),
    ];
    const before = [...rows];
    sortReferrals(rows, NOW);
    expect(rows).toEqual(before);
  });

  it("is stable for identical signedAt", () => {
    const a = row({promoterId: PROMOTER_ID, signedAt: BigInt(NOW - 1)});
    const b = row({promoterId: OTHER_ID, signedAt: BigInt(NOW - 1)});
    expect(sortReferrals([a, b], NOW)).toEqual([a, b]);
  });

  it("returns an empty array unchanged", () => {
    expect(sortReferrals([], NOW)).toEqual([]);
  });
});

describe("countLive", () => {
  it("counts only unexpired attributions", () => {
    const rows = [
      row({expiresAt: BigInt(NOW + 1)}),
      row({expiresAt: BigInt(NOW - 1)}),
      row({expiresAt: BigInt(NOW + 100)}),
    ];
    expect(countLive(rows, NOW)).toBe(2);
  });

  it("ignores empty slots", () => {
    const rows = [row({promoterId: ZERO_ID, expiresAt: BigInt(0)}), row()];
    expect(countLive(rows, NOW)).toBe(1);
  });

  it("is zero for no rows", () => {
    expect(countLive([], NOW)).toBe(0);
  });
});
