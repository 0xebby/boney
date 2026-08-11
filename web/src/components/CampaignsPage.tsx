"use client";

import {useMemo, useState} from "react";
import Link from "next/link";
import {useCampaigns, useReputation, type TokenMeta} from "@/hooks/useCampaigns";
import {useJoinedCampaigns} from "@/hooks/useJoinedCampaigns";
import {useNow} from "@/hooks/useNow";
import {DataTable, type Column} from "@/components/ui/DataTable";
import {StatTile, StatRow} from "@/components/ui/StatTile";
import {StatusPill} from "@/components/ui/StatusPill";
import {JoinedBadge} from "@/components/ui/JoinedBadge";
import {Meter} from "@/components/ui/Meter";
import {Card} from "@/components/ui/Card";
import {EmptyState, ErrorState, SkeletonRows} from "@/components/ui/States";
import {
  filterCampaigns,
  summarize,
  EMPTY_FILTERS,
  type CampaignFilters,
  type StatusFilter,
} from "@/lib/filters";
import {utilization} from "@/lib/campaign";
import { projectName, hasProjectName } from "@/lib/projects";
import {formatTokenAmount, formatPercent, formatTimeUntil, shortAddress} from "@/lib/format";
import type {CampaignView} from "@/lib/types";

/**
 * Filter order, most-asked-for first: a visitor scanning the marketplace wants what is running
 * now, so Active leads and the rest follow the lifecycle.
 *
 * Spelled out rather than spread from `CAMPAIGN_STATUS`, because that array mirrors the Solidity
 * enum and its indices are load-bearing (`statusFromIndex`) — it cannot be reordered to suit the
 * UI. `satisfies` keeps the two from drifting apart on spelling; this list must name every status.
 */
const STATUS_OPTIONS = [
  "all",
  "Active",
  "Pending",
  "Paused",
  "Ended",
  "Cancelled",
] as const satisfies readonly StatusFilter[];

