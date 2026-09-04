import {rankTitle} from "@/lib/rankTitle";

/**
 * RankTitleMark — the chess mark a Boneyboard rank carries, with its title beside it where there is
 * room for one.
 *
 * Renders nothing outside the leading three ranks. The glyph is decorative and the rank number is
 * always rendered next to it, so nothing is carried by the mark alone. Rank one's glyph breathes;
 * second and third are static. Returns a fragment, so the caller's own flex gap spaces it.
 *
 * @param rank A 1-based Boneyboard rank.
 * @param showName Whether to render the title next to the glyph.
 */
export function RankTitleMark({rank, showName = false}: {rank: number; showName?: boolean}) {
  const title = rankTitle(rank);
  if (!title) return null;

  return (
    <>
      <span aria-hidden className={`text-brand ${rank === 1 ? "animate-crown-pulse" : ""}`}>
        {title.glyph}
      </span>
      {showName ? <span className="uppercase tracking-[0.1em]">{title.name}</span> : null}
    </>
  );
}
