"use client";

import {useQueries} from "@tanstack/react-query";
import {useBoneyChainId} from "@/hooks/useBoneyChain";
import {resolveCampaignGuide, type CampaignGuide, type ResolvedGuide} from "@/lib/campaignGuide";

/**
 * Guides for many campaigns at once — the list form of `useCampaignGuide`.
 *
 * Same query key, fetch and stale time as the single-campaign hook, so a row read here is already
 * cached when the reader opens that campaign. The committed catalog answers synchronously, so a row
 * with a catalog entry has its summary on the first paint and the fetches only upgrade it.
 *
 * @param campaigns Campaign addresses to resolve. Duplicates and casing are collapsed.
 * @returns A map from lowercased campaign address to its guide, or `null` where there is none.
 */
export function useCampaignGuides(
  campaigns: readonly `0x${string}`[],
): Map<string, ResolvedGuide | null> {
  const chainId = useBoneyChainId();
  const addresses = Array.from(new Set(campaigns.map((c) => c.toLowerCase())));

  const queries = useQueries({
    queries: addresses.map((campaign) => ({
      queryFn: async (): Promise<CampaignGuide | null> => {
        const params = new URLSearchParams({campaign, chainId: String(chainId)});
        const response = await fetch(`/api/campaign-guide?${params}`);
        if (!response.ok) return null;

        const body = (await response.json()) as {guide?: CampaignGuide | null};
        return body.guide ?? null;
      },
      queryKey: ["campaignGuide", chainId, campaign] as const,
      retry: false,
      staleTime: 60_000,
    })),
  });

  const guides = new Map<string, ResolvedGuide | null>();
  addresses.forEach((campaign, i) => {
    guides.set(campaign, resolveCampaignGuide({campaign, chainId, stored: queries[i]?.data}));
  });

  return guides;
}
