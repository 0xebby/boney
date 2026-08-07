"use client";

import {useMemo, useState} from "react";
import Link from "next/link";
import {useCampaigns, useReputation, type TokenMeta} from "@/hooks/useCampaigns";
import {useNow} from "@/hooks/useNow";
import {DataTable, type Column} from "@/components/ui/DataTable";
import {StatTile, StatRow} from "@/components/ui/StatTile";
import {StatusPill} from "@/components/ui/StatusPill";
import {Meter} from "@/components/ui/Meter";
import {Card} from "@/components/ui/Card";
import {EmptyState, ErrorState, SkeletonRows} from "@/components/ui/States";
import {filterCampaigns, summarize, EMPTY_FILTERS, type CampaignFilters} from "@/lib/filters";
import {utilization} from "@/lib/campaign";
import {formatTokenAmount, formatPercent, formatTimeUntil, shortAddress} from "@/lib/format";
import {CAMPAIGN_STATUS, type CampaignView} from "@/lib/types";

const STATUS_OPTIONS = ["all", ...CAMPAIGN_STATUS] as const;

export function CampaignsPage() {
  const {campaigns, tokens, isLoading, isRefreshing, error, refetch, deployed} = useCampaigns();
  const {reputation} = useReputation();
  const [filters, setFilters] = useState<CampaignFilters>(EMPTY_FILTERS);

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

  const columns = useMemo(() => buildColumns(tokens, now), [tokens, now]);

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
          The marketplace for trustless marketing campaigns.
        </p>

        {/*
          Search is promoted out of the filter row and into the hero: on a marketplace landing
          page it is the primary way in, not one control among several. The status and
          "joinable" filters stay below, where they scope the table they sit above.
        */}
        <div className="mt-6">
          <label className="sr-only" htmlFor="campaign-search">
            Search campaigns by id or project address
          </label>
          <input
            id="campaign-search"
            type="search"
            value={filters.search}
            onChange={(e) => setFilters((f) => ({...f, search: e.target.value}))}
            placeholder="Search by campaign id or project address…"
            className="h-11 w-full rounded-lg border border-hairline-strong bg-surface-1 px-4 text-sm text-ink transition-colors placeholder:text-ink-muted hover:border-brand-dim focus:border-brand"
          />
        </div>

        <p className="mt-3 text-xs text-ink-muted">
          <Link href="/docs" className="text-brand underline-offset-2 hover:underline">
            How it works
          </Link>
        </p>
      </header>

      <StatRow>
        <StatTile
          label="Campaigns"
          value={summary.count.toLocaleString("en-US")}
          hint={`${summary.activeCount} active`}
        />
        <StatTile
          label="Total escrowed"
          value={
            singleToken
              ? formatTokenAmount(summary.totalPool, singleToken.decimals, {compact: true})
              : `${tokenList.length} tokens`
          }
          hint={singleToken?.symbol}
          accent="var(--series-1)"
        />
        <StatTile
          label="Paid to promoters"
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
          <SkeletonRows rows={4} cols={6} />
        ) : error ? (
          <ErrorState message={String(error)} onRetry={() => refetch()} />
        ) : (
          <DataTable
            rows={visible}
            columns={columns}
            rowKey={(c) => c.campaign}
            initialSort={{key: "pool", dir: "desc"}}
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
                      Create campaign
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
): Column<CampaignView>[] {
  const meta = (c: CampaignView) => tokens[c.token.toLowerCase()] ?? {symbol: "", decimals: 18};

  return [
    {
      key: "id",
      header: "Campaign",
      sortValue: (c) => c.campaignId,
      render: (c) => (
        <Link
          href={`/campaign/${c.campaignId}`}
          className="font-medium text-ink hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          #{c.campaignId.toString()}
          <span className="ml-2 font-normal text-ink-muted">{shortAddress(c.campaign)}</span>
        </Link>
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
      header: "Utilization",
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
      header: "Min. rep",
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
      header: "Ends in",
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
