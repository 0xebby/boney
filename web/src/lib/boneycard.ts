import {boneyScore, ethosLevel, MAX_BONEY_SCORE} from "./boneyscore";
import {rankOf, type Rank} from "./ranks";
import {canJoin} from "./promoter";
import {isBoundedScoreCeiling} from "./validation";
import {kpiKindFromIndex, type CampaignView, type KpiKind} from "./types";
import type {
  HistoryCampaign,
  HistoryCredit,
  HistoryKpi,
  HistoryMembership,
  HistoryPayout,
  PromoterHistory,
} from "./boneyHistory";

/**
 * BoneyCard — a promoter's card, stage 1.
 *
 * Pure and React-free (decision F6), same split as `promoters.ts` and `discovery.ts`: the fetch
 * lives in `useBoneyCard`, and everything that can be *wrong* lives here where a fixture can prove
 * it.
 *
 * ## The two scores this module keeps apart
 *
 * A wallet has two BoneyScores and they are routinely different:
 *
 *  - **Prospective** — computed off Ethos + X by `/api/score`. Free, instant, and exists for a
 *    wallet that has never sent a transaction.
 *  - **On-chain** — `ReputationRegistry.scoreOf`. Zero until the promoter submits attestations and
 *    pays gas, and it is the only one `Campaign.join()` reads.
 *
 * The card *displays* the prospective score, because showing a new promoter a zero is the opposite
 * of onboarding them. But `join()` checks the on-chain one, so a campaign the prospective score
 * clears is **not** joinable yet — it is "verify, then join". `qualify` below is built entirely
 * around not conflating those, because conflating them means a promoter pays gas for a transaction
 * that reverts `InsufficientReputation`. `useScoreCeiling`'s header records the last time a local
 * number disagreeing with the chain cost someone a reverted transaction.
 *
 * ## Why the score is dated and the history is not
 *
 * `ProspectiveScore.computedAt` exists because this number can go *down* with nothing happening:
 * Ethos scores move, follower counts move, and on-chain attestations expire against their schema's
 * `maxAge`. `discovery.ts` already named its field `scoreAtJoin` rather than `score` for exactly
 * this reason — "presenting it as a current score would be a lie". Stage 2's history counters are
 * the opposite: cumulative, and they never decrease.
 */

/** A prospective score, as `/api/score` computes it. Never read from the chain. */
export type ProspectiveScore = {
  wallet: `0x${string}`;
  /** Raw Ethos credibility, 0–2800. */
  ethos: number;
  /** Log-normalised reach, 0–2800. */
  reach: number;
  followers: number;
  /** Kaito's smart-follower count. Display only, contributes nothing to the score. */
  smartFollowers: number;
  handle: string | null;
  profileId: number;
  /** `7 * ethos + 3 * reach` — the same arithmetic `scoreOf` would do once attested. */
  total: number;
  /** Ethos's own band label for `ethos`. */
  level: string;
  /**
   * True when `reach` is a zero this module cannot vouch for.
   *
   * `fetchFollowers` returns 0 on *every* failure path by design — an outage should cost a promoter
   * their reach points, not their ability to join — and its own note says a zero cannot be
   * distinguished from a genuinely empty account. So the card cannot detect an outage, only suspect
   * one, and this flag carries the suspicion rather than presenting a 30% haircut as a fact.
   *
   * The heuristic: a wallet whose Ethos profile names an X handle, whose follower count came back
   * 0. A claimed handle with literally no followers is rarer than a throttled source. It is a
   * heuristic and the UI must word it as one ("reach unconfirmed"), never as "reach: 0".
   */
  reachUnconfirmed: boolean;
  /** Unix seconds. The card is dated; see the module note. */
  computedAt: number;
};

/**
 * What the card can show for a wallet's score.
 *
 * Three states, not two, and the third is the one that matters: an upstream failure must never
 * render as a zero score. A zero is a claim about a person, and a fetch that did not complete has
 * not earned the right to make one.
 */
export type CardScore =
  | {kind: "scored"; score: ProspectiveScore; rank: Rank}
  /**
   * No claimed Ethos profile. `fetchEthosProfile` throws `no_ethos_profile` for this, so there is
   * no score *and no reach either* — the X handle reach is derived from comes out of the Ethos
   * profile (`xHandleOf`), so breaking that link removes both halves at once.
   *
   * This is the expected first-run state for most wallets, not an error. The card still works: the
   * campaigns with `minReputation` 0 need no score at all.
   */
  | {kind: "unclaimed"; message: string}
  | {kind: "unavailable"; message: string};

/** The successful payload shape `/api/score` returns. */
export type ScoreResponse = Omit<ProspectiveScore, "total" | "level" | "rank">;

/** The error payload shape, shared with `/api/attest`. */
export type ScoreErrorResponse = {error: string; message: string};

/**
 * Fold an `/api/score` response into a card state.
 *
 * Takes the parsed body and the HTTP status rather than a `Response` so it stays testable without a
 * fetch. `no_ethos_profile` is the only error code that maps to `unclaimed`; everything else,
 * including a malformed body, is `unavailable`. Defaulting an unknown failure to `unclaimed` would
 * tell a promoter with a perfectly good profile to go and claim one.
 */
