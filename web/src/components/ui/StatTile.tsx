import type {ReactNode} from "react";

/**
 * StatTile — the form for a single headline number.
 *
 * Per the form heuristic, a lone current value is a stat tile, never a one-bar chart.
 * The value keeps the font's default *proportional* figures: `tabular-nums` gives every
 * digit the width of a `0`, which makes a number like `121` look loose at display sizes.
 * Tabular figures are reserved for columns that align vertically (table rows, axis ticks).
 */
export function StatTile({
  label,
  value,
  hint,
  delta,
  accent,
}: {
  label: string;
  value: string;
  hint?: string;
  /** Signed change vs a named period. `positive` says whether up is good here. */
  delta?: {text: string; positive: boolean};
  /** Optional series color for a leading rule, when the tile pairs with a chart. */
  accent?: string;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-hairline bg-surface-1 p-4">
      <div className="flex items-center gap-2">
        {accent ? (
          <span aria-hidden className="h-3 w-0.5 rounded-full" style={{background: accent}} />
        ) : null}
        <span className="text-xs text-ink-muted">{label}</span>
      </div>

      <span className="font-display text-3xl leading-tight text-ink">{value}</span>

      {delta || hint ? (
        <div className="flex items-baseline gap-2">
          {delta ? (
            <span
              className={`text-xs font-medium ${delta.positive ? "text-good" : "text-critical"}`}
            >
              {delta.text}
            </span>
          ) : null}
          {hint ? <span className="text-xs text-ink-muted">{hint}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

/** A responsive row of stat tiles — the KPI row, not a grouped bar chart. */
export function StatRow({children}: {children: ReactNode}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">{children}</div>
  );
}
