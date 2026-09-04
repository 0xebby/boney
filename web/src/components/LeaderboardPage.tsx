"use client";

import {useMemo} from "react";
import Link from "next/link";
import {useAccount} from "wagmi";
import {useCountUp} from "@/hooks/useCountUp";
import {useLeaderboard} from "@/hooks/useLeaderboard";
import {useOffscreen} from "@/hooks/useOffscreen";
import {Card, CardHeader} from "@/components/ui/Card";
import {DataTable, type Column} from "@/components/ui/DataTable";
import {RankTitleMark} from "@/components/ui/RankTitleMark";
import {StatRow, StatTile} from "@/components/ui/StatTile";
import {EmptyState, ErrorState, SkeletonRows} from "@/components/ui/States";
import {compactNumber, shortAddress} from "@/lib/format";
import type {GraphUnavailable} from "@/lib/graph";
import {
  actionsOf,
  pointsShare,
  POINTS_JOIN,
  POINTS_PROMOTER_ACTION,
  POINTS_PROMOTER_REPORT,
  POINTS_REFERRAL_ACTION,
  POINTS_REFERRAL_REPORT,
  POINTS_TOUCH,
  type PointsRow,
} from "@/lib/points";

/**
 * `/leaderboard` — the Boneyboard: every wallet that has scored on Boneyard, ranked.
 *
 * The board is folded from rows the subgraph has held since the CampaignRegistry was deployed, so it
 * opens populated. A failed read renders as unavailable rather than as a table of zeroes, and a
 * truncated read labels every total as a floor.
 */

/** Ramp steps for the three podium places — ordinal, so the sequential ramp rather than the series. */
const PLACE_FILL = ["var(--seq-400)", "var(--seq-450)", "var(--seq-550)"] as const;

/** The table's bars all share one step: the length carries the magnitude, so the colour need not. */
const ROW_FILL = "var(--seq-450)";