export function cardScoreFrom(status: number, body: unknown): CardScore {
  if (status >= 200 && status < 300) {
    const raw = body as Partial<ScoreResponse> | null;
    if (!raw || typeof raw.ethos !== "number" || typeof raw.reach !== "number") {
      return {kind: "unavailable", message: "The score service returned an unexpected payload."};
    }

    const score: ProspectiveScore = {
      wallet: raw.wallet as `0x${string}`,
      ethos: raw.ethos,
      reach: raw.reach,
      followers: raw.followers ?? 0,
      smartFollowers: raw.smartFollowers ?? 0,
      handle: raw.handle ?? null,
      profileId: raw.profileId ?? 0,
      total: boneyScore({ethos: raw.ethos, reach: raw.reach}),
      level: ethosLevel(raw.ethos),
      reachUnconfirmed: raw.reachUnconfirmed ?? false,
      computedAt: raw.computedAt ?? 0,
    };
    return {kind: "scored", score, rank: rankOf(score.total)};
  }

  const err = body as Partial<ScoreErrorResponse> | null;
  if (err?.error === "no_ethos_profile") {
    return {
      kind: "unclaimed",
      message: err.message ?? "This wallet has no claimed Ethos profile.",
    };
  }
  return {
    kind: "unavailable",
    message: err?.message ?? "Could not reach the score service.",
  };
}

// ── the ceiling the chain actually keeps ─────────────────────────

/**
 * What this network's registry will let a score reach, and whether verifying can raise one at all.
 *
 * `MAX_BONEY_SCORE` is the arithmetic for the *seeded* schema configuration, not a protocol
 * constant: `ReputationRegistry.maxScore()` is the sum of `maxValue * weight` over the weighted
 * schemas, so it moves when schemas are registered, re-weighted, or capped differently. The card
 * needs the real number for two separate reasons, and the second one is the load-bearing one:
 *
 *  1. The score meter's denominator. Quoting 28,000 on a network that caps at something else
 *     mis-draws the bar.
 *  2. **Whether "verify to promote" is a promise that can be kept.** A registry with no weighted
 *     schemas has a ceiling of 0, every wallet scores 0 permanently, and no attestation can change
 *     that. Offering a Verify button there sells one transaction per schema for no possible effect
 *     — the same class of mistake as the reverted transaction in `useScoreCeiling`'s header, only
 *     paid for in full rather than reverted.
 *
 * That state is not hypothetical: `DeployBoney` registers no schemas, so a redeploy that skips
 * `SeedDevRep` leaves exactly this behind, and `CreateCampaignPage`'s `CeilingNote` already warns
 * about the same registry from the project's side.
 */
export type ScoreScale = {
  /**
   * Denominator for the score meter. Absent when there is no ratio worth drawing — either no
   * ceiling exists or the registry admits no score at all.
   */
  max?: number;
  /** Whether submitting attestations can move `scoreOf` on this network at all. */
  verifiable: boolean;
  /** The part the numbers cannot carry, for the UI to render as words. */
  note?: string;
};

/**
 * Fold `useScoreCeiling`'s reading into a scale.
 *
 * Takes the raw `bigint | undefined` rather than the hook's whole result because `undefined` already
 * means "no answer" for both of the hook's non-answers — still loading, and the read failed — and the
 * card treats them identically.
 */
export function scoreScaleFrom(ceiling: bigint | undefined): ScoreScale {
  // No answer yet, or the read failed. Fall back to the local arithmetic — the same
  // `?? MAX_BONEY_SCORE` that `validateCampaignDraft` uses — and keep offering verification. "The
  // registry is unreachable" and "the registry admits no reputation" are opposite claims, and
  // assuming the second would withhold a verification the chain would have accepted.
  if (ceiling === undefined) return {max: MAX_BONEY_SCORE, verifiable: true};

  if (ceiling === BigInt(0)) {
    return {
      verifiable: false,
      note:
        "This network's reputation registry has no weighted schemas, so no wallet can hold an " +
        "on-chain BoneyScore yet. Verifying would cost gas and change nothing.",
    };
  }

  // `maxScore()` returns `type(uint256).max` when a weighted schema has no value cap. That is an
  // unbounded score, not an enormous one, so there is no denominator — drawing a meter against
  // 1.15e77 would render every real score as an empty bar.
  if (!isBoundedScoreCeiling(ceiling)) {
    return {
      verifiable: true,
      note: "This network reports no score ceiling, so there is no maximum to measure against.",
    };
  }

  return {max: Number(ceiling), verifiable: true};
}

// ── qualification ────────────────────────────────────────────────

/**
 * Which bucket a campaign falls into for one wallet.
 *
 * `verifyToJoin` is the whole reason this is five groups rather than a boolean: it is the set the
 * prospective score clears and the chain does not, which is exactly where a naive implementation
 * hands someone a promote button that reverts.
 */
export type QualificationGroup =
  /** On-chain score already clears it (or it has no gate). Promoting works today. */
  | "joinableNow"
  /** Prospective score clears it, on-chain does not. Attest first, then promote. */
  | "verifyToJoin"
  /** Even the prospective score falls short. */
  | "scoreTooLow"
  /** Already a promoter here. The bridge to stage 2. */
  | "joined"
  /** Not accepting promoters — ended, cancelled, or paused. */
  | "closed";

export type QualifiedCampaign = {
  view: CampaignView;
  group: QualificationGroup;
  /** How far short the prospective score is. Only set for `scoreTooLow`. */
  shortfall?: bigint;
};

