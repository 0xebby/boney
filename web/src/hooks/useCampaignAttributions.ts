"use client";

import {useQuery} from "@tanstack/react-query";
import {usePublicClient} from "wagmi";
import {type PublicClient} from "viem";
import {getDeployment, isDeployed} from "@/lib/chains";
import {useBoneyChainId} from "@/hooks/useBoneyChain";
import {subgraphUrl} from "@/lib/graph";
import {fetchTouchesFromGraph, touchEntries} from "@/lib/attributionGraph";
import {currentAttributions, groupByPromoter, type AttributionEntry} from "@/lib/attributions";
import {planWindows} from "@/lib/promoters";
import type {CampaignView} from "@/lib/types";
import {TOUCH_STORED} from "@/lib/events";

export type AttributionDirectory = {
  /** One entry per `(campaign, referral)` — the touch the registry currently holds. */
  entries: AttributionEntry[];
  /** The same entries keyed by `promoterKey(campaign, promoterId)`. */
  byPromoter: Map<string, AttributionEntry[]>;
  /**
   * Set when the chain's history was too long to scan within the query budget. Touches signed
   * before this block are missing.
   *
   * Never set on the subgraph path, which has no block floor.
   */
  scannedFrom?: bigint;
  /**
   * Set when the subgraph path hit its page cap, making the lists a floor rather than the whole
   * set.
   *
   * Never set on the log path, whose partiality is `scannedFrom`.
   */
  truncated: boolean;
};

/** Stable empty map, so a loading render does not hand callers a fresh identity every time. */
const EMPTY_BY_PROMOTER: Map<string, AttributionEntry[]> = new Map();

/**
 * Which referral wallets are attributed to each promoter, across several campaigns.
 *
 * `AttributionRegistry` exposes only `touchOf(campaign, user)`, so the chain can answer "is this
 * wallet attributed?" but not "who is attributed to this promoter?". The subgraph's `Touch` entity
 * is the enumerable form and is tried first; a `TouchStored` log scan is the fallback, bounded by
 * `planWindows` and reporting its floor through `scannedFrom`.
 *
 * The result is reduced through `currentAttributions`, so a referral who re-signed under a
 * different promoter appears once, under whichever promoter the registry now holds.
 *
 * @param campaigns The campaigns to read attributions for.
 * @returns The directory, plus the usual query state.
 */
export function useCampaignAttributions(campaigns: readonly CampaignView[]) {
  const client = usePublicClient({chainId: useBoneyChainId()});
  const chainId = client?.chain?.id;
  const deployment = getDeployment(chainId);
  const graphUrl = subgraphUrl(chainId);

  const query = useQuery({
    queryKey: ["campaignAttributions", chainId, campaigns.map((c) => c.campaign).join(",")],
    enabled: Boolean(client) && isDeployed(chainId) && campaigns.length > 0,
    // Matches the promoter directory: the log fallback is expensive, and a touch signed seconds ago
    // is picked up by the write path's own refetch.
    staleTime: 60_000,
    queryFn: async ({signal}): Promise<AttributionDirectory> => {
      if (!client || campaigns.length === 0) {
        return {entries: [], byPromoter: new Map(), truncated: false};
      }

      const addresses = campaigns.map((c) => c.campaign);

      if (graphUrl) {
        const result = await fetchTouchesFromGraph({url: graphUrl, campaigns: addresses, signal});
        // Only an `ok` result replaces the log scan. An unavailable subgraph must fall through
        // rather than render as "nobody is attributed".
        if (result.kind === "ok") {
          const entries = currentAttributions(touchEntries(result.data));
          return {
            entries,
            byPromoter: groupByPromoter(entries),
            truncated: result.data.truncated,
          };
        }
      }

      const head = await (client as PublicClient).getBlockNumber({cacheTime: 0});
      const {windows, skippedBefore} = planWindows(deployment?.startBlock ?? BigInt(0), head);

      const raw: AttributionEntry[] = [];
      for (const window of windows) {
        try {
          const logs = await (client as PublicClient).getLogs({
            address: deployment?.attributionRegistry,
            event: TOUCH_STORED,
            args: {campaign: addresses},
            fromBlock: window.from,
            toBlock: window.to,
          });

          for (const log of logs) {
            // A log missing an indexed arg cannot be attributed to a promoter, so it is dropped
            // rather than rendered as a row with holes in it.
            if (!log.args.campaign || !log.args.user || !log.args.promoterId) continue;
            raw.push({
              campaign: log.args.campaign,
              referral: log.args.user,
              promoterId: log.args.promoterId,
              signedAt: log.args.signedAt ?? BigInt(0),
              expiresAt: log.args.expiresAt ?? BigInt(0),
              blockNumber: log.blockNumber ?? BigInt(0),
            });
          }
        } catch {
          // Rate limit or transient RPC failure on one window: keep what the others returned.
          continue;
        }
      }

      const entries = currentAttributions(raw);
      const byPromoter = groupByPromoter(entries);
      return skippedBefore === undefined
        ? {entries, byPromoter, truncated: false}
        : {entries, byPromoter, scannedFrom: skippedBefore, truncated: false};
    },
  });

  return {
    entries: query.data?.entries ?? [],
    byPromoter: query.data?.byPromoter ?? EMPTY_BY_PROMOTER,
    scannedFrom: query.data?.scannedFrom,
    truncated: query.data?.truncated ?? false,
    isLoading: query.isLoading,
    isRefreshing: query.isFetching && !query.isLoading,
    error: query.error,
    refetch: query.refetch,
  };
}
