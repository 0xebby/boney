"use client";

import {useAccount} from "wagmi";
import {useCampaigns} from "@/hooks/useCampaigns";
import {useJoinedCampaigns} from "@/hooks/useJoinedCampaigns";

/**
 * Whether the connected wallet has joined at least one campaign.
 *
 * Exists so the navigation can hide the Promoters tab from wallets it would only ever show an
 * empty dashboard to. There is no cheap way to ask this: a `Campaign` stores membership as
 * `_promoterIdOf[wallet]` and exposes only point lookups, and no registry aggregates them, so the
 * answer costs one read per campaign — the same fan-out `/promoters` already performs.
 *
 * Which is exactly why this composes the existing hooks rather than issuing its own reads. Both
 * queries keep their original keys, so `AppShell` and `PromoterDashboard` are two observers of one
 * cache entry: on `/promoters` the navigation adds nothing at all, and elsewhere the fan-out
 * happens once and is reused.
 *
 * Two guards keep the cost off routes that do not need it:
 *
 *  - `enabled: isConnected` — a visitor with no wallet cannot be a promoter, so the campaign list
 *    is never fetched on their behalf. Their navigation costs zero RPC calls.
 *  - `poll: false` — the nav never needs a live list. Where a page *does* want one (`/`, `/my`),
 *    that page's own observer asks for the interval and React Query honours the shortest request,
 *    so this neither slows those pages down nor makes `/docs` poll the chain.
 *
 * `isLoading` is reported so callers can distinguish "not a promoter" from "not known yet" and
 * render nothing rather than flashing a tab in or out as the fan-out settles.
 */
export function useIsPromoter(): {isPromoter: boolean; isLoading: boolean} {
  const {isConnected} = useAccount();
  const {campaigns} = useCampaigns({enabled: isConnected, poll: false});
  const {joined, isLoading} = useJoinedCampaigns(campaigns);

  if (!isConnected) return {isPromoter: false, isLoading: false};

  return {isPromoter: joined.length > 0, isLoading};
}
