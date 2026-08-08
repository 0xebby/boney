import {keccak256, encodeAbiParameters} from "viem";
import type {CampaignStatus} from "./types";

/**
 * Promoter-side domain logic — join eligibility, promoter identity, and the tracking link a
 * promoter shares.
 *
 * Pure and React-free (F6). As with `lifecycle.ts`, every rule here mirrors a guard in
 * `Campaign.sol` and names it, because a mirror that drifts either offers a button that reverts
 * or hides one the contract would have allowed. The contract is the security boundary; this
 * decides what to render and why.
 *
 * There is no settlement eligibility here, and that is deliberate. `Campaign.reportUserAction`
 * calls `_settle` inline, which releases escrow straight to the promoter's wallet — so there is no
 * state in which a promoter has earned a tier and still needs to ask for it. Mirroring
 * `Campaign.settle` would only describe a claim step the protocol does not have.
 */

// ── promoter identity ────────────────────────────────────────────

/**
 * The promoter id `join()` will assign — derivable *before* joining.
 *
 * Mirrors `Campaign.join`: `keccak256(abi.encode(address(this), msg.sender))`. Computing it
 * client-side lets the UI show a promoter their tracking link the moment they connect, and lets a
 * live test assert the frontend and the chain agree rather than trusting one of them.
 *
 * `abi.encode` of two static types is a plain 64-byte concatenation of left-padded words, which
 * is exactly what `encodeAbiParameters` produces for `[address, address]` — so this is the same
 * preimage, not a lookalike.
 */
export function derivePromoterId(
  campaign: `0x${string}`,
  promoter: `0x${string}`,
): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [{type: "address"}, {type: "address"}],
      // Lowercased first: `abi.encode` works on the 20 raw bytes, so case carries no meaning
      // here — but viem's encoder rejects a mixed-case address whose EIP-55 checksum does not
      // validate. Normalizing means a hand-typed or non-checksummed address derives the same id
      // as the checksummed one from the wallet, instead of throwing.
      [campaign.toLowerCase() as `0x${string}`, promoter.toLowerCase() as `0x${string}`],
    ),
  );
}

const ZERO_ID = `0x${"00".repeat(32)}` as const;

/** Whether a promoter id from the chain represents an actual join. */
export function hasJoined(promoterId: string | undefined | null): boolean {
  return Boolean(promoterId) && promoterId !== ZERO_ID;
}

// ── join ─────────────────────────────────────────────────────────

export type JoinContext = {
  status: CampaignStatus;
  /** `_promoterIdOf[msg.sender] != 0` on chain. */
  alreadyJoined: boolean;
  /** The wallet's score from the reputation registry. */
  reputation: bigint;
  /** `minReputation`; 0 means the campaign is open to all. */
  minReputation: bigint;
  /** No wallet connected — not a contract rule, but nothing can be signed. */
  connected: boolean;
};

export type Eligibility = {
  ok: boolean;
  /** Why not, when `ok` is false. */
  reason?: string;
  /**
   * Set when the only thing standing in the way is a reputation score that an attestation could
   * raise. The UI offers "verify your BoneyScore" instead of a dead button, because an
   * un-attested wallet reads as score 0 and would otherwise look permanently barred from every
   * gated campaign. Never set for status or already-joined failures, which no attestation fixes.
   */
  actionable?: "attest";
};

/**
 * `join()` — Solidity: `WrongStatus` unless Active **or Pending**, `AlreadyJoined`, and
 * `InsufficientReputation` when `minReputation != 0 && score < minReputation`.
 *
 * Pending is deliberately joinable: promoters can prepare tracking links before a campaign
 * launches. A UI that only offered Join on Active campaigns would hide a legitimate action.
 */
export function canJoin(ctx: JoinContext): Eligibility {
  if (!ctx.connected) return no("Connect a wallet to join this campaign.");

  if (ctx.status !== "Active" && ctx.status !== "Pending") {
    return no(`This campaign is ${ctx.status.toLowerCase()} and is no longer accepting promoters.`);
  }
  if (ctx.alreadyJoined) return no("You have already joined this campaign.");

  // minReputation of 0 disables the check entirely — matching the contract's `!= 0` guard.
  if (ctx.minReputation > BigInt(0) && ctx.reputation < ctx.minReputation) {
    // A score of 0 almost always means "never attested" rather than "genuinely disqualified" —
    // the registry returns 0 for any wallet it has no records for.
    const unverified = ctx.reputation === BigInt(0);
    return {
      ok: false,
      reason: unverified
        ? `This campaign requires a BoneyScore of ${ctx.minReputation.toString()}. Verify your Ethos profile to establish yours.`
        : `Your BoneyScore is ${ctx.reputation.toString()}; this campaign requires ${ctx.minReputation.toString()}.`,
      actionable: "attest",
    };
  }
  return {ok: true};
}

// ── tracking link ────────────────────────────────────────────────

/**
 * The link a promoter shares.
 *
 * Carries the two fields a `Touch` is built from — `campaign` and `promoterId` — because the
 * attribution registry accepts a referral-signed touch only when its `promoterId` is registered to
 * that campaign. `expiresAt` is deliberately *not* in the link: it is set when the touch is
 * signed, from the campaign's own `attributionWindow`, so baking a timestamp into a shared URL
 * would only create a link that silently stops working.
 */
export function trackingLink(
  origin: string,
  campaign: `0x${string}`,
  promoterId: `0x${string}`,
): string {
  const base = origin.replace(/\/+$/, "");
  const params = new URLSearchParams({c: campaign, p: promoterId});
  return `${base}/r?${params.toString()}`;
}

/** Parses a tracking link back into its parts; null when it is not one. */
export function parseTrackingLink(
  url: string,
): {campaign: `0x${string}`; promoterId: `0x${string}`} | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const campaign = parsed.searchParams.get("c");
  const promoterId = parsed.searchParams.get("p");
  if (!campaign || !promoterId) return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(campaign)) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(promoterId)) return null;

  return {
    campaign: campaign as `0x${string}`,
    promoterId: promoterId as `0x${string}`,
  };
}

function no(reason: string): Eligibility {
  return {ok: false, reason};
}
