"use client";

import {useMemo, useState} from "react";
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
import {KolDirectory} from "@/components/KolDirectory";
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
  const {isConnected} = useAccount();
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
          title="Boneyard is not available on this network"
          description="Switch your wallet to a supported network to see campaigns."
        />
      </Card>
    );
  }

  if (!isConnected) {
    return (
      <div className="space-y-5">
        <Header connected={false} />
        <KolDirectory
          campaigns={campaigns}
          tokens={tokens}
          isLoading={isLoading}
          error={error}
          onRetry={() => refetch()}
        />
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

/**
 * The heading says different things to different visitors: a connected promoter is looking at
 * their own memberships, an anonymous one is browsing everybody's.
 */
function Header({connected = true}: {connected?: boolean}) {
  return (
    <header>
      <h1 className="font-display text-2xl text-ink">
        {connected ? "KOL dashboard" : "KOLs"}
      </h1>
      <p className="mt-0.5 text-xs text-ink-muted">
        {connected
          ? "Campaigns you joined. Open one to see progress, claim rewards, and copy your tracking link."
          : "Promoters active on each campaign, and the links they share. Connect a wallet to join and get your own."}
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
      render: (r) => <CopyLinkButton link={r.link} />,
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

/**
 * Copy-to-clipboard for a tracking link, with the confirmation the bare `writeText` call lacked.
 *
 * Copying is invisible by nature — nothing on screen changes — so without feedback the only way
 * to know it worked is to paste somewhere and check. This is its own component rather than
 * inline JSX because it owns state, and `buildColumns` is a pure function called from a `useMemo`.
 *
 * The failure path matters as much as the success one. `navigator.clipboard` is permission-gated
 * and absent over plain http on some browsers, and an unhandled rejection there would leave the
 * user believing they had copied a link they had not. So the promise is caught and the button
 * says so, mirroring `PromoterPanel`.
 */
function CopyLinkButton({link}: {link: string}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  const copy = async (e: React.MouseEvent) => {
    // The row is itself clickable; copying must not also navigate.
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(link);
      setState("copied");
    } catch {
      setState("failed");
    }
    setTimeout(() => setState("idle"), 2_000);
  };

  return (
    <button
      type="button"
      onClick={copy}
      className={`flex items-center gap-1.5 rounded border px-2 py-1 text-xs transition-colors ${
        state === "copied"
          ? "border-good/40 text-good"
          : state === "failed"
            ? "border-critical/40 text-critical"
            : "border-hairline text-ink-secondary hover:bg-surface-hover hover:text-ink"
      }`}
      title={state === "failed" ? link : "Copy tracking link"}
    >
      <span aria-hidden className="text-[10px]">
        {state === "copied" ? "✓" : state === "failed" ? "!" : "⎘"}
      </span>
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy link"}
      {/* Announced to screen readers, which see no color change. */}
      <span role="status" aria-live="polite" className="sr-only">
        {state === "copied" ? "Tracking link copied" : state === "failed" ? "Copy failed" : ""}
      </span>
    </button>
  );
}