export type Qualification = {
  joinableNow: QualifiedCampaign[];
  verifyToJoin: QualifiedCampaign[];
  scoreTooLow: QualifiedCampaign[];
  joined: QualifiedCampaign[];
  closed: QualifiedCampaign[];
};

const EMPTY_QUALIFICATION = (): Qualification => ({
  joinableNow: [],
  verifyToJoin: [],
  scoreTooLow: [],
  joined: [],
  closed: [],
});

/**
 * Sort every campaign into what this wallet could do about it.
 *
 * Runs `canJoin` **twice** — once against the on-chain score, once against the prospective one —
 * rather than reimplementing the gate. `canJoin` already mirrors Solidity's three failure modes
 * (`WrongStatus` unless Active or Pending, `AlreadyJoined`, `InsufficientReputation` when
 * `minReputation != 0 && score < minReputation`) and already distinguishes a reputation block from
 * the others via `actionable: "attest"`. A second implementation here would be a second thing to
 * drift.
 *
 * `connected` is deliberately not a parameter. `canJoin` treats a missing wallet as a blocker,
 * which is right for a promote button but wrong here: qualification answers "would this wallet be
 * admitted", not "can this browser sign right now". Passing `connected: false` through would
 * collapse every campaign into one bucket and make the shared card (`/b/<wallet>`, no wallet
 * connected) useless. The button's own guard still calls `canJoin` with the real value.
 */
