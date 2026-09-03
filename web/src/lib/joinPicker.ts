import {canJoin, type Eligibility} from "./promoter";
import type {CampaignView} from "./types";

/**
 * The "Join a campaign" picker's option list — which campaigns a promoter is offered, in what
 * order, and why a listed one is unavailable.
 */

/** Statuses `Campaign.join()` accepts; every other status is left out of the picker. */
const OFFERABLE: readonly CampaignView["status"][] = ["Active", "Pending"];

/** One campaign as the picker presents it. */
export type JoinOption = {
  view: CampaignView;
  /** From `canJoin`. `ok` enables the option; `reason` labels a disabled one. */
  eligibility: Eligibility;
};

export type JoinPickerContext = {
  /** The connected wallet's BoneyScore. */
  reputation: bigint;
  /** Lowercased addresses of campaigns this wallet has already joined. */
  joinedAddresses: ReadonlySet<string>;
  /** Whether a wallet is connected at all. */
  connected: boolean;
};

/**
 * Ranks a status for ordering: Active ahead of Pending.
 *
 * @param status The campaign's status.
 * @returns A sort weight, lower first.
 */
function statusWeight(status: CampaignView["status"]): number {
  return status === "Active" ? 0 : 1;
}

/**
 * The campaigns to offer a promoter, joinable ones first.
 *
 * Statuses `Campaign.join()` rejects are omitted entirely. A campaign the wallet has already
 * joined, or whose reputation gate it does not clear, is kept and disabled — its absence would
 * read as the campaign not existing.
 *
 * @param views Every campaign on the marketplace.
 * @param ctx The connected wallet's score, memberships, and connection state.
 * @returns One option per offerable campaign: joinable first, Active before Pending, newest first.
 */
export function joinOptions(
  views: readonly CampaignView[],
  ctx: JoinPickerContext,
): JoinOption[] {
  const options = views
    .filter((view) => OFFERABLE.includes(view.status))
    .map((view) => ({
      view,
      eligibility: canJoin({
        status: view.status,
        alreadyJoined: ctx.joinedAddresses.has(view.campaign.toLowerCase()),
        reputation: ctx.reputation,
        minReputation: view.minReputation,
        connected: ctx.connected,
      }),
    }));

  return options.sort((a, b) => {
    if (a.eligibility.ok !== b.eligibility.ok) return a.eligibility.ok ? -1 : 1;

    const byStatus = statusWeight(a.view.status) - statusWeight(b.view.status);
    if (byStatus !== 0) return byStatus;

    if (a.view.campaignId === b.view.campaignId) return 0;
    return a.view.campaignId > b.view.campaignId ? -1 : 1;
  });
}

/**
 * How many of the options can actually be joined right now.
 *
 * @param options The picker's options.
 * @returns The count whose eligibility is `ok`.
 */
export function joinableCount(options: readonly JoinOption[]): number {
  return options.reduce((total, option) => total + (option.eligibility.ok ? 1 : 0), 0);
}
