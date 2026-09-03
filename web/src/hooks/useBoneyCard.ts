"use client";

import {useMemo} from "react";
import {useQuery} from "@tanstack/react-query";
import {useCampaigns} from "@/hooks/useCampaigns";
import {useJoinedCampaigns} from "@/hooks/useJoinedCampaigns";
import {usePromoterReputation} from "@/hooks/usePromoterReputation";
import {useScoreCeiling} from "@/hooks/useScoreCeiling";
import {useBoneyHistory} from "@/hooks/useBoneyHistory";
import {useBlockTimes} from "@/hooks/useBlockTimes";
import {useNow} from "@/hooks/useNow";
import {useTokenMeta} from "@/hooks/useTokenMeta";
import {
  cardScoreFrom,
  foldHistory,
  milestoneBlocks,
  qualify,
  qualificationHeadline,
  scoreScaleFrom,
  withResolvedDates,
  type CardHistory,
  type CardScore,
  type Qualification,
  type ScoreScale,
} from "@/lib/boneycard";
import type {CampaignView} from "@/lib/types";

/**
 * A wallet's BoneyCard, stage 1.
 *
 * IO only, per F6: the fetch and the three chain reads live here, and every decision the result
 * feeds lives in `lib/boneycard.ts` where a fixture can prove it.
 *
 * Five sources, and it is worth naming why each is separate:
 *
 *  - **`/api/score`** — the prospective score. Off-chain, free, exists for a wallet that has never
 *    transacted. This is what the card *shows*.
 *  - **`usePromoterReputation`** — `ReputationRegistry.scoreOf`. Zero until attestations land, and
 *    the only figure `Campaign.join()` reads. This is what decides whether Join actually works.
 *  - **`useCampaigns`** — what there is to qualify for.
 *  - **`useJoinedCampaigns`** — membership, which is the bridge to stage 2's history.
 *  - **`useScoreCeiling`** — `maxScore()`, which decides whether verification is a promise this
 *    network can keep at all. See `scoreScaleFrom`.
 *  - **`useBoneyHistory`** — the indexed campaign history behind stage 2. The only source here that
 *    is not the chain, because the chain cannot enumerate a promoter's campaigns past a 25-hour log
 *    window; see that hook's header.
 *
 * The score fetch is deliberately **not** gated on the chain reads. A card whose headline number
 * waits on an RPC round trip has thrown away the one advantage the off-chain score has, which is
 * that it is available immediately. The qualification section fills in behind it.
 *
 * The history is not gated on anything either, and it is allowed to fail on its own: a card with a
 * working score and an unreachable subgraph shows the score and says history is unavailable. What it
 * must never do is fold the failure into zeros — see `useBoneyHistory`.
 */
