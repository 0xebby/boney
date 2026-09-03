"use client";

import {useQuery} from "@tanstack/react-query";
import {usePublicClient, useAccount} from "wagmi";
import type {PublicClient} from "viem";
import {fetchBrowseCampaigns, fetchCampaignCount, fetchReputation} from "@/lib/contracts";
import {IERC20MetadataAbi} from "@/lib/abis";
import {isDeployed} from "@/lib/chains";
import {UNKNOWN_TOKEN, type TokenMeta} from "@/lib/token";
import { useBoneyChainId } from "@/hooks/useBoneyChain";
import type {CampaignView} from "@/lib/types";

/**
 * Loads every campaign plus the metadata for each distinct escrow token.
 *
 * `browseCampaigns` is paginated on-chain; the MVP loads one page large enough for a local
 * chain. Real pagination is wired through `limit`/`offset` when campaign counts justify it.
 *
 * Polls on `POLL_MS` for the same reason the detail hook does — a status that changed on chain
 * (a campaign ended, activated, or paused by anyone) would otherwise never reach an open list.
 * Cheap by comparison: one `browseCampaigns` call for the whole page, plus one `symbol`/`decimals`
 * pair per *distinct* token, so cost scales with token variety rather than campaign count.
 */
const POLL_MS = 30_000;

/**
 * @param enabled Set false to keep the query dormant. `AppShell` uses this so a disconnected
 *   visitor's navigation costs zero reads — it only needs the list to decide whether the wallet is
 *   a promoter, which is moot with no wallet.
 * @param poll Set false to opt out of the interval. Every consumer shares one query key and React
 *   Query polls at the shortest interval any observer asks for, so a page that wants live data
 *   still gets it; this only stops routes whose *sole* observer is the nav (`/docs`, `/create`)
 *   from polling the chain for a list they never render.
 */
export function useCampaigns({
  limit = 100,
  enabled = true,
  poll = true,
}: { limit?: number; enabled?: boolean; poll?: boolean } = {}) {
  const client = usePublicClient({ chainId: useBoneyChainId() });
  const chainId = client?.chain?.id;
  const deployed = isDeployed(chainId);

  const query = useQuery({
    queryKey: ["campaigns", chainId, limit],
    enabled: Boolean(client) && deployed && enabled,
    refetchInterval: poll ? POLL_MS : false,
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
        return [address, UNKNOWN_TOKEN] as const;
      }
    }),
  );

  return Object.fromEntries(entries);
}

/** The connected wallet's reputation score, used by the "Open to me" filter. */
export function useReputation() {
  const client = usePublicClient({ chainId: useBoneyChainId() });
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
  const client = usePublicClient({ chainId: useBoneyChainId() });
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
