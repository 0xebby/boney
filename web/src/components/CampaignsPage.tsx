"use client";

import {useMemo, useState} from "react";
import Link from "next/link";
import {useAccount} from "wagmi";
import {useCampaigns, useReputation} from "@/hooks/useCampaigns";
import {useCampaignKpiSpecs} from "@/hooks/useCampaignKpiSpecs";
import {useCampaignGuides} from "@/hooks/useCampaignGuides";
import {type TokenMeta} from "@/lib/token";
import {poolValue} from "@/lib/poolValue";
import {useJoinedCampaigns} from "@/hooks/useJoinedCampaigns";
import {useNow} from "@/hooks/useNow";
import {DataTable, type Column} from "@/components/ui/DataTable";
import {Figure} from "@/components/ui/StatTile";
import {StatusPill} from "@/components/ui/StatusPill";
import {JoinedBadge} from "@/components/ui/JoinedBadge";
import {Meter} from "@/components/ui/Meter";
import {Card} from "@/components/ui/Card";
import {JoinCampaignMenu} from "@/components/ui/JoinCampaignMenu";
import {CampaignFilters as CampaignFilterControls} from "@/components/CampaignFilters";
import {LeaderboardTeaser} from "@/components/LeaderboardTeaser";
import {EmptyState, ErrorState, SkeletonRows} from "@/components/ui/States";
import {WelcomeDialog} from "@/components/WelcomeDialog";
import {welcomeFigure} from "@/lib/welcome";
import {
  filterCampaigns,
  summarize,
  EMPTY_FILTERS,
  type CampaignFilters,
} from "@/lib/filters";
import {joinOptions} from "@/lib/joinPicker";
import {utilization} from "@/lib/campaign";
import {summarizeKinds} from "@/lib/kpiSummary";
import {projectName, hasProjectName} from "@/lib/projects";
import type {ResolvedGuide} from "@/lib/campaignGuide";
import {formatTokenAmount, formatPercent, formatTimeUntil, formatUsd} from "@/lib/format";
import type {CampaignView, KpiSpec} from "@/lib/types";

