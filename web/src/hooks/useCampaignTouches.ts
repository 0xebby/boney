"use client";

import {useQuery} from "@tanstack/react-query";
import {usePublicClient} from "wagmi";
import {type PublicClient} from "viem";
import {getDeployment, isDeployed} from "@/lib/chains";
import {useBoneyChainId} from "@/hooks/useBoneyChain";
import {subgraphUrl} from "@/lib/graph";
import {fetchTouchesFromGraph, touchEntries} from "@/lib/attributionGraph";
import {planWindows} from "@/lib/promoters";
import {latestTouches, type TouchEntry} from "@/lib/reporting";
import {
  buildAttributionWindows,
  mergeAttributionWindows,
  type AttributionWindows,
  type TouchLog,
} from "@/lib/attributionWindows";
import {TOUCH_STORED} from "@/lib/events";

/** Which enumeration the touch list was read from. */
export type TouchSource = "graph" | "logs";

export type CampaignTouches = {
  touches: TouchEntry[];
  /**
   * Who held each referral over which blocks, keyed lowercase — the same walk
   * `AttributionRegistry.promoterAt` performs. Built from the raw entries rather than a second pass,
   * because `latestTouches` is about to throw the superseded ones away.
   */
  windows: AttributionWindows;
  /** Where `touches` came from, which decides what `scannedFrom` still limits. */
  source: TouchSource;
  /**
   * Lowest block the log scan reached, set when history was longer than the query budget.
   *
   * On the `logs` source, touches signed before it are missing from `touches`. On the `graph` source
   * `touches` is complete and only superseded `windows` history is bounded by it.
   */
  scannedFrom?: bigint;
  /** The subgraph paged out, making `touches` a floor rather than the whole set. */
  truncated: boolean;
};

/** Stable empty map, so a loading render does not hand callers a fresh identity every time. */
const EMPTY_WINDOWS: AttributionWindows = new Map();

/**
 * Restates a touch row in the shape `buildAttributionWindows` reads.
 *
 * @param entry The touch row.
 * @returns The same touch, with the referral under the ABI's `user` name.
 */
function toTouchLog(entry: TouchEntry): TouchLog {
  return {
    user: entry.referral,
    promoterId: entry.promoterId,
    signedAt: entry.signedAt,
    expiresAt: entry.expiresAt,
    blockNumber: entry.blockNumber,
  };
}

/** Raw `TouchStored` entries, plus the floor the scan could not reach past. */
type TouchLogScan = {entries: TouchEntry[]; skippedBefore?: bigint};

/**
 * Reads one campaign's `TouchStored` logs in `planWindows`-sized spans.
 *
 * A window the RPC rejects is skipped rather than failing the scan, so a partial list still lets the
 * project report for the promoters it did find.
 *
 * @param client Public client for the campaign's chain.
 * @param registry `AttributionRegistry` address.
 * @param startBlock Block the deployment began at.
 * @param campaign Campaign address, matched against the indexed topic.
 * @returns Every entry the windows returned, and the floor when the range was too wide to cover.
 */
async function scanTouchLogs(
  client: PublicClient,
  registry: `0x${string}`,
  startBlock: bigint,
  campaign: `0x${string}`,
): Promise<TouchLogScan> {
  const head = await client.getBlockNumber({cacheTime: 0});
  const {windows, skippedBefore} = planWindows(startBlock, head);

  const entries: TouchEntry[] = [];
  for (const window of windows) {
    try {
      const logs = await client.getLogs({
        address: registry,
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

  return skippedBefore === undefined ? {entries} : {entries, skippedBefore};
}

/**
 * Every referral attributed to any promoter on one campaign.
 *
 * `AttributionRegistry` exposes only `touchOf(campaign, user)`, a point lookup, so the list has to be
 * enumerated elsewhere. The subgraph's `Touch` entity is read first and carries no block floor; the
 * `TouchStored` log scan is the fallback, and an unavailable subgraph falls through to it rather than
 * rendering as "nobody is attributed".
 *
 * `windows` needs the log scan either way, because it keeps the superseded touches the subgraph's
 * `Touch` row overwrites. The subgraph's live touch is merged in, so a referral whose touch predates
 * the log floor still resolves to a promoter instead of being dropped.
 *
 * `touches` is reduced through `latestTouches`, so a referral who re-signed under a different promoter
 * appears once, under whichever promoter the contract would resolve.
 *
 * @param campaign Campaign to read touches for, or undefined to leave the query disabled.
 * @returns The touch list, the attribution windows, the coverage flags and the query state.
 */
export function useCampaignTouches(campaign: `0x${string}` | undefined) {
  const client = usePublicClient({chainId: useBoneyChainId()});
  const chainId = client?.chain?.id;
  const deployment = getDeployment(chainId);
  const graphUrl = subgraphUrl(chainId);

  const query = useQuery({
    queryKey: ["campaignTouches", chainId, campaign],
    enabled: Boolean(client) && isDeployed(chainId) && Boolean(campaign) && Boolean(deployment),
    // Shorter than the promoter directory's minute: this backs a write panel, and a touch signed
    // seconds ago should show up on the next refetch rather than after a stale window expires.
    staleTime: 15_000,
    queryFn: async ({signal}): Promise<CampaignTouches> => {
      if (!client || !campaign || !deployment) {
        return {touches: [], windows: new Map(), source: "logs", truncated: false};
      }

      const [graph, scan] = await Promise.all([
        graphUrl
          ? // Resolved rather than rejected, so a throw on the subgraph side leaves the log scan's
            // result intact instead of failing the whole query with it.
            fetchTouchesFromGraph({url: graphUrl, campaigns: [campaign], signal}).catch(() => null)
          : Promise.resolve(null),
        scanTouchLogs(
          client as PublicClient,
          deployment.attributionRegistry,
          deployment.startBlock,
          campaign,
        ),
      ]);

      const logWindows = buildAttributionWindows(scan.entries.map(toTouchLog));

      if (graph?.kind === "ok") {
        const rows: TouchEntry[] = touchEntries(graph.data).map((entry) => ({
          referral: entry.referral,
          promoterId: entry.promoterId,
          signedAt: entry.signedAt,
          expiresAt: entry.expiresAt,
          blockNumber: entry.blockNumber,
        }));
        const windows = mergeAttributionWindows(
          logWindows,
          buildAttributionWindows(rows.map(toTouchLog)),
        );
        const graphed: CampaignTouches = {
          touches: latestTouches(rows),
          windows,
          source: "graph",
          truncated: graph.data.truncated,
        };
        return scan.skippedBefore === undefined
          ? graphed
          : {...graphed, scannedFrom: scan.skippedBefore};
      }

      const logged: CampaignTouches = {
        touches: latestTouches(scan.entries),
        windows: logWindows,
        source: "logs",
        truncated: false,
      };
      return scan.skippedBefore === undefined
        ? logged
        : {...logged, scannedFrom: scan.skippedBefore};
    },
  });

  return {
    touches: query.data?.touches ?? [],
    windows: query.data?.windows ?? EMPTY_WINDOWS,
    source: query.data?.source ?? "logs",
    scannedFrom: query.data?.scannedFrom,
    truncated: query.data?.truncated ?? false,
    isLoading: query.isLoading,
    isRefreshing: query.isFetching && !query.isLoading,
    error: query.error,
    refetch: query.refetch,
  };
}
