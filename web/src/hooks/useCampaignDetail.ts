"use client";

import {useQuery} from "@tanstack/react-query";
import {usePublicClient, useAccount} from "wagmi";
import type {PublicClient} from "viem";
import {fetchCampaignView} from "@/lib/contracts";
import {fetchCampaignDetail, fetchPromoterState} from "@/lib/campaignDetail";
import {IERC20MetadataAbi} from "@/lib/abis";
import {isDeployed} from "@/lib/chains";

/**
 * Detail data for one campaign.
 *
 * Two queries rather than one: the summary row comes from the facade (and gives the campaign's
 * address), while KPI ladders and settlement counters only exist on the `Campaign` contract. The
 * second query is keyed on the resolved address so it re-runs if the id maps elsewhere.
 */
export function useCampaignDetail(campaignId: bigint | undefined) {
  const client = usePublicClient();
  const chainId = client?.chain?.id;
  const deployed = isDeployed(chainId);
  const enabled = Boolean(client) && deployed && campaignId !== undefined;

  const viewQuery = useQuery({
    queryKey: ["campaignView", chainId, campaignId?.toString()],
    enabled,
    queryFn: async () => {
      if (!client || campaignId === undefined) return null;
      return fetchCampaignView(client as PublicClient, campaignId);
    },
  });

  const address = viewQuery.data?.campaign;

  const detailQuery = useQuery({
    queryKey: ["campaignDetail", chainId, address],
    enabled: Boolean(client && address),
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
  const client = usePublicClient();
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
    return {symbol: "???", decimals: 18};
  }
}
