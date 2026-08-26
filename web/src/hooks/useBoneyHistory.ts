"use client";

import {useQuery} from "@tanstack/react-query";
import {useBlockNumber} from "wagmi";
import {useBoneyChainId} from "@/hooks/useBoneyChain";
import {fetchPromoterHistory, type PromoterHistory} from "@/lib/boneyHistory";
import {graphLag, type GraphResult, type GraphUnavailable} from "@/lib/graph";

/**
 * A promoter's indexed history — the IO half of the BoneyCard's stage 2.
 *
 * IO only, per F6: this hook fetches and reports freshness, `lib/boneyHistory.ts` decodes, and the
 * counts the card shows are a fold in `lib/boneycard.ts` where fixtures can pin them.
 *
 * ## What it does differently from the app's other hooks
 *
 * Every other read in the app goes to the chain through wagmi. This one goes to `boney-indexer`,
 * because a card's history has to reach back to a promoter's first campaign and the chain cannot
 * enumerate one: `Campaign` exposes only point lookups, so `promoters.ts` rebuilds membership from
 * logs inside a 45,600-block window — about 25 hours of Base.
 *
 * ## The result is a union, and that is on purpose
 *
 * `history` is a `GraphResult`, not a `PromoterHistory | undefined`. A consumer therefore cannot read
 * counts without first handling `unavailable`, which is the whole point: an unreachable subgraph must
 * render "history unavailable" and never "0 campaigns, 0 tiers, 0 referrals". Those zeros are a claim
 * about a person, and a fetch that did not complete has not earned the right to make one.
 *
 * The fetch never throws, so react-query's `error` stays empty by design and failures arrive as data.
 * That is deliberate — a thrown error would put the fail-soft decision in every consumer's error
 * boundary, and the one place it must not be forgotten is the one where it renders as an empty card.
 */
export function useBoneyHistory(wallet: `0x${string}` | undefined) {
  const chainId = useBoneyChainId();

  const query = useQuery<GraphResult<PromoterHistory>>({
    queryKey: ["boneyHistory", chainId, wallet?.toLowerCase()],
    enabled: Boolean(wallet),
    // History is cumulative and moves only when a campaign is joined, an action is credited, or a
    // tier settles — none of which happen while someone reads their own card. A minute of staleness
    // costs nothing; the 10s global default would re-run two round trips on every navigation.
    staleTime: 60_000,
    // The failure is the data, so react-query has nothing to retry against. Retrying would also
    // hammer a rate-limited endpoint, which is the failure most likely to be transient and the one
    // where extra requests make it worse.
    retry: false,
    queryFn: async ({signal}) => fetchPromoterHistory({chainId, wallet, signal}),
  });

  /**
   * The chain head, for the lag figure.
   *
   * `watch: false` — this is a footer annotation, not a live readout, and a subscription that
   * re-rendered the card every two seconds to move a number nobody is watching would be a poor
   * trade. `chainId` is passed explicitly because wagmi otherwise falls back to `chains[0]`, which
   * is anvil.
   */
  const {data: chainHead} = useBlockNumber({
    chainId,
    watch: false,
    query: {staleTime: 30_000},
  });

  const result = query.data;
  const history = result?.kind === "ok" ? result.data : undefined;

  return {
    /** The union. Consumers handle `unavailable` before they can reach a count. */
    result,
    /** Present only on a successful read. */
    history,
    /** Present only on a failed one, with a reason the copy can branch on. */
    unavailable: (result?.kind === "unavailable" ? result : undefined) as
      | GraphUnavailable
      | undefined,

    isLoading: query.isLoading,
    isRefreshing: query.isFetching && !query.isLoading,
    refetch: query.refetch,

    /**
     * How far behind the chain the indexer is, in blocks. Undefined until both numbers are in.
     *
     * Worth surfacing rather than hiding: a promoter who just crossed a tier and does not see it needs
     * "indexed to 3 blocks ago", not a card that looks wrong.
     */
    lag: history ? graphLag(history.indexedBlock, chainHead) : undefined,
    /**
     * The counts over this data are lower bounds, either because a page cap was hit or because a
     * handler threw while indexing. Distinct from `unavailable`: the rows are real, just incomplete.
     */
    partial: Boolean(history && (history.truncated || history.hasIndexingErrors)),
  };
}
