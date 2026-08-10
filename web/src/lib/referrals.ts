import type {CampaignView} from "./types";

/**
 * Referral attribution — reading back the touches `/r` writes.
 *
 * Pure and React-free (decision F6); the RPC calls live in `useReferredCampaigns`.
 *
 * Vocabulary, per `indexerCore`'s note: the contract calls the attributed wallet `user`, and
 * everywhere else in this codebase it is a **referral** — someone who arrived through a promoter's
 * tracking link and signed a Touch. A promoter promotes; a referral is promoted *to*.
 *
 * Why this reads state rather than scanning `TouchStored` logs: `touchOf(campaign, referral)` is a
 * point lookup returning the whole struct, so N campaigns cost N calls with no windowing, no
 * range caps, and no partial-history caveat. `AttributionRegistry` keeps only the newest touch per
 * `(campaign, user)` pair — a later touch overwrites an earlier one — so the stored value *is* the
 * live answer. Scanning logs would rebuild the same fact more expensively and then have to
 * re-derive which one won.
 */

/** The `Touch` struct as `touchOf` returns it. */
export type StoredTouch = {
  campaign: `0x${string}`;
  promoterId: `0x${string}`;
  signedAt: bigint;
  expiresAt: bigint;
};

export const ZERO_ID = "0x0000000000000000000000000000000000000000000000000000000000000000";

export type TouchStatus =
  /** No touch on record — this wallet was never attributed on this campaign. */
  | "none"
  /** Attributed and still crediting. */
  | "live"
  /** Attributed, but the window has passed; actions no longer credit the promoter. */
  | "expired";

/**
 * Classifies what a stored touch means right now.
 *
 * Takes only the two fields the question turns on, so a raw `touchOf` result and an assembled
 * `ReferredCampaign` row both satisfy it without either being converted into the other.
 *
 * The expired case is kept rather than collapsed into "none" because the two are different facts
 * and the page says so: an expired touch is a relationship that existed and lapsed, which is worth
 * showing, while "none" means the wallet never followed that promoter's link at all. Silently
 * dropping expired rows would make a referral's history shrink for no visible reason.
 *
 * A zero `promoterId` is how the registry represents "nothing stored" — a struct read from an
 * empty slot returns zeroes rather than reverting, so this is the only way to tell them apart.
 * Checked before expiry, since an empty struct also has `expiresAt` of 0 and would otherwise
 * classify as expired.
 */
export function classifyTouch(
  touch: {promoterId: `0x${string}`; expiresAt: bigint} | null,
  nowSeconds: number,
): TouchStatus {
  if (!touch || touch.promoterId === ZERO_ID) return "none";
  // `nowSeconds === 0` means the clock is not live yet (`useNow` before hydration). Treat it as
  // live rather than expired: claiming every attribution lapsed for one frame is the worse error.
  if (nowSeconds > 0 && touch.expiresAt <= BigInt(nowSeconds)) return "expired";
  return "live";
}

/** One campaign the connected wallet has been attributed on. */
export type ReferredCampaign = {
  view: CampaignView;
  promoterId: `0x${string}`;
  /** The promoter's wallet, resolved from `promoterId` — undefined if that lookup failed. */
  promoter?: `0x${string}`;
  signedAt: bigint;
  expiresAt: bigint;
};

/**
 * Orders referral rows for display: live attributions first, then by most recently signed.
 *
 * Recency beats campaign id here — unlike the promoter table, which sorts by id — because a
 * referral's list is a history of things that happened *to* them, and the useful question is "what
 * am I currently credited to", not "which campaign has the lowest number".
 */
export function sortReferrals(
  rows: readonly ReferredCampaign[],
  nowSeconds: number,
): ReferredCampaign[] {
  const rank = (r: ReferredCampaign) => (classifyTouch(r, nowSeconds) === "live" ? 0 : 1);

  return rows.slice().sort((a, b) => {
    const byStatus = rank(a) - rank(b);
    if (byStatus !== 0) return byStatus;
    if (a.signedAt === b.signedAt) return 0;
    return a.signedAt > b.signedAt ? -1 : 1;
  });
}

/** How many of these attributions are still crediting — for the summary tile. */
export function countLive(rows: readonly ReferredCampaign[], nowSeconds: number): number {
  return rows.filter((r) => classifyTouch(r, nowSeconds) === "live").length;
}
