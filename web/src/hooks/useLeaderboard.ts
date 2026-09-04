"use client";

import {useMemo} from "react";
import {useQuery} from "@tanstack/react-query";
import {useAccount} from "wagmi";
import {useBoneyChainId} from "@/hooks/useBoneyChain";
import {findPointsRow, foldPoints, type PointsRow} from "@/lib/points";
import {fetchPointsFromGraph, type PointsSnapshot} from "@/lib/pointsGraph";
import type {GraphResult, GraphUnavailable} from "@/lib/graph";

/**
 * The whole leaderboard — every wallet that has scored, ranked.
 *
 * IO only: this hook fetches, `lib/pointsGraph.ts` decodes and `lib/points.ts` scores, so the point
 * table can be retuned and tested without touching a network.
 *
 * The result stays a `GraphResult`, so a consumer cannot reach a rank without first handling
 * `unavailable`. That matters more here than anywhere else in the app: a board that renders an empty
 * table on a failed read tells everyone they have no points.
 */
export function useLeaderboard() {
  const chainId = useBoneyChainId();
  const {address} = useAccount();

  const query = useQuery<GraphResult<PointsSnapshot>>({
    queryKey: ["leaderboard", chainId],
    // Points move only when someone joins, signs or has an action credited, and the indexer trails the
    // chain regardless. The 10s global default would re-read the whole protocol on every navigation.
    staleTime: 60_000,
    // The failure is the data, so there is nothing for react-query to retry against.
    retry: false,
    queryFn: async ({signal}) => fetchPointsFromGraph({chainId, signal}),
  });

  const result = query.data;
  const snapshot = result?.kind === "ok" ? result.data : undefined;

  // The fold walks every credit in the protocol, so it is memoised against the fetched snapshot rather
  // than re-run on each render of a table that also sorts and filters.
  const rows = useMemo<PointsRow[]>(
    () => (snapshot ? foldPoints(snapshot.input) : []),
    [snapshot],
  );

  const you = useMemo(() => findPointsRow(rows, address), [rows, address]);

  return {
    /** The union. Consumers handle `unavailable` before they can reach a row. */
    result,
    /** Ranked descending. Empty on a failed read — check `unavailable` first. */
    rows,
    /** The connected wallet's row, when it has scored. */
    you,
    /** The highest total, for bar widths. */
    top: rows[0]?.total ?? 0,
    /** Present only on a failed read, with a reason the copy can branch on. */
    unavailable: (result?.kind === "unavailable" ? result : undefined) as
      | GraphUnavailable
      | undefined,

    isLoading: query.isLoading,
    isRefreshing: query.isFetching && !query.isLoading,
    refetch: query.refetch,

    /**
     * Every total is a lower bound — a page cap was hit, or a handler threw while indexing. Distinct
     * from `unavailable`: the rows are real, just incomplete.
     */
    partial: Boolean(snapshot && (snapshot.truncated || snapshot.hasIndexingErrors)),
    indexedBlock: snapshot?.indexedBlock,
  };
}
