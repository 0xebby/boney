"use client";

import Link from "next/link";
import {useAccount} from "wagmi";
import {useCountUp} from "@/hooks/useCountUp";
import {useLeaderboard} from "@/hooks/useLeaderboard";
import {Card, CardHeader} from "@/components/ui/Card";
import {RankTitleMark} from "@/components/ui/RankTitleMark";
import {pointsShare, type PointsRow} from "@/lib/points";
import {compactNumber, shortAddress} from "@/lib/format";

/**
 * The leaderboard's landing block — the top three, and where the connected wallet stands.
 *
 * On `/` rather than `/discover`: this is aimed at the people who could earn points, and the list page
 * is where they arrive. It renders nothing at all when the board cannot be read or has nobody on it —
 * a landing page is not the place to explain a subgraph outage, and the full board at `/leaderboard`
 * says so properly.
 */

/** Ramp steps for the three places — ordinal, so the sequential ramp rather than the series. */
const PLACE_FILL = ["var(--seq-400)", "var(--seq-450)", "var(--seq-550)"] as const;

export function LeaderboardTeaser() {
  const {rows, you, top, unavailable, isLoading} = useLeaderboard();
  const {address} = useAccount();

  if (unavailable || isLoading || rows.length === 0) return null;

  const self = address?.toLowerCase();
  const podium = rows.slice(0, 3);

  return (
    <Card>
      <CardHeader
        title="Leaderboard"
        subtitle="Points for verified actions"
        action={
          <Link href="/leaderboard" className="text-xs font-medium text-brand hover:opacity-80">
            Full board →
          </Link>
        }
      />

      <ol className="flex flex-col divide-y divide-hairline">
        {podium.map((row, index) => (
          <TeaserRow
            key={row.wallet}
            row={row}
            top={top}
            place={index}
            isSelf={row.wallet === self}
          />
        ))}
      </ol>

      {/* Your own line, whether or not you are in the three above — the reason to keep reading. */}
      <div className="mt-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t border-hairline pt-3">
        <span className="text-xs font-bold text-brand">You</span>
        {you ? (
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className="tnum text-[13px] font-medium text-ink">
              {you.total.toLocaleString("en-US")} pts
            </span>
            <span className="tnum text-xs text-ink-muted">
              rank {you.rank} of {rows.length}
            </span>
            {you.rank > 1 ? (
              <span className="text-xs text-ink-muted">
                {compactNumber(top - you.total)} behind first
              </span>
            ) : null}
          </span>
        ) : (
          <span className="text-xs text-ink-muted">
            {address ? "Join a campaign to score" : "Connect a wallet to see your rank"}
          </span>
        )}
      </div>
    </Card>
  );
}

/** One podium line: place, wallet, bar, total. */
function TeaserRow({
  row,
  top,
  place,
  isSelf,
}: {
  row: PointsRow;
  top: number;
  place: number;
  isSelf: boolean;
}) {
  const stagger = ["[animation-delay:60ms]", "[animation-delay:120ms]", "[animation-delay:180ms]"];
  const delay = stagger[place] ?? "";
  const shown = useCountUp(row.total);

  return (
    <li className={`animate-rise-in flex items-center gap-3 py-2 first:pt-0 last:pb-0 ${delay}`}>
      <span className="tnum flex w-7 shrink-0 items-baseline gap-1 text-xs font-medium text-ink-secondary">
        <RankTitleMark rank={row.rank} />
        {row.rank}
      </span>

      <Link
        href={`/b/${row.wallet}`}
        className="shrink-0 font-mono text-xs text-ink hover:text-brand"
      >
        {shortAddress(row.wallet, 6, 4)}
      </Link>

      {isSelf ? (
        <span className="shrink-0 rounded border border-brand-dim/50 px-1 text-[10px] font-medium text-brand">
          you
        </span>
      ) : null}

      {/* Decorative: the number it encodes is the cell to its right. */}
      <span aria-hidden className="hidden h-1 flex-1 overflow-hidden rounded-full bg-track sm:block">
        <span
          className={`animate-bar-grow block h-full rounded-full ${delay}`}
          style={{
            width: `${Math.max(pointsShare(row.total, top) * 100, 2)}%`,
            background: PLACE_FILL[place] ?? "var(--seq-450)",
          }}
        />
      </span>

      <span className="ml-auto shrink-0 text-[13px] font-medium text-ink sm:ml-0">
        {shown.toLocaleString("en-US")}
      </span>
    </li>
  );
}