export function CampaignsPage() {
  const {campaigns, tokens, isLoading, isRefreshing, error, refetch, deployed} = useCampaigns();
  const {reputation} = useReputation();
  const [filters, setFilters] = useState<CampaignFilters>(EMPTY_FILTERS);

  /*
    Which of these the connected wallet has already joined.

    Costs nothing extra here: `AppShell` runs this exact query on every route through
    `useIsPromoter`, and both go through the same `useCampaigns` key, so this is a third observer
    of one cache entry rather than a second fan-out. It returns an empty list with no wallet
    connected, so a disconnected visitor issues no reads and sees no markers.
  */
  const {joined} = useJoinedCampaigns(campaigns);

  // Lowercased so a checksummed address from one source still matches a lowercase one from
  // another — the two happen to agree today, but a mismatch would silently drop every marker.
  const joinedAddresses = useMemo(
    () => new Set(joined.map((j) => j.view.campaign.toLowerCase())),
    [joined],
  );

  // Wall-clock time via an external store — see `useNow`. Returns 0 until the clock is live,
  // which keeps the server prerender and client hydration in agreement.
  const now = useNow();

  const visible = useMemo(
    () => filterCampaigns(campaigns, filters, reputation),
    [campaigns, filters, reputation],
  );
  const summary = useMemo(() => summarize(visible), [visible]);

  // The summary tiles read in whatever token the first campaign escrows. Mixed-token lists
  // would make a single total meaningless, so the tiles show a count instead in that case.
  const tokenList = useMemo(
    () => [...new Set(campaigns.map((c) => c.token.toLowerCase()))],
    [campaigns],
  );
  const singleToken = tokenList.length === 1 ? tokens[tokenList[0]] : undefined;

  const columns = useMemo(
    () => buildColumns(tokens, now, joinedAddresses),
    [tokens, now, joinedAddresses],
  );

  if (!deployed) {
    return (
      <Card>
        <EmptyState
          title="Boneyard is not available on this network"
          description="Switch your wallet to a supported network to see campaigns."
        />
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      {/*
        The list page doubles as the landing page, so the name gets hero treatment here rather
        than the small page-title treatment every other route uses. Lowercase to match the brand
        mark in the top bar.
      */}
      <header className="py-8 text-center sm:py-12">
        <h1 className="font-display text-5xl lowercase leading-none text-brand sm:text-7xl">
          boneyard
        </h1>
        <p className="mx-auto mt-4 max-w-lg text-balance text-sm text-ink-secondary sm:text-base">
          The marketplace for verifiable Web3 growth.
        </p>

        {/*
          Search is promoted out of the filter row and into the hero: on a marketplace landing
          page it is the primary way in, not one control among several. The status and
          "joinable" filters stay below, where they scope the table they sit above.
        */}
        <div className="mx-auto mt-6 max-w-lg">
          <label className="sr-only" htmlFor="campaign-search">
            Search campaigns, projects, or campaign IDs
          </label>
          <input
            id="campaign-search"
            type="search"
            value={filters.search}
            onChange={(e) => setFilters((f) => ({...f, search: e.target.value}))}
            placeholder="Search campaigns, projects, or campaign IDs…"
            className="h-11 w-full rounded-lg border border-hairline-strong bg-surface-1 px-4 text-sm text-ink transition-colors placeholder:text-ink-muted hover:border-brand-dim focus:border-brand"
          />
        </div>

        {/*
          The "Create a campaign" button itself lives in the top bar, which has no room for a
          subtitle — so its supporting line sits here instead, where the landing page can afford
          to spell out what a project is actually signing up for.
        */}
        <p className="mt-5 text-xs text-ink-secondary">
          Set your KPIs. Escrow Reward Pool. Pay for verified results.
        </p>

        <p className="mt-2 text-xs text-ink-muted">
          <Link href="/docs" className="text-brand underline-offset-2 hover:underline">
            See how it works
          </Link>
        </p>
      </header>

      <StatRow>
        <StatTile
          label="Active campaigns"
          value={summary.activeCount.toLocaleString("en-US")}
          hint={`of ${summary.count.toLocaleString("en-US")} shown`}
        />
        <StatTile
          label="Total rewards"
          value={
            singleToken
              ? formatTokenAmount(summary.totalPool, singleToken.decimals, {compact: true})
              : `${tokenList.length} tokens`
          }
          hint={singleToken?.symbol}
          accent="var(--series-1)"
        />
        <StatTile
          label="Rewards earned"
          value={
            singleToken
              ? formatTokenAmount(summary.totalPaidOut, singleToken.decimals, {compact: true})
              : "—"
          }
          hint={singleToken?.symbol}
          accent="var(--series-3)"
        />
        <StatTile
          label="Pool utilization"
          value={formatPercent(Number(summary.totalPaidOut), Number(summary.totalPool))}
          hint="across shown campaigns"
        />
      </StatRow>

      {/* One filter row above everything it scopes — never per-card filters. Search lives in the
          hero above, so this row is status and eligibility only. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-md border border-hairline bg-surface-1 p-0.5">
          {STATUS_OPTIONS.map((option) => {
            const active = filters.status === option;
            return (
              <button
                key={option}
                type="button"
                onClick={() => setFilters((f) => ({...f, status: option}))}
                aria-pressed={active}
                className={`rounded px-2 py-1 text-xs transition-colors ${
                  active ? "bg-surface-2 font-medium text-ink" : "text-ink-muted hover:text-ink"
                }`}
              >
                {option === "all" ? "All" : option}
              </button>
            );
          })}
        </div>

        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-ink-secondary">
          <input
            type="checkbox"
            checked={filters.joinableOnly}
            onChange={(e) => setFilters((f) => ({...f, joinableOnly: e.target.checked}))}
            className="size-3.5 accent-[var(--brand)]"
          />
          Joinable by me
        </label>

        {visible.length !== campaigns.length ? (
          <span className="text-xs text-ink-muted">
            {visible.length} of {campaigns.length}
          </span>
        ) : null}
      </div>

      <Card padded={false}>
        {isLoading ? (
          <SkeletonRows rows={4} cols={7} />
        ) : error ? (
          <ErrorState message={String(error)} onRetry={() => refetch()} />
        ) : (
          <DataTable
            rows={visible}
            columns={columns}
            rowKey={(c) => c.campaign}
                initialSort={{ key: "id", dir: "asc" }}
            isRefreshing={isRefreshing}
            emptyState={
              <EmptyState
                title={campaigns.length === 0 ? "No campaigns yet" : "No campaigns match"}
                description={
                  campaigns.length === 0
                    ? "Create the first campaign to start a performance-based collaboration."
                    : "Try clearing the filters or widening your search."
                }
                action={
                  campaigns.length === 0 ? (
                    <Link
                      href="/create"
                      className="rounded-md border border-hairline-strong px-3 py-1.5 text-xs font-medium text-ink hover:bg-surface-hover"
                    >
                      Create a campaign
                    </Link>
                  ) : null
                }
              />
            }
          />
        )}
      </Card>
    </div>
  );
}

function buildColumns(
  tokens: Record<string, TokenMeta>,
  now: number,
  joinedAddresses: ReadonlySet<string>,
): Column<CampaignView>[] {
  const meta = (c: CampaignView) => tokens[c.token.toLowerCase()] ?? {symbol: "", decimals: 18};
  const hasJoined = (c: CampaignView) => joinedAddresses.has(c.campaign.toLowerCase());

  return [
    {
      key: "id",
      header: "Campaign",
      sortValue: (c) => c.campaignId,
      render: (c) => (
        <span className="inline-flex items-center gap-2">
          <Link
            href={`/campaign/${c.campaignId}`}
            className="font-medium text-ink hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            #{c.campaignId.toString()}
            <span className="ml-2 font-normal text-ink-muted">{shortAddress(c.campaign)}</span>
          </Link>
          {hasJoined(c) ? <JoinedBadge /> : null}
        </span>
      ),
    },
    {
      key: "project",
      header: "Project",
      // Sorts on the displayed string, so the column orders the way it reads. Rows falling back
      // to an address sort among themselves under "0x" rather than being scattered by name.
      sortValue: (c) => projectName(c),
      render: (c) =>
        hasProjectName(c) ? (
          <span className="text-ink-secondary">{projectName(c)}</span>
        ) : (
          // An address here means no name is on file — dimmed so it reads as absent metadata
          // rather than as a project literally called "0xba95…".
          <span className="font-normal text-ink-muted">{shortAddress(c.project)}</span>
        ),
    },
    {
      key: "status",
      header: "Status",
      sortValue: (c) => c.status,
      render: (c) => <StatusPill status={c.status} />,
    },
    {
      key: "pool",
      header: "Reward pool",
      numeric: true,
      sortValue: (c) => c.rewardPool,
      render: (c) => {
        const m = meta(c);
        return (
          <span>
            {formatTokenAmount(c.rewardPool, m.decimals, {compact: true})}{" "}
            <span className="text-ink-muted">{m.symbol}</span>
          </span>
        );
      },
    },
    {
      key: "paid",
      header: "Paid out",
      numeric: true,
      hideOnMobile: true,
      sortValue: (c) => c.paidOut,
      render: (c) => formatTokenAmount(c.paidOut, meta(c).decimals, {compact: true}),
    },
    {
      key: "utilization",
      header: "Progress",
      sortValue: (c) => utilization(c),
      width: "140px",
      render: (c) => (
        <Meter
          value={Number(c.paidOut)}
          max={Number(c.rewardPool)}
          valueText={formatPercent(Number(c.paidOut), Number(c.rewardPool))}
        />
      ),
    },
    {
      key: "kpis",
      header: "KPIs",
      numeric: true,
      hideOnMobile: true,
      sortValue: (c) => c.kpiCount,
      render: (c) => c.kpiCount.toString(),
    },
    {
      key: "minRep",
      header: "Min. rep.",
      numeric: true,
      hideOnMobile: true,
      sortValue: (c) => c.minReputation,
      render: (c) =>
        c.minReputation === BigInt(0) ? (
          <span className="text-ink-muted">Open</span>
        ) : (
          c.minReputation.toLocaleString("en-US")
        ),
    },
    {
      key: "ends",
      header: "Ends",
      numeric: true,
      sortValue: (c) => c.endTime,
      render: (c) => {
        // `now === 0` means the clock effect has not run yet; show nothing rather than
        // flashing "ended" against every row on the first paint.
        if (now === 0) return <span className="text-ink-muted">—</span>;
        return (
          <span className={Number(c.endTime) <= now ? "text-ink-muted" : undefined}>
            {formatTimeUntil(c.endTime, now)}
          </span>
        );
      },
    },
  ];
}
