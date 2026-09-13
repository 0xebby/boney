
/** Fixed by the level ladder in `lib/boneycard.ts`. Notch count, not a display choice. */
const NOTCHES = 5;

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
 * The `B` monogram — the wordmark's badge, built from the bone's own geometry.
 *
 * The stem is a rounded bar the width of a bone shaft and the two bowls are lobes at the same
 * radius ratio, so the letter reads as a `B` and as a bone end-on. Cut out with a mask rather than a
 * single evenodd path: the pieces overlap, exactly as in `BoneGlyph`, and an overlap under evenodd
 * would punch a hole through the letter instead of filling it.
 *
 * `aria-hidden` — the word "boneyard" is always beside it.
 *
 * @param className Sizing and colour classes; the fill is `currentColor`.
 * @returns The monogram.
 */
export function BoneyB({className = ""}: {className?: string}) {
  return (
    <svg aria-hidden viewBox="0 0 40 48" className={className}>
      {/* One id, one definition: a second instance on the page resolves to the same mask, which
          draws the same letter. */}
      <mask id="boney-b-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="40" height="48">
        <rect width="40" height="48" fill="black" />
        <g fill="white">
          <rect x="3" y="4" width="11" height="40" rx="4" />
          <circle cx="21" cy="16" r="11" />
          <circle cx="21" cy="32" r="11" />
        </g>
        <g fill="black">
          <circle cx="22.5" cy="16" r="4.3" />
          <circle cx="22.5" cy="32" r="4.3" />
        </g>
      </mask>

      <rect width="40" height="48" fill="currentColor" mask="url(#boney-b-mask)" />
    </svg>
  );
}


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

/** One bone in the page field: where it sits in its tile, and how it is turned and sized. */
type FieldBone = {x: number; y: number; rotate: number; scale: number};

/** Tile of the page field's primary layer, in CSS pixels. */
const FIELD_TILE = 360;

/** Rendered stroke width of every field bone, in CSS pixels. */
const FIELD_HAIRLINE = 1.6;

const FIELD_BONES: FieldBone[] = [
  {x: 30, y: 60, rotate: -18, scale: 0.34},
  {x: 215, y: 205, rotate: 37, scale: 0.26},
  {x: 60, y: 265, rotate: -8, scale: 0.2},
];

/**
 * One placed instance of the field's bone outline.
 *
 * @param bone Position, rotation and scale within the tile.
 * @param key React list key.
 * @returns A `use` of the shared outline, stroked to the same rendered width at any scale.
 */
function fieldBone(bone: FieldBone, key: number) {
  return (
    <use
      key={key}
      href="#bone-field-outline"
      transform={`translate(${bone.x} ${bone.y}) rotate(${bone.rotate}) scale(${bone.scale})`}
      strokeWidth={FIELD_HAIRLINE / bone.scale}
    />
  );
}


export function BoneField() {
  return (
    <svg
      aria-hidden
      className="pointer-events-none fixed inset-0 -z-10 opacity-[0.035] contrast-more:hidden print:hidden"
    >
      <defs>
        <g id="bone-field-outline" fill="none" stroke="var(--brand)">
          <circle cx="70" cy="58" r="34" />
          <circle cx="70" cy="142" r="34" />
          <circle cx="330" cy="58" r="34" />
          <circle cx="330" cy="142" r="34" />
          <rect x="70" y="66" width="260" height="68" rx="10" />
        </g>

        <pattern
          id="bone-field"
          width={FIELD_TILE}
          height={FIELD_TILE}
          patternUnits="userSpaceOnUse"
        >
          {FIELD_BONES.map(fieldBone)}
        </pattern>

      </defs>

      <rect width="100%" height="100%" fill="url(#bone-field)" />
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
