import {shortAddress} from "./format";
import type {CampaignView} from "./types";

/**
 * Display name for a campaign.
 *
 * Reads the name off the campaign itself. Until `Types.CampaignConfig` carried a `name`, this file
 * held a hardcoded map from campaign id to a plausible project label — deliberately wrong data whose
 * only job was to stop the marketplace's name column rendering twelve identical addresses. The
 * contract now stores a name the creator supplied, unique across the registry and validated for
 * length and charset, so the map is gone rather than grown.
 *
 * Note what changed semantically: the old map keyed by *campaign id*, so two campaigns from one
 * project showed different names, which was a property of the placeholder. That is now the real
 * behaviour by design — a name belongs to a campaign, not to the wallet behind it, so one project
 * running three campaigns names each of them separately.
 */
export function projectName(view: Pick<CampaignView, "name" | "project">): string {
  // Falls back to the shortened address rather than an empty cell. A campaign created through this
  // app or any of the seed scripts always has a name; a campaign constructed directly against the
  // contracts is validated too, so the fallback is defensive rather than a path anything takes.
  return view.name?.trim() || shortAddress(view.project);
}

/**
 * Whether `projectName` returned a real name rather than the address fallback.
 *
 * Lets a caller style the two differently — a name reads as content, a bare address reads as
 * missing metadata — without duplicating the lookup or string-matching the result.
 */
export function hasProjectName(view: Pick<CampaignView, "name">): boolean {
  return Boolean(view.name?.trim());
}
