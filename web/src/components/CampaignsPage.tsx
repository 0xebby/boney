"use client";

import {useMemo, useState} from "react";
import Link from "next/link";
import {useCampaigns, useReputation} from "@/hooks/useCampaigns";
import {useCampaignKpiSpecs} from "@/hooks/useCampaignKpiSpecs";
import {useCampaignGuides} from "@/hooks/useCampaignGuides";
import {denominations, type TokenMeta} from "@/lib/token";
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
import {summarizeKinds} from "@/lib/kpiSummary";
import {projectName, hasProjectName} from "@/lib/projects";
import type {ResolvedGuide} from "@/lib/campaignGuide";
import {formatTokenAmount, formatPercent, formatTimeUntil} from "@/lib/format";
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

  // The summary tiles read in whatever token the campaigns escrow. Mixed tokens would make a
  // single total meaningless, so the tiles show a count of units instead in that case — see
  // `denominations` for what makes two token contracts one unit.
  //
  // Derived from `visible`, not `campaigns`, because `summary` is: filtering down to a
  // single-token slice should denominate the totals that filter produced, rather than leave the
  // row reporting a mix the table below no longer shows.
  const units = useMemo(() => denominations(visible, tokens), [visible, tokens]);
  const singleToken = units.length === 1 ? units[0] : undefined;

  // Only reached with zero or 2+ units, so there is no singular case to spell. Nothing visible
  // means there is no total to explain, and "0 tokens" reads as a balance rather than an absence.
  const mixedLabel = units.length === 0 ? "—" : `${units.length} tokens`;

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
    <div className="space-y-5">
      {/*
        The list page doubles as the landing page, so the name gets hero treatment here rather
        than the small page-title treatment every other route uses. Lowercase to match the brand
        mark in the top bar.
      */}
      <header className="py-8 text-center sm:py-12">
        <h1 className="font-display text-5xl lowercase leading-none text-brand sm:text-7xl">
          Boneyard
        </h1>
        <p className="mx-auto mt-4 max-w-lg text-balance text-sm text-brand sm:text-base">
          The Marketplace for Verifiable Web3 Growth.
        </p>

        {/*
          Search is promoted out of the filter row and into the hero: on a marketplace landing
          page it is the primary way in, not one control among several. The status and
          "joinable" filters stay below, where they scope the table they sit above.
        */}
        <div className="mx-auto mt-6 max-w-lg">
          <label className="sr-only" htmlFor="campaign-search">
            Search campaigns, project names, or campaign IDs
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
          Set your KPIs. Escrow Reward Pool. Pay for Verifiable Results.
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
          qualifier={`of ${summary.count.toLocaleString("en-US")}`}
        />
        <StatTile
          label="Total Reward Pool"
          value={
            singleToken
              ? formatTokenAmount(summary.totalPool, singleToken.decimals, {compact: true})
              : mixedLabel
          }
          unit={singleToken?.symbol}
          //accent="var(--series-1)"
        />
        <StatTile
          label="Rewards Earned"
          value={
            singleToken
              ? formatTokenAmount(summary.totalPaidOut, singleToken.decimals, {compact: true})
              : "—"
          }
          unit={singleToken?.symbol}
          //accent="var(--series-3)"
        />
        {/*

        */}
        <StatTile
          label="Pool Utilization across all campaigns"
          value={
            singleToken
              ? formatPercent(Number(summary.totalPaidOut), Number(summary.totalPool))
              : "—"
          }
          //hint="across all campaigns"
        />
      </StatRow>

      {/* One filter row above everything it scopes — never per-card filters. Search lives in the
          hero above, so this row is status and eligibility only. The controls sit at the trailing
          edge, above the table's own right-aligned columns; what the row *says* stays at the left. */}
      <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
        <div className="mr-auto flex flex-wrap items-center gap-x-3 gap-y-1">
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
    </div>
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
      render: (c) => (
        <span className="inline-flex items-center gap-2">
          <Link
            href={`/campaign/${c.campaignId}`}
            className="font-medium text-ink hover:underline"
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
