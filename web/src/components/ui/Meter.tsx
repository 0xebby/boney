/**
 * Meter — a single ratio against a limit (pool utilization).
 *
 * Per the form heuristic this is a meter, not a 2-slice pie. The unfilled track is a
 * lighter step of the *same* ramp so the state reads across the whole bar, and the fill
 * carries severity as utilization climbs.
 *
 * The percentage is always rendered as text beside the bar: the fill is a visual aid, never
 * the only way to read the value.
 */
export function Meter({
  value,
  max,
  label,
  valueText,
  /** When true, a fuller bar is worse (e.g. pool drained). Drives the severity ramp. */
  fullIsBad = false,
}: {
  value: number;
  max: number;
  label?: string;
  valueText?: string;
  fullIsBad?: boolean;
}) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;

  // Severity steps only when "full" is the bad direction; otherwise stay on the ramp.
  let fill = "var(--seq-400)";
  if (fullIsBad) {
    if (pct >= 90) fill = "var(--status-critical)";
    else if (pct >= 70) fill = "var(--status-serious)";
    else if (pct >= 50) fill = "var(--status-warning)";
  }

  return (
    <div className="flex flex-col gap-1">
      {label || valueText ? (
        <div className="flex items-baseline justify-between gap-2">
          {label ? <span className="text-xs text-ink-muted">{label}</span> : null}
          {valueText ? (
            <span className="tnum text-xs font-medium text-ink-secondary">{valueText}</span>
          ) : null}
        </div>
      ) : null}

      <div
        role="meter"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label ?? "Utilization"}
        className="h-1.5 w-full overflow-hidden rounded-full bg-track"
      >
        <div
          className="h-full rounded-full transition-[width] duration-300"
          style={{width: `${pct}%`, background: fill}}
        />
      </div>
    </div>
  );
}
