"use client";

import {useMemo} from "react";
import Link from "next/link";
import {useAccount} from "wagmi";
import {useCampaigns} from "@/hooks/useCampaigns";
import {type TokenMeta} from "@/lib/token";
import {poolValue} from "@/lib/poolValue";
import {useNow} from "@/hooks/useNow";
import {DataTable, type Column} from "@/components/ui/DataTable";
import {StatTile, StatRow} from "@/components/ui/StatTile";
import {StatusPill} from "@/components/ui/StatusPill";
import {Meter} from "@/components/ui/Meter";
import {Card, CardHeader} from "@/components/ui/Card";
import {EmptyState, ErrorState, SkeletonRows} from "@/components/ui/States";
import {ReferredCampaigns} from "@/components/ReferredCampaigns";
import {utilization} from "@/lib/campaign";
import {projectName, hasProjectName} from "@/lib/projects";
import {
  formatTokenAmount,
  formatPercent,
  formatTimeUntil,
  formatUsd,
  shortAddress,
} from "@/lib/format";
import type {CampaignView} from "@/lib/types";

/**
 * `/my` — the connected wallet's own positions: campaigns it created, and campaigns it was
 * referred to.
 *
 * Ownership is `CampaignView.project`, which the marketplace already fetches, so this is a filter
 * over the same query rather than a second read path. That also means it shares the cache: a
 * campaign created on `/create` shows up here without an extra round trip.
 *
 * The referrals card is the same `ReferredCampaigns` the promoter dashboard renders. It lives here
 * too because `/my` is the one personal tab every connected wallet gets, and a wallet that only
 * ever signed somebody's boneylink is a referral with no membership and no campaign of its own.
 */
export function MyCampaignsPage() {
  const {address, isConnected} = useAccount();
  const {campaigns, tokens, isLoading, isRefreshing, error, refetch, deployed} = useCampaigns();
  const now = useNow();

  const mine = useMemo(() => {
    if (!address) return [];
    return campaigns.filter((c) => c.project.toLowerCase() === address.toLowerCase());
  }, [campaigns, address]);

  const activeCount = useMemo(
    () => mine.filter((c) => c.status === "Active").length,
    [mine],
  );

  // Reward pools are stablecoin-denominated, so the tiles read in dollars and campaigns escrowing
  // different tokens still share one total — see `poolValue`.
  const value = useMemo(() => poolValue(mine, tokens), [mine, tokens]);

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
          hint={`${activeCount} active`}
        />
        <StatTile
          label="Total escrowed"
          value={formatUsd(value.pool, {compact: true})}
          //accent="var(--series-1)"
        />
        <StatTile
          label="Paid to promoters"
          value={formatUsd(value.paidOut, {compact: true})}
          //accent="var(--series-3)"
        />
        <StatTile
          label="Pool utilization"
          value={formatPercent(value.paidOut, value.pool)}
          hint="across your campaigns"
        />
      </StatRow>

      <Card padded={false}>
        {/* `Card` drops its padding so the table can run edge to edge; the header puts its own
            back, matching the referrals card below it. */}
        <div className="px-4 pt-4">
          <CardHeader
            title="Campaigns you created"
            subtitle="Campaigns this wallet owns, and what each has paid out"
          />
        </div>
        {isLoading ? (
          <SkeletonRows rows={3} cols={7} />
        ) : error ? (
          <ErrorState message={String(error)} onRetry={() => refetch()} />
        ) : (
          <DataTable
            rows={mine}
            columns={columns}
            rowKey={(c) => c.campaign}
            initialSort={{key: "name", dir: "asc"}}
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

      <ReferredCampaigns campaigns={campaigns} isLoading={isLoading} />
    </div>
  );
}

function Header() {
  return (
    <header>
      <h1 className="font-display text-2xl text-ink">My Campaigns</h1>
      <p className="mt-0.5 text-xs text-ink-muted">
        Campaigns you created. Click one to <b>Fund, Activate, Pause, End, or Reclaim Unspent Escrow</b>{" "}
        funds. Campaigns a promoter referred you to are listed below them.
      </p>
    </header>
  );
}

function buildColumns(tokens: Record<string, TokenMeta>, now: number): Column<CampaignView>[] {
  const meta = (c: CampaignView) => tokens[c.token.toLowerCase()] ?? {symbol: "", decimals: 18};

  return [
    {
      key: "name",
      header: "Campaign",
      // Sorts on the displayed title. Unnamed rows sort together under "Campaign #".
      sortValue: (c) => (hasProjectName(c) ? projectName(c) : `Campaign #${c.campaignId}`),
      render: (c) => (
        <span className="inline-flex items-center gap-2">
          <Link href={`/campaign/${c.campaignId}`} className="font-medium text-ink hover:underline">
            {hasProjectName(c) ? projectName(c) : `Campaign #${c.campaignId.toString()}`}
          </Link>
          {/* The owner's own operations page, where the id is the handle every script and
              explorer link uses — so it is shown rather than revealed. */}
          {hasProjectName(c) ? (
            <span className="tnum text-xs text-ink-muted">#{c.campaignId.toString()}</span>
          ) : null}
        </span>
      ),
    },
    {
      key: "project",
      header: "Project",
      // Every row is the connected wallet's own campaign, so this repeats one address down the
      // table. First to go on a phone.
      hideOnMobile: true,
      sortValue: (c) => c.project.toLowerCase(),
      render: (c) => <span className="text-ink-muted">{shortAddress(c.project)}</span>,
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
