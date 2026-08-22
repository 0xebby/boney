"use client";

import {useQuery} from "@tanstack/react-query";
import {usePublicClient} from "wagmi";
import type {PublicClient} from "viem";
import {ReputationRegistryAbi} from "@/lib/abis";
import {getDeployment, ZERO_ADDRESS} from "@/lib/chains";
import {useBoneyChainId} from "@/hooks/useBoneyChain";

/**
 * The highest BoneyScore any wallet could reach on this network, read from the registry.
 *
 * `Campaign`'s constructor rejects a `minReputation` above `ReputationRegistry.maxScore()` with
 * `UnreachableReputation`, and that ceiling is *configuration*, not a protocol constant: it is the sum
 * of `maxValue * weight` over the weighted schemas, so it moves when schemas are registered,
 * re-weighted, or capped differently. `lib/boneyscore.MAX_BONEY_SCORE` reproduces the arithmetic for
 * the seeded configuration and is right whenever the registry is seeded as intended.
 *
 * It was not, and that is why this hook exists. A fresh `ReputationRegistry` has *no* schemas, so the
 * ceiling is 0 and every gate is unreachable — `DeployBoney` registers none, and a redeploy that skips
 * `SeedDevRep` leaves the chain in exactly that state. The form's local constant said 28,000, the
 * chain said 0, and the disagreement surfaced as a reverted transaction the user had already paid for.
 * Reading the real ceiling closes that gap.
 *
 * A failed read returns `undefined` rather than 0. "The registry is unreachable" and "the registry
 * admits no reputation at all" are opposite claims, and guessing the second would block a gate the
 * chain would have accepted.
 */

/**
 * What `maxScore()` returns when a weighted schema has no value cap: unbounded.
 *
 * `ReputationRegistry.maxScore` returns `type(uint256).max` in that case rather than summing to a
 * number, so it must be read as "no ceiling to check against" instead of as an enormous one.
 */
export const UNCAPPED_CEILING = BigInt(2) ** BigInt(256) - BigInt(1);

export type ScoreCeiling = {
  /** `maxScore()`, or `undefined` while loading or when the read failed. */
  ceiling?: bigint;
  isLoading: boolean;
  /** The registry could not be read; the caller falls back to its local constant. */
  isUnavailable: boolean;
};

export function useScoreCeiling(): ScoreCeiling {
  const chainId = useBoneyChainId();
  const client = usePublicClient({chainId});
  const registry = getDeployment(chainId)?.reputationRegistry;

  const enabled = Boolean(client) && Boolean(registry) && registry !== ZERO_ADDRESS;

  const query = useQuery({
    queryKey: ["scoreCeiling", chainId],
    enabled,
    retry: false,
    // Schema configuration changes only by an owner transaction, but "only by governance" is not
    // "never" — and this exact value being stale is what produced the failure above. A minute keeps
    // it off every keystroke while still noticing a reseed within one.
    staleTime: 60_000,
    queryFn: async (): Promise<bigint> => {
      const c = client as PublicClient;
      return (await c.readContract({
        address: registry as `0x${string}`,
        abi: ReputationRegistryAbi,
        functionName: "maxScore",
      })) as bigint;
    },
  });

  return {
    ceiling: query.data,
    isLoading: enabled && query.isLoading,
    isUnavailable: enabled && query.isError,
  };
}
