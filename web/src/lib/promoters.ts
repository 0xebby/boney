import type {CampaignView} from "./types";

/**
 * Promoter discovery — turning `PromoterJoined` logs into a browsable directory.
 *
 * Pure and React-free (decision F6). The RPC calls live in `useCampaignPromoters`; everything
 * that can be *wrong* lives here, where a fixture can prove it.
 *
 * The reason this file exists at all: a campaign stores no promoter list. `Campaign.join()` writes
 * `_promoterIdOf[msg.sender]` and emits `PromoterJoined`, but exposes only point lookups —
 * `promoterIdOf(address)` and `promoterOf(bytes32)`. Both answer "is this address a promoter?",
 * neither answers "who are the promoters?". So a directory has to be reconstructed from logs, and
 * log queries are range-capped, which is what the windowing below is for.
 */

/**
 * Blocks per `getLogs` query.
 *
 * Public RPCs reject wider ranges — Base's endpoint returns `-32602: query exceeds max block
 * range 2000`. Held just under the cap so a provider that counts the range inclusively (making
 * 2000 mean 2001 blocks) does not trip it.
 */
export const MAX_LOG_RANGE = 1900n;

/**
 * Hard ceiling on queries per scan.
 *
 * A directory is a nice-to-have; it must not fire hundreds of requests at a rate-limited public
 * endpoint. When the range needs more windows than this, the scan covers the most RECENT span and
 * reports the gap rather than pretending it looked everywhere — see `WindowPlan.skippedBefore`.
 */
export const MAX_WINDOWS = 24;

export type BlockWindow = {from: bigint; to: bigint};

export type WindowPlan = {
  windows: BlockWindow[];
  /**
   * Set when the range was too wide to cover. Blocks below this were NOT scanned, so promoters
   * who joined before it are missing. The UI says so; it never renders a partial list as complete.
   */
  skippedBefore?: bigint;
};

/**
 * Splits a block range into `getLogs`-sized windows, newest-last.
 *
 * Windows are inclusive on both ends and share no blocks: a window ending at N is followed by one
 * starting at N+1. Overlapping them would double-count a join; leaving a gap would drop one.
 */
export function planWindows(
  from: bigint,
  to: bigint,
  span: bigint = MAX_LOG_RANGE,
  maxWindows: number = MAX_WINDOWS,
): WindowPlan {
  if (span <= 0n) throw new Error("span must be positive");
  if (to < from) return {windows: []};

  // Clamp to the most recent `maxWindows` spans when the range is too wide to cover in full.
  const capacity = span * BigInt(maxWindows);
  const total = to - from + 1n;
  let start = from;
  let skippedBefore: bigint | undefined;
  if (total > capacity) {
    start = to - capacity + 1n;
    skippedBefore = start;
  }

  const windows: BlockWindow[] = [];
  for (let cursor = start; cursor <= to; cursor += span) {
    const end = cursor + span - 1n;
    windows.push({from: cursor, to: end > to ? to : end});
  }

  return skippedBefore === undefined ? {windows} : {windows, skippedBefore};
}

/** One promoter's membership in one campaign, as reconstructed from a log. */
export type PromoterEntry = {
  campaign: `0x${string}`;
  promoter: `0x${string}`;
  promoterId: `0x${string}`;
  reputation: bigint;
  /** Block the join landed in — used to order a campaign's promoters by seniority. */
  blockNumber: bigint;
};

/**
 * Collapses raw entries to one row per (campaign, promoter), keeping the earliest.
 *
 * `Campaign.join()` reverts `AlreadyJoined` on a repeat, so a wallet legitimately appears once per
 * campaign. Duplicates therefore mean a re-org replay or an overlapping window, and the earliest
 * block is the one that actually stuck.
 */
export function dedupePromoters(entries: readonly PromoterEntry[]): PromoterEntry[] {
  const byKey = new Map<string, PromoterEntry>();

  for (const entry of entries) {
    const key = `${entry.campaign.toLowerCase()}:${entry.promoter.toLowerCase()}`;
    const seen = byKey.get(key);
    if (!seen || entry.blockNumber < seen.blockNumber) byKey.set(key, entry);
  }

  return [...byKey.values()];
}

export type CampaignPromoters = {
  view: CampaignView;
  promoters: PromoterEntry[];
};

/**
 * Groups promoters under the campaigns they joined, ordered for display.
 *
 * Campaigns come back in the order given (the caller sorts), and a campaign with no promoters is
 * kept rather than dropped — "nobody has joined yet" is information a visitor deciding where to
 * promote wants, and silently omitting it would misrepresent the marketplace as smaller.
 * Promoters within a campaign are ordered by join block, earliest first.
 */
export function groupByCampaign(
  views: readonly CampaignView[],
  entries: readonly PromoterEntry[],
): CampaignPromoters[] {
  const byCampaign = new Map<string, PromoterEntry[]>();

  for (const entry of entries) {
    const key = entry.campaign.toLowerCase();
    const list = byCampaign.get(key);
    if (list) list.push(entry);
    else byCampaign.set(key, [entry]);
  }

  return views.map((view) => {
    const promoters = (byCampaign.get(view.campaign.toLowerCase()) ?? [])
      .slice()
      .sort((a, b) => (a.blockNumber === b.blockNumber ? 0 : a.blockNumber < b.blockNumber ? -1 : 1));
    return {view, promoters};
  });
}

/** Total promoter rows across every campaign, for the summary tile. */
export function countPromoters(groups: readonly CampaignPromoters[]): number {
  return groups.reduce((total, group) => total + group.promoters.length, 0);
}

/** Distinct promoter wallets across every campaign — a wallet joining three campaigns counts once. */
export function countDistinctPromoters(groups: readonly CampaignPromoters[]): number {
  const wallets = new Set<string>();
  for (const group of groups) {
    for (const promoter of group.promoters) wallets.add(promoter.promoter.toLowerCase());
  }
  return wallets.size;
}
