import {keccak256, toHex} from "viem";
import type {PublicClient} from "viem";
import {AttributionRegistryAbi} from "./abis";

/**
 * Attribution signing — EIP-712 Touch construction.
 *
 * The typehash and domain must match `AttributionRegistry` exactly. A mismatch is silent: the
 * signature looks fine, but `storeTouch` reverts `InvalidSignature` and the tracking link becomes
 * useless. This is why Phase 8's gate is that a frontend-produced signature must recover to the
 * signer on a live chain — a unit test alone cannot prove domain alignment.
 *
 * Ordering: touches are ordered by their signed `signedAt`, not by relay order. Relayers are
 * adversarial promoters, so whoever transacts last says nothing about what the user meant. A touch
 * only lands if `signedAt > stored.signedAt`, so replaying a superseded signature is a no-op and
 * the fix for the stale-signature replay exploit.
 */

/** Matches `AttributionRegistry.Touch` exactly. */
export type Touch = {
  campaign: `0x${string}`;
  promoterId: `0x${string}`;
  signedAt: bigint;
  expiresAt: bigint;
};

/** The EIP-712 domain for touch signatures. */
export type AttributionDomain = {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: `0x${string}`;
};

/**
 * Builds the EIP-712 domain for a chain. Must match `AttributionRegistry`'s EIP712 constructor:
 * `EIP712("Boney Attribution", "1")`.
 */
export function attributionDomain(
  chainId: number,
  attributionRegistry: `0x${string}`,
): AttributionDomain {
  return {
    name: "Boney Attribution",
    version: "1",
    chainId,
    verifyingContract: attributionRegistry,
  };
}

/**
 * The Touch struct's EIP-712 typehash.
 *
 * Must match `AttributionRegistry.TOUCH_TYPEHASH`:
 * `keccak256("Touch(address campaign,bytes32 promoterId,uint64 signedAt,uint64 expiresAt)")`
 */
export const TOUCH_TYPEHASH = keccak256(
  toHex("Touch(address campaign,bytes32 promoterId,uint64 signedAt,uint64 expiresAt)"),
);

/** The Touch struct's EIP-712 type definition for `signTypedData`. */
export const TOUCH_EIP712_TYPES = {
  Touch: [
    {name: "campaign", type: "address"},
    {name: "promoterId", type: "bytes32"},
    {name: "signedAt", type: "uint64"},
    {name: "expiresAt", type: "uint64"},
  ],
} as const;

/**
 * Reads `maxTouchDuration` from the attribution registry.
 *
 * This is the longest horizon a touch may claim, and it clamps `expiresAt` when building a touch
 * from a campaign's `attributionWindow`. Typically 30 days.
 */
export async function fetchMaxTouchDuration(
  client: PublicClient,
  attributionRegistry: `0x${string}`,
): Promise<bigint> {
  return await client.readContract({
    address: attributionRegistry,
    abi: AttributionRegistryAbi,
    functionName: "maxTouchDuration",
  });
}

/**
 * Builds a Touch ready to sign.
 *
 * `signedAt` is set to the current block timestamp (or the user's local clock approximation —
 * the contract allows a few seconds of clock skew). `expiresAt` is derived from the campaign's
 * `attributionWindow`, clamped to `maxTouchDuration` to satisfy `TouchTooLong`.
 *
 * @param campaign The campaign the user is engaging with.
 * @param promoterId The KOL's opaque id (from `derivePromoterId`).
 * @param attributionWindow The campaign's configured window (seconds).
 * @param maxTouchDuration The registry's cap (seconds).
 * @param now Current timestamp (seconds). Defaults to `Math.floor(Date.now() / 1000)`.
 */
export function buildTouch(
  campaign: `0x${string}`,
  promoterId: `0x${string}`,
  attributionWindow: bigint,
  maxTouchDuration: bigint,
  now: number = Math.floor(Date.now() / 1000),
): Touch {
  const signedAt = BigInt(now);
  // The campaign's window is what the user expects, but the registry enforces a global cap.
  const horizon = attributionWindow < maxTouchDuration ? attributionWindow : maxTouchDuration;
  const expiresAt = signedAt + horizon;

  return {campaign, promoterId, signedAt, expiresAt};
}

/** Eligibility to store a touch. Mirrors `AttributionRegistry.storeTouch` reverts. */
export type TouchEligibility = {
  ok: boolean;
  /** Contract error when `ok` is false. */
  reason?: string;
};

function no(reason: string): TouchEligibility {
  return {ok: false, reason};
}

/**
 * Client-side eligibility for `storeTouch`.
 *
 * Mirrors every guard in `AttributionRegistry.storeTouch`. The contract is the authority;
 * this exists so the UI can block or explain before the user signs.
 *
 * Does not check signature validity — that is always deferred to the chain.
 */
export function canStoreTouch(ctx: {
  touch: Touch;
  promoterRegistered: boolean;
  storedSignedAt: bigint;
  now: number;
  maxTouchDuration: bigint;
}): TouchEligibility {
  const nowTs = BigInt(ctx.now);

  if (ctx.touch.signedAt > nowTs) {
    return no(`TouchNotYetValid: signed at ${ctx.touch.signedAt}, now ${nowTs}`);
  }

  if (ctx.touch.expiresAt <= nowTs) {
    return no(`TouchExpired: expires at ${ctx.touch.expiresAt}, now ${nowTs}`);
  }

  if (ctx.touch.expiresAt > nowTs + ctx.maxTouchDuration) {
    const max = nowTs + ctx.maxTouchDuration;
    return no(`TouchTooLong: expires at ${ctx.touch.expiresAt}, max ${max}`);
  }

  if (!ctx.promoterRegistered) {
    return no(`PromoterNotRegistered: ${ctx.touch.promoterId.slice(0, 10)}...`);
  }

  if (ctx.touch.signedAt <= ctx.storedSignedAt) {
    return no(`TouchNotNewer: signed at ${ctx.touch.signedAt}, stored ${ctx.storedSignedAt}`);
  }

  return {ok: true};
}
