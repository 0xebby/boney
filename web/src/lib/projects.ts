import {shortAddress} from "./format";
import type {CampaignView} from "./types";

/**
 * Display names for the projects behind each campaign.
 *
 * **Placeholder data.** Nothing on chain carries a project name: `Types.CampaignConfig` stores
 * `project` as an address and no registry maps it to a label. Until a name source exists (an
 * off-chain profile, an ENS reverse record, or a `name` field on the config), the marketplace
 * needs something readable in that column and this is it.
 *
 * Keyed by **campaign id, not project address**, which is deliberate and wrong on purpose. Every
 * seeded campaign on Base Sepolia is owned by the same deployer key, so an address-keyed map would
 * print one identical name down all twelve rows and the column would carry no information. Keying
 * by id gives each row a distinct name so the layout can be judged against realistic data.
 *
 * The consequence to remember when this is replaced: two campaigns from the *same* project
 * currently show *different* names. That is a property of the placeholder, not of the protocol.
 * Real names must key off `view.project` — at which point this map goes away rather than growing.
 */
const PROJECT_NAMES: Record<number, string> = {
  0: "Aerodrome",
  1: "Velodrome",
  2: "Moonwell",
  3: "Aave",
  4: "Compound",
  5: "Balancer",
  6: "Morpho",
  7: "Seamless",
  8: "Extra Finance",
  9: "Overnight",
  10: "Beefy",
  11: "Yearn",
};

/**
 * A campaign's project as a display string.
 *
 * Falls back to the shortened address for any campaign the map does not cover — a newly created
 * campaign gets an id past the seeded range immediately, so the fallback is the normal path for
 * anything real, not an error case. Never returns an empty string: the column always renders
 * something identifying.
 */
export function projectName(view: Pick<CampaignView, "campaignId" | "project">): string {
  return PROJECT_NAMES[Number(view.campaignId)] ?? shortAddress(view.project);
}

/**
 * Whether `projectName` returned a real name rather than the address fallback.
 *
 * Lets a caller style the two differently — a name reads as content, a bare address reads as
 * missing metadata — without duplicating the lookup or string-matching the result.
 */
export function hasProjectName(view: Pick<CampaignView, "campaignId">): boolean {
  return PROJECT_NAMES[Number(view.campaignId)] !== undefined;
}
