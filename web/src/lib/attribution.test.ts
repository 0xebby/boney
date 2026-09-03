
import {describe, it, expect} from "vitest";
import {
  TOUCH_TYPEHASH,
  attributionDomain,
  buildTouch,
  effectiveHorizon,
  canStoreTouch,
} from "./attribution";
import type {Touch} from "./attribution";
import {keccak256, toHex} from "viem";

describe("attributionDomain", () => {
  it("names the domain the contract expects", () => {
    const d = attributionDomain(31337, "0x0000000000000000000000000000000000000001");
    expect(d.name).toBe("Boney Attribution");
    expect(d.version).toBe("1");
    expect(d.chainId).toBe(31337);
    expect(d.verifyingContract).toBe("0x0000000000000000000000000000000000000001");
  });
});

describe("TOUCH_TYPEHASH", () => {
  it("matches the contract's exact value", () => {
    // The contract: keccak256("Touch(address campaign,bytes32 promoterId,uint64 signedAt,uint64 expiresAt)")
    const expected = keccak256(
      toHex("Touch(address campaign,bytes32 promoterId,uint64 signedAt,uint64 expiresAt)"),
    );
    expect(TOUCH_TYPEHASH).toBe(expected);
  });

  it("is a complete bytes32", () => {
    expect(TOUCH_TYPEHASH.length).toBe(66); // "0x" + 64 hex
    expect(TOUCH_TYPEHASH).not.toBe(`0x${"00".repeat(32)}`);
  });
});

describe("buildTouch", () => {
  const campaign = "0x1111111111111111111111111111111111111111" as const;
  const promoterId = `0x${"ab".repeat(32)}` as const;

  it("sets signedAt from the caller's clock", () => {
    const touch = buildTouch(campaign, promoterId, BigInt(7 * 86_400), BigInt(30 * 86_400), 1_700_000);
    expect(touch.signedAt).toBe(BigInt(1_700_000));
  });

  it("expiresAt = now + attributionWindow when inside the cap", () => {
    const now = 1_700_000;
    const touch = buildTouch(campaign, promoterId, BigInt(7 * 86_400), BigInt(30 * 86_400), now);
    expect(touch.expiresAt).toBe(BigInt(now) + BigInt(7 * 86_400));
  });

  it("clamps expiresAt to maxTouchDuration when the campaign's window exceeds it", () => {
    const now = 1_700_000;
    // 14 days from now, but the registry caps everything at 7 days.
    const touch = buildTouch(campaign, promoterId, BigInt(14 * 86_400), BigInt(7 * 86_400), now);
    expect(touch.expiresAt).toBe(BigInt(now) + BigInt(7 * 86_400));
  });

  it("includes the campaign and promoterId from the tracking link", () => {
    const touch = buildTouch(campaign, promoterId, BigInt(7 * 86_400), BigInt(30 * 86_400), 1_700_000);
    expect(touch.campaign).toBe(campaign);
    expect(touch.promoterId).toBe(promoterId);
  });

  it("falls back to the global cap when the campaign window reads zero", () => {
    // Mirrors AttributionRegistry._effectiveMaxDuration: `Campaign` rejects a zero
    // attributionWindow at construction, so zero means "not a campaign", not "no attribution".
    // Building a zero-length touch would produce one that fails TouchExpired immediately.
    const now = 1_700_000;
    const touch = buildTouch(campaign, promoterId, BigInt(0), BigInt(30 * 86_400), now);
    expect(touch.expiresAt).toBe(BigInt(now) + BigInt(30 * 86_400));
  });
});

describe("effectiveHorizon", () => {
  const CAP = BigInt(30 * 86_400);

  it("takes the campaign window when it is tighter", () => {
    expect(effectiveHorizon(BigInt(7 * 86_400), CAP)).toBe(BigInt(7 * 86_400));
  });

  it("clamps to the global cap when the campaign asks for more", () => {
    expect(effectiveHorizon(BigInt(90 * 86_400), CAP)).toBe(CAP);
  });

  it("returns either when they are equal", () => {
    expect(effectiveHorizon(CAP, CAP)).toBe(CAP);
  });

  it("treats zero as 'no window of its own' and uses the cap", () => {
    expect(effectiveHorizon(BigInt(0), CAP)).toBe(CAP);
  });

  it("never returns more than the cap, for any campaign window", () => {
    // The security property: a campaign can narrow its horizon but never widen it, so a hostile
    // or misconfigured campaign cannot grant itself a longer attribution than the protocol allows.
    for (const w of [0, 1, 7, 30, 31, 365, 10_000]) {
      expect(effectiveHorizon(BigInt(w * 86_400), CAP) <= CAP).toBe(true);
    }
  });
});