export function qualify(input: {
  campaigns: readonly CampaignView[];
  /** Off-chain score from `/api/score`. 0 when the card is `unclaimed` or `unavailable`. */
  prospective: number;
  /** `ReputationRegistry.scoreOf`. */
  onChain: bigint;
  /** Lowercased campaign addresses this wallet has already joined. */
  joined: ReadonlySet<string>;
}): Qualification {
  const out = EMPTY_QUALIFICATION();
  const prospective = BigInt(Math.max(0, Math.floor(input.prospective)));

  for (const view of input.campaigns) {
    const alreadyJoined = input.joined.has(view.campaign.toLowerCase());
    const base = {
      status: view.status,
      alreadyJoined,
      minReputation: view.minReputation,
      connected: true,
    };

    // Membership is not a qualification question, so it is answered before either score is read.
    if (alreadyJoined) {
      out.joined.push({view, group: "joined"});
      continue;
    }

    const onChainVerdict = canJoin({...base, reputation: input.onChain});
    if (onChainVerdict.ok) {
      out.joinableNow.push({view, group: "joinableNow"});
      continue;
    }

    // Anything a signature cannot fix is a status problem — ended, cancelled, paused.
    if (onChainVerdict.actionable !== "attest") {
      out.closed.push({view, group: "closed"});
      continue;
    }

    if (canJoin({...base, reputation: prospective}).ok) {
      out.verifyToJoin.push({view, group: "verifyToJoin"});
      continue;
    }

    out.scoreTooLow.push({
      view,
      group: "scoreTooLow",
      shortfall: view.minReputation - prospective,
    });
  }

  return out;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Verb agreement for a count.
 *
 * `plural` handles the noun; this handles what follows it. Without it every one-campaign card reads
 * "1 open campaign need a higher BoneyScore" — and the one-campaign case is not an edge, it is what a
 * network with a single gated campaign shows every visitor.
 */
const agrees = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * The card's opening line.
 *
 * Ordered to lead with what needs no gas. Five of the eight live campaigns on Base Sepolia set
 * `minReputation` 0, so for most new wallets the true first message is "you can start now" rather
 * than "verify first" — and putting a verification prompt in front of that is asking a stranger to
 * pay for three transactions before they have seen the product work.
 *
 * `anonymous` is the no-wallet case, which is a real one: the card renders before a connection and at
 * `/b/<wallet>` for a visitor who is not the subject. The grouping is still valid there — `qualify`
 * never asks whether a wallet is connected — but the second person is not, because "you can promote"
 * is a claim about a reader whose address nobody knows. The counts are the same; only the voice
 * changes.
 *
 * `verifiable: false` suppresses every verification clause. On a registry with no weighted schemas
 * the `verifyToJoin` group is not a set verification unlocks — it is gated with no route through at
 * all — so the honest line names the gate and stops, rather than selling a transaction per schema
 * that cannot raise a score. See `scoreScaleFrom`.
 */
export function qualificationHeadline(
  q: Qualification,
  opts: {anonymous?: boolean; verifiable?: boolean} = {},
): string {
  const now = q.joinableNow.length;
  const verify = q.verifyToJoin.length;
  const short = q.scoreTooLow.length;

  if (opts.anonymous) {
    // With no wallet there is no prospective score, so every gated campaign lands in `scoreTooLow`.
    // Reporting it as "above your score" would be a judgement about a stranger; it is simply gated.
    const gated = verify + short;
    if (now > 0 && gated > 0) {
      return `${plural(now, "campaign", "campaigns")} open to anyone — no BoneyScore needed. ${gated} more ${agrees(gated, "is", "are")} score-gated.`;
    }
    if (now > 0) return `${plural(now, "campaign", "campaigns")} open to anyone — no BoneyScore needed.`;
    if (gated > 0) {
      return `${plural(gated, "open campaign", "open campaigns")}, ${agrees(gated, "and it is", "all of them")} score-gated. Connect to see where you stand.`;
    }
    return "No campaigns are open to promote right now.";
  }

  if (opts.verifiable === false) {
    // The prospective score is real and still clears these gates; what is missing is anywhere to
    // record it. So the two gated groups collapse into one — the distinction between them is which
    // side of a verification they sit on, and there is no verification on this network.
    const gated = verify + short;
    if (now > 0 && gated > 0) {
      return `You can promote ${plural(now, "campaign", "campaigns")} right now. ${gated} more ${agrees(gated, "is", "are")} score-gated, and this network cannot record a BoneyScore yet.`;
    }
    if (now > 0) return `You can promote ${plural(now, "campaign", "campaigns")} right now.`;
    if (gated > 0) {
      return `${plural(gated, "open campaign", "open campaigns")} ${agrees(gated, "is", "are")} score-gated, and this network cannot record a BoneyScore yet.`;
    }
  }

  if (now > 0 && verify > 0) {
    return `You can promote ${plural(now, "campaign", "campaigns")} right now — verify your BoneyScore to unlock ${verify} more.`;
  }
  if (now > 0) return `You can promote ${plural(now, "campaign", "campaigns")} right now.`;
  if (verify > 0) {
    return `Verify your BoneyScore to unlock ${plural(verify, "campaign", "campaigns")}.`;
  }
  if (short > 0) {
    return `${plural(short, "open campaign", "open campaigns")} ${agrees(short, "needs", "need")} a higher BoneyScore than yours.`;
  }
  if (q.joined.length > 0) return "You are promoting every campaign that is currently open.";
  return "No campaigns are open to promote right now.";
}

/**
 * Bone level. Stage 1 is always 1.
 *
 * Deliberately not a formula over the score: levels are the *delivery* progression, and stage 1 has
 * no delivery yet. Differentiating new promoters is the rank badge's job — the ladder in `ranks.ts`
 * already spans Netrunner to Legend off Ethos and reach — so a level derived from the same inputs
 * would say the same thing twice and leave nothing for campaigns to move.
 */
export const STAGE_ONE_LEVEL = 1;
export const MAX_LEVEL = 5;

// ── stage 2: the history fold ────────────────────────────────────

/**
 * Everything below folds `PromoterHistory` into the card's history half.
 *
 * Pure, so the fixtures can pin it. `boneyHistory.ts` fetches and decodes and counts nothing; this is
 * where the counting lives, which is the same split `promoters.ts` and `discovery.ts` use and the
 * reason the subgraph stores no aggregate entities either.
 *
 * ## Counts, never rates
 *
 * Every figure here is cumulative and can only go up. No percentages, no denominators — a percentage
 * exists to be compared, and the moment the card shows one it is a ranking whether or not anything
 * sorts on it. That decision is also what removes most of the arithmetic: there is no denominator to
 * keep unearned blame out of, so the awkward cases (an aggregate KPI nobody can score on, a campaign
 * the project killed early) become display flags rather than exclusion rules.
 *
 * ## Two things that are deliberately never summed
 *
 *  - **`Credit.amount` across campaigns.** One campaign's amount is a swap count, another's is raw
 *    wei, another's a token total awaiting `Kpi.scale`. Adding them produces a large meaningless
 *    number. Amounts stay on per-campaign rows in their own units; the card totals `actions` instead.
 *  - **`TierPayout.paid` across tokens.** Base Sepolia alone has two mock bUSD deployments at
 *    different addresses, so adding them asserts a 1:1 rate nobody set. `earned` is grouped by token
 *    and the UI renders the dominant one with a "+N other tokens" affordance. Summing *within* one
 *    campaign is safe — a campaign has exactly one `token`.
 */

/** One campaign as the card's per-campaign row. Amounts stay here, in their own units. */
export type CampaignHistoryRow = {
  campaign: HistoryCampaign;
  /** `count(Credit)` for this wallet here. */
  actions: number;
  /** Distinct `Credit.user` here. */
  referrals: number;
  /** `count(TierPayout)`. */
  tiers: number;
  /** `Σ TierPayout.paid`. Safe to sum: one campaign, one token. */
  paid: bigint;
  /** At least one credited action. */
  delivered: boolean;
  /** KPI kinds this wallet holds credit on here — the specialization badges' source. */
  kinds: KpiKind[];
  /**
   * Every KPI here is campaign-wide, so **no promoter could ever be credited**.
   *
   * `reportUserAction` reverts `AggregateKpi` before it even reaches attribution, and the only
   * writable path, `applyAggregateUpdate`, moves `_totalProgress` and never `_progress[promoter]`.
   * Campaign 8 "Gyndore" is the live case: one aggregate Swap KPI behind a 3-tier, 27,000 bUSD ladder
   * that could not pay anybody, ended three hours in at `totalProgress` 0.
   *
   * So `delivered: false` here is not a miss and the card must not draw it as one — it is a
   * project-side misconfiguration, and worth surfacing rather than hiding.
   *
   * False when the KPI list is empty rather than assumed: absent data cannot support the claim, and
   * "nothing was creditable" is a strong thing to say about someone else's campaign.
   */
  aggregateOnly: boolean;
  /**
   * The project called `end()` before the campaign's own `endTime`.
   *
   * Undefined when that cannot be known, which is the common case: the subgraph's `Campaign` entity
   * carries `createdAt` and `status` but **no end time**, so "Ended" alone does not distinguish a
   * campaign that ran its course from one killed hours after launch. The window comes from the
   * on-chain `CampaignView.endTime`, which `/card` already holds for the qualification half — pass it
   * in and the row can explain itself; leave it out and the row says "Ended" and claims nothing more.
   */
  endedEarly?: boolean;
};

/** Earnings in one token. Never combined with another token's. */
export type TokenEarnings = {
  token: `0x${string}`;
  paid: bigint;
  /** How many campaigns paid in it, for the "+N other tokens" affordance. */
  campaigns: number;
};

export type MilestoneKey =
  | "firstJoin"
  | "firstCredit"
  | "firstTier"
  | "firstPaid"
  | "fifthCampaign"
  | "firstRepeatProject"
  | "secondKind";

/**
 * A dated first.
 *
 * `at` is unix seconds and `atBlock` is a block number, and which one a milestone carries is not a
 * style choice: `Credit` and `TierPayout` are indexed with a `timestamp`, but `Promoter` records only
 * `joinedAtBlock` and no time at all. So every join-derived milestone is a block until something
 * resolves it. `Campaign.createdAt` is not that something — it is a lower bound that would date a
 * promoter to before they joined — and the earliest credit is an upper bound that would date them to
 * after. One `getBlock` per card is the honest fix, and it belongs in the hook, not here.
 */
export type Milestone = {
  key: MilestoneKey;
  label: string;
  /**
   * The same milestone as an instruction, for the unearned case.
   *
   * Two labels rather than one because an unearned achievement written in the past tense reads as a
   * failure — a wallet that has done nothing would be looking at seven greyed-out things it has not
   * done. The empty card is the state that matters most, and "Promote your first campaign" is an
   * invitation where "First campaign promoted" is a void.
   */
  todo: string;
  earned: boolean;
  /** Unix seconds. Only on milestones derived from a `Credit` or `TierPayout`. */
  at?: number;
  /** Block number. Only on milestones derived from a join. */
  atBlock?: bigint;
};

export type CardHistory = {
  campaignsJoined: number;
  /**
   * Unix seconds of the earliest join, once a block has been resolved to a time.
   *
   * Absent until `withResolvedDates` runs — `foldHistory` cannot fill it, because `Promoter` indexes
   * `joinedAtBlock` and no timestamp at all. See `Milestone`.
   */
  promotingSince?: number;
  /** Distinct `campaign.project`. One address is behind all 9 live campaigns, so this reads 1 today. */
  projects: number;
  campaignsDelivered: number;
  /** Distinct `Credit.user` across every campaign — a user referred twice counts once. */
  referrals: number;
  actions: number;
  tiers: number;
  /** Per token, largest first. `[0]` is the dominant token the card renders. */
  earned: TokenEarnings[];
  /** Earliest `joinedAtBlock`. A block, not a date — see `Milestone`. */
  promotingSinceBlock?: bigint;
  /** Distinct KPI kinds with credit. The badges. */
  specializations: KpiKind[];
  level: number;
  milestones: Milestone[];
  /** Per campaign, most recently joined first. */
  rows: CampaignHistoryRow[];
  /** A page cap was hit or a handler threw. Every count above is a floor, and the card must say so. */
  partial: boolean;
  /**
   * Payouts this wallet received in a campaign it has no membership row for.
   *
   * Should be zero. Settlement pays a promoter who joined, and `join()` records the wallet in the same
   * transaction, so a non-zero count means the index is inconsistent. Counted in `tiers` because the
   * payout did happen, but left out of `earned` because there is no membership to read a token from —
   * and surfaced rather than swallowed, since a silent drop here understates what someone earned.
   */
  orphanPayouts: number;
};

/**
 * The bone ladder.
 *
 * Calibrated against the real fixture rather than in the abstract, which is the only way to make
 * "level 2" land somewhere that feels earned: the dev wallet holds 8 delivered campaigns and 31 tiers
 * across the 9 campaigns of the 2026-08-23 fixture (registry `0x6427217e`, since replaced), and
 * reaches 5.
 *
 * **Distinct projects is deliberately not a requirement.** One project address is behind every live
 * campaign, so a rung that demanded two would pin every wallet on this deployment below it forever —
 * a level nobody can reach is not a progression, it is a locked door. It stays available as a
 * milestone (`firstRepeatProject`) where it costs nothing.
 *
 * Tiers are an alternative to delivered campaigns at every rung, not a second requirement. Crossing a
 * tier implies delivery — a tier settles on credited progress — so this is not a loosening; it is
 * what keeps the level right when `credits` truncated and `tierPayouts` did not.
 */
const LEVEL_LADDER: readonly {level: number; delivered: number; tiers: number}[] = [
  {level: 2, delivered: 1, tiers: 1},
  {level: 3, delivered: 3, tiers: 5},
  {level: 4, delivered: 6, tiers: 15},
  {level: 5, delivered: 8, tiers: 30},
];

/**
 * The bone level, 1–5.
 *
 * Takes the **highest** rung satisfied rather than scanning to the first failure. With `OR` rungs the
 * two are not the same function: a wallet with 30 tiers and no surviving credit rows clears rung 5 on
 * tiers while failing rung 2 on delivered campaigns, and a first-failure scan would hand it level 1.
 * Taking the maximum also makes monotonicity structural — every rung's predicate is monotone in both
 * inputs, so the level can never fall when a count rises, which is the one hard rule here. A level
 * that drops takes away something already earned, usually over something the promoter did not
 * control.
 */
export function boneLevel(counts: {campaignsDelivered: number; tiers: number}): number {
  let level = STAGE_ONE_LEVEL;
  for (const rung of LEVEL_LADDER) {
    if (counts.campaignsDelivered >= rung.delivered || counts.tiers >= rung.tiers) {
      level = Math.max(level, rung.level);
    }
  }
  return Math.min(level, MAX_LEVEL);
}

/** Ascending, with rows that never joined last. Used for every join-ordered milestone. */
function joinOrdered(memberships: readonly HistoryMembership[]): HistoryMembership[] {
  return [...memberships]
    .filter((m) => m.joinedAtBlock !== undefined)
    .sort((a, b) => (a.joinedAtBlock! < b.joinedAtBlock! ? -1 : a.joinedAtBlock! > b.joinedAtBlock! ? 1 : 0));
}

const MILESTONE_LABEL: Record<MilestoneKey, string> = {
  firstJoin: "First campaign promoted",
  firstCredit: "First action credited",
  firstTier: "First tier crossed",
  firstPaid: "First reward paid",
  fifthCampaign: "5th campaign promoted",
  firstRepeatProject: "First repeat project",
  secondKind: "First second protocol type",
};

/**
 * The same seven as instructions.
 *
 * Worded so they stay true when read out of order, which happens: `firstPaid` can be unearned while
 * `firstTier` is earned, because a tier settles for whatever the pool could release and that can be
 * nothing. So this one says "a reward pays out" rather than "cross a tier to get paid" — the promoter
 * may already have done everything asked.
 */
const MILESTONE_TODO: Record<MilestoneKey, string> = {
  firstJoin: "Promote your first campaign",
  firstCredit: "Get your first action credited",
  firstTier: "Cross your first reward tier",
  firstPaid: "Have a reward pay out",
  fifthCampaign: "Promote five campaigns",
  firstRepeatProject: "Promote for the same project twice",
  secondKind: "Deliver on a second protocol type",
};

/**
 * The dated list of firsts, earned and not.
 *
 * Always returns all seven in a fixed order, including the unearned ones — the empty card is the most
 * important state, and a promoter who has done nothing should see what is *next* rather than a blank
 * space. That is the difference between an invitation and a void.
 *
 * Everything time-ordered sorts on `timestamp`, never on arrival or `id`. `Credit.id` and
 * `TierPayout.id` are `<txHash>-<logIndex>`, which is lexicographic and has nothing to do with when
 * anything happened; the paginator orders by it because it needs a stable total order, and reusing
 * that order here would date the milestones by transaction hash.
 *
 * `firstPaid` is separate from `firstTier` on purpose. `TierSettled` fires with whatever the pool
 * could release, so `paid` can be 0 when the reward pool ran short — the tier was crossed and nothing
 * arrived. Folding them together would either claim a payment that never came or hide a tier that was
 * genuinely earned.
 */
export function milestonesOf(input: {
  memberships: readonly HistoryMembership[];
  credits: readonly HistoryCredit[];
  payouts: readonly HistoryPayout[];
  /** Credit id → the KPI kinds that credit sits on. Built by the fold. */
  kindsOfCredit: (credit: HistoryCredit) => readonly KpiKind[];
}): Milestone[] {
  const joins = joinOrdered(input.memberships);
  const byTime = <T extends {timestamp: bigint}>(rows: readonly T[]): T[] =>
    [...rows].sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));

  const credits = byTime(input.credits);
  const payouts = byTime(input.payouts);
  const firstCredit = credits[0];
  const firstTier = payouts[0];
  const firstPaid = payouts.find((p) => p.paid > BigInt(0));

  // The join at which some project appeared for the second time. Ordered by block, so the milestone
  // is dated to the repeat rather than to the project's first campaign.
  let repeatAt: bigint | undefined;
  const seenProjects = new Set<string>();
  for (const m of joins) {
    const project = m.campaign.project.toLowerCase();
    if (seenProjects.has(project)) {
      repeatAt = m.joinedAtBlock;
      break;
    }
    seenProjects.add(project);
  }

  // The credit that introduced a second distinct KPI kind. One credit can carry more than one kind
  // when a campaign reuses an index across KPIs, so the set is grown per credit, not per row.
  let secondKindAt: bigint | undefined;
  const seenKinds = new Set<KpiKind>();
  for (const credit of credits) {
    for (const kind of input.kindsOfCredit(credit)) seenKinds.add(kind);
    if (seenKinds.size >= 2) {
      secondKindAt = credit.timestamp;
      break;
    }
  }

  const at = (t: bigint | undefined) => (t === undefined ? undefined : Number(t));

  const rows: {key: MilestoneKey; at?: number; atBlock?: bigint}[] = [
    {key: "firstJoin", atBlock: joins[0]?.joinedAtBlock},
    {key: "firstCredit", at: at(firstCredit?.timestamp)},
    {key: "firstTier", at: at(firstTier?.timestamp)},
    {key: "firstPaid", at: at(firstPaid?.timestamp)},
    {key: "fifthCampaign", atBlock: joins[4]?.joinedAtBlock},
    {key: "firstRepeatProject", atBlock: repeatAt},
    {key: "secondKind", at: at(secondKindAt)},
  ];

  return rows.map((row) => ({
    key: row.key,
    label: MILESTONE_LABEL[row.key],
    todo: MILESTONE_TODO[row.key],
    earned: row.at !== undefined || row.atBlock !== undefined,
    ...(row.at !== undefined ? {at: row.at} : {}),
    ...(row.atBlock !== undefined ? {atBlock: row.atBlock} : {}),
  }));
}