export function CampaignsPage() {
  const {campaigns, tokens, isLoading, isRefreshing, error, refetch, deployed, chainId} =
    useCampaigns();
  const {reputation} = useReputation();
  const {isConnected} = useAccount();
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
  const {joined, refetch: refetchJoined} = useJoinedCampaigns(campaigns);

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

  /*
    What the promote menu offers — built from `campaigns`, not `visible`.

    The table's filters narrow what a visitor is reading; they are not a statement about what they
    are allowed to join. Sourcing the menu from the filtered list would make "Ended only" empty it.
  */
  const joinable = useMemo(
    () => joinOptions(campaigns, {reputation, joinedAddresses, connected: isConnected}),
    [campaigns, reputation, joinedAddresses, isConnected],
  );

  if (!deployed) {
    return (
      <Card>
        <EmptyState
          title="Boneyard is not available on this network"
          description="Switch your wallet to base sepolia network to see campaigns."
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
          </div>
        </header>

        {/* One panel across the width: what the marketplace is paying out and how much of it has
            landed. Four figures reading left to right, the pool set larger as the one everything
            else is a share of. Unheaded — each figure carries its own label, so a heading above them
            would only name the panel a second time.

            One gap for both axes, equal to the card's own inset: every space inside the panel —
            figure to figure, figure to edge — measures the same. */}
        <Card>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Figure
              label="Total Reward Pool"
              value={formatUsd(value.pool, {compact: true})}
              size="lg"
            />
            <Figure
              label="Active campaigns"
              value={summary.activeCount.toLocaleString("en-US")}
              qualifier={`of ${summary.count.toLocaleString("en-US")}`}
            />
            <Figure label="Rewards Earned" value={formatUsd(value.paidOut, {compact: true})} />
            <Figure label="Pool Utilization" value={formatPercent(value.paidOut, value.pool)} />
          </div>
        </Card>

        {/* The two actions the page exists to start, centred between the overview above and the table
            below. Promoting is a menu rather than a link because the campaign has to be chosen, and
            the choice is the part a promoter needs help with — every offerable campaign is listed,
            with the ones this wallet cannot promote yet saying why. */}
        {/* A capped band rather than two text-width buttons or a pair stretched across the panel:
            each takes half of a measure narrow enough to stay a pair, wide enough to read as the
            page’s two entry points. A caption under each states what that side of the marketplace
            does. Stacked below `sm`, where half of a phone is not a button, and spaced wider there
            so a caption groups with the button above it instead of reading as four loose lines. */}
        <div className="mx-auto flex w-full max-w-xl flex-col gap-6 py-2 sm:flex-row sm:gap-3 sm:py-4">
          <div className="flex flex-col gap-2 sm:flex-1">
            <Link
              href="/create"
              className="flex min-h-11 w-full items-center justify-center rounded-md bg-brand px-5 text-sm font-semibold text-plane transition-opacity hover:opacity-90"
            >
              Create a campaign
            </Link>

            <p className="text-balance text-center text-xs leading-snug text-brand">
              <i>Set your KPIs. Escrow reward pool. Pay for verifiable results.</i>
            </p>
          </div>

          <JoinCampaignMenu
            options={joinable}
            onJoined={refetchJoined}
            loading={isLoading}
            caption="Generate a unique boneylink, share and earn rewards."
            className="sm:flex-1"
          />
        </div>

        <Card padded={false}>
          {/* The table’s own header carries what the list is showing and the one control that
              changes it — filters live behind it rather than in a row of their own above the panel.
              Padded to the table’s own cell inset, so the title starts where the first column does. */}
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-hairline px-2 py-2.5 sm:px-3">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h2 className="text-sm font-bold text-brand">Browse campaigns</h2>

              {visible.length !== campaigns.length ? (
                <span className="tnum text-xs text-ink-muted">
                  {visible.length} of {campaigns.length}
                </span>
              ) : null}

              {/* Said out loud rather than absorbed: those rows show a KPI count, not a kind, and a
                  column that quietly stopped describing the tail of the list would read as “no KPIs
                  here”. */}
              {kpiSpecsDropped > 0 ? (
                <span className="text-xs text-ink-muted">
                  KPI kinds not loaded for {kpiSpecsDropped} campaign
                  {kpiSpecsDropped === 1 ? "" : "s"}
                </span>
              ) : null}
            </div>

            <CampaignFilterControls filters={filters} setFilters={setFilters} />
          </div>

          {isLoading ? (
            <SkeletonRows rows={4} cols={8} />
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

        {/* Who is already earning, below the table rather than above it: the panel renders nothing
            until the subgraph answers, so a slot here shifts only the docs link under it. */}
        <LeaderboardTeaser />

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
        its column: an uncapped name — or a `Promoting` badge that appears when the wallet connects
        and vanishes when it disconnects — moved every column to its right. The cap makes this
        column's measure a constant, so the badge is free to come and go.
      */
      render: (c) => (
        <div className="flex max-w-[42vw] flex-col gap-0.5 sm:max-w-[220px]">
          <span className="flex items-center gap-2">
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

          {/* A phone drops six of the nine columns, which left it a name, a status and a number.
              The three that decide whether a campaign is worth opening — when it ends, what it
              gates on, how much of the pool has moved — ride under the name instead, and go away
              from `md` up where the table shows them itself. */}
          <span className="text-[11px] leading-snug text-ink-muted md:hidden">
            {now > 0 ? `${formatTimeUntil(c.endTime, now)} · ` : ""}
            {c.minReputation === BigInt(0)
              ? "open to all"
              : `min ${c.minReputation.toLocaleString("en-US")}`}
            {c.paidOut > BigInt(0)
              ? ` · ${formatPercent(Number(c.paidOut), Number(c.rewardPool))} paid`
              : ""}
          </span>
        </div>
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
      key: "utilization",
      header: "Progress",
      sortValue: (c) => utilization(c),
      // The fixed width is also why this is one of the first columns dropped on a phone: 140px of a
      // 375px viewport spent on a bar, when the same percentage rides under the project name there.
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
      header: "Min. BoneyScore",
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