describe("canStoreTouch", () => {
  const campaign = "0x1111111111111111111111111111111111111111" as const;
  const promoterId = `0x${"ab".repeat(32)}` as const;
  const maxTouchDuration = BigInt(30 * 86_400);

  function fresh(now: number = 1_700_000): Touch {
    return buildTouch(campaign, promoterId, BigInt(7 * 86_400), maxTouchDuration, now);
  }

  function ctx(overrides: Partial<Parameters<typeof canStoreTouch>[0]> = {}) {
    return {
      touch: fresh(),
      promoterRegistered: true,
      storedSignedAt: BigInt(0),
      storedPromoterId: `0x${"00".repeat(32)}` as `0x${string}`,
      storedExpiresAt: BigInt(0),
      now: 1_700_000,
      maxTouchDuration,
      campaignEndTime: BigInt(1_700_000 + 30 * 86_400),
      campaignStatus: 1, // Active
      ...overrides,
    };
  }

  // ── happy path ───────────────────────────────────────────

  it("ok for a fresh, registered touch with no stored predecessor", () => {
    expect(canStoreTouch(ctx())).toEqual({ok: true});
  });

  // ── future signedAt ──────────────────────────────────────

  it("rejects a future signedAt with TouchNotYetValid", () => {
    const r = canStoreTouch(ctx({touch: fresh(1_700_001), now: 1_700_000}));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/TouchNotYetValid.*1700001.*1700000/);
  });

  it("accepts signedAt exactly equal to now", () => {
    const t = buildTouch(campaign, promoterId, BigInt(7 * 86_400), maxTouchDuration, 1_700_000);
    expect(canStoreTouch(ctx({touch: t}))).toEqual({ok: true});
  });

  // ── expiry ───────────────────────────────────────────────

  it("rejects an already-expired touch with TouchExpired", () => {
    const t = buildTouch(campaign, promoterId, BigInt(7 * 86_400), maxTouchDuration, 1_000_000);
    expect(t.expiresAt).toBe(BigInt(1_000_000 + 7 * 86_400));
    // Now is 1_700_000, well past expiresAt.
    const r = canStoreTouch(ctx({touch: t, now: 1_700_000}));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/TouchExpired/);
  });

  it("rejects an expiresAt exactly at now", () => {
    const expiresAt = BigInt(1_700_000);
    const t: Touch = {campaign, promoterId, signedAt: BigInt(1_500_000), expiresAt};
    const r = canStoreTouch(ctx({touch: t, now: 1_700_000}));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/TouchExpired/);
  });

  // ── too long ─────────────────────────────────────────────

  it("rejects a touch whose ttl exceeds maxTouchDuration", () => {
    const t = buildTouch(campaign, promoterId, BigInt(7 * 86_400), maxTouchDuration, 1_700_000);
    const r = canStoreTouch(ctx({
      touch: {...t, expiresAt: t.expiresAt + BigInt(1)},
      now: 1_700_000,
      maxTouchDuration: BigInt(7 * 86_400 - 1),
    }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/TouchTooLong/);
  });

  // ── campaign life ────────────────────────────────────────

  it("rejects a touch once the campaign window has closed", () => {
    const r = canStoreTouch(ctx({campaignEndTime: BigInt(1_699_999)}));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/CampaignOver.*1699999.*1700000/);
  });

  it("accepts a touch on the campaign's final second", () => {
    expect(canStoreTouch(ctx({campaignEndTime: BigInt(1_700_000)}))).toEqual({ok: true});
  });

  it("rejects a touch once the campaign is Ended, even inside its window", () => {
    // endTime is still 30 days out, so only the status check can catch an early end.
    const r = canStoreTouch(ctx({campaignStatus: 3}));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/CampaignTerminal.*3/);
  });

  it("rejects a touch once the campaign is Cancelled", () => {
    const r = canStoreTouch(ctx({campaignStatus: 4}));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/CampaignTerminal.*4/);
  });

  it("accepts Pending, Active and Paused", () => {
    for (const status of [0, 1, 2]) {
      expect(canStoreTouch(ctx({campaignStatus: status}))).toEqual({ok: true});
    }
  });

  it("fails closed on an unrecognised status", () => {
    const r = canStoreTouch(ctx({campaignStatus: 255}));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/CampaignTerminal/);
  });

  it("treats a zero endTime as no campaign window to read, like the registry", () => {
    expect(canStoreTouch(ctx({campaignEndTime: BigInt(0)}))).toEqual({ok: true});
  });

  // ── unregistered promoter ────────────────────────────────

  it("rejects an unregistered promoter id", () => {
    const r = canStoreTouch(ctx({promoterRegistered: false}));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/PromoterNotRegistered/);
  });

  // ── ordering ─────────────────────────────────────────────

  it("rejects a touch not newer than the stored one", () => {
    const t = fresh(1_700_000);
    const r = canStoreTouch(ctx({touch: t, storedSignedAt: t.signedAt}));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/TouchNotNewer/);
  });

  it("accepts a touch strictly newer than the stored one", () => {
    const t = fresh(1_700_000);
    expect(canStoreTouch(ctx({touch: t, storedSignedAt: BigInt(1_699_999)}))).toEqual({ok: true});
  });

  // ── same-promoter re-touch ───────────────────────────────

  it("rejects re-touching the promoter whose stored touch is still live", () => {
    const r = canStoreTouch(ctx({
      touch: fresh(1_700_000),
      storedSignedAt: BigInt(1_699_000),
      storedPromoterId: promoterId,
      storedExpiresAt: BigInt(1_700_001),
    }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/TouchAlreadyActive/);
  });

  it("accepts re-touching the same promoter once their window has lapsed", () => {
    expect(
      canStoreTouch(ctx({
        touch: fresh(1_700_000),
        storedSignedAt: BigInt(1_699_000),
        storedPromoterId: promoterId,
        storedExpiresAt: BigInt(1_700_000),
      })),
    ).toEqual({ok: true});
  });

  it("accepts a switch to a different promoter while the stored touch is live", () => {
    expect(
      canStoreTouch(ctx({
        touch: fresh(1_700_000),
        storedSignedAt: BigInt(1_699_000),
        storedPromoterId: `0x${"cd".repeat(32)}`,
        storedExpiresAt: BigInt(1_700_001),
      })),
    ).toEqual({ok: true});
  });

  // ── missing values ───────────────────────────────────────

  it("handles a zero promoterId like a missing one", () => {
    const r = canStoreTouch(ctx({
      touch: {...fresh(), promoterId: `0x${"00".repeat(32)}`},
      promoterRegistered: false,
    }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/PromoterNotRegistered/);
  });
});
