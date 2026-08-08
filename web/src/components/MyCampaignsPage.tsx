"use client";

import {useMemo} from "react";
import Link from "next/link";
import {useAccount} from "wagmi";
import {useCampaigns, type TokenMeta} from "@/hooks/useCampaigns";
import {useNow} from "@/hooks/useNow";
import {DataTable, type Column} from "@/components/ui/DataTable";
import {StatTile, StatRow} from "@/components/ui/StatTile";
import {StatusPill} from "@/components/ui/StatusPill";
import {Meter} from "@/components/ui/Meter";
import {Card} from "@/components/ui/Card";
import {EmptyState, ErrorState, SkeletonRows} from "@/components/ui/States";
import {utilization} from "@/lib/campaign";
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

  // Mixed-token totals do not add up to anything meaningful, so the tiles fall back to a count.
  const tokenList = useMemo(
    () => [...new Set(mine.map((c) => c.token.toLowerCase()))],
    [mine],
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
              : `${tokenList.length} tokens`
          }
          hint={singleToken?.symbol}
          accent="var(--series-1)"
        />
        <StatTile
          label="Paid to promoters"
          value={
            singleToken
              ? formatTokenAmount(totals.paidOut, singleToken.decimals, {compact: true})
              : "—"
          }
          hint={singleToken?.symbol}
          accent="var(--series-3)"
        />
        <StatTile
          label="Pool utilization"
          value={formatPercent(Number(totals.paidOut), Number(totals.pool))}
          hint="across your campaigns"
        />
      </StatRow>

      <Card padded={false}>
        {isLoading ? (
          <SkeletonRows rows={3} cols={6} />
        ) : error ? (
          <ErrorState message={String(error)} onRetry={() => refetch()} />
        ) : (
          <DataTable
            rows={mine}
            columns={columns}
            rowKey={(c) => c.campaign}
            initialSort={{key: "id", dir: "desc"}}
            isRefreshing={isRefreshing}
            emptyState={
              <EmptyState
                title="No campaigns yet"
                description="Campaigns you create with this wallet appear here, with funding and lifecycle controls."
                action={
                  <Link
                    href="/create"
                    className="rounded-md border border-hairline-strong px-3 py-1.5 text-xs font-medium text-ink hover:bg-surface-hover"
                  >
                    Create campaign
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
      <h1 className="font-display text-2xl text-ink">My campaigns</h1>
      <p className="mt-0.5 text-xs text-ink-muted">
        Campaigns you created. Open one to fund, activate, pause, end, or reclaim unspent escrow.
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
      key: "ends",
      header: "Ends",
      numeric: true,
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
