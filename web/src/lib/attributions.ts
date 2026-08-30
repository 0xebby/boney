import {classifyTouch} from "./referrals";

/**
 * Referral attributions grouped by the promoter holding them.
 *
 * Pure and React-free; the subgraph query lives in `attributionGraph.ts` and the RPC fallback in
 * `useCampaignAttributions`.
 *
 * The contract calls the attributed wallet `user`; here it is a **referral**, matching the rest of
 * the app.
 */

/** One touch, as either the subgraph or a `TouchStored` log reports it. */
export type AttributionEntry = {
  campaign: `0x${string}`;
  referral: `0x${string}`;
  promoterId: `0x${string}`;
  signedAt: bigint;
  expiresAt: bigint;
  /** Block the touch landed in, used to break a `signedAt` tie. */
  blockNumber: bigint;
};

/**
 * Collapses entries to the one touch per `(campaign, referral)` the registry actually holds.
 *
 * `AttributionRegistry.storeTouch` accepts a new touch only when `signedAt` is strictly greater, so
 * the newest `signedAt` wins; a tie falls to the later block.
 *
 * @param entries Raw entries, in any order, possibly spanning several campaigns.
 * @returns One entry per campaign and referral.
 */
export function currentAttributions(entries: readonly AttributionEntry[]): AttributionEntry[] {
  const byPair = new Map<string, AttributionEntry>();

  for (const entry of entries) {
    const key = `${entry.campaign.toLowerCase()}:${entry.referral.toLowerCase()}`;
    const seen = byPair.get(key);
    const newer =
      !seen ||
      entry.signedAt > seen.signedAt ||
      (entry.signedAt === seen.signedAt && entry.blockNumber > seen.blockNumber);
    if (newer) byPair.set(key, entry);
  }

  return [...byPair.values()];
}

/**
 * The map key one promoter's referrals are stored under.
 *
 * A promoter id is minted per campaign, so the campaign has to be part of the key.
 *
 * @param campaign Campaign address, in any casing.
 * @param promoterId The campaign-bound promoter id, in any casing.
 * @returns A lowercased composite key.
 */
export function promoterKey(campaign: string, promoterId: string): string {
  return `${campaign.toLowerCase()}:${promoterId.toLowerCase()}`;
}

/**
 * Groups current attributions under the promoter each names, newest signature first.
 *
 * @param entries Entries already reduced by `currentAttributions`.
 * @returns Referrals per `promoterKey`.
 */
export function groupByPromoter(
  entries: readonly AttributionEntry[],
): Map<string, AttributionEntry[]> {
  const byPromoter = new Map<string, AttributionEntry[]>();

  for (const entry of entries) {
    const key = promoterKey(entry.campaign, entry.promoterId);
    const list = byPromoter.get(key);
    if (list) list.push(entry);
    else byPromoter.set(key, [entry]);
  }

  for (const list of byPromoter.values()) {
    list.sort((a, b) => (a.signedAt === b.signedAt ? 0 : a.signedAt > b.signedAt ? -1 : 1));
  }

  return byPromoter;
}

/**
 * How many of these attributions are still inside their window.
 *
 * @param entries Attributions to count.
 * @param nowSeconds Current unix time, or `0` before the clock is live.
 * @returns The number still crediting.
 */
export function countLiveAttributions(
  entries: readonly AttributionEntry[],
  nowSeconds: number,
): number {
  return entries.filter((e) => classifyTouch(e, nowSeconds) === "live").length;
}

/**
 * Distinct referral wallets across every campaign.
 *
 * @param entries Attributions to count.
 * @returns The number of distinct wallets.
 */
export function countDistinctReferrals(entries: readonly AttributionEntry[]): number {
  const wallets = new Set<string>();
  for (const entry of entries) wallets.add(entry.referral.toLowerCase());
  return wallets.size;
}
