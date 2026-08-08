import type {Rank} from "@/lib/ranks";

/**
 * RankBadge — a promoter's BoneyScore band.
 *
 * Ranks are ordinal, so the palette is the sequential ramp rather than the categorical series: the
 * eye should read "higher" off the colour, which distinct hues cannot convey. Colour is never the
 * only carrier — the name is always present, and the tier is announced to screen readers — so this
 * stays legible in monochrome and to anyone who does not distinguish the steps.
 *
 * `reachOnly` bands get a warning outline instead of a ramp step. Those are the ranks an account
 * with no Ethos credibility can reach on follower count alone, and a project browsing for
 * trustworthy promoters needs that visible on the row, not buried in the docs.
 *
 * `tone` exists because that warning is aimed at one audience only. Vetting someone else's row, an
 * un-credentialed rank is a caution worth the yellow. Showing a wallet its *own* standing — the
 * header badge — the same yellow reads as a fault in the app rather than an invitation to verify,
 * and the `reachOnly` note ("reachable on follower count alone") describes a band the viewer is
 * being warned about, not advice they can act on. `tone="muted"` therefore drops both to a neutral
 * outline and stays silent, leaving the caller to supply first-person context. Ranks that do have a
 * ramp step keep it under either tone: earning the colour is the point of the badge.
 */
const RANK_STYLE: Record<string, {bg: string; fg: string}> = {
  legend: {bg: "var(--seq-100)", fg: "var(--plane)"},
  oracle: {bg: "var(--seq-250)", fg: "var(--plane)"},
  ghost: {bg: "var(--seq-400)", fg: "var(--plane)"},
  samurai: {bg: "var(--seq-450)", fg: "var(--plane)"},
  ronin: {bg: "var(--seq-550)", fg: "var(--text-primary)"},
  fixer: {bg: "var(--seq-600)", fg: "var(--text-primary)"},
  netrunner: {bg: "var(--seq-700)", fg: "var(--text-primary)"},
};

export function RankBadge({
  rank,
  showRange = false,
  tone = "default",
}: {
  rank: Rank;
  showRange?: boolean;
  /** "muted" for a wallet's own standing; "default" when vetting someone else's. */
  tone?: "default" | "muted";
}) {
  const style = RANK_STYLE[rank.id];
  const unranked =
    tone === "muted" ? "border border-hairline-strong text-ink-muted" : "border border-warning/50 text-warning";

  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span
        className={`rounded px-1.5 py-0.5 text-xs font-medium ${style ? "" : unranked}`}
        style={style ? {background: style.bg, color: style.fg} : undefined}
      >
        {rank.name}
      </span>
      {rank.reachOnly && tone === "default" ? (
        <span className="sr-only">reachable on follower count alone, no Ethos credibility needed</span>
      ) : null}
      {showRange ? (
        <span className="tnum text-xs text-ink-muted">
          {rank.min.toLocaleString("en-US")}
          {rank.max > rank.min ? `–${rank.max.toLocaleString("en-US")}` : ""}
        </span>
      ) : null}
    </span>
  );
}
