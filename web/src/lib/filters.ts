import type {CampaignStatus, CampaignView} from "./types";

/**
 * Campaign list filtering — pure functions so the behavior is unit-tested without React.
 *
 * These are the "semantic toggles" of the design reference: controls that change which rows are
 * in play, not just how they are sorted.
 */

export type StatusFilter = "all" | CampaignStatus;

export type CampaignFilters = {
  status: StatusFilter;
  /** Free-text match against campaign id, campaign address, project, or token. */
  search: string;
  /** Only campaigns the given wallet could join right now. */
  joinableOnly: boolean;
};

export const EMPTY_FILTERS: CampaignFilters = {
  status: "all",
  search: "",
  joinableOnly: false,
};

/**
 * Whether a wallet with `reputation` could join this campaign.
 * Mirrors `Campaign.join()`: the campaign must be Pending or Active, and the wallet's score must
 * clear `minReputation` (a zero minimum admits anyone).
 */
export function isJoinable(
  view: Pick<CampaignView, "status" | "minReputation">,
  reputation: bigint,
): boolean {
  if (view.status !== "Active" && view.status !== "Pending") return false;
  if (view.minReputation === BigInt(0)) return true;
  return reputation >= view.minReputation;
}

/**
 * Matches a search query against a campaign.
 *
 * A purely numeric query is treated as a campaign id and nothing else. Falling back to a
 * substring match on addresses would make short queries useless: every hex address contains
 * "2", so searching `2` would return essentially every campaign. Address search therefore
 * requires a query that looks like hex — either `0x`-prefixed or at least four hex digits.
 */
function matchesSearch(view: CampaignView, needle: string): boolean {
  const q = needle.trim().toLowerCase();
  if (!q) return true;

  if (/^\d+$/.test(q)) return view.campaignId.toString() === q;

  const looksLikeAddress = q.startsWith("0x") || /^[0-9a-f]{4,}$/.test(q);
  if (!looksLikeAddress) return false;

  return (
    view.campaign.toLowerCase().includes(q) ||
    view.project.toLowerCase().includes(q) ||
    view.token.toLowerCase().includes(q)
  );
}

export function filterCampaigns(
  views: readonly CampaignView[],
  filters: CampaignFilters,
  reputation: bigint,
): CampaignView[] {
  return views.filter((view) => {
    if (filters.status !== "all" && view.status !== filters.status) return false;
    if (!matchesSearch(view, filters.search)) return false;
    if (filters.joinableOnly && !isJoinable(view, reputation)) return false;
    return true;
  });
}

/** Aggregates for the summary stat row, computed over whatever slice is currently shown. */
export type CampaignSummary = {
  count: number;
  activeCount: number;
  totalPool: bigint;
  totalPaidOut: bigint;
};

export function summarize(views: readonly CampaignView[]): CampaignSummary {
  let totalPool = BigInt(0);
  let totalPaidOut = BigInt(0);
  let activeCount = 0;

  for (const v of views) {
    totalPool += v.rewardPool;
    totalPaidOut += v.paidOut;
    if (v.status === "Active") activeCount += 1;
  }

  return {count: views.length, activeCount, totalPool, totalPaidOut};
}
