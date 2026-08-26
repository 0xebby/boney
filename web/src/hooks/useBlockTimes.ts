"use client";

import {useMemo} from "react";
import {useQuery} from "@tanstack/react-query";
import {usePublicClient} from "wagmi";
import type {PublicClient} from "viem";
import {useBoneyChainId} from "@/hooks/useBoneyChain";

/**
 * Block number → block timestamp, for the handful of blocks a card needs dated.
 *
 * ## Why this exists at all
 *
 * The subgraph's `Promoter` entity records `joinedAtBlock` and no time, so every join-derived
 * milestone — first campaign, fifth campaign, first repeat project — arrives as a block number. There
 * are two ways to avoid the lookup and both are wrong: `Campaign.createdAt` is a lower bound that
 * would date a promoter to before they joined, and their earliest `Credit.timestamp` is an upper bound
 * that would date them to after. A block's timestamp is the chain's own clock, so this is a lookup
 * rather than an estimate.
 *
 * ## Fail soft, block by block
 *
 * `allSettled`, not `all`: this repo has already recorded Base Sepolia's public RPC returning 502 on
 * roughly one call in three, and one failed lookup must not take the other two dates with it. A block
 * that did not resolve is simply absent from the map, and `withResolvedDates` leaves that milestone on
 * its block number — which is true, just less readable. That is the whole failure mode.
 */
/**
 * A card asks for three blocks. The cap is a backstop against a caller that grew a list, since each
 * entry is its own RPC round trip and they all fire together.
 */
const MAX_BLOCKS = 8;

/** Shared so an unresolved read returns a stable reference and cannot retrigger a memo. */
const EMPTY: ReadonlyMap<bigint, number> = new Map();

export function useBlockTimes(blocks: readonly bigint[]) {
  const chainId = useBoneyChainId();
  const client = usePublicClient({chainId});

  // Sorted and de-duplicated so the key is stable across renders: `milestoneBlocks` returns whatever
  // order the milestone list happened to be in, and an unsorted key would refetch on a reorder that
  // asks for exactly the same blocks.
  const wanted = useMemo(
    () =>
      [...new Set(blocks.map((b) => b.toString()))]
        .sort()
        .slice(0, MAX_BLOCKS)
        .map((b) => BigInt(b)),
    [blocks],
  );

  const query = useQuery<ReadonlyMap<bigint, number>>({
    queryKey: ["blockTimes", chainId, wanted.map((b) => b.toString())],
    enabled: Boolean(client) && wanted.length > 0,
    // A mined block's timestamp never changes, so there is nothing a refetch could learn. Only a
    // failed lookup is worth retrying, which `retry` covers.
    staleTime: Infinity,
    gcTime: Infinity,
    // One retry, unlike the app's read-only queries that take none: the failure being guarded against
    // is a flaky public RPC rather than a wrong answer, and a single extra call is cheap against a
    // milestone list that would otherwise read "block 45,857,100".
    retry: 1,
    queryFn: async (): Promise<ReadonlyMap<bigint, number>> => {
      const c = client as PublicClient;
      const settled = await Promise.allSettled(
        wanted.map(async (blockNumber) => {
          const block = await c.getBlock({blockNumber});
          return [blockNumber, Number(block.timestamp)] as const;
        }),
      );

      const times = new Map<bigint, number>();
      for (const result of settled) {
        // A zero timestamp is not a date. Dropping it leaves the milestone on its block number
        // instead of dating it to 1 January 1970.
        if (result.status === "fulfilled" && result.value[1] > 0) {
          times.set(result.value[0], result.value[1]);
        }
      }
      return times;
    },
  });

  return {
    /** Empty until the lookup lands, and partial if some of it failed. Never wrong. */
    times: query.data ?? EMPTY,
    isLoading: query.isLoading,
  };
}
