"use client";

import {useQuery} from "@tanstack/react-query";
import {usePublicClient} from "wagmi";
import {type PublicClient} from "viem";
import {getDeployment, isDeployed} from "@/lib/chains";
import {useBoneyChainId} from "@/hooks/useBoneyChain";
import {planWindows} from "@/lib/promoters";
import {foldSettlements, type PromoterPayout, type SettlementEntry} from "@/lib/settlements";
import {TIER_SETTLED} from "@/lib/events";

export type CampaignSettlements = {
  /** Payouts per promoter, keyed by lowercased address. */
  payouts: Map<string, PromoterPayout>;
  /**
   * Set when history was too long to scan within the query budget. Settlements below this block are
   * missing from the fold, so the table's total is a floor — `unaccountedPaid` measures the gap
   * against the campaign's own `paidOut`, and the panel says so rather than presenting a short total
   * as complete.
   */
  scannedFrom?: bigint;
};

/** Stable empty map, so a loading render does not hand callers a fresh identity every time. */
const EMPTY_PAYOUTS: Map<string, PromoterPayout> = new Map();

/**
 * What one campaign has paid each of its promoters.
 *
 * A log scan, for the usual reason: `Campaign` stores `paidOut` as a single total and `_settledTiers`
 * as a per-promoter count, so the chain can answer "how much has this campaign paid" and "how many
 * tiers has this wallet crossed", but not "how much has this wallet been paid". `TierSettled` carries
 * the released amount and is the only enumerable record of it.
 *
 * Windows, caps, and per-window failure handling are `useCampaignTouches`' — same RPC limits, same
 * trade. Filtered to one campaign by emitter address rather than by topic, since a campaign emits its
 * own settlements.
 *
 * Oldest window first, which `foldSettlements` relies on for its dedupe: the earlier block of a
 * duplicated log is the one that stuck.
 */
export function useCampaignSettlements(campaign: `0x${string}` | undefined) {
  const client = usePublicClient({chainId: useBoneyChainId()});
  const chainId = client?.chain?.id;
  const deployment = getDeployment(chainId);

  const query = useQuery({
    queryKey: ["campaignSettlements", chainId, campaign],
    enabled: Boolean(client) && isDeployed(chainId) && Boolean(campaign) && Boolean(deployment),
    // A settlement lands inside `reportUserAction`, which the project triggers from this same page,
    // so the window is short enough that a fresh payout shows on the next refetch.
    staleTime: 15_000,
    queryFn: async (): Promise<CampaignSettlements> => {
      if (!client || !campaign || !deployment) return {payouts: new Map()};

      const head = await (client as PublicClient).getBlockNumber({cacheTime: 0});
      const {windows, skippedBefore} = planWindows(deployment.startBlock, head);

      const entries: SettlementEntry[] = [];
      for (const window of windows) {
        try {
          const logs = await (client as PublicClient).getLogs({
            address: campaign,
            event: TIER_SETTLED,
            fromBlock: window.from,
            toBlock: window.to,
          });

          for (const log of logs) {
            // Without the promoter the row has nobody to credit, so it is dropped rather than
            // rendered as a payout to an unknown wallet.
            if (!log.args.promoter) continue;
            entries.push({
              promoter: log.args.promoter,
              kpiIndex: Number(log.args.kpiIndex ?? BigInt(0)),
              tier: Number(log.args.tier ?? BigInt(0)),
              paid: log.args.paid ?? BigInt(0),
              blockNumber: log.blockNumber ?? BigInt(0),
            });
          }
        } catch {
          // Rate limit or transient RPC failure on one window: keep what the others returned.
          continue;
        }
      }

      const payouts = foldSettlements(entries);
      return skippedBefore === undefined ? {payouts} : {payouts, scannedFrom: skippedBefore};
    },
  });

  return {
    payouts: query.data?.payouts ?? EMPTY_PAYOUTS,
    scannedFrom: query.data?.scannedFrom,
    isLoading: query.isLoading,
    isRefreshing: query.isFetching && !query.isLoading,
    error: query.error,
    refetch: query.refetch,
  };
}
