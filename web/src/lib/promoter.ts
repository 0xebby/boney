import {keccak256, encodeAbiParameters} from "viem";
import type {CampaignStatus} from "./types";

/**
 * Promoter-side domain logic — join eligibility, settlement eligibility, promoter Campaign Title, and
 * the tracking link a promoter shares.
 *
 * Pure and React-free (F6). As with `lifecycle.ts`, every rule here mirrors a guard in
 * `Campaign.sol` and names it, because a mirror that drifts either offers a button that reverts
 * or hides one the contract would have allowed. The contract is the security boundary; this
 * decides what to render and why.
 */

// ── promoter Campaign Title ────────────────────────────────────────────

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

// ── settle ───────────────────────────────────────────────────────

export type SettleContext = {
  status: CampaignStatus;
  /** `_promoterIdOf[promoter] != 0` on chain. */
  joined: boolean;
  /**
   * What `settle` would actually transfer right now — `settlementPayout(...).payout` from
   * `lib/campaign`, i.e. the crossed-but-unsettled tiers capped by what escrow can still cover.
   *
   * Not a contract guard: `Campaign.settle` succeeds and pays nothing when the ladder has no
   * unsettled rung. That is the case worth refusing hardest, because it is the only refusal the
   * chain will not make on the promoter's behalf — they would pay gas for a transfer of zero.
   */
  owed: bigint;
  /** When `end()` ran; grace is measured from here, not `endTime`. */
  endedAtSeconds: number;
  claimGraceSeconds: number;
  nowSeconds: number;
  /** No wallet connected — not a contract rule, but nothing can be signed. */
  connected: boolean;
};

/**
 * `settle()` — Solidity: `UnknownKpi`, then `NotJoined`, then a status check that admits **Active**
 * outright and **Ended** only while `block.timestamp <= endedAt + CLAIM_GRACE`.
 *
 * Note what this is *not*. `Campaign.reportUserAction` calls `_settle` inline, and `_progress` is
 * written in exactly one place — the line above that call — so on the happy path a crossed tier is
 * paid in the same transaction that credits it, and `owed` is zero. This mirror exists for the
 * state the contract still allows for: a rung marked crossed but not settled, which
 * `KpiPanel`'s ladder already surfaces as "Unsettled" and which nothing else can clear. Gating on
 * `owed` keeps the button out of the way the rest of the time rather than offering a claim step
 * the protocol does not have.
 *
 * Permissionless by design — `settle` takes the promoter as an argument and pays *that* address,
 * so `connected` here means "someone can sign", not "the promoter is connected".
 *
 * The grace boundary is deliberately inclusive: the contract reverts on
 * `block.timestamp > endedAt + CLAIM_GRACE`, so the boundary second itself is still open. That
 * makes this the exact complement of `isReclaimable` in `lib/campaign`, which opens on the same
 * second — settlement and reclaim can never both be available, and never both be closed.
 */
export function canSettle(ctx: SettleContext): Eligibility {
  if (!ctx.connected) return no("Connect a wallet to settle these rewards.");
  if (!ctx.joined) return no("This wallet has not joined the campaign, so it has earned nothing.");

  if (ctx.status === "Ended") {
    if (ctx.nowSeconds > ctx.endedAtSeconds + ctx.claimGraceSeconds) {
      return no("The settlement window has closed; unspent escrow has returned to the project.");
    }
  } else if (ctx.status !== "Active") {
    return no(
      `Rewards can only be settled while a campaign is active or within its settlement window (currently ${ctx.status.toLowerCase()}).`,
    );
  }

  // Not a revert — `settle` would simply walk a ladder with nothing left to pay and transfer zero.
  if (ctx.owed <= BigInt(0)) return no("Everything you have earned has already been paid out.");

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
