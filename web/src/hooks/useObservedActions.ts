"use client";

import {useQuery} from "@tanstack/react-query";
import {usePublicClient} from "wagmi";
import {pad, toHex, type Hex, type PublicClient} from "viem";
import {getDeployment, isDeployed} from "@/lib/chains";
import {useBoneyChainId} from "@/hooks/useBoneyChain";
import {planWindows} from "@/lib/promoters";
import {decodeEventSource, type EventSource} from "@/lib/kpiSource";
import {aggregateByActor, type IndexedLog} from "@/lib/indexerCore";
import {CampaignAbi} from "@/lib/abis";
import type {ObservedReferral} from "@/lib/reporting";

/**
 * What a KPI's declared event source says its attributed referrals actually did.
 *
 * This is the browser half of `scripts/indexer.ts`, and deliberately the same code underneath:
 * `decodeEventSource` reads the contract-and-event commitment out of `KpiSpec.params`, and
 * `aggregateByActor` folds the matched logs into per-referral totals. Sharing that module is the
 * point — the manual report panel and the unattended indexer must not be able to disagree about
 * what a referral is owed, and two implementations of scaling and actor extraction would.
 *
 * Without this, a report has no factual basis at all: the panel's figure came from the reward
 * ladder, so it credited whatever crossed the next threshold whether or not anyone had done
 * anything. See `planObservedReport`.
 *
 * ## Scan shape
 *
 * Logs are filtered server-side to the referrals we care about, using a positional topic filter
 * (`topics[actorTopic]` = any of the live referrals). That matters for a source like WETH, where an
 * unfiltered window returns thousands of transfers the browser would have to fold locally; filtered,
 * the response is usually empty. It needs a raw `eth_getLogs` request rather than viem's `getLogs`,
 * which wants a full ABI event it can encode arguments from — here the only thing known about the
 * event is its topic hash, by construction.
 *
 * Windows come from `planWindows`, the same ~1900-block spans and cap the touch and promoter scans
 * use, because the limit is the RPC's rather than any one query's.
 */
export type ObservedActions = {
  /** Decoded event source, or null when the KPI declares none — nothing to observe. */
  source: EventSource | null;
  /** Observed activity per referral, keyed lowercase. */
  observed: ReadonlyMap<string, ObservedReferral>;
  /** Set when history was too long to cover; actions before this block are missing. */
  scannedFrom?: bigint;
  /**
   * Windows the RPC failed on.
   *
   * Surfaced rather than swallowed because a dropped window *understates* activity, and an
   * understated scan is indistinguishable from an honest "nobody has acted yet" — the one reading
   * the panel would otherwise present as fact.
   */
  failedWindows: number;
};

const EMPTY_OBSERVED: ReadonlyMap<string, ObservedReferral> = new Map();