/**
 * Fold one wallet's indexed history into the card.
 *
 * `views` supplies on-chain `endTime` per campaign so an Ended campaign can be told apart from one the
 * project killed early; it is optional because the subgraph does not carry an end time and a card
 * rendered without the chain read should say less rather than guess. `now` is a parameter rather than
 * a `Date.now()` call so the ended-early rule is pinnable by a fixture.
 *
 * The `promoterId` hop happens here. `Credit` carries only `promoterId`, which is **per campaign** — a
 * wallet promoting three campaigns holds three unrelated ids — so credits are attributed by mapping
 * the id back through the memberships. A credit whose id is not among them cannot be placed and is
 * counted in the totals but not in any row, which is the honest handling: it is this wallet's credit
 * either way, and inventing a campaign for it would be worse than leaving a row short.
 */
export function foldHistory(
  history: PromoterHistory,
  opts: {now?: number; views?: ReadonlyMap<string, Pick<CampaignView, "endTime">>} = {},
): CardHistory {
  const membershipById = new Map<string, HistoryMembership>();
  for (const m of history.memberships) membershipById.set(m.promoterId.toLowerCase(), m);

  const kpisByCampaign = new Map<string, HistoryKpi[]>();
  for (const kpi of history.kpis) {
    const key = kpi.campaign.toLowerCase();
    const list = kpisByCampaign.get(key);
    if (list) list.push(kpi);
    else kpisByCampaign.set(key, [kpi]);
  }

  /** The kinds a credit sits on. A campaign can carry several KPIs at one index only if the index is
   *  reused, so this is usually one kind; it is a list so that case cannot silently drop one. */
  const kindsOfCredit = (credit: HistoryCredit): KpiKind[] => {
    const campaign = membershipById.get(credit.promoterId.toLowerCase())?.campaign.address;
    if (!campaign) return [];
    return (kpisByCampaign.get(campaign.toLowerCase()) ?? [])
      .filter((k) => k.index === credit.kpiIndex)
      .map((k) => kpiKindFromIndex(k.kind));
  };

  type Bucket = {
    membership: HistoryMembership;
    actions: number;
    users: Set<string>;
    tiers: number;
    paid: bigint;
    kinds: Set<KpiKind>;
  };

  const buckets = new Map<string, Bucket>();
  for (const m of history.memberships) {
    buckets.set(m.campaign.address.toLowerCase(), {
      membership: m,
      actions: 0,
      users: new Set(),
      tiers: 0,
      paid: BigInt(0),
      kinds: new Set(),
    });
  }

  const allUsers = new Set<string>();
  for (const credit of history.credits) {
    allUsers.add(credit.user.toLowerCase());
    const campaign = membershipById.get(credit.promoterId.toLowerCase())?.campaign.address;
    const bucket = campaign ? buckets.get(campaign.toLowerCase()) : undefined;
    if (!bucket) continue;
    bucket.actions += 1;
    bucket.users.add(credit.user.toLowerCase());
    for (const kind of kindsOfCredit(credit)) bucket.kinds.add(kind);
  }

  let orphanPayouts = 0;
  for (const payout of history.payouts) {
    const bucket = buckets.get(payout.campaign.toLowerCase());
    if (!bucket) {
      orphanPayouts += 1;
      continue;
    }
    bucket.tiers += 1;
    bucket.paid += payout.paid;
  }

  const now = opts.now;
  const rows: CampaignHistoryRow[] = [...buckets.values()].map((bucket) => {
    const kpis = kpisByCampaign.get(bucket.membership.campaign.address.toLowerCase()) ?? [];
    const endTime = opts.views?.get(bucket.membership.campaign.address.toLowerCase())?.endTime;
    const ended = bucket.membership.campaign.status === "Ended";
    return {
      campaign: bucket.membership.campaign,
      actions: bucket.actions,
      referrals: bucket.users.size,
      tiers: bucket.tiers,
      paid: bucket.paid,
      delivered: bucket.actions > 0,
      kinds: [...bucket.kinds],
      // An empty KPI list cannot support the claim — see `aggregateOnly`.
      aggregateOnly: kpis.length > 0 && kpis.every((k) => k.aggregate),
      ...(ended && endTime !== undefined && now !== undefined
        ? {endedEarly: BigInt(Math.floor(now)) < endTime}
        : {}),
    };
  });

  // Most recently joined first: a card is read for what is happening now, and the oldest campaign is
  // already called out by "promoting since". Rows with no join block sort last.
  rows.sort((a, b) => {
    const ja = buckets.get(a.campaign.address.toLowerCase())?.membership.joinedAtBlock;
    const jb = buckets.get(b.campaign.address.toLowerCase())?.membership.joinedAtBlock;
    if (ja === undefined) return jb === undefined ? 0 : 1;
    if (jb === undefined) return -1;
    return ja > jb ? -1 : ja < jb ? 1 : 0;
  });

  const earnedByToken = new Map<string, TokenEarnings>();
  for (const row of rows) {
    if (row.paid <= BigInt(0)) continue;
    const token = row.campaign.token.toLowerCase() as `0x${string}`;
    const entry = earnedByToken.get(token);
    if (entry) {
      entry.paid += row.paid;
      entry.campaigns += 1;
    } else {
      earnedByToken.set(token, {token, paid: row.paid, campaigns: 1});
    }
  }
  const earned = [...earnedByToken.values()].sort((a, b) =>
    a.paid > b.paid ? -1 : a.paid < b.paid ? 1 : 0,
  );

  const joins = joinOrdered(history.memberships);
  const campaignsDelivered = rows.filter((r) => r.delivered).length;
  const tiers = history.payouts.length;

  const specializations = [...new Set(rows.flatMap((r) => r.kinds))];

  return {
    campaignsJoined: history.memberships.length,
    projects: new Set(history.memberships.map((m) => m.campaign.project.toLowerCase())).size,
    campaignsDelivered,
    referrals: allUsers.size,
    actions: history.credits.length,
    tiers,
    earned,
    ...(joins[0]?.joinedAtBlock !== undefined ? {promotingSinceBlock: joins[0].joinedAtBlock} : {}),
    specializations,
    level: boneLevel({campaignsDelivered, tiers}),
    milestones: milestonesOf({
      memberships: history.memberships,
      credits: history.credits,
      payouts: history.payouts,
      kindsOfCredit,
    }),
    rows,
    partial: history.truncated || history.hasIndexingErrors,
    orphanPayouts,
  };
}

