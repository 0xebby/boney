/**
 * BoneyScore — the composite reputation number `Campaign.join()` gates on.
 *
 *   BoneyScore = 7 * ETHOS_SCORE + 3 * X_REACH
 *
 * Why the inputs are normalised before they reach the chain
 * --------------------------------------------------------
 * `ReputationRegistry.scoreOf` is a weighted sum that multiplies and never divides, and the
 * smallest non-zero weight is 1. A raw follower count therefore enters the sum at *at least* its
 * full magnitude — 24,000 followers against an Ethos score of ~2,000 is roughly 92% followers, no
 * matter how the weights are set. Scaling down is impossible on chain, so it has to happen in the
 * attested value itself.
 *
 * `reachFromFollowers` maps a follower count onto the same 0–2800 range Ethos uses. Only then do
 * integer weights express a real ratio: 70% trust, 30% reach. Trust is weighted higher because
 * followers are purchasable and Ethos vouches are not.
 *
 * This module is the single source of truth for that arithmetic. The attestor route signs values
 * computed here and the UI displays scores computed here, so the two cannot drift. The Solidity
 * side mirrors the weights in `script/SeedLocal.s.sol` (ETHOS_WEIGHT / REACH_WEIGHT).
 */

/** Schema names, hashed to schema ids by `ReputationRegistry.schemaId`. */
export const SCHEMA_ETHOS = "ETHOS_SCORE";
export const SCHEMA_REACH = "X_REACH";
export const SCHEMA_FOLLOWERS = "X_FOLLOWERS";

/** On-chain schema weights. Must match `SeedLocal.s.sol`. */
export const ETHOS_WEIGHT = 7;
export const REACH_WEIGHT = 3;

/**
 * Upper bound of the Ethos score, and the ceiling reach is normalised onto so the two are
 * commensurable.
 */
export const MAX_ETHOS = 2800;

/** Slope of the reach curve: `400 * log10(1 + followers)` reaches 2800 at 10M followers. */
const REACH_SLOPE = 400;

/** Highest attainable BoneyScore, for rendering progress bars. */
export const MAX_BONEY_SCORE = ETHOS_WEIGHT * MAX_ETHOS + REACH_WEIGHT * MAX_ETHOS;

/**
 * Normalise a follower count onto the 0–2800 reach scale.
 *
 * Log rather than linear because follower counts are power-law distributed: linearly, a single
 * account with 10M followers outweighs a thousand genuine mid-tier KOLs combined, which makes the
 * reach term a whale detector instead of an audience signal. On a log curve the gap between 1k and
 * 10k followers is the same as between 100k and 1M — which is how reach actually behaves.
 *
 * Returns an integer because the value is attested on chain as a uint256.
 */
export function reachFromFollowers(followers: number): number {
  if (!Number.isFinite(followers) || followers <= 0) return 0;
  return Math.min(MAX_ETHOS, Math.floor(REACH_SLOPE * Math.log10(1 + followers)));
}

/** The two attested components of a BoneyScore. */
export type ScoreParts = {
  /** Raw Ethos credibility score, 0–2800. */
  ethos: number;
  /** Normalised reach, 0–2800. Zero when no follower data was available. */
  reach: number;
};

/**
 * Compose the on-chain score from its parts.
 *
 * Mirrors `scoreOf`'s arithmetic exactly, so a value computed here can be compared against a
 * campaign's `minReputation` without a round trip.
 */
export function boneyScore({ethos, reach}: ScoreParts): number {
  return ETHOS_WEIGHT * ethos + REACH_WEIGHT * reach;
}

/**
 * Ethos's own credibility bands, lowest to highest. Used to label a raw Ethos score.
 *
 * Thresholds follow Ethos's published bands; `level` is also returned directly by their score
 * endpoint, so prefer the API's value when present and use this only when deriving a label from a
 * stored on-chain value.
 */
const ETHOS_BANDS: ReadonlyArray<{min: number; label: string}> = [
  {min: 2600, label: "renowned"},
  {min: 2400, label: "revered"},
  {min: 2200, label: "distinguished"},
  {min: 2000, label: "exemplary"},
  {min: 1800, label: "reputable"},
  {min: 1600, label: "established"},
  {min: 1400, label: "known"},
  {min: 1200, label: "neutral"},
  {min: 800, label: "questionable"},
  {min: 0, label: "untrusted"},
];

/** Label for a raw Ethos score. */
export function ethosLevel(ethos: number): string {
  return ETHOS_BANDS.find((b) => ethos >= b.min)?.label ?? "untrusted";
}

/**
 * Human-readable breakdown of how a BoneyScore was reached, for the join panel.
 *
 * Showing the split matters because a KOL rejected by a gate needs to know *which* half is short —
 * "get vouched on Ethos" and "grow your audience" are very different instructions.
 */
export function explainScore(parts: ScoreParts): {
  total: number;
  ethosPoints: number;
  reachPoints: number;
  level: string;
} {
  return {
    total: boneyScore(parts),
    ethosPoints: ETHOS_WEIGHT * parts.ethos,
    reachPoints: REACH_WEIGHT * parts.reach,
    level: ethosLevel(parts.ethos),
  };
}