export function useObservedActions({
  campaign,
  kpiIndex,
  params,
  referrals,
  firstSignedAt,
  enabled,
}: {
  campaign: `0x${string}` | undefined;
  kpiIndex: number;
  /** `KpiSpec.params` — the event-source commitment, or empty for a KPI that declares none. */
  params: Hex | undefined;
  referrals: readonly `0x${string}`[];
  /**
   * Each referral's earliest touch time, from `useCampaignTouches`. The floor activity is measured
   * from; a referral absent from it has never been attributed and is dropped entirely.
   */
  firstSignedAt: ReadonlyMap<string, bigint>;
  enabled: boolean;
}) {
  const client = usePublicClient({chainId: useBoneyChainId()});
  const chainId = client?.chain?.id;
  const deployment = getDeployment(chainId);
  const key = referrals.map((r) => r.toLowerCase()).join(",");
  // The floors are part of the query's input, so they belong in its key. A referral re-signing moves
  // nothing here — `signedAt` only ever increases — but a *first* touch landing for a referral that
  // had none changes what is creditable, and without this the panel would serve the stale answer.
  const floorKey = referrals
    .map((r) => `${r.toLowerCase()}:${firstSignedAt.get(r.toLowerCase()) ?? 0n}`)
    .join(",");

  const query = useQuery({
    queryKey: ["observedActions", chainId, campaign, kpiIndex, params, key, floorKey],
    enabled:
      enabled && Boolean(client && campaign && deployment) && isDeployed(chainId) && key.length > 0,
    // Matches the touch scan: this backs a write panel, so an action a few seconds old should show
    // up on the next refetch rather than after a long stale window.
    staleTime: 15_000,
    queryFn: async (): Promise<ObservedActions> => {
      const source = decodeEventSource(params);
      if (!client || !campaign || !deployment || !source) {
        return {source: source ?? null, observed: EMPTY_OBSERVED, failedWindows: 0};
      }

      const publicClient = client as PublicClient;
      const head = await publicClient.getBlockNumber({cacheTime: 0});
      const {windows, skippedBefore} = planWindows(deployment.startBlock, head);

      // `topics[0]` is the signature and the actor sits at `source.actorTopic`; the positions
      // between are wildcards. An array at the actor position is an OR over the referrals, so one
      // request covers every wallet this KOL brought in.
      const actorFilter = referrals.map((r) => pad(r.toLowerCase() as Hex, {size: 32}));
      const topics: (Hex | Hex[] | null)[] = [source.topic0];
      for (let i = 1; i < source.actorTopic; i++) topics.push(null);
      topics.push(actorFilter);

      const logs: IndexedLog[] = [];
      let failedWindows = 0;
      // Always resolved now. These used to be fetched only for a verifier-gated KPI, on the grounds
      // that nothing else read the evidence — but the attribution floor below is a timestamp
      // comparison, and a log carrying 0 is dropped rather than assumed to clear it. Skipping the
      // fetch would therefore blank every ungated KPI's panel. Still deduped per block.
      const timestamps = new Map<bigint, bigint>();

      for (const window of windows) {
        let raw: RawLog[];
        try {
          raw = (await publicClient.request({
            method: "eth_getLogs",
            params: [
              {
                address: source.source,
                topics: topics as never,
                fromBlock: toHex(window.from),
                toBlock: toHex(window.to),
              },
            ],
          })) as RawLog[];
        } catch {
          // Rate limit or transient failure on one window: keep what the others returned, and
          // count it so the caller can say the total is a floor rather than a fact.
          failedWindows++;
          continue;
        }

        for (const log of raw) {
          if (log.blockNumber === null || log.blockNumber === undefined) continue;
          const blockNumber = BigInt(log.blockNumber);

          let timestamp = BigInt(0);
          const cached = timestamps.get(blockNumber);
          if (cached !== undefined) timestamp = cached;
          else {
            try {
              const block = await publicClient.getBlock({blockNumber});
              timestamp = block.timestamp;
              timestamps.set(blockNumber, timestamp);
            } catch {
              // Carried through as zero, which the floor treats as unresolved and drops. Evidence
              // with a zero timestamp likewise fails a window check rather than passing one.
              timestamp = BigInt(0);
            }
          }

          logs.push({
            topics: log.topics,
            data: log.data,
            blockNumber,
            timestamp,
          });
        }
      }

      // The floor the relayer and `scripts/indexer.ts` both apply: activity counts once the referral
      // has been attributed at all and the campaign has begun tracking. It is the referral's
      // *earliest* touch, not its current one — `Campaign` credits `newTotal - _userCredited`, and
      // that guard spans every promoter the referral ever had, so a total measured only from the
      // latest touch would leave a switched referral permanently uncreditable. See
      // `earliestSignedAt`.
      const startTime = (await publicClient.readContract({
        address: campaign,
        abi: CampaignAbi,
        functionName: "startTime",
      })) as bigint;

      const floors = new Map<string, bigint>();
      for (const referral of referrals) {
        const first = firstSignedAt.get(referral.toLowerCase());
        if (first === undefined || first === BigInt(0)) continue; // never attributed
        floors.set(referral.toLowerCase(), first > startTime ? first : startTime);
      }

      const totals = aggregateByActor(logs, source, floors);
      const observed = new Map<string, ObservedReferral>();
      for (const [addr, total] of totals) {
        observed.set(addr, {
          referral: total.referral,
          observed: total.amount,
          actions: total.actions,
        });
      }

      return skippedBefore === undefined
        ? {source, observed, failedWindows}
        : {source, observed, scannedFrom: skippedBefore, failedWindows};
    },
  });

  return {
    source: query.data?.source ?? decodeEventSource(params),
    observed: query.data?.observed ?? EMPTY_OBSERVED,
    scannedFrom: query.data?.scannedFrom,
    failedWindows: query.data?.failedWindows ?? 0,
    isLoading: query.isLoading && query.fetchStatus !== "idle",
    refetch: query.refetch,
  };
}

/** The three fields crediting needs, as `eth_getLogs` returns them before viem decodes anything. */
type RawLog = {
  topics: readonly Hex[];
  data: Hex;
  blockNumber: Hex | null;
};
