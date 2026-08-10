import {
  ETHOS_WEIGHT,
  REACH_WEIGHT,
  MAX_ETHOS,
  MAX_BONEY_SCORE,
  boneyScore,
  followersForReach,
} from "./boneyscore";

/**
 * BoneyScore ranks — the browsable, human-facing layer over a raw score.
 *
 * A campaign host setting `minReputation` has to pick a number out of 0–28,000 with no intuition
 * for what any of it means, and the field is immutable once the campaign is constructed
 * (`Campaign.sol`), so a badly chosen gate cannot be walked back. Ranks exist to make that choice
 * legible: each band is a score range paired with what it implies about the two inputs.
 *
 * Why the boundaries sit where they do
 * ------------------------------------
 * Every boundary is `ETHOS_WEIGHT * <an Ethos band floor>` — the score an account of that
 * credibility reaches with *no audience at all*. So a boundary names the credibility that clears it
 * unaided, and that is the only thing it names.
 *
 * What a rank does not tell you
 * -----------------------------
 * A rank is a function of the total score, and the total mixes both inputs, so reach *does*
 * manufacture ranks. A maximal audience is worth `REACH_WEIGHT * MAX_ETHOS` = 8,400 points, which is
 * six bands wide, so every band above Netrunner is reachable on far less credibility than its name
 * suggests: an Ethos of 1,401 ("known") with ten million followers scores 18,201 and reads as
 * `Legend`.
 *
 * `reachOnly` marks only the bands clearable with *zero* credibility. It is not a claim that the
 * bands above it are trust-gated. `minEthosAtFullReach` is the honest floor for each band — the
 * least credibility that reaches it when audience is doing everything it can — and /docs renders it
 * beside `ethosAlone` so a host sees both ends of who a gate admits.
 *
 * Ranks remain the right thing to show a promoter: they are legible and monotonic in score. But a
 * campaign owner who needs credibility specifically has to read the score's composition rather than
 * the badge, and `explainScore` in `boneyscore.ts` is what splits it.
 *
 * The structural fact that anchors the whole ladder: `ETHOS_WEIGHT * 1200 === 8400` and
 * `REACH_WEIGHT * MAX_ETHOS === 8400` are the same number. A neutral-Ethos account with no
 * followers and a zero-Ethos account with ten million followers score identically. So 8,400 is
 * simultaneously the neutral floor and the *pure-reach ceiling* — the highest score reachable with
 * no credibility whatsoever. Everything at or below it is clearable by followers alone, which is
 * why `NETRUNNER` starts one point above it and why `reachOnly` is flagged on the bands below.
 *
 * Names are cyberpunk archetypes rather than references to any particular work.
 */

export type Rank = {
  /** Stable key for URLs and filter state. Never rendered. */
  id: string;
  /** Display name. */
  name: string;
  /** Inclusive lower bound of the band. */
  min: number;
  /** Inclusive upper bound. */
  max: number;
  /** The Ethos band floor this boundary derives from, or 0 for the unattested rank. */
  ethosFloor: number;
  /**
   * True when the band's floor is at or below the pure-reach ceiling (8,400), meaning an account
   * with *zero* Ethos credibility can reach it on follower count alone.
   *
   * A false here is not a trust guarantee — see `minEthosAtFullReach` for how little credibility a
   * band actually requires once a real audience is counted.
   */
  reachOnly: boolean;
  /** One line on what an account here actually looks like. */
  blurb: string;
};

/**
 * The ladder, highest first.
 *
 * Ordered descending because `rankOf` scans for the first band a score clears, the same shape as
 * `ETHOS_BANDS` in `boneyscore.ts`. Bands are contiguous and cover 0..MAX_BONEY_SCORE with no gap
 * and no overlap — `ranks.test.ts` pins that, since a gap would leave a real score unrankable.
 */
export const RANKS: ReadonlyArray<Rank> = [
  {
    id: "legend",
    name: "Legend",
    min: ETHOS_WEIGHT * 2600 + 1,
    max: MAX_BONEY_SCORE,
    ethosFloor: 2600,
    reachOnly: false,
    blurb:
      "Renowned on Ethos, or merely known with an audience in the millions. Rare either way.",
  },
  {
    id: "oracle",
    name: "Oracle",
    min: ETHOS_WEIGHT * 2400 + 1,
    max: ETHOS_WEIGHT * 2600,
    ethosFloor: 2400,
    reachOnly: false,
    blurb: "Revered standing, or neutral standing carried by a very large audience.",
  },
  {
    id: "ghost",
    name: "Ghost",
    min: ETHOS_WEIGHT * 2200 + 1,
    max: ETHOS_WEIGHT * 2400,
    ethosFloor: 2200,
    reachOnly: false,
    blurb: "Distinguished, or a thinner profile behind a large following.",
  },
  {
    id: "samurai",
    name: "Samurai",
    min: ETHOS_WEIGHT * 2000 + 1,
    max: ETHOS_WEIGHT * 2200,
    ethosFloor: 2000,
    reachOnly: false,
    blurb: "Exemplary credibility, or questionable standing behind a mass audience.",
  },
  {
    id: "ronin",
    name: "Ronin",
    min: ETHOS_WEIGHT * 1800 + 1,
    max: ETHOS_WEIGHT * 2000,
    ethosFloor: 1800,
    reachOnly: false,
    blurb: "Reputable and unaffiliated. Strong track record without a large audience behind it.",
  },
  {
    id: "fixer",
    name: "Fixer",
    min: ETHOS_WEIGHT * 1600 + 1,
    max: ETHOS_WEIGHT * 1800,
    ethosFloor: 1600,
    reachOnly: false,
    blurb: "Established. Known quantity, connected, gets campaigns delivered.",
  },
  {
    id: "netrunner",
    name: "Netrunner",
    min: ETHOS_WEIGHT * 1200 + 1,
    max: ETHOS_WEIGHT * 1600,
    ethosFloor: 1200,
    reachOnly: false,
    blurb:
      "The first rank a zero-credibility account cannot reach — but only just. A maximal audience covers all but one point of it.",
  },
  {
    id: "runner",
    name: "Runner",
    min: ETHOS_WEIGHT * 800 + 1,
    max: ETHOS_WEIGHT * 1200,
    ethosFloor: 800,
    reachOnly: true,
    blurb: "Questionable-to-neutral Ethos, or a large audience carrying a thin profile.",
  },
  {
    id: "scavenger",
    name: "Scavenger",
    min: 1,
    max: ETHOS_WEIGHT * 800,
    ethosFloor: 0,
    reachOnly: true,
    blurb: "Attested, but untrusted on Ethos. Any score here is mostly or entirely audience.",
  },
  {
    id: "drifter",
    name: "Drifter",
    min: 0,
    max: 0,
    ethosFloor: 0,
    reachOnly: true,
    blurb: "No attestation on record. Either never verified, or no claimed Ethos profile.",
  },
];

