"use client";

import {useMemo, useState} from "react";
import Link from "next/link";
import {useCampaigns, useReputation} from "@/hooks/useCampaigns";
import {useCampaignKpiSpecs} from "@/hooks/useCampaignKpiSpecs";
import {useCampaignGuides} from "@/hooks/useCampaignGuides";
import {type TokenMeta} from "@/lib/token";
import {poolValue} from "@/lib/poolValue";
import {useJoinedCampaigns} from "@/hooks/useJoinedCampaigns";
import {useNow} from "@/hooks/useNow";
import {DataTable, type Column} from "@/components/ui/DataTable";
import {StatTile, StatRow} from "@/components/ui/StatTile";
import {StatusPill} from "@/components/ui/StatusPill";
import {JoinedBadge} from "@/components/ui/JoinedBadge";
import {Meter} from "@/components/ui/Meter";
import {Card} from "@/components/ui/Card";
import {EmptyState, ErrorState, SkeletonRows} from "@/components/ui/States";
import {WelcomeDialog} from "@/components/WelcomeDialog";
import {welcomeFigure} from "@/lib/welcome";
import {
  filterCampaigns,
  summarize,
  EMPTY_FILTERS,
  type CampaignFilters,
  type StatusFilter,
} from "@/lib/filters";
import {utilization} from "@/lib/campaign";
import {summarizeKinds} from "@/lib/kpiSummary";
import {projectName, hasProjectName} from "@/lib/projects";
import type {ResolvedGuide} from "@/lib/campaignGuide";
import {formatTokenAmount, formatPercent, formatTimeUntil, formatUsd} from "@/lib/format";
import type {CampaignView, KpiSpec} from "@/lib/types";

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
  const {campaigns, tokens, isLoading, isRefreshing, error, refetch, deployed, chainId} =
    useCampaigns();
  const {reputation} = useReputation();
  const [filters, setFilters] = useState<CampaignFilters>(EMPTY_FILTERS);

  /*
    What each campaign measures, for the KPI column.

    One read per KPI across the page, fetched once and never polled — see `useCampaignKpiSpecs` for
    why a `KpiSpec` cannot change under a reader. Keyed on the campaign set rather than the list
    object, so `useCampaigns`' 30s poll does not drag this along with it.
  */
  const {specs: kpiSpecs, dropped: kpiSpecsDropped} = useCampaignKpiSpecs(campaigns);

  /*
    What each campaign is *for*, in the project's own words. The committed catalog is in the bundle,
    so a row that has an entry reads immediately; a project-published guide arrives a moment later
    and lands in the same cache the campaign page reads.
  */
  const guides = useCampaignGuides(useMemo(() => campaigns.map((c) => c.campaign), [campaigns]));

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

  // Reward pools are stablecoin-denominated, so the summary tiles read in dollars and campaigns
  // escrowing different tokens still share one total — see `poolValue`.
  //
  // Derived from `visible`, not `campaigns`, because `summary` is: filtering the list should
  // retotal what the filter produced rather than leave the row reporting rows it no longer shows.
  const value = useMemo(() => poolValue(visible, tokens), [visible, tokens]);

  // The welcome dialog's headline number, from the same totals the tiles below read.
  const welcome = useMemo(
    () =>
      welcomeFigure({
        pool: value.pool,
        activeCount: summary.activeCount,
      }),
    [value.pool, summary.activeCount],
  );

  const columns = useMemo(
    () => buildColumns(tokens, now, joinedAddresses, kpiSpecs, guides, chainId),
    [tokens, now, joinedAddresses, kpiSpecs, guides, chainId],
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
    <>
      {/* Outside the column below, not the first child of it: `space-y-5` would give the overlay a
          top margin, and an `inset-0` box shifts for one. */}
      <WelcomeDialog figure={welcome} ready={!isLoading && !error} />

      <div className="space-y-5">
        {/*
          The list page doubles as the landing page, so the name gets hero treatment here rather
          than the small page-title treatment every other route uses. Lowercase to match the brand
          mark in the top bar.
        */}
        <header className="py-6 text-center sm:py-12">
          {/*
            The wordmark and both lines are one lockup, inside a `w-fit` box.

            That box is as wide as its widest child, so no line can run wider than the name it sits
            under: on a phone both wrap inside the wordmark's own measure, on a desktop they centre under
            it. Centring them against the page instead let the blocks meet at a shared midpoint while
            their edges disagreed, which is what read as misaligned — and capping only the first line
            left the second free to set the box's width, so the first one wrapped early inside a box
            wider than the wordmark.
          */}
          <div className="mx-auto w-fit">
            <h1 className="animate-rise-in font-display text-5xl lowercase leading-none text-brand sm:text-7xl">
              Boneyard
            </h1>
            <p className="animate-rise-in mx-auto mt-3 max-w-[15rem] text-balance text-sm leading-snug text-brand [animation-delay:60ms] sm:mt-4 sm:max-w-none sm:text-base">
              The Marketplace for Verifiable Web3 Growth.
            </p>

            {/*
              Capped to the same measure as the line above it. Left unbounded it was the widest child,
              so it — not the wordmark — decided how wide the box was.
            */}
            <p className="animate-rise-in mx-auto mt-4 max-w-[15rem] text-balance text-xs leading-snug text-ink-secondary [animation-delay:120ms] sm:mt-5 sm:max-w-none">
              Set your KPIs. Escrow Reward Pool. Pay for Verifiable Results.
            </p>
          </div>
        </header>

        <StatRow>
          <StatTile
            label="Active campaigns"
            value={summary.activeCount.toLocaleString("en-US")}
            qualifier={`of ${summary.count.toLocaleString("en-US")}`}
          />
          <StatTile
            label="Total Reward Pool"
            value={formatUsd(value.pool, {compact: true})}
            //accent="var(--series-1)"
          />
          <StatTile
            label="Rewards Earned"
            value={formatUsd(value.paidOut, {compact: true})}
            //accent="var(--series-3)"
          />
          {/*

          */}
          <StatTile
            label="Pool Utilization"
            value={formatPercent(value.paidOut, value.pool)}
            //hint="across all campaigns"
          />
        </StatRow>

        {/* One filter row above everything it scopes — never per-card filters. Search leads it, on the
            same line as the status and eligibility controls it narrows with: it is one control among
            them rather than a hero field, and sharing their row is what keeps the three baselines
            aligned. The controls sit at the trailing edge, above the table's own right-aligned
            columns; what the row *says* stays at the left.

            Only from `sm` up, though. Below it the field takes the whole line and the rest wraps, and a
            trailing edge there leaves each wrapped group at its own offset — which is the ragged column
            the row exists to prevent. On a phone they stack against the left edge instead. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 sm:justify-end">
          {/* `flex-1` so the field runs from the left edge to whatever sits next in the row, rather than
              stopping at a fixed width and leaving a gap the eye reads as a missing control. `min-w-56`
              keeps a project name legible once the row is crowded. */}
          <div className="w-full sm:min-w-56 sm:flex-1">
            <label className="sr-only" htmlFor="campaign-search">
              Search campaigns, project names, or campaign IDs
            </label>
            <input
              id="campaign-search"
              type="search"
              value={filters.search}
              onChange={(e) => setFilters((f) => ({...f, search: e.target.value}))}
              placeholder="Search campaigns, projects, or IDs…"
              className="h-11 w-full rounded-md border border-hairline-strong bg-surface-1 px-2.5 text-xs text-ink transition-colors placeholder:text-ink-muted hover:border-brand-dim focus:border-brand sm:h-8"
            />
          </div>

          {/* No `mr-auto`: the field beside it already absorbs the row's free space, and two elements
              competing for it split it between them. */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 empty:hidden">
            {visible.length !== campaigns.length ? (
              <span className="text-xs text-ink-muted">
                {visible.length} of {campaigns.length}
              </span>
            ) : null}

            {/* Said out loud rather than absorbed: those rows show a KPI count, not a kind, and a
                column that quietly stopped describing the tail of the list would read as "no KPIs
                here". */}
            {kpiSpecsDropped > 0 ? (
              <span className="text-xs text-ink-muted">
                KPI kinds not loaded for {kpiSpecsDropped} campaign
                {kpiSpecsDropped === 1 ? "" : "s"}
              </span>
            ) : null}
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

          {/* `flex-wrap`: six chips measure wider than a phone's content column, and wrapping inside
              their own box keeps every status visible — an `overflow-x-auto` strip would put half of
              them behind a gesture nothing advertises. */}
          <div className="flex flex-wrap items-center gap-1 rounded-md border border-hairline bg-surface-1 p-0.5">
            {STATUS_OPTIONS.map((option) => {
              const active = filters.status === option;
              return (
                <button
                  key={option}
                  type="button"
                  onClick={() => setFilters((f) => ({...f, status: option}))}
                  aria-pressed={active}
                  className={`rounded px-2 py-1.5 text-xs transition-colors sm:py-1 ${
                    active ? "bg-surface-2 font-medium text-ink" : "text-ink-muted hover:text-ink"
                  }`}
                >
                  {option === "all" ? "All" : option}
                </button>
              );
            })}
          </div>
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
              initialSort={{key: "project", dir: "asc"}}
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

        {/* The docs link sits after the table rather than in the hero: a visitor who has read the list
            and not found what they came for is the one who wants an explanation, and the hero's job is
            to get them to the list. */}
        <p className="text-xs text-ink-muted">
          <Link href="/docs" className="text-brand underline-offset-2 hover:underline">
            See how it works
          </Link>
        </p>
      </div>
    </>
  );
}