export function LeaderboardPage() {
  const {rows, you, top, unavailable, isLoading, isRefreshing, refetch, partial} = useLeaderboard();
  const {address} = useAccount();
  const {ref: standingRef, offscreen: standingGone} = useOffscreen<HTMLDivElement>();

  const self = address?.toLowerCase();
  const podium = rows.slice(0, 3);

  const totals = useMemo(
    () => ({
      points: rows.reduce((sum, row) => sum + row.total, 0),
      actions: rows.reduce((sum, row) => sum + actionsOf(row), 0),
    }),
    [rows],
  );

  const columns = useMemo<Column<PointsRow>[]>(
    () => [
      {
        key: "rank",
        header: "#",
        width: "3.25rem",
        sortValue: (row) => row.rank,
        render: (row) => (
          <span className="tnum inline-flex items-center gap-1 font-medium text-ink-secondary">
            <RankTitleMark rank={row.rank} />
            {row.rank}
          </span>
        ),
      },
      {
        key: "wallet",
        header: "Wallet",
        sortValue: (row) => row.wallet,
        render: (row) => (
          <span className="inline-flex items-center gap-2">
            <Link
              href={`/b/${row.wallet}`}
              className="font-mono text-xs text-ink hover:text-brand"
            >
              {shortAddress(row.wallet)}
            </Link>
            {row.wallet === self ? (
              <span className="rounded border border-brand-dim/50 px-1 text-[10px] font-medium text-brand">
                you
              </span>
            ) : null}
          </span>
        ),
      },
      {
        key: "points",
        header: "BoneyPoints",
        numeric: true,
        sortValue: (row) => row.total,
        render: (row) => (
          <span className="inline-flex w-full flex-col items-end gap-1">
            <span className="font-medium text-ink">{row.total.toLocaleString("en-US")}</span>
            <PointsBar share={pointsShare(row.total, top)} fill={ROW_FILL} className="w-16" />
          </span>
        ),
      },
      {
        key: "joins",
        header: "Campaigns joined",
        numeric: true,
        hideOnMobile: true,
        sortValue: (row) => row.counts.joins,
        render: (row) => row.counts.joins.toLocaleString("en-US"),
      },
      {
        key: "touches",
        header: "Signed",
        numeric: true,
        hideOnMobile: true,
        sortValue: (row) => row.counts.touches,
        render: (row) => row.counts.touches.toLocaleString("en-US"),
      },
      {
        key: "actions",
        header: "Actions",
        numeric: true,
        hideOnMobile: true,
        sortValue: (row) => actionsOf(row),
        render: (row) => actionsOf(row).toLocaleString("en-US"),
      },
    ],
    [self, top],
  );

  if (unavailable) {
    return (
      <div className="space-y-5">
        <LeaderboardHeader />
        <Card>
          <Unavailable unavailable={unavailable} onRetry={() => refetch()} />
        </Card>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-5">
        <LeaderboardHeader />
        <Card padded={false}>
          <SkeletonRows rows={6} cols={4} />
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <LeaderboardHeader />

      {rows.length === 0 ? (
        <Card>
          <EmptyState
            title="No BoneyPoints scored yet"
            description="Join a campaign or sign an attribution to open the board."
          />
        </Card>
      ) : (
        <>
          {/* The pitch: three places, largest first, each rising in behind the one before it. */}
          <div className="grid gap-3 sm:grid-cols-3">
            {podium.map((row, index) => (
              <PodiumCard
                key={row.wallet}
                row={row}
                top={top}
                place={index}
                isSelf={row.wallet === self}
              />
            ))}
          </div>

          <StatRow>
            <StatTile
              label="Wallets ranked"
              value={rows.length.toLocaleString("en-US")}
              hint="all-time"
            />
            <StatTile
              label="BoneyPoints awarded"
              value={compactNumber(totals.points)}
              hint={partial ? "at least" : "across the protocol"}
            />
            <StatTile
              label="Actions credited"
              value={compactNumber(totals.actions)}
              hint={partial ? "at least" : "verified on chain"}
            />
            <StatTile
              label="Your rank"
              value={you ? `#${you.rank}` : "—"}
              qualifier={you ? `of ${rows.length}` : undefined}
              hint={you ? `${you.total.toLocaleString("en-US")} BoneyPoints` : "not on the board yet"}
            />
          </StatRow>

          {partial ? (
            <p className="rounded-md border border-hairline bg-surface-1 px-3 py-2 text-xs text-ink-muted">
              The indexer returned a partial history, so every total here is a floor.
            </p>
          ) : null}

          {you ? <StandingPanel ref={standingRef} row={you} count={rows.length} top={top} /> : null}

          <Card padded={false}>
            <div className="border-b border-hairline px-2 py-2.5 sm:px-3">
              <h2 className="text-sm font-bold text-brand">Boneyard Leaderboard ...</h2>
            </div>
            <DataTable
              rows={rows}
              columns={columns}
              rowKey={(row) => row.wallet}
              initialSort={{key: "points", dir: "desc"}}
              isRefreshing={isRefreshing}
            />
          </Card>

          <EarningCard />

          {you && standingGone ? <StandingStrip row={you} count={rows.length} /> : null}
        </>
      )}
    </div>
  );
}

/**
 * The subgraph could not be believed.
 *
 * An unset endpoint and a chain with no deployment are facts about this build rather than failures,
 * and no retry changes either. Every other reason gets `ErrorState` and a retry.
 */
function Unavailable({
  unavailable,
  onRetry,
}: {
  unavailable: GraphUnavailable;
  onRetry?: () => void;
}) {
  const expected =
    unavailable.reason === "not-configured" || unavailable.reason === "unsupported-chain";

  if (expected) {
    return (
      <div className="flex flex-col gap-1.5 rounded border border-hairline bg-surface-2 p-3">
        <p className="text-sm font-semibold text-ink">No BoneyPoints indexed here</p>
        <p className="text-xs text-ink-secondary">{unavailable.message}</p>
      </div>
    );
  }

  return (
    <ErrorState
      message="Leaderboard unavailable"
      detail={`${unavailable.message} (${unavailable.reason})`}
      onRetry={onRetry}
    />
  );
}

/** The page title and its one line. Repeated across all three arms, so it is its own component. */
function LeaderboardHeader() {
  return (
    <header className="animate-rise-in">
      <h1 className="font-display text-2xl text-ink">Boneyboard</h1>
      <p className="mt-0.5 text-xs text-ink-muted">
        BoneyPoints for verified actions, counted since the protocol went live.
      </p>
    </header>
  );
}

/**
 * A decorative bar carrying a share of the leading total.
 *
 * `aria-hidden` because the number it encodes is always rendered as text beside it — announcing both
 * would read the same value twice.
 */
function PointsBar({
  share,
  fill,
  className = "",
  delay = "",
}: {
  share: number;
  fill: string;
  className?: string;
  /** A Tailwind `[animation-delay:…]` utility, for staggering a group. */
  delay?: string;
}) {
  return (
    <span aria-hidden className={`block h-1 overflow-hidden rounded-full bg-track ${className}`}>
      <span
        className={`animate-bar-grow block h-full rounded-full ${delay}`}
        style={{width: `${Math.max(share * 100, 2)}%`, background: fill}}
      />
    </span>
  );
}

/** A counting figure. Settles on the real number, and never animates under reduced motion. */
function PointsFigure({total, className = ""}: {total: number; className?: string}) {
  const shown = useCountUp(total);
  return (
    <span className={`font-display leading-none text-ink ${className}`}>
      {shown.toLocaleString("en-US")}
    </span>
  );
}

/** `12 joined · 9 signed · 74 actions` — the same three counts everywhere they appear. */
function Breakdown({row}: {row: PointsRow}) {
  return (
    <p className="tnum text-xs text-ink-muted">
      {row.counts.joins.toLocaleString("en-US")} joined ·{" "}
      {row.counts.touches.toLocaleString("en-US")} signed ·{" "}
      {actionsOf(row).toLocaleString("en-US")} actions
    </p>
  );
}

/**
 * One of the three leading wallets.
 *
 * `place` is the index, not the rank: two wallets tied at rank 1 both read as first place, and the
 * ramp step follows the position in the podium so the three cards stay distinguishable. The title
 * follows the rank instead, so tied wallets carry the same one.
 */
function PodiumCard({
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

  return (
    <div
      className={`animate-rise-in flex flex-col gap-2 rounded-lg border bg-surface-1 p-4 ${delay} ${
        place === 0 ? "border-hairline-strong" : "border-hairline"
      }`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="flex items-baseline gap-1.5 text-xs font-bold text-brand">
          <RankTitleMark rank={row.rank} showName />
          <span className="tnum font-medium text-ink-muted">#{row.rank}</span>
        </span>
        {isSelf ? (
          <span className="rounded border border-brand-dim/50 px-1 text-[10px] font-medium text-brand">
            you
          </span>
        ) : null}
      </div>

      <Link
        href={`/b/${row.wallet}`}
        className="font-mono text-xs text-ink-secondary hover:text-brand"
      >
        {shortAddress(row.wallet)}
      </Link>

      <div className="flex flex-wrap items-baseline gap-x-1.5">
        <PointsFigure total={row.total} className={place === 0 ? "text-4xl" : "text-3xl"} />
        <span className="text-sm font-semibold text-ink-secondary">pts</span>
      </div>

      <PointsBar
        share={pointsShare(row.total, top)}
        fill={PLACE_FILL[place] ?? ROW_FILL}
        delay={delay}
      />
      <Breakdown row={row} />
    </div>
  );
}

/**
 * The connected wallet's own standing, above the table.
 *
 * Takes a ref so the sticky strip below can appear only once this has scrolled away.
 */
function StandingPanel({
  ref,
  row,
  count,
  top,
}: {
  ref: React.RefObject<HTMLDivElement | null>;
  row: PointsRow;
  count: number;
  top: number;
}) {
  return (
    <div ref={ref}>
      <Card>
        <CardHeader title="Your standing" />
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-baseline gap-x-1.5">
              <PointsFigure total={row.total} className="text-3xl" />
              <span className="text-sm font-semibold text-ink-secondary">pts</span>
              <span className="text-xs text-ink-muted">
                rank {row.rank} of {count}
              </span>
            </div>
            <Breakdown row={row} />
          </div>

          <div className="flex w-full flex-col gap-1 sm:w-48">
            <PointsBar share={pointsShare(row.total, top)} fill={ROW_FILL} />
            <span className="text-xs text-ink-muted">
              {row.rank === 1 ? "leading the board" : `${compactNumber(top - row.total)} behind first`}
            </span>
          </div>
        </div>
      </Card>
    </div>
  );
}

/** The same standing, pinned to the bottom of the viewport once the panel is out of view. */
function StandingStrip({row, count}: {row: PointsRow; count: number}) {
  return (
    <div className="animate-strip-in pointer-events-none sticky bottom-3 z-10 flex justify-center">
      <div className="pointer-events-auto flex items-baseline gap-3 rounded-full border border-hairline-strong bg-surface-2 px-4 py-2 shadow-none">
        <span className="text-xs font-bold text-brand">You</span>
        <span className="tnum text-sm font-medium text-ink">
          {row.total.toLocaleString("en-US")} pts
        </span>
        <span className="tnum text-xs text-ink-muted">
          rank {row.rank} of {count}
        </span>
      </div>
    </div>
  );
}

/**
 * What each action is worth.
 *
 * On the page rather than in the docs because it is the whole point of the board: a promoter reading
 * a rank should be able to see what would move it.
 */
function EarningCard() {
  const rules: Array<{action: string; points: string; note?: string}> = [
    {action: "Join a campaign", points: `+${POINTS_JOIN}`, note: "per campaign"},
    {action: "Sign an attribution", points: `+${POINTS_TOUCH}`, note: "once per campaign"},
    {
      action: "Referral action credited",
      points: `+${POINTS_REFERRAL_ACTION}`,
      note: "to the wallet that acted",
    },
    {
      action: "Promoter action credited",
      points: `+${POINTS_PROMOTER_ACTION}`,
      note: "to the promoter who drove it",
    },
    {
      action: "Referral volume or TVL credited",
      points: `+${POINTS_REFERRAL_REPORT}`,
      note: "per report, not per unit",
    },
    {
      action: "Promoter volume or TVL credited",
      points: `+${POINTS_PROMOTER_REPORT}`,
      note: "per report, not per unit",
    },
  ];

  return (
    <Card>
      <CardHeader title="How BoneyPoints are calculated" subtitle="Every credited action is verified on-chain" />
      <ul className="flex flex-col divide-y divide-hairline">
        {rules.map((rule) => (
          <li key={rule.action} className="flex items-baseline justify-between gap-4 py-2 first:pt-0 last:pb-0">
            <span className="text-[13px] text-ink">{rule.action}</span>
            <span className="flex items-baseline gap-2">
              {rule.note ? <span className="text-xs text-ink-muted">{rule.note}</span> : null}
              <span className="tnum text-[13px] font-semibold text-brand">{rule.points}</span>
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-ink-muted">
        Re-signing an attribution earns nothing.
      </p>
    </Card>
  );
}
