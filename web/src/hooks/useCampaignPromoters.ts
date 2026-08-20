"use client";

import {useQuery} from "@tanstack/react-query";
import {usePublicClient} from "wagmi";
import {type PublicClient} from "viem";
import {getDeployment, isDeployed} from "@/lib/chains";
import {useBoneyChainId} from "@/hooks/useBoneyChain";
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
   */
  scannedFrom?: bigint;
};

/**
 * Every promoter who has joined any of `campaigns`, for the public promoter directory.
 *
 * This reads logs rather than contract state because there is nothing else to read. A `Campaign`
 * records membership as `_promoterIdOf[wallet]` and exposes only point lookups — `promoterIdOf`,
 * `promoterOf` — so the chain can answer "is this wallet a promoter?" but not "who are the
 * promoters?". `PromoterJoined` is the only enumerable trace of a join.
 *
 * Three consequences worth knowing:
 *
 *  - **One query covers all campaigns.** `getLogs` takes an address array, so the scan is
 *    windowed by block range, not multiplied by campaign count. Adding campaigns costs nothing.
 *  - **Windows are capped at ~2000 blocks** because public RPCs reject wider ranges (Base returns
 *    `-32602: query exceeds max block range 2000`), and the whole scan is capped at a fixed number
 *    of windows so a nice-to-have directory cannot hammer a rate-limited endpoint. See
 *    `planWindows`.
 *  - **The floor is the deployment block**, recorded in `deployments.ts` from the broadcast
 *    receipt. Scanning from genesis on an L2 would be tens of thousands of requests.
 *
 * Failure is per-window and non-fatal: a rate-limited window is skipped and the rest still
 * render, because a directory missing one block range is far more useful than an error page.
 */
export function useCampaignPromoters(campaigns: readonly CampaignView[]) {
  const client = usePublicClient({chainId: useBoneyChainId()});
  const chainId = client?.chain?.id;
  const deployment = getDeployment(chainId);

  const query = useQuery({
    queryKey: ["campaignPromoters", chainId, campaigns.map((c) => c.campaign).join(",")],
    enabled: Boolean(client) && isDeployed(chainId) && campaigns.length > 0,
    // Joins are infrequent and this is the most expensive read in the app; a minute of staleness
    // is a fair trade against re-scanning on every mount.
    staleTime: 60_000,
    queryFn: async (): Promise<PromoterDirectory> => {
      if (!client || campaigns.length === 0) return {groups: []};

      const addresses = campaigns.map((c) => c.campaign);
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
      return skippedBefore === undefined ? {groups} : {groups, scannedFrom: skippedBefore};
    },
  });

  return {
    groups: query.data?.groups ?? [],
    scannedFrom: query.data?.scannedFrom,
    isLoading: query.isLoading,
    isRefreshing: query.isFetching && !query.isLoading,
    error: query.error,
    refetch: query.refetch,
  };
}
