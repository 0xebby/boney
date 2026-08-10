/**
 * TrustReachBar — how a BoneyScore was earned, as a composition rather than a magnitude.
 *
 * A `Meter` would be the wrong form here. That answers "how far along a limit" and carries a
 * severity ramp; this answers "which of two halves carries this score", where neither half is a
 * limit and neither direction is bad. So: one stacked bar, two segments, always summing to 100.
 *
 * Both hues come from the sequential amber ramp rather than the categorical series. The categorical
 * palette exists for unordered things, and these two are ordered — trust is the half the ranks are
 * built on and the half that cannot be bought, so it takes the lighter, more prominent step.
 * Introducing blue and orange here would also collide with `RankBadge`, which already spends the
 * ramp on the rank sitting one column to the left.
 *
 * The percentages are always rendered as text. Colour never carries the value alone, which keeps
 * the cell readable in monochrome and to anyone who does not separate the two amber steps.
 */
export function TrustReachBar({
  trustPct,
  reachPct,
}: {
  trustPct: number;
  reachPct: number;
}) {
  const label = `${trustPct}% trust, ${reachPct}% reach`;

  return (
    <div className="flex flex-col items-end gap-1">
      <span className="tnum text-[13px] text-ink">
        {trustPct}%
        <span className="text-ink-muted"> / </span>
        {reachPct}%
      </span>

      <div
        role="img"
        aria-label={label}
        title={label}
        className="flex h-1.5 w-20 overflow-hidden rounded-full bg-track"
      >
        <div style={{width: `${trustPct}%`, background: "var(--seq-400)"}} />
        <div style={{width: `${reachPct}%`, background: "var(--seq-600)"}} />
      </div>
    </div>
  );
}
