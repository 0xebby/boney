"use client";

import {useQuery} from "@tanstack/react-query";
import {usePublicClient} from "wagmi";
import type {PublicClient} from "viem";
import {EventMetricKpiVerifierAbi, GuardedKpiVerifierAbi, IERC20MetadataAbi} from "@/lib/abis";
import {getDeployment, ZERO_ADDRESS} from "@/lib/chains";
import {decodeEventSource} from "@/lib/kpiSource";
import {resolveTrackedEvent, type TrackedEvent} from "@/lib/eventNames";
import {useBoneyChainId} from "@/hooks/useBoneyChain";
import type {KpiKind} from "@/lib/types";

/**
 * Resolves one KPI's tracked event into something a person can read.
 *
 * A few reads at most, and only for a KPI that declares an event source at all — a KPI the project
 * reports by hand has nothing to look up, so the hook stays dormant and issues none. What it gathers:
 *
 *  1. the verifier's configured signature, which is the authoritative human-readable name (see
 *     `lib/eventNames`);
 *  2. `name()` / `symbol()` / `decimals()` off the watched contract, for sources that can introduce
 *     themselves — the last of which is what lets a scale be stated as a token amount rather than as
 *     a divisor (see `lib/kpiUnits`).
 *
 * Everything is individually caught. A KPI panel exists to show a reward ladder; degrading its
 * "Tracking" line to a topic hash because an RPC hiccuped is acceptable, blanking the page is not.
 *
 * `staleTime: Infinity` and no interval, because none of this changes under a reader: a campaign's
 * KPI specs are written in `Campaign`'s constructor and have no setter, a verifier config is
 * rewritten only by a deliberate `setKpiConfig`, and a token does not rename itself. This is one
 * fetch per KPI per session, cached across every visit to the campaign.
 */
export function useTrackedEvent({
  campaign,
  kpiIndex,
  kind,
  verifier,
  params,
  campaignName,
}: {
  campaign: `0x${string}`;
  kpiIndex: number;
  kind: KpiKind;
  /** The KPI's `verifier` — usually the guard wrapper, which names the metric verifier behind it. */
  verifier: `0x${string}`;
  /** `KpiSpec.params`; anything that is not an event-source blob leaves this hook idle. */
  params: `0x${string}`;
  /** The campaign's own name, the last-resort protocol label. */
  campaignName?: string;
}): {tracked: TrackedEvent | null; isLoading: boolean} {
  const client = usePublicClient({chainId: useBoneyChainId()});
  const chainId = client?.chain?.id;

  const source = decodeEventSource(params);

  const query = useQuery({
    queryKey: ["trackedEvent", chainId, campaign.toLowerCase(), kpiIndex] as const,
    enabled: Boolean(client) && source !== null,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    queryFn: async () => {
      if (!client || !source) return {};

      const [configSignature, scanned] = await Promise.all([
        readConfiguredSignature(client as PublicClient, chainId, campaign, kpiIndex, verifier),
        readContractIdentity(client as PublicClient, source.source),
      ]);

      return {configSignature, scanned};
    },
  });

  if (!source) return {tracked: null, isLoading: false};

  return {
    tracked: resolveTrackedEvent({
      source,
      kind,
      chainId,
      configSignature: query.data?.configSignature,
      scanned: query.data?.scanned,
      campaignName,
    }),
    // The line renders from the first paint with whatever the catalog knows, then sharpens when the
    // reads land. Callers use this only to dim it, never to withhold it.
    isLoading: query.isLoading,
  };
}

/**
 * The event signature the KPI's verifier is configured with, if it has one.
 *
 * Two hops, because a campaign's `KpiSpec.verifier` is normally the `GuardedKpiVerifier` wrapper and
 * the config lives on the `EventMetricKpiVerifier` behind it. `boneyVerifier()` on the wrapper is the
 * authoritative link (it is immutable there), so it is tried first; the deployment's own address is
 * the fallback for a KPI pointed straight at the metric verifier, or one whose verifier is `0x0`.
 */
async function readConfiguredSignature(
  client: PublicClient,
  chainId: number | undefined,
  campaign: `0x${string}`,
  kpiIndex: number,
  verifier: `0x${string}`,
): Promise<string | undefined> {
  const metric = await resolveMetricVerifier(client, chainId, verifier);
  if (!metric) return undefined;

  try {
    const config = await client.readContract({
      address: metric,
      abi: EventMetricKpiVerifierAbi,
      functionName: "configOf",
      args: [campaign, BigInt(kpiIndex)],
    });

    // An unconfigured KPI reads back as a zeroed struct, whose `eventSignature` is `""`. Returning
    // that would look like a contract claiming its event has no name.
    return config.configured ? config.eventSignature : undefined;
  } catch {
    return undefined;
  }
}

async function resolveMetricVerifier(
  client: PublicClient,
  chainId: number | undefined,
  verifier: `0x${string}`,
): Promise<`0x${string}` | undefined> {
  const deployed = getDeployment(chainId)?.eventMetricKpiVerifier;

  if (verifier && verifier !== ZERO_ADDRESS) {
    if (deployed && verifier.toLowerCase() === deployed.toLowerCase()) return deployed;

    try {
      const inner = await client.readContract({
        address: verifier,
        abi: GuardedKpiVerifierAbi,
        functionName: "boneyVerifier",
      });
      if (inner && inner !== ZERO_ADDRESS) return inner;
    } catch {
      // Not a guard — a `TouchWindowVerifier`, say, which has no inner verifier to name.
    }
  }

  return deployed;
}

/**
 * What the watched contract calls itself, and in what units it counts.
 *
 * All three calls are expected to fail for the interesting sources: Aave's Pool and Sygma's bridge
 * implement none of them, which is why `lib/knownContracts` exists. They succeed for the token
 * contracts the demo campaigns watch, where the symbol is the same one every amount on the page is
 * quoted in.
 *
 * `decimals` is what lets `lib/kpiUnits` state a `dataWord0` scale as a real amount — "0.001 WETH"
 * rather than "1,000,000,000,000,000 base units". One extra read on a query that is already
 * `staleTime: Infinity`, so it costs one call per KPI per session; a contract that will not answer
 * degrades to base units rather than to an assumed 18.
 */
async function readContractIdentity(
  client: PublicClient,
  address: `0x${string}`,
): Promise<{name?: string; symbol?: string; decimals?: number}> {
  const [name, symbol, decimals] = await Promise.all([
    readString(client, address, "name"),
    readString(client, address, "symbol"),
    readDecimals(client, address),
  ]);

  return {name, symbol, decimals};
}

/**
 * `decimals()` as a number, or `undefined`.
 *
 * Range-checked rather than trusted: a contract answering something absurd would otherwise reach
 * `formatTokenAmount`, which throws on a negative and would divide by a nonsense power of ten on a
 * huge one. 36 is well past any real token and still far inside safe territory.
 */
function readDecimals(
  client: PublicClient,
  address: `0x${string}`,
): Promise<number | undefined> {
  return client
    .readContract({address, abi: IERC20MetadataAbi, functionName: "decimals"})
    .then((value) => {
      const decimals = Number(value);
      return Number.isInteger(decimals) && decimals >= 0 && decimals <= 36 ? decimals : undefined;
    })
    .catch(() => undefined);
}

function readString(
  client: PublicClient,
  address: `0x${string}`,
  functionName: "name" | "symbol",
): Promise<string | undefined> {
  return client
    .readContract({address, abi: IERC20MetadataAbi, functionName})
    .then((value) => (typeof value === "string" ? value : undefined))
    .catch(() => undefined);
}
