
import {describe, it, expect} from "vitest";
import {
  TOUCH_TYPEHASH,
  attributionDomain,
  buildTouch,
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
      now: 1_700_000,
      maxTouchDuration,
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
