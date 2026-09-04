/**
 * Titles for the three leading ranks on the Boneyboard.
 *
 * Keyed on the rank itself rather than on a row's position, so wallets tied on a rank share its title
 * and no title is given to a rank nobody holds.
 */

/** One rank's title and the glyph that marks it. */
export type RankTitle = {
  /** The 1-based rank this title belongs to. */
  rank: number;
  /** Display name, in title case. */
  name: string;
  /** Chess glyph, rendered beside the rank number. */
  glyph: string;
};

/** Ranks one to three, descending. Names are distinct from the BoneyScore bands in `lib/ranks.ts`. */
const RANK_TITLES: readonly RankTitle[] = [
  {rank: 1, name: "Kingpin", glyph: "♚"},
  {rank: 2, name: "Cipher", glyph: "♝"},
  {rank: 3, name: "Lancer", glyph: "♞"},
];

/**
 * The title a rank carries.
 *
 * @param rank A 1-based rank, as `foldPoints` assigns them.
 * @returns That rank's title, or `undefined` for any rank outside the leading three.
 */
export function rankTitle(rank: number): RankTitle | undefined {
  return RANK_TITLES.find((title) => title.rank === rank);
}
