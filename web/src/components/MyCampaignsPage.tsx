"use client";

import {useMemo} from "react";
import Link from "next/link";
import {useAccount} from "wagmi";
import {useCampaigns} from "@/hooks/useCampaigns";
import {denominations, type TokenMeta} from "@/lib/token";
import {useNow} from "@/hooks/useNow";
import {DataTable, type Column} from "@/components/ui/DataTable";
import {StatTile, StatRow} from "@/components/ui/StatTile";
import {StatusPill} from "@/components/ui/StatusPill";
import {Meter} from "@/components/ui/Meter";
import {Card} from "@/components/ui/Card";
import {EmptyState, ErrorState, SkeletonRows} from "@/components/ui/States";
import {utilization} from "@/lib/campaign";
import {projectName, hasProjectName} from "@/lib/projects";
import {formatTokenAmount, formatPercent, formatTimeUntil, shortAddress} from "@/lib/format";
import type {CampaignView} from "@/lib/types";

/**
 * `/my` — campaigns the connected wallet created.
 *
 * Ownership is `CampaignView.project`, which the marketplace already fetches, so this is a filter
 * over the same query rather than a second read path. That also means it shares the cache: a
 * campaign created on `/create` shows up here without an extra round trip.
 */
export function MyCampaignsPage() {
  const {address, isConnected} = useAccount();
  const {campaigns, tokens, isLoading, isRefreshing, error, refetch, deployed} = useCampaigns();
  const now = useNow();

  const mine = useMemo(() => {
    if (!address) return [];
    return campaigns.filter((c) => c.project.toLowerCase() === address.toLowerCase());
  }, [campaigns, address]);

  const totals = useMemo(() => {
    return mine.reduce(
      (acc, c) => ({
        pool: acc.pool + c.rewardPool,
        paidOut: acc.paidOut + c.paidOut,
        active: acc.active + (c.status === "Active" ? 1 : 0),
      }),
      {pool: BigInt(0), paidOut: BigInt(0), active: 0},
    );
  }, [mine]);

  // Mixed-token totals do not add up to anything meaningful, so the tiles fall back to a count
  // of units — see `denominations` for what makes two token contracts one unit.
  const units = useMemo(() => denominations(mine, tokens), [mine, tokens]);
  const singleToken = units.length === 1 ? units[0] : undefined;

  // Only reached with zero or 2+ units, so there is no singular case to spell. No campaigns
  // means there is no total to explain, and "0 tokens" reads as a balance rather than an absence.
  const mixedLabel = units.length === 0 ? "—" : `${units.length} tokens`;

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

  if (!isConnected) {
    return (
      <div className="space-y-5">
        <Header />
        <Card>
          <EmptyState
            title="Connect a wallet"
            description="Your campaigns are keyed to the wallet that created them. Connect to see the ones you own."
          />
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <Header />

      <StatRow>
        <StatTile
          label="Your campaigns"
          value={mine.length.toLocaleString("en-US")}
          hint={`${totals.active} active`}
        />
        <StatTile
          label="Total escrowed"
          value={
            singleToken
              ? formatTokenAmount(totals.pool, singleToken.decimals, {compact: true})
              : mixedLabel
          }
          unit={singleToken?.symbol}
          //accent="var(--series-1)"
        />
        <StatTile
          label="Paid to promoters"
          value={
            singleToken
              ? formatTokenAmount(totals.paidOut, singleToken.decimals, {compact: true})
              : "—"
          }
          unit={singleToken?.symbol}
          //accent="var(--series-3)"
        />
        {/*
          Gated on a single unit like the two tiles beside it: the percentage looks unitless, but
          it divides one sum of token amounts by another, so a mixed list makes it as meaningless
          as the totals above — and quieter about it, since a bare "15.7%" gives no hint that two
          different tokens went into it.
        */}
        <StatTile
          label="Pool utilization"
          value={singleToken ? formatPercent(Number(totals.paidOut), Number(totals.pool)) : "—"}
          hint="across your campaigns"
        />
      </StatRow>

      <Card padded={false}>
        {isLoading ? (
          <SkeletonRows rows={3} cols={7} />
        ) : error ? (
          <ErrorState message={String(error)} onRetry={() => refetch()} />
        ) : (
          <DataTable
            rows={mine}
            columns={columns}
            rowKey={(c) => c.campaign}
            initialSort={{key: "id", dir: "asc"}}
            isRefreshing={isRefreshing}
            emptyState={
              <EmptyState
                title="This wallet has no Campaigns yet."
                description="Campaigns you create with this wallet appear here."
                action={
                  <Link
                    href="/create"
                  >
                    {/*Create campaign*/}

                    <button
                              type="submit"
                              className="rounded-md bg-brand px-4 py-2 text-sm font-semibold text-plane hover:opacity-90 disabled:opacity-50"
                            >
                      Create campaign
                            </button>
                  </Link>
                }
              />
            }
          />
        )}
      </Card>
    </div>
  );
}

function Header() {
  return (
    <header>
      <h1 className="font-display text-2xl text-ink">My Campaigns</h1>
      <p className="mt-0.5 text-xs text-ink-muted">
        Campaigns you created. Open one to <b>Fund, Activate, Pause, End, or Reclaim Unspent Escrow</b> funds.
      </p>
    </header>
  );
}

function buildColumns(tokens: Record<string, TokenMeta>, now: number): Column<CampaignView>[] {
  const meta = (c: CampaignView) => tokens[c.token.toLowerCase()] ?? {symbol: "", decimals: 18};

  return [
    {
      key: "id",
      header: "Campaign",
      sortValue: (c) => c.campaignId,
      render: (c) => (
        <Link href={`/campaign/${c.campaignId}`} className="font-medium text-ink hover:underline">
          #{c.campaignId.toString()}
          <span className="ml-2 font-normal text-ink-muted">{shortAddress(c.campaign)}</span>
        </Link>
      ),
    },
    {
      key: "project",
      header: "Project",
      // On this page every row is the connected wallet's own campaign, so the project column repeats
      // one value down the table. First to go on a phone.
      hideOnMobile: true,
      sortValue: (c) => projectName(c),
      render: (c) =>
        hasProjectName(c) ? (
          <span className="text-ink-secondary">{projectName(c)}</span>
        ) : (
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
      numeric: true,
      hideOnMobile: true,
      sortValue: (c) => c.kpiCount,
      render: (c) => c.kpiCount.toString(),
    },
    {
      key: "ends",
      header: "Ends",
      numeric: true,
      hideOnMobile: true,
      sortValue: (c) => c.endTime,
      render: (c) => {
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
