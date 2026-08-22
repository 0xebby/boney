"use client";

import {useMemo} from "react";
import {useQuery} from "@tanstack/react-query";
import {usePublicClient} from "wagmi";
import type {PublicClient} from "viem";
import {fetchKpiSpecs} from "@/lib/campaignDetail";
import {planSpecReads} from "@/lib/kpiSummary";
import {isDeployed} from "@/lib/chains";
import {useBoneyChainId} from "@/hooks/useBoneyChain";
import type {CampaignView, KpiSpec} from "@/lib/types";

/**
 * The KPI specs behind a list of campaigns, keyed by lowercased campaign address.
 *
 * `IBoney.CampaignView` carries `kpiCount` and nothing else about the KPIs, so a list that wants to
 * say *what* each campaign measures has to ask each campaign. `Boney` has no KPI accessor at all —
 * `kpi(i)` lives on `Campaign` — so this is one read per KPI, planned up front by `planSpecReads`
 * (which caps the fan-out and reports what it dropped).
 *
 * Fetched once and kept: a `KpiSpec` is pushed in `Campaign`'s constructor and there is no setter, so
 * unlike every other query in this app there is nothing here to poll for. `staleTime: Infinity` with
 * no `refetchInterval` means navigating back to the marketplace re-renders the column from cache
 * while `useCampaigns` keeps polling the volatile half (status, paid out) on its own 30s interval.
 *
 * A campaign whose reads fail is simply absent from the map. The column then falls back to the count
 * it always showed, which is a worse answer but not a wrong one.
 */
export function useCampaignKpiSpecs(campaigns: readonly CampaignView[]): {
  specs: Record<string, KpiSpec[]>;
  isLoading: boolean;
  /** Campaigns the read budget left out — see `planSpecReads`. */
  dropped: number;
} {
  const client = usePublicClient({chainId: useBoneyChainId()});
  const chainId = client?.chain?.id;

  const plan = useMemo(() => planSpecReads(campaigns), [campaigns]);

  /*
    Keyed on the campaigns to be read, not on the list itself. `useCampaigns` polls every 30s and
    resolves to a fresh array each time; keying on identity would refetch every KPI on the page twice
    a minute to re-learn values that cannot change.
  */
  const target = plan.targets.map((t) => `${t.campaign.toLowerCase()}:${t.count}`).join(",");

  const query = useQuery({
    queryKey: ["campaignKpiSpecs", chainId, target] as const,
    enabled: Boolean(client) && isDeployed(chainId) && plan.targets.length > 0,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    queryFn: async () => {
      if (!client) return {};

      const entries = await Promise.all(
        plan.targets.map(async ({campaign, count}) => {
          try {
            return [campaign.toLowerCase(), await fetchKpiSpecs(client as PublicClient, campaign, count)] as const;
          } catch {
            // One campaign that will not answer must not cost the whole column.
            return null;
          }
        }),
      );

      return Object.fromEntries(entries.filter((entry): entry is NonNullable<typeof entry> => entry !== null));
    },
  });

  return {
    specs: query.data ?? {},
    isLoading: query.isLoading,
    dropped: plan.dropped,
  };
}
