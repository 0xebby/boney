"use client";

import {useQuery} from "@tanstack/react-query";
import {usePublicClient, useAccount} from "wagmi";
import type {PublicClient} from "viem";
import {fetchCampaignView} from "@/lib/contracts";
import {fetchCampaignDetail, fetchPromoterState} from "@/lib/campaignDetail";
import {IERC20MetadataAbi} from "@/lib/abis";
import {isDeployed} from "@/lib/chains";
import {UNKNOWN_TOKEN} from "@/lib/token";
import {useBoneyChainId} from "@/hooks/useBoneyChain";

/**
 * Detail data for one campaign.
 *
 * Two queries rather than one: the summary row comes from the facade (and gives the campaign's
 * address), while KPI ladders and settlement counters only exist on the `Campaign` contract. The
 * second query is keyed on the resolved address so it re-runs if the id maps elsewhere.
 *
 * Both poll on `POLL_MS`. Without it the record was read once on mount and never again: the only
 * refresh path was `refetch` after a *local* write, so a campaign ended from another tab, another
 * wallet, or by any third party once its window closed left this page showing pre-end state
 * indefinitely — status pill still Active, "End campaign" still live, and the guards in
 * `lib/lifecycle` faithfully mirroring a snapshot that no longer existed. The countdown kept
 * ticking the whole time (`useNow` has its own timer), which made the staleness easy to miss.
 *
 * `refetchIntervalInBackground` is left at its default `false`, so a backgrounded tab costs
 * nothing and the focus refetch in `Providers` covers the return.
 */

/**
 * How often to re-read campaign state while the tab is visible.
 *
 * A detail refetch is ~21 RPC calls — `fetchCampaignDetail` issues one per view function plus
 * three per KPI, and deliberately does not batch through Multicall3 (see the note there: a stock
 * anvil has no such contract). Against Base's rate-limited public endpoint that puts 30s at well
 * under one call per second sustained, which is the budget this is chosen to fit. A shorter
 * interval is not free here — scale it with the KPI count, not with impatience.
 */
const POLL_MS = 30_000;

export function useCampaignDetail(campaignId: bigint | undefined) {
  const client = usePublicClient({chainId: useBoneyChainId()});
  const chainId = client?.chain?.id;
  const deployed = isDeployed(chainId);
  const enabled = Boolean(client) && deployed && campaignId !== undefined;

  const viewQuery = useQuery({
    queryKey: ["campaignView", chainId, campaignId?.toString()],
    enabled,
    refetchInterval: POLL_MS,
    queryFn: async () => {
      if (!client || campaignId === undefined) return null;
      return fetchCampaignView(client as PublicClient, campaignId);
    },
  });

  const address = viewQuery.data?.campaign;

  const detailQuery = useQuery({
    queryKey: ["campaignDetail", chainId, address],
    enabled: Boolean(client && address),
    refetchInterval: POLL_MS,
    queryFn: async () => {
      if (!client || !address) return null;

      const detail = await fetchCampaignDetail(client as PublicClient, address);
      const token = await fetchTokenMeta(client as PublicClient, detail.token);
      return {detail, token};
    },
  });

  return {
    view: viewQuery.data ?? null,
    detail: detailQuery.data?.detail ?? null,
    token: detailQuery.data?.token ?? {symbol: "", decimals: 18},
    // The page is not usable until both land, so "loading" spans the whole chain.
    isLoading: viewQuery.isLoading || (Boolean(address) && detailQuery.isLoading),
    isRefreshing:
      (viewQuery.isFetching && !viewQuery.isLoading) ||
      (detailQuery.isFetching && !detailQuery.isLoading),
    error: viewQuery.error ?? detailQuery.error,
    // A resolved id with a zero address means the campaign does not exist.
    notFound: viewQuery.isSuccess && !address,
    refetch: () => {
      void viewQuery.refetch();
      void detailQuery.refetch();
    },
    deployed,
    chainId,
  };
}

/** The connected wallet's promoter state on one campaign. */
export function usePromoterState(
  campaignAddress: `0x${string}` | undefined,
  kpiCount: number,
) {
  const client = usePublicClient({chainId: useBoneyChainId()});
  const {address: wallet} = useAccount();
  const chainId = client?.chain?.id;

  const query = useQuery({
    queryKey: ["promoterState", chainId, campaignAddress, wallet, kpiCount],
    enabled: Boolean(client && campaignAddress && wallet),
    queryFn: async () => {
      if (!client || !campaignAddress || !wallet) return null;
      return fetchPromoterState(client as PublicClient, campaignAddress, wallet, kpiCount);
    },
  });

  return {
    promoter: query.data ?? null,
    isLoading: query.isLoading,
    refetch: query.refetch,
    wallet,
  };
}

async function fetchTokenMeta(
  client: PublicClient,
  token: `0x${string}`,
): Promise<{symbol: string; decimals: number}> {
  try {
    const [symbol, decimals] = await Promise.all([
      client.readContract({address: token, abi: IERC20MetadataAbi, functionName: "symbol"}),
      client.readContract({address: token, abi: IERC20MetadataAbi, functionName: "decimals"}),
    ]);
    return {symbol: symbol as string, decimals: Number(decimals)};
  } catch {
    // Same fallback as the list: a token without the metadata extension is still valid escrow.
    return UNKNOWN_TOKEN;
  }
}
