"use client";

import {useQuery} from "@tanstack/react-query";
import {usePublicClient} from "wagmi";
import {type PublicClient} from "viem";
import {getDeployment, isDeployed} from "@/lib/chains";
import {useBoneyChainId} from "@/hooks/useBoneyChain";
import {subgraphUrl} from "@/lib/graph";
import {fetchPromotersFromGraph, promoterEntries} from "@/lib/promoterGraph";
import {
  planWindows,
  dedupePromoters,
  groupByCampaign,
  type PromoterEntry,
  type CampaignPromoters,
} from "@/lib/promoters";
import type {CampaignView} from "@/lib/types";
import {PROMOTER_JOINED} from "@/lib/events";

export type PromoterDirectory = {
  groups: CampaignPromoters[];
  /**
   * Set when the chain's history was too long to scan within the query budget. Promoters who
   * joined before this block are missing from `groups`, and the UI must say so — a directory
   * that is quietly partial is worse than one that admits its floor.
   *
   * Never set on the subgraph path, which has no block floor.
   */
  scannedFrom?: bigint;
  /**
   * Set when the subgraph path hit its page cap. `groups` is then a floor rather than the whole
   * membership, and the UI must say so.
   *
   * Never set on the log path, whose partiality is `scannedFrom`.
   */
  truncated: boolean;
};

/**
 * Every promoter who has joined any of `campaigns`, for the public promoter directory.
 *
 * A `Campaign` records membership as `_promoterIdOf[wallet]` and exposes only point lookups —
 * `promoterIdOf`, `promoterOf` — so the chain can answer "is this wallet a promoter?" but not "who
 * are the promoters?". `PromoterJoined` is the only enumerable trace of a join, so the directory is
 * reconstructed from it, by one of two sources.
 *
 * **The subgraph is tried first, and is the only source without a block floor.** It indexes
 * `PromoterJoined` from the campaign's first block, and reports `truncated` when a membership list
 * runs past its page cap. The log scan below covers `MAX_WINDOWS * MAX_LOG_RANGE` blocks clamped to
 * the newest span — about 45,600 blocks, which on Base Sepolia's 2s blocks is roughly a day. On a
 * chain older than that, a promoter who joined earlier is absent from the log directory while every
 * point lookup still finds them: their tracking link works, `PromoterPanel` shows their membership,
 * and only this list omits them.
 *
 * The log path therefore stays as a fallback for chains the subgraph does not cover, and reports its
 * floor through `scannedFrom` rather than presenting a partial list as complete.
 *
 * Log failure is per-window and non-fatal: a rate-limited window is skipped and the rest still
 * render, because a directory missing one block range is more useful than an error page.
 */
export function useCampaignPromoters(campaigns: readonly CampaignView[]) {
  const client = usePublicClient({chainId: useBoneyChainId()});
  const chainId = client?.chain?.id;
  const deployment = getDeployment(chainId);
  const graphUrl = subgraphUrl(chainId);

  const query = useQuery({
    queryKey: ["campaignPromoters", chainId, campaigns.map((c) => c.campaign).join(",")],
    enabled: Boolean(client) && isDeployed(chainId) && campaigns.length > 0,
    // Joins are infrequent and the log fallback is the most expensive read in the app; a minute of
    // staleness is a fair trade against re-scanning on every mount.
    staleTime: 60_000,
    queryFn: async ({signal}): Promise<PromoterDirectory> => {
      if (!client || campaigns.length === 0) return {groups: [], truncated: false};

      const addresses = campaigns.map((c) => c.campaign);

      if (graphUrl) {
        const result = await fetchPromotersFromGraph({
          url: graphUrl,
          campaigns: addresses,
          signal,
        });
        // Only an `ok` result replaces the log scan. An unavailable subgraph must fall through
        // rather than render as an empty directory.
        if (result.kind === "ok") {
          const entries = promoterEntries(result.data);
          return {
            groups: groupByCampaign(campaigns, dedupePromoters(entries)),
            truncated: result.data.truncated,
          };
        }
      }

      const head = await (client as PublicClient).getBlockNumber({cacheTime: 0});
      const {windows, skippedBefore} = planWindows(deployment?.startBlock ?? BigInt(0), head);

      const entries: PromoterEntry[] = [];
      for (const window of windows) {
        try {
          const logs = await (client as PublicClient).getLogs({
            address: addresses,
            event: PROMOTER_JOINED,
            fromBlock: window.from,
            toBlock: window.to,
          });

          for (const log of logs) {
            // A log without its indexed args or origin cannot be attributed to a promoter, so it
            // is dropped rather than rendered as a row with holes in it.
            if (!log.args.promoter || !log.args.promoterId || !log.address) continue;
            entries.push({
              campaign: log.address,
              promoter: log.args.promoter,
              promoterId: log.args.promoterId,
              reputation: log.args.reputation ?? BigInt(0),
              blockNumber: log.blockNumber ?? BigInt(0),
            });
          }
        } catch {
          // Rate limit or transient RPC failure on one window: keep what the others returned.
          continue;
        }
      }

      const groups = groupByCampaign(campaigns, dedupePromoters(entries));
      return skippedBefore === undefined
        ? {groups, truncated: false}
        : {groups, scannedFrom: skippedBefore, truncated: false};
    },
  });

  return {
    groups: query.data?.groups ?? [],
    scannedFrom: query.data?.scannedFrom,
    truncated: query.data?.truncated ?? false,
    isLoading: query.isLoading,
    isRefreshing: query.isFetching && !query.isLoading,
    error: query.error,
    refetch: query.refetch,
  };
}