// ── blocks into dates ────────────────────────────────────────────

/**
 * The block numbers this card needs a timestamp for.
 *
 * Three at most — first join, fifth campaign, first repeat project — because `Promoter` is the only
 * entity indexed without a time, and every other milestone comes from a `Credit` or a `TierPayout`
 * that carries one. Distinct, so the common case of a promoter whose first and fifth joins landed in
 * one transaction costs a single lookup.
 *
 * Returned rather than resolved here because this module makes no requests. `useBoneyCard` fetches the
 * blocks and hands the answers back to `withResolvedDates`.
 */
export function milestoneBlocks(card: Pick<CardHistory, "milestones">): bigint[] {
  const blocks = new Set<bigint>();
  for (const milestone of card.milestones) {
    if (milestone.atBlock !== undefined) blocks.add(milestone.atBlock);
  }
  return [...blocks];
}

/**
 * Date the join-derived milestones, leaving the rest alone.
 *
 * A block timestamp is the chain's own clock, so a resolved `at` here is exactly as good as one that
 * came from a `Credit` — this is a lookup, not an estimate, which is why neither of the two available
 * approximations was acceptable instead. `Campaign.createdAt` is a lower bound that would date a
 * promoter to before they joined; the earliest credit is an upper bound that would date them to after.
 *
 * `atBlock` is deliberately **kept** alongside the resolved `at`. The lookup is one RPC call against a
 * network this repo has already recorded as flaky, so a milestone whose block did not resolve still
 * has something true to render, and the UI falls back to the block number rather than to a dash.
 *
 * Pure, and total: an empty map returns the card unchanged rather than dropping the dates it cannot
 * fill.
 */
