"use client";

import {useQuery} from "@tanstack/react-query";
import {usePublicClient} from "wagmi";
import {type PublicClient} from "viem";
import {getDeployment, isDeployed} from "@/lib/chains";
import {useBoneyChainId} from "@/hooks/useBoneyChain";
import {planWindows} from "@/lib/promoters";
import {latestTouches, type TouchEntry} from "@/lib/reporting";
import {buildAttributionWindows, type AttributionWindows} from "@/lib/attributionWindows";
import {TOUCH_STORED} from "@/lib/events";

export type CampaignTouches = {
  touches: TouchEntry[];
  /**
   * Who held each referral over which blocks, keyed lowercase — the same walk
   * `AttributionRegistry.promoterAt` performs. Built from the raw entries rather than a second pass,
   * because `latestTouches` is about to throw the superseded ones away.
   */
  windows: AttributionWindows;
  /**
   * Set when history was too long to scan within the query budget. Touches signed before this
   * block are missing, and the caller must say so — a KOL can look un-attributed purely because
   * its touch predates the floor.
   */
  scannedFrom?: bigint;
};

/** Stable empty map, so a loading render does not hand callers a fresh identity every time. */
const EMPTY_WINDOWS: AttributionWindows = new Map();

/**
 * Every referral attributed to any promoter on one campaign.
 *
 * Reads logs for the same reason `useCampaignPromoters` does: `AttributionRegistry` exposes only
 * `touchOf(campaign, user)`, a point lookup. The chain can answer "is this wallet attributed?" but
 * not "who is attributed on this campaign?", and `TouchStored` is the only enumerable trace.
 *
 * The scan is filtered to a single campaign (the topic is indexed), so it is far narrower than the
 * directory's cross-campaign query — but it inherits the same ~1900-block windows and window cap,
 * because the RPC limits are the RPC's, not the query's. Per-window failure is non-fatal for the
 * same reason: a partial list still lets the dev report for the KOLs it did find.
 *
 * The result is reduced through `latestTouches`, so a referral who re-signed under a different
 * promoter appears once, under whichever KOL the contract would actually resolve. `windows` is built
 * from the same entries *before* that reduction, because credit follows the promoter who held the
 * referral at each action's own block rather than the one holding it now.
 */
export function useCampaignTouches(campaign: `0x${string}` | undefined) {
  const client = usePublicClient({chainId: useBoneyChainId()});
  const chainId = client?.chain?.id;
  const deployment = getDeployment(chainId);

  const query = useQuery({
    queryKey: ["campaignTouches", chainId, campaign],
    enabled: Boolean(client) && isDeployed(chainId) && Boolean(campaign) && Boolean(deployment),
    // Shorter than the promoter directory's minute: this backs a write panel, and a touch signed
    // seconds ago should show up on the next refetch rather than after a stale window expires.
    staleTime: 15_000,
    queryFn: async (): Promise<CampaignTouches> => {
      if (!client || !campaign || !deployment) return {touches: [], windows: new Map()};

      const head = await (client as PublicClient).getBlockNumber({cacheTime: 0});
      const {windows: scanWindows, skippedBefore} = planWindows(deployment.startBlock, head);

      const entries: TouchEntry[] = [];
      for (const window of scanWindows) {
        try {
          const logs = await (client as PublicClient).getLogs({
            address: deployment.attributionRegistry,
            event: TOUCH_STORED,
            args: {campaign},
            fromBlock: window.from,
            toBlock: window.to,
          });

          for (const log of logs) {
            // A log missing an indexed arg cannot be attributed to a referral, so it is dropped
            // rather than rendered as a row with holes in it.
            if (!log.args.user || !log.args.promoterId) continue;
            entries.push({
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

      const touches = latestTouches(entries);
      const windows = buildAttributionWindows(
        entries.map((e) => ({
          user: e.referral,
          promoterId: e.promoterId,
          signedAt: e.signedAt,
          expiresAt: e.expiresAt,
          blockNumber: e.blockNumber,
        })),
      );
      return skippedBefore === undefined
        ? {touches, windows}
        : {touches, windows, scannedFrom: skippedBefore};
    },
  });

  return {
    touches: query.data?.touches ?? [],
    windows: query.data?.windows ?? EMPTY_WINDOWS,
    scannedFrom: query.data?.scannedFrom,
    isLoading: query.isLoading,
    isRefreshing: query.isFetching && !query.isLoading,
    error: query.error,
    refetch: query.refetch,
  };
}
