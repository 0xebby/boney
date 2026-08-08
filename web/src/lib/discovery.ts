import {rankOf, rankDistribution, type Rank} from "./ranks";
import type {PromoterEntry, CampaignPromoters} from "./promoters";

/**
 * Promoter discovery — browsing promoters by BoneyScore rank.
 *
 * Pure and React-free (decision F6), same split as `promoters.ts`: the RPC scan lives in
 * `useCampaignPromoters`, and everything that can be *wrong* lives here where a fixture can prove
 * it.
 *
 * ## The number this page browses is a snapshot, not a live score
 *
 * `PromoterJoined(promoter, promoterId, reputation)` carries the score `Campaign.join()` read at
 * the moment of joining. Nothing rewrites it afterwards. Two things make it drift from the
 * promoter's current score:
 *
 *  - **Attestations expire.** `ReputationRegistry.scoreOf` counts only values inside their schema's
 *    `maxAge`, so a promoter who joined at 19,494 can score 5,256 today having done nothing at all.
 *  - **Weights are governable.** `setSchemaWeight` reprices every score retroactively.
 *
 * So this module names the field `scoreAtJoin` rather than `score`, and the UI labels it that way.
 * Ranking a directory on a historical number is the right call — it is what the campaign actually
 * admitted them on, it is the only figure available for every promoter without one `scoreOf` call
 * per wallet, and it cannot silently change under a browsing project. But presenting it as a
 * current score would be a lie, and a project picking promoters off this page deserves to know which
 * question the number answers.
 */

export type RankedPromoter = {
  entry: PromoterEntry;
  /** Score recorded in the join event. A snapshot — see the module note. */
  scoreAtJoin: number;
  rank: Rank;
};

/** Attaches a rank to each promoter, highest score first. */
export function rankPromoters(entries: readonly PromoterEntry[]): RankedPromoter[] {
  return entries
    .map((entry) => {
      const scoreAtJoin = Number(entry.reputation);
      return {entry, scoreAtJoin, rank: rankOf(scoreAtJoin)};
    })
    .sort((a, b) => b.scoreAtJoin - a.scoreAtJoin);
}

export type DiscoveryFilters = {
  /** Campaign address (lowercase), or "all" to browse every promoter at once. */
  campaign: string;
  /** Rank ids to include. Empty means every rank — an empty result set is never the default. */
  ranks: string[];
  /** Lower bound on score at join. */
  minScore: number;
};

export const ALL_CAMPAIGNS = "all";

export const EMPTY_DISCOVERY_FILTERS: DiscoveryFilters = {
  campaign: ALL_CAMPAIGNS,
  ranks: [],
  minScore: 0,
};

/**
 * Every promoter across the selected campaigns, ranked.
 *
 * When one campaign is selected this is simply that campaign's promoters. When browsing all of
 * them, a wallet promoting three campaigns would otherwise appear three times; it is collapsed to
 * one row carrying its highest score, because the question a project is asking on this page is "who
 * are the promoters" and the answer should not repeat a person for being busy.
 */
export function collectPromoters(
  groups: readonly CampaignPromoters[],
  campaign: string,
): RankedPromoter[] {
  const selected =
    campaign === ALL_CAMPAIGNS
      ? groups
      : groups.filter((g) => g.view.campaign.toLowerCase() === campaign.toLowerCase());

  const entries = selected.flatMap((g) => g.promoters);
  if (campaign !== ALL_CAMPAIGNS) return rankPromoters(entries);

  const best = new Map<string, PromoterEntry>();
  for (const entry of entries) {
    const key = entry.promoter.toLowerCase();
    const seen = best.get(key);
    if (!seen || entry.reputation > seen.reputation) best.set(key, entry);
  }
  return rankPromoters([...best.values()]);
}

/** Applies the rank and score filters. */
export function filterPromoters(
  promoters: readonly RankedPromoter[],
  filters: Pick<DiscoveryFilters, "ranks" | "minScore">,
): RankedPromoter[] {
  return promoters.filter((p) => {
    if (filters.ranks.length > 0 && !filters.ranks.includes(p.rank.id)) return false;
    if (p.scoreAtJoin < filters.minScore) return false;
    return true;
  });
}

/** Toggles a rank in a filter list, so the UI can treat the chips as a set. */
export function toggleRank(ranks: readonly string[], id: string): string[] {
  return ranks.includes(id) ? ranks.filter((r) => r !== id) : [...ranks, id];
}

export type DiscoverySummary = {
  count: number;
  /** Highest score at join in the current slice, or 0 when empty. */
  topScore: number;
  /** Median rather than mean: a single Legend would drag an average off every real promoter. */
  medianScore: number;
  distribution: {rank: Rank; count: number}[];
};

export function summarize(promoters: readonly RankedPromoter[]): DiscoverySummary {
  const scores = promoters.map((p) => p.scoreAtJoin).sort((a, b) => a - b);

  let medianScore = 0;
  if (scores.length > 0) {
    const mid = Math.floor(scores.length / 2);
    medianScore =
      scores.length % 2 === 0 ? Math.round((scores[mid - 1] + scores[mid]) / 2) : scores[mid];
  }

  return {
    count: promoters.length,
    topScore: scores.length > 0 ? scores[scores.length - 1] : 0,
    medianScore,
    distribution: rankDistribution(scores),
  };
}
