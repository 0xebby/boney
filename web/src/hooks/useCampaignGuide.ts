"use client";

import {useQuery} from "@tanstack/react-query";
import {useBoneyChainId} from "@/hooks/useBoneyChain";
import {resolveCampaignGuide, type CampaignGuide, type ResolvedGuide} from "@/lib/campaignGuide";

/**
 * The guide for one campaign — the stored one if a project published it, otherwise the committed
 * catalog's.
 *
 * The catalog is already in the bundle, so `resolveCampaignGuide` runs synchronously on the first
 * paint and the fetch only ever *upgrades* the answer. That ordering is deliberate: the seeded fixture
 * campaigns render their guide immediately, and a campaign created through the form fills in a moment
 * later. Nothing waits on the network to show something it already knows.
 *
 * A failed fetch is not an error state. `retry: false` and no error surface: if `/api/campaign-guide`
 * is unreachable the catalog still answers, and a campaign page should not grow an error banner
 * because an advisory section could not be upgraded.
 */
export function useCampaignGuide(campaign: `0x${string}` | undefined): {
  guide: ResolvedGuide | null;
  isLoading: boolean;
  /** Re-reads the store. The project's editor calls it after publishing. */
  refetch: () => void;
} {
  const chainId = useBoneyChainId();

  const query = useQuery({
    enabled: Boolean(campaign),
    queryFn: async (): Promise<CampaignGuide | null> => {
      const params = new URLSearchParams({campaign: campaign!, chainId: String(chainId)});
      const response = await fetch(`/api/campaign-guide?${params}`);
      if (!response.ok) return null;

      const body = (await response.json()) as {guide?: CampaignGuide | null};
      return body.guide ?? null;
    },
    queryKey: ["campaignGuide", chainId, campaign?.toLowerCase()] as const,
    retry: false,
    /*
      A guide changes only when its project deliberately republishes one — there is no background
      process that rewrites it — so this is one fetch per campaign per session, like `useTrackedEvent`.
      Not `Infinity`, though: the project itself publishes a guide and then navigates straight to the
      campaign page, and an infinite stale time would show it the catalog entry it just replaced.
    */
    staleTime: 60_000,
  });

  return {
    guide: resolveCampaignGuide({campaign, chainId, stored: query.data}),
    isLoading: query.isLoading,
    refetch: () => void query.refetch(),
  };
}
