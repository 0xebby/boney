"use client";

import {useQuery} from "@tanstack/react-query";
import {usePublicClient} from "wagmi";
import {type PublicClient} from "viem";
import {getDeployment, isDeployed} from "@/lib/chains";
import {useBoneyChainId} from "@/hooks/useBoneyChain";
import {planWindows} from "@/lib/promoters";
import {latestTouches, earliestSignedAt, type TouchEntry} from "@/lib/reporting";
import {TOUCH_STORED} from "@/lib/events";

export type CampaignTouches = {
  touches: TouchEntry[];
  /**
   * Each referral's earliest touch time, keyed lowercase — the floor observed activity is measured
   * from. Derived from the same scan as `touches` rather than a second pass, because the raw entries
   * are already here and `latestTouches` is about to throw the older ones away.
   */
  firstSignedAt: Map<string, bigint>;
  /**
   * Set when history was too long to scan within the query budget. Touches signed before this
   * block are missing, and the caller must say so — a KOL can look un-attributed purely because
   * its touch predates the floor.
   */
  scannedFrom?: bigint;
};

/** Stable empty map, so a loading render does not hand callers a fresh identity every time. */
const EMPTY_FIRST_SIGNED: Map<string, bigint> = new Map();

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
 * promoter appears once, under whichever KOL the contract would actually resolve. `firstSignedAt` is
 * taken from the same entries *before* that reduction, since the floor a report is measured from is
 * the referral's first touch rather than its current one — see `earliestSignedAt`.
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
      if (!client || !campaign || !deployment) return {touches: [], firstSignedAt: new Map()};

      const head = await (client as PublicClient).getBlockNumber({cacheTime: 0});
      const {windows, skippedBefore} = planWindows(deployment.startBlock, head);

      const entries: TouchEntry[] = [];
      for (const window of windows) {
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
      const firstSignedAt = earliestSignedAt(entries);
      return skippedBefore === undefined
        ? {touches, firstSignedAt}
        : {touches, firstSignedAt, scannedFrom: skippedBefore};
    },
  });

  return {
    touches: query.data?.touches ?? [],
    firstSignedAt: query.data?.firstSignedAt ?? EMPTY_FIRST_SIGNED,
    scannedFrom: query.data?.scannedFrom,
    isLoading: query.isLoading,
    isRefreshing: query.isFetching && !query.isLoading,
    error: query.error,
    refetch: query.refetch,
  };
}
