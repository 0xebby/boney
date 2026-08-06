"use client";

import {useMemo} from "react";
import Link from "next/link";
import {useAccount} from "wagmi";
import {useCampaigns, type TokenMeta} from "@/hooks/useCampaigns";
import {useJoinedCampaigns} from "@/hooks/useJoinedCampaigns";
import {useNow} from "@/hooks/useNow";
import {DataTable, type Column} from "@/components/ui/DataTable";
import {StatTile, StatRow} from "@/components/ui/StatTile";
import {StatusPill} from "@/components/ui/StatusPill";
import {Card} from "@/components/ui/Card";
import {EmptyState, ErrorState, SkeletonRows} from "@/components/ui/States";
import {trackingLink} from "@/lib/kol";
import {formatTokenAmount, formatTimeUntil, shortAddress} from "@/lib/format";
import type {CampaignView} from "@/lib/types";

type JoinedRow = {
  view: CampaignView;
  promoterId: `0x${string}`;
  link: string;
};

/**
 * `/kol` — promoter dashboard.
 *
 * Shows campaigns the connected wallet has joined, plus their tracking links. This is the KOL's
 * landing page: earned rewards, active campaigns, and links to share. A "Join more" button routes
 * to the marketplace with the "Joinable by me" filter already set.
 *
 * The dashboard does not compute `earned` or `claimable` — that requires one campaign-detail read
 * per membership to retrieve tier ladders and progress, which is better done on the detail page
 * where the full breakdown is useful. The summary here shows pool, status, and time remaining,
 * which are already present in the `CampaignView` the marketplace fetched.
 */
export function KolPage() {
  const {address, isConnected} = useAccount();
  const {campaigns, tokens, isLoading, error, refetch, deployed} = useCampaigns();
  const joinedQuery = useJoinedCampaigns(campaigns);
  const now = useNow();

  const rows = useMemo((): JoinedRow[] => {
    if (typeof window === "undefined") return [];
    const origin = window.location.origin;
    return joinedQuery.joined.map(({view, promoterId}) => ({
      view,
      promoterId,
      link: trackingLink(origin, view.campaign, promoterId),
    }));
  }, [joinedQuery.joined]);

  const activeCount = useMemo(
    () => rows.filter((r) => r.view.status === "Active").length,
    [rows],
  );

  const columns = useMemo(() => buildColumns(tokens, now), [tokens, now]);

  if (!deployed) {
    return (
      <Card>
        <EmptyState
          title="Protocol not deployed on this network"
          description="Switch to a network with a Boney deployment, or run a local anvil chain and deploy with script/DeployBoney.s.sol."
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
            description="Join campaigns to earn performance-based rewards. Connect to see your memberships and tracking links."
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
          label="Joined campaigns"
          value={rows.length.toLocaleString("en-US")}
          hint={`${activeCount} active`}
        />
        <StatTile
          label="Tracking links"
          value={rows.length.toLocaleString("en-US")}
          hint="one per campaign"
        />
      </StatRow>

      <Card padded={false}>
        {isLoading || joinedQuery.isLoading ? (
          <SkeletonRows rows={3} cols={5} />
        ) : error ? (
          <ErrorState message={String(error)} onRetry={() => refetch()} />
        ) : joinedQuery.error ? (
          <ErrorState message={String(joinedQuery.error)} onRetry={() => joinedQuery.refetch()} />
        ) : (
          <DataTable
            rows={rows}
            columns={columns}
            rowKey={(r) => r.view.campaign}
            initialSort={{key: "id", dir: "desc"}}
            isRefreshing={joinedQuery.isRefreshing}
            emptyState={
              <EmptyState
                title="No memberships yet"
                description="Browse the boneyard and join campaigns that match your audience. Each membership gives you a tracking link to share."
                action={
                  <Link
                    href="/"
                    className="rounded-md border border-hairline-strong px-3 py-1.5 text-xs font-medium text-ink hover:bg-surface-hover"
                  >
                    Browse the boneyard
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
      <h1 className="text-lg font-semibold text-ink">KOL dashboard</h1>
      <p className="mt-0.5 text-xs text-ink-muted">
        Campaigns you joined. Open one to see progress, claim rewards, and copy your tracking link.
      </p>
    </header>
  );
}

function buildColumns(tokens: Record<string, TokenMeta>, now: number): Column<JoinedRow>[] {
  const meta = (r: JoinedRow) =>
    tokens[r.view.token.toLowerCase()] ?? {symbol: "", decimals: 18};

  return [
    {
      key: "id",
      header: "Campaign",
      sortValue: (r) => r.view.campaignId,
      render: (r) => (
        <Link
          href={`/campaign/${r.view.campaignId}`}
          className="font-medium text-ink hover:underline"
        >
          #{r.view.campaignId.toString()}
          <span className="ml-2 font-normal text-ink-muted">{shortAddress(r.view.campaign)}</span>
        </Link>
      ),
    },
    {
      key: "status",
      header: "Status",
      sortValue: (r) => r.view.status,
      render: (r) => <StatusPill status={r.view.status} />,
    },
    {
      key: "pool",
      header: "Reward pool",
      numeric: true,
      hideOnMobile: true,
      sortValue: (r) => r.view.rewardPool,
      render: (r) => {
        const m = meta(r);
        return (
          <span>
            {formatTokenAmount(r.view.rewardPool, m.decimals, {compact: true})}{" "}
            <span className="text-ink-muted">{m.symbol}</span>
          </span>
        );
      },
    },
    {
      key: "link",
      header: "Tracking link",
      sortValue: () => 0,
      render: (r) => (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            navigator.clipboard.writeText(r.link);
          }}
          className="flex items-center gap-1.5 rounded border border-hairline px-2 py-1 text-xs text-ink-secondary hover:bg-surface-hover hover:text-ink"
          title="Copy tracking link"
        >
          <span aria-hidden className="text-[10px]">
            ⎘
          </span>
          Copy link
        </button>
      ),
    },
    {
      key: "ends",
      header: "Ends in",
      numeric: true,
      sortValue: (r) => r.view.endTime,
      render: (r) => {
        if (now === 0) return <span className="text-ink-muted">—</span>;
        return (
          <span className={Number(r.view.endTime) <= now ? "text-ink-muted" : undefined}>
            {formatTimeUntil(r.view.endTime, now)}
          </span>
        );
      },
    },
  ];
}
