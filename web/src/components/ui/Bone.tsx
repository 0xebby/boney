/**
 * The bone — the BoneyCard's mark, and the one thing on it that is purely a shape.
 *
 * SVG rather than the 🦴 emoji it replaces, for three reasons that all point the same way: an emoji
 * renders as a different picture on every platform, it is a *font* dependency and so is missing
 * entirely from the headless renderer an OG image is produced by, and it cannot be recoloured to sit
 * on the brand. A path is the same picture in a browser, a screenshot and a share card.
 *
 * ## Nothing here carries information on its own
 *
 * `BoneWatermark` is `aria-hidden` framing. `BoneLevel` draws notches, but the level is also written
 * out beside them in words — a filled-versus-faded notch is a redundant encoding of a number that is
 * already text, never the only way to read it. That matters most in the state the level is *not*
 * known: an undefined level renders "lvl —" rather than an unfilled row of notches that would read
 * as a confident level 0.
 */

/** Fixed by the level ladder in `lib/boneycard.ts`. Notch count, not a display choice. */
const NOTCHES = 5;

/**
 * One bone, filled.
 *
 * Four lobes and a shaft, unioned by overlap rather than traced as one outline — every piece carries
 * the same `currentColor` fill, so the seams between them do not render. That is also why this is a
 * silhouette and not a stroked outline: stroking the pieces would draw the seams.
 */
export function BoneGlyph({className = ""}: {className?: string}) {
  return (
    <svg aria-hidden viewBox="0 0 32 20" className={className} fill="currentColor">
      <circle cx="6" cy="6.6" r="4.7" />
      <circle cx="6" cy="13.4" r="4.7" />
      <circle cx="26" cy="6.6" r="4.7" />
      <circle cx="26" cy="13.4" r="4.7" />
      <rect x="6" y="6.6" width="20" height="6.8" />
    </svg>
  );
}

/**
 * The card's background bone — a wireframe watermark, not a container.
 *
 * Drawn as separate stroked pieces on purpose: at 13% opacity the seams read as construction lines,
 * which is the register wanted here. `preserveAspectRatio="slice"` lets it crop rather than squash on
 * a narrow phone, since it is framing and losing an inch of shaft costs nothing.
 */
export function BoneWatermark() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 400 200"
      className="pointer-events-none absolute inset-0 h-full w-full opacity-[0.13]"
      preserveAspectRatio="xMidYMid slice"
    >
      <g fill="none" stroke="var(--brand)" strokeWidth="3">
        <circle cx="70" cy="58" r="34" />
        <circle cx="70" cy="142" r="34" />
        <circle cx="330" cy="58" r="34" />
        <circle cx="330" cy="142" r="34" />
        <rect x="70" y="66" width="260" height="68" rx="10" />
      </g>
    </svg>
  );
}

/**
 * Bone level, 1–5, as notches plus the number.
 *
 * `level` is optional and undefined is a real state, not a loading placeholder: the level is a fold
 * over indexed history, so an unreachable subgraph means it is *unknown*. Rendering 1 there would
 * take a level-5 promoter's card down to a beginner's over an outage — which is the same class of
 * mistake as rendering a failed fetch as "0 campaigns", and the reason `useBoneyHistory` returns a
 * union rather than a default.
 */
export function BoneLevel({level, max = NOTCHES}: {level?: number; max?: number}) {
  const known = level !== undefined;

  return (
    <div className="flex items-center gap-2">
      <span
        className="flex items-center gap-1 text-brand"
        role="img"
        aria-label={known ? `Bone level ${level} of ${max}` : "Bone level unknown"}
      >
        {Array.from({length: max}, (_, i) => (
          <BoneGlyph
            key={i}
            className={`h-3 w-[1.2rem] ${known && i < level ? "" : "opacity-20"}`}
          />
        ))}
      </span>
      <span className="text-[10px] uppercase tracking-wide text-ink-muted">
        {known ? `lvl ${level}` : "lvl —"}
      </span>
    </div>
  );
}
