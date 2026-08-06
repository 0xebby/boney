"use client";

import {useQuery} from "@tanstack/react-query";
import {usePublicClient, useAccount} from "wagmi";
import type {PublicClient} from "viem";
import {fetchBrowseCampaigns, fetchCampaignCount, fetchReputation} from "@/lib/contracts";
import {IERC20MetadataAbi} from "@/lib/abis";
import {isDeployed} from "@/lib/chains";
import type {CampaignView} from "@/lib/types";

/** Token metadata, needed to format escrow amounts correctly. */
export type TokenMeta = {symbol: string; decimals: number};

/**
 * Loads every campaign plus the metadata for each distinct escrow token.
 *
 * `browseCampaigns` is paginated on-chain; the MVP loads one page large enough for a local
 * chain. Real pagination is wired through `limit`/`offset` when campaign counts justify it.
 */
export function useCampaigns({limit = 100}: {limit?: number} = {}) {
  const client = usePublicClient();
  const chainId = client?.chain?.id;
  const deployed = isDeployed(chainId);

  const query = useQuery({
    queryKey: ["campaigns", chainId, limit],
    enabled: Boolean(client) && deployed,
    queryFn: async () => {
      if (!client) return {views: [] as CampaignView[], tokens: {} as Record<string, TokenMeta>};

      const views = await fetchBrowseCampaigns(client as PublicClient, BigInt(0), BigInt(limit));
      const tokens = await fetchTokenMetas(client as PublicClient, views);
      return {views, tokens};
    },
  });

  return {
    campaigns: query.data?.views ?? [],
    tokens: query.data?.tokens ?? {},
    isLoading: query.isLoading,
    isRefreshing: query.isFetching && !query.isLoading,
    error: query.error,
    refetch: query.refetch,
    deployed,
    chainId,
  };
}

/** Reads `symbol`/`decimals` once per distinct token across the campaign list. */
async function fetchTokenMetas(
  client: PublicClient,
  views: readonly CampaignView[],
): Promise<Record<string, TokenMeta>> {
  const unique = [...new Set(views.map((v) => v.token.toLowerCase()))];

  const entries = await Promise.all(
    unique.map(async (address) => {
      try {
        const [symbol, decimals] = await Promise.all([
          client.readContract({
            address: address as `0x${string}`,
            abi: IERC20MetadataAbi,
            functionName: "symbol",
          }),
          client.readContract({
            address: address as `0x${string}`,
            abi: IERC20MetadataAbi,
            functionName: "decimals",
          }),
        ]);
        return [address, {symbol: symbol as string, decimals: Number(decimals)}] as const;
      } catch {
        // A token that does not implement the metadata extension is still usable for escrow —
        // fall back rather than failing the whole list.
        return [address, {symbol: "???", decimals: 18}] as const;
      }
    }),
  );

  return Object.fromEntries(entries);
}

/** The connected wallet's reputation score, used by the "joinable by me" filter. */
export function useReputation() {
  const client = usePublicClient();
  const {address} = useAccount();
  const chainId = client?.chain?.id;

  const query = useQuery({
    queryKey: ["reputation", chainId, address],
    enabled: Boolean(client && address) && isDeployed(chainId),
    queryFn: async () => {
      if (!client || !address) return BigInt(0);
      return fetchReputation(client as PublicClient, address);
    },
  });

  return {reputation: query.data ?? BigInt(0), isLoading: query.isLoading};
}

/** Total campaign count, for the summary row when the list is paginated. */
export function useCampaignCount() {
  const client = usePublicClient();
  const chainId = client?.chain?.id;

  const query = useQuery({
    queryKey: ["campaignCount", chainId],
    enabled: Boolean(client) && isDeployed(chainId),
    queryFn: async () => {
      if (!client) return BigInt(0);
      return fetchCampaignCount(client as PublicClient);
    },
  });

  return {count: query.data ?? BigInt(0), isLoading: query.isLoading};
}