/** The rank a score falls in. Never returns undefined — the bands cover the whole range. */
export function rankOf(score: number): Rank {
  const clamped = Number.isFinite(score) ? Math.max(0, score) : 0;
  // Descending scan: the first band whose floor the score clears is its band.
  return RANKS.find((r) => clamped >= r.min) ?? RANKS[RANKS.length - 1];
}

export function rankById(id: string): Rank | undefined {
  return RANKS.find((r) => r.id === id);
}

/** Ascending order, for tables and legends that read bottom-up. */
export function ranksAscending(): Rank[] {
  return RANKS.slice().reverse();
}

/**
 * The highest score reachable with no Ethos credibility at all: `REACH_WEIGHT * MAX_ETHOS`.
 *
 * A gate at or below this admits an account whose entire score is followers. Exported because both
 * the docs table and the campaign-creation guidance need to name it.
 */
export const PURE_REACH_CEILING = REACH_WEIGHT * MAX_ETHOS;

/**
 * The highest score reachable on credibility alone: `ETHOS_WEIGHT * MAX_ETHOS`.
 *
 * The upper bookend to `PURE_REACH_CEILING`. A gate above this cannot be cleared by a perfect Ethos
 * score with no audience, so it necessarily demands both maximum credibility *and* a following —
 * which almost nobody has. Campaign owners setting a gate here have usually excluded everyone by
 * accident, and `minReputation` is immutable, so the mistake is unrecoverable.
 */
export const PURE_TRUST_CEILING = ETHOS_WEIGHT * MAX_ETHOS;

/**
 * The least Ethos credibility that reaches a rank when reach contributes everything it can.
 *
 * The companion to `ethosAlone`, and the number that shows what a rank really guarantees. `Samurai`
 * looks like it demands an exemplary 2,000, but a maximal audience covers 8,400 of its 14,001, so
 * an Ethos of 801 — "questionable" — clears it. Both ends are rendered in the /docs table because
 * the gap between them is the part a host setting an immutable gate needs to see.
 *
 * Returns 0 for bands a maximal audience clears outright, which is exactly the `reachOnly` set.
 */
export function minEthosAtFullReach(rank: Rank): number {
  const gap = rank.min - PURE_REACH_CEILING;
  return gap <= 0 ? 0 : Math.ceil(gap / ETHOS_WEIGHT);
}

/**
 * Two illustrative ways to reach a rank's floor, for the docs table.
 *
 * A single number does not convey what a threshold means, because two very different accounts hit
 * it: one on credibility with no audience, one on a middling profile plus a real following. Both
 * are returned so a host can see the shape of who a gate admits.
 *
 * `followersAlone` is `null` when the floor sits above `PURE_REACH_CEILING` — no audience alone can
 * reach it, which is exactly the property a host wants from a gate.
 */
export function rankExamples(rank: Rank): {
  /** Ethos score needed with zero followers. */
  ethosAlone: number;
  /** Followers needed with zero Ethos, or null when unreachable by reach alone. */
  followersAlone: number | null;
  /** A mixed case: neutral Ethos (1200) plus the followers needed to close the gap. */
  mixed: {ethos: number; followers: number} | null;
} {
  const ethosAlone = Math.ceil(rank.min / ETHOS_WEIGHT);

  const reachNeeded = rank.min / REACH_WEIGHT;
  const followersAlone =
    reachNeeded > MAX_ETHOS ? null : Math.max(0, followersForReach(Math.ceil(reachNeeded)));

  const NEUTRAL = 1200;
  const gap = rank.min - boneyScore({ethos: NEUTRAL, reach: 0});
  let mixed: {ethos: number; followers: number} | null = null;
  if (gap > 0) {
    const reach = Math.ceil(gap / REACH_WEIGHT);
    if (reach <= MAX_ETHOS) {
      const followers = followersForReach(reach);
      if (Number.isFinite(followers)) mixed = {ethos: NEUTRAL, followers};
    }
  }

  return {ethosAlone, followersAlone, mixed};
}

/** How many promoters sit in each rank, highest rank first. Zero-count bands are kept. */
export function rankDistribution(scores: readonly number[]): {rank: Rank; count: number}[] {
  const counts = new Map<string, number>();
  for (const score of scores) {
    const rank = rankOf(score);
    counts.set(rank.id, (counts.get(rank.id) ?? 0) + 1);
  }
  return RANKS.map((rank) => ({rank, count: counts.get(rank.id) ?? 0}));
}