export function useBoneyCard(wallet: `0x${string}` | undefined) {
  const score = useQuery<CardScore>({
    queryKey: ["boneycard-score", wallet?.toLowerCase()],
    enabled: Boolean(wallet),
    // Matches the route's own OK_TTL. Refetching sooner cannot produce a different answer, and the
    // follower sources throttle back-to-back requests.
    staleTime: 5 * 60 * 1000,
    retry: false,
    queryFn: async (): Promise<CardScore> => {
      if (!wallet) return {kind: "unavailable", message: "No wallet."};

      // A non-2xx is an expected outcome here, not an exception: `no_ethos_profile` is the ordinary
      // first-run state. So the status and body are folded into a state rather than thrown, and
      // `retry: false` keeps a 400 from being re-requested three times.
      const response = await fetch(`/api/score?wallet=${wallet}`);
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        // Fall through with a null body; `cardScoreFrom` reports it as unavailable.
      }
      return cardScoreFrom(response.status, body);
    },
  });

  const {campaigns, isLoading: campaignsLoading, error: campaignsError} = useCampaigns();
  const {joined, isLoading: joinedLoading} = useJoinedCampaigns(campaigns);
  const {
    reputation,
    hasExpired,
    isLoading: reputationLoading,
    refetch: refetchReputation,
  } = usePromoterReputation(wallet);
  const {ceiling} = useScoreCeiling();

  const cardScore = score.data;
  const prospective = cardScore?.kind === "scored" ? cardScore.score.total : 0;
  const scale: ScoreScale = useMemo(() => scoreScaleFrom(ceiling), [ceiling]);

  const joinedAddresses = useMemo(
    () => new Set(joined.map((j) => j.view.campaign.toLowerCase())),
    [joined],
  );

  const qualification: Qualification = useMemo(
    () =>
      qualify({
        campaigns,
        prospective,
        // `undefined` means the read has not landed. Treating that as 0 would flash every gated
        // campaign into "verify to promote" and then move it, so the unresolved case is held at 0 only
        // because `qualificationReady` gates the render.
        onChain: reputation ?? BigInt(0),
        joined: joinedAddresses,
      }),
    [campaigns, prospective, reputation, joinedAddresses],
  );

  // ── stage 2 ────────────────────────────────────────────────────

  const {
    history,
    unavailable: historyUnavailable,
    isLoading: historyLoading,
    refetch: refetchHistory,
    lag,
  } = useBoneyHistory(wallet);

  /**
   * Wall-clock seconds, for the one history field that needs a comparison against it: whether an
   * Ended campaign was ended before its own `endTime`. `useNow` rather than `Date.now()` because a
   * clock read during render is impure — and it ticks once a minute, which is far finer than a rule
   * about a campaign's scheduled end needs.
   */
  const now = useNow();

  /**
   * On-chain `endTime` per campaign, keyed the way the subgraph keys campaigns.
   *
   * The fold needs it to tell an Ended campaign apart from one the project killed early, and the
   * subgraph's `Campaign` entity carries no end time at all. `useCampaigns` already holds it for the
   * qualification half, so this costs nothing — and when the list has not loaded the map is simply
   * empty and the rows claim nothing, which is the intended degradation.
   */
  const views = useMemo(
    () =>
      new Map<string, Pick<CampaignView, "endTime">>(
        campaigns.map((view) => [view.campaign.toLowerCase(), {endTime: view.endTime}]),
      ),
    [campaigns],
  );

  const folded: CardHistory | undefined = useMemo(
    () =>
      history
        ? foldHistory(history, {
            // `useNow` returns 0 until its store is live, and 0 is not a time — passing it would make
            // `now < endTime` true for every Ended campaign and label all of them "ended early". So
            // the clock is omitted until it is real, and the rows claim nothing in the meantime.
            ...(now > 0 ? {now} : {}),
            views,
          })
        : undefined,
    [history, views, now],
  );

  /**
   * Dates for the join-derived milestones.
   *
   * `Promoter` is indexed with `joinedAtBlock` and no timestamp, so three of the seven milestones
   * arrive as block numbers and need one lookup each. Two hooks rather than one fold because the
   * blocks are only known *after* the fold — and the fold is pure, so it cannot fetch them itself.
   */
  const blocks = useMemo(() => (folded ? milestoneBlocks(folded) : EMPTY_BLOCKS), [folded]);
  const {times} = useBlockTimes(blocks);
  const dated = useMemo(
    () => (folded ? withResolvedDates(folded, times) : undefined),
    [folded, times],
  );

  /**
   * Metadata for the dominant earned token.
   *
   * Only the first: `earned` is grouped by token and never summed across them, so the card renders one
   * amount and counts the rest. Reading three tokens' decimals to display two numbers the card is not
   * allowed to add would be three RPC calls for nothing.
   */
  const {meta: earnedToken} = useTokenMeta(dated?.earned[0]?.token ?? "");

  return {
    /** `scored` | `unclaimed` | `unavailable`. Never a zero standing in for a failure. */
    score: cardScore,
    scoreLoading: score.isLoading,
    refetchScore: score.refetch,

    /** `ReputationRegistry.scoreOf`, and whether it has aged out. */
    onChainScore: reputation,
    onChainExpired: hasExpired,
    /**
     * Re-read `scoreOf`. Submitting attestations changes it, and nothing else in the app will
     * notice: `useEthosAttestation` owns no query, so the cached reputation would otherwise keep
     * the newly-verified campaigns sitting in "verify to promote" until a reload. `PromoterPanel`
     * refetches the same way after its own attest.
     */
    refetchReputation,

    /** This network's real ceiling, and whether verification can move a score on it at all. */
    scale,

    qualification,
    headline: qualificationHeadline(qualification, {
      anonymous: !wallet,
      verifiable: scale.verifiable,
    }),
    /**
     * Whether the grouping can be trusted yet. Both the campaign list and the on-chain score have to
     * be in before "joinable now" is distinguishable from "verify to promote", and showing the wrong
     * one first would tell a promoter to pay for a verification they had already done.
     */
    qualificationReady: !campaignsLoading && !reputationLoading && !joinedLoading,
    campaignsError,

    /**
     * The history half, folded and dated. Undefined while loading and on a failed read — never a
     * zeroed card, which would be a claim about someone rather than a missing answer.
     */
    history: dated,
    historyUnavailable,
    historyLoading,
    refetchHistory,
    /** From `_meta`, so a lagging indexer is visible in the footer instead of looking like an error. */
    indexedBlock: history?.indexedBlock,
    lag,
    earnedToken,
    /**
     * The bone level, or undefined when it is not known.
     *
     * Undefined rather than 1 on an unreachable subgraph, because 1 is a *number* and this is a
     * missing answer: an outage must not take a level-5 promoter's card down to a beginner's.
     */
    level: dated?.level,
  };
}

/** Stable empty reference, so a card with no history does not hand `useBlockTimes` a new array a render. */
const EMPTY_BLOCKS: readonly bigint[] = [];