function buildColumns(
  tokens: Record<string, TokenMeta>,
  now: number,
  joinedAddresses: ReadonlySet<string>,
  kpiSpecs: Record<string, KpiSpec[]>,
  guides: Map<string, ResolvedGuide | null>,
  chainId?: number,
): Column<CampaignView>[] {
  const meta = (c: CampaignView) => tokens[c.token.toLowerCase()] ?? {symbol: "", decimals: 18};
  const hasJoined = (c: CampaignView) => joinedAddresses.has(c.campaign.toLowerCase());

  /*
    What this campaign measures, in words. Reads no chain state of its own: the kind comes from the
    specs the hook fetched once, and the hover text names the watched contract from the local catalog
    or — where a campaign watches the token it escrows, as most seeded ones do — the token metadata
    already loaded for the reward-pool column.
  */
  const kindSummary = (c: CampaignView) => {
    const specs = kpiSpecs[c.campaign.toLowerCase()];
    if (!specs) return null;

    return summarizeKinds(specs, {
      chainId,
      escrowToken: c.token.toLowerCase(),
      tokenSymbol: meta(c).symbol || undefined,
      campaignName: c.name,
    });
  };

  /** The project's own line about the campaign, from its guide. */
  const summaryFor = (c: CampaignView) =>
    guides.get(c.campaign.toLowerCase())?.summary?.trim() || undefined;

  return [
    {
      key: "project",
      header: "Project",
      // The campaign's on-chain name, which is what a project puts its own name in. The project
      // wallet stands in where a campaign was created without one.
      sortValue: (c) => (hasProjectName(c) ? projectName(c) : c.project.toLowerCase()),
      // `min()` rather than a flat 220px: the same declaration is the column's share of a phone's
      // width and its measure on a desktop, which an inline width cannot express with a breakpoint.
      width: "min(220px, 42vw)",
      /*
        Capped at the column's own width, with the name truncating inside it.
        `overflow-x-auto` handles the table's total; this line only has to stop one cell from
        setting it. The table lays out `auto`, so a cell's widest possible content is what sizes
        its column: an uncapped name — or a `Joined` badge that appears when the wallet connects
        and vanishes when it disconnects — moved every column to its right. The cap makes this
        column's measure a constant, so the badge is free to come and go.
      */
      render: (c) => (
        <span className="flex max-w-[42vw] items-center gap-2 sm:max-w-[220px]">
          <Link
            href={`/campaign/${c.campaignId}`}
            title={projectName(c)}
            className="min-w-0 truncate font-medium text-ink hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {projectName(c)}
          </Link>
          {hasJoined(c) ? <JoinedBadge /> : null}
        </span>
      ),
    },
    {
      key: "why",
      header: "Campaign",
      hideOnMobile: true,
      width: "320px",
      // Sorts on the summary, so campaigns that say what they are for group ahead of the ones that
      // do not. The numeric id is not here at all — it is on the campaign's own page.
      sortValue: (c) => summaryFor(c) ?? "",
      render: (c) => {
        const summary = summaryFor(c);

        // Nothing published yet. Said as an absence rather than filled with the KPI kinds, which
        // are their own column and describe what is measured rather than what it is for.
        if (!summary) {
          return <span className="text-ink-muted">No campaign info yet</span>;
        }

        return (
          <span className="line-clamp-2 text-ink-secondary" title={summary}>
            {summary}
          </span>
        );
      },
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
      // The fixed width is also why this is one of the first columns dropped on a phone: 140px of a
      // 375px viewport spent on a bar whose number is already in "Paid out".
      hideOnMobile: true,
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
      hideOnMobile: true,
      // Sorts on the label, so the column orders the way it reads. Rows whose specs have not landed
      // (or were left out by the read budget) sort together under the empty string.
      sortValue: (c) => kindSummary(c)?.sortValue ?? "",
      render: (c) => {
        const summary = kindSummary(c);

        // No specs yet: the count is what this column showed before, and it is never wrong — just
        // less useful than the kind. Better than an empty cell that reads as "no KPIs".
        if (!summary) {
          return <span className="text-ink-muted">{c.kpiCount.toString()}</span>;
        }

        return (
          <span title={summary.title} className="text-ink-secondary">
            {summary.label}
            {summary.extra > 0 ? (
              <span className="ml-1 text-ink-muted">+{summary.extra}</span>
            ) : null}
          </span>
        );
      },
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
      hideOnMobile: true,
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
