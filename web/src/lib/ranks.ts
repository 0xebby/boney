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
 * credibility reaches with *no audience at all*. That makes each rank a statement about trust
 * first, which is the point of weighting trust 70/30 in the first place. Reach then moves an
 * account within its rank, and can carry it into the next one, but cannot manufacture a rank on
 * its own.
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
   * with zero Ethos credibility can reach it on follower count alone. A gate set inside one of
   * these bands does not filter for trust.
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
    blurb: "Renowned on Ethos with a mass audience. Vanishingly rare — expect an empty directory.",
  },
  {
    id: "oracle",
    name: "Oracle",
    min: ETHOS_WEIGHT * 2400 + 1,
    max: ETHOS_WEIGHT * 2600,
    ethosFloor: 2400,
    reachOnly: false,
    blurb: "Revered standing. Vouched for by people who are themselves vouched for.",
  },
  {
    id: "ghost",
    name: "Ghost",
    min: ETHOS_WEIGHT * 2200 + 1,
    max: ETHOS_WEIGHT * 2400,
    ethosFloor: 2200,
    reachOnly: false,
    blurb: "Distinguished and hard to reach. A long, clean history behind the score.",
  },
  {
    id: "samurai",
    name: "Samurai",
    min: ETHOS_WEIGHT * 2000 + 1,
    max: ETHOS_WEIGHT * 2200,
    ethosFloor: 2000,
    reachOnly: false,
    blurb: "Exemplary credibility. The top of what most real accounts reach.",
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
      "The first rank that cannot be faked with followers. Neutral-or-better Ethos standing is required.",
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