export function withResolvedDates(
  card: CardHistory,
  times: ReadonlyMap<bigint, number>,
): CardHistory {
  if (times.size === 0) return card;

  const milestones = card.milestones.map((milestone) => {
    if (milestone.atBlock === undefined || milestone.at !== undefined) return milestone;
    const at = times.get(milestone.atBlock);
    return at === undefined ? milestone : {...milestone, at};
  });

  const since =
    card.promotingSinceBlock === undefined ? undefined : times.get(card.promotingSinceBlock);

  return {
    ...card,
    milestones,
    ...(since === undefined ? {} : {promotingSince: since}),
  };
}

/**
 * The next milestone to aim at, or undefined once all seven are earned.
 *
 * Milestones are in a fixed order and that order is the ladder, so "next" is simply the first
 * unearned one. It exists because the empty card is the state that matters most: a promoter who has
 * done nothing should be looking at what to do next, not at a blank list.
 */
export function nextMilestone(milestones: readonly Milestone[]): Milestone | undefined {
  return milestones.find((m) => !m.earned);
}

/**
 * Earned milestones oldest-first, then the unearned ones in ladder order.
 *
 * `milestonesOf` returns the ladder, which is the right order to *reason* about — it is the sequence a
 * promoter climbs — but the wrong order to read as a dated list: the fifth-campaign rung is dated by a
 * join and the reward rungs by settlements, so ladder order routinely prints 18 August below
 * 23 August. Reordering the earned half is what makes it a history rather than a checklist with dates
 * attached.
 *
 * The unearned half keeps ladder order and stays at the end, which leaves `nextMilestone` unchanged:
 * the first unearned entry is the same either way.
 *
 * An earned milestone with no date sorts last within the earned half. That is only reachable when a
 * block lookup failed, and it is the least-bad option — the alternative is comparing a block number
 * against a unix timestamp, which are both monotone in time and on completely different scales.
 */
export function orderedMilestones(milestones: readonly Milestone[]): Milestone[] {
  const earned = milestones.filter((m) => m.earned);
  const unearned = milestones.filter((m) => !m.earned);

  const at = (m: Milestone) => m.at ?? Number.POSITIVE_INFINITY;
  // Stable, so undated entries and ties keep the ladder order they arrived in.
  earned.sort((a, b) => (at(a) === at(b) ? 0 : at(a) < at(b) ? -1 : 1));

  return [...earned, ...unearned];
}
