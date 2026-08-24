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
 * adversarial promoters, so whoever transacts last says nothing about what the referral meant. A touch
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
 * The protocol-wide ceiling, typically 30 days. Prefer `fetchEffectiveMaxDuration` when building a
 * touch: a campaign may configure a shorter window, and the registry enforces the tighter of the
 * two. This remains exported because it is the bound that applies when there is no campaign window
 * to read.
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
 * Reads the horizon a touch for `campaign` may actually claim.
 *
 * `min(campaign.attributionWindow, maxTouchDuration)`, resolved on chain. This is the exact bound
 * `storeTouch` enforces, so asking the registry beats recomputing the minimum client-side and
 * risking a drift that only shows up as a `TouchTooLong` revert after the referral has signed.
 */
export async function fetchEffectiveMaxDuration(
  client: PublicClient,
  attributionRegistry: `0x${string}`,
  campaign: `0x${string}`,
): Promise<bigint> {
  return await client.readContract({
    address: attributionRegistry,
    abi: AttributionRegistryAbi,
    functionName: "effectiveMaxDuration",
    args: [campaign],
  });
}

/**
 * Builds a Touch ready to sign.
 *
 * `signedAt` is set to the current block timestamp (or the referral's local clock approximation —
 * the contract allows a few seconds of clock skew). `expiresAt` is derived from the campaign's
 * `attributionWindow`, clamped to the registry's cap to satisfy `TouchTooLong`.
 *
 * The clamp is belt-and-braces rather than the enforcement itself: `AttributionRegistry.storeTouch`
 * caps every touch at `min(attributionWindow, maxTouchDuration)` on chain, so a client that skipped
 * this — or a promoter hand-rolling a touch outside the app — is rejected rather than granted a
 * longer horizon than the campaign advertised.
 *
 * @param campaign The campaign the referral is engaging with.
 * @param promoterId The promoter's opaque id (from `derivePromoterId`).
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
  const horizon = effectiveHorizon(attributionWindow, maxTouchDuration);
  const expiresAt = signedAt + horizon;

  return {campaign, promoterId, signedAt, expiresAt};
}

/**
 * The horizon the registry will allow, mirroring `AttributionRegistry._effectiveMaxDuration`.
 *
 * A zero campaign window means "no window of its own" rather than "no attribution": `Campaign`
 * rejects a zero `attributionWindow` at construction, so zero here is a non-campaign address and
 * the global cap stands. Treating it as zero would build a touch that fails `TouchExpired`.
 */
export function effectiveHorizon(attributionWindow: bigint, maxTouchDuration: bigint): bigint {
  if (attributionWindow <= BigInt(0)) return maxTouchDuration;
  return attributionWindow < maxTouchDuration ? attributionWindow : maxTouchDuration;
}

/** Eligibility to store a touch. Mirrors `AttributionRegistry.storeTouch` reverts. */
export type TouchEligibility = {
  ok: boolean;
  /** Contract error when `ok` is false. */
  reason?: string;
};

/**
 * First `Types.CampaignStatus` index the registry treats as terminal — `Ended`, and everything
 * after it. Compared with `>=` rather than by name for the same reason the contract does: an
 * unrecognised status fails closed instead of being waved through.
 */
const TERMINAL_STATUS = 3;

function no(reason: string): TouchEligibility {
  return {ok: false, reason};
}

/**
 * Client-side eligibility for `storeTouch`.
 *
 * Mirrors every guard in `AttributionRegistry.storeTouch`. The contract is the authority;
 * this exists so the UI can block or explain before the referral signs.
 *
 * `maxTouchDuration` here means the **effective** cap for the campaign in question — what
 * `effectiveMaxDuration(campaign)` returns, which is `min(attributionWindow, maxTouchDuration)`.
 * Passing the global cap alone would under-report `TouchTooLong` on a campaign with a tighter
 * window and let the UI wave through a touch the chain rejects.
 *
 * `campaignEndTime` and `campaignStatus` are the campaign-life bound. Both are needed and neither
 * implies the other: a campaign past its `endTime` that nobody has ended yet is still `Active`, and
 * a campaign ended early is terminal while its `endTime` is still in the future. See
 * `AttributionRegistry._requireCampaignOpen`.
 *
 * Does not check signature validity — that is always deferred to the chain.
 */
export function canStoreTouch(ctx: {
  touch: Touch;
  promoterRegistered: boolean;
  storedSignedAt: bigint;
  now: number;
  /** The effective cap for this campaign — see `fetchEffectiveMaxDuration`. */
  maxTouchDuration: bigint;
  /**
   * The campaign's `endTime`. Zero means there is no campaign window to read — the registry
   * treats a registrant that does not answer as unbounded, so this mirrors that rather than
   * rejecting everything.
   */
  campaignEndTime: bigint;
  /** The campaign's `status` as a `Types.CampaignStatus` index. */
  campaignStatus: number;
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

  // Inclusive, like the contract: `endTime` itself still credits a report.
  if (ctx.campaignEndTime > BigInt(0) && nowTs > ctx.campaignEndTime) {
    return no(`CampaignOver: ended at ${ctx.campaignEndTime}, now ${nowTs}`);
  }

  if (ctx.campaignStatus >= TERMINAL_STATUS) {
    return no(`CampaignTerminal: status ${ctx.campaignStatus}`);
  }

  if (!ctx.promoterRegistered) {
    return no(`PromoterNotRegistered: ${ctx.touch.promoterId.slice(0, 10)}...`);
  }

  if (ctx.touch.signedAt <= ctx.storedSignedAt) {
    return no(`TouchNotNewer: signed at ${ctx.touch.signedAt}, stored ${ctx.storedSignedAt}`);
  }

  return {ok: true};
}
