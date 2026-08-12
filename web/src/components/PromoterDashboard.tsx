"use client";

import {useMemo, useState} from "react";
import Link from "next/link";
import {useAccount} from "wagmi";
import {useCampaigns} from "@/hooks/useCampaigns";
import type {TokenMeta} from "@/lib/token";
import {useJoinedCampaigns} from "@/hooks/useJoinedCampaigns";
import {useReferredCampaigns} from "@/hooks/useReferredCampaigns";
import {useNow} from "@/hooks/useNow";
import {DataTable, type Column} from "@/components/ui/DataTable";
import {StatTile, StatRow} from "@/components/ui/StatTile";
import {StatusPill} from "@/components/ui/StatusPill";
import {Card, CardHeader} from "@/components/ui/Card";
import {EmptyState, ErrorState, SkeletonRows} from "@/components/ui/States";
import {PromoterDirectory} from "@/components/PromoterDirectory";
import {trackingLink} from "@/lib/promoter";
import { projectName, hasProjectName } from "@/lib/projects";
import {
  classifyTouch,
  sortReferrals,
  countLive,
  type ReferredCampaign,
} from "@/lib/referrals";
import {formatTokenAmount, formatTimeUntil, shortAddress} from "@/lib/format";
import type {CampaignView} from "@/lib/types";

type JoinedRow = {
  view: CampaignView;
  promoterId: `0x${string}`;
  link: string;
};

/**
 * `/promoters` — promoter dashboard.
 *
 * Two roles, two tables. A wallet can hold both at once and they are genuinely different
 * relationships, so neither is folded into the other:
 *
 *  - **Campaigns you promote** — memberships from `join()`, each with a tracking link to share.
 *  - **Campaigns you were referred to** — campaigns where *this* wallet signed a Touch through
 *    somebody else's link. The attribution is what credits that promoter when this wallet acts,
 *    so it is worth being able to see, and until now nothing in the app read it back.
 *
 * A wallet with no memberships still sees the referral table (and vice versa); each carries its own
 * empty state rather than the page hiding one behind the other.
 *
 * The dashboard does not total what each membership has paid — that requires one campaign-detail
 * read per membership to retrieve tier ladders and progress, which is better done on the detail
 * page where the full breakdown is useful. The summary here shows pool, status, and time remaining,
 * which are already present in the `CampaignView` the marketplace fetched.
 */
export function PromoterDashboard() {
  const {isConnected} = useAccount();
  const {campaigns, tokens, isLoading, error, refetch, deployed} = useCampaigns();
  const joinedQuery = useJoinedCampaigns(campaigns);
  const referredQuery = useReferredCampaigns(campaigns);
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

  const referredRows = useMemo(
    () => sortReferrals(referredQuery.referred, now),
    [referredQuery.referred, now],
  );

  const activeCount = useMemo(
    () => rows.filter((r) => r.view.status === "Active").length,
    [rows],
  );

  const liveReferrals = useMemo(
    () => countLive(referredQuery.referred, now),
    [referredQuery.referred, now],
  );

  const columns = useMemo(() => buildColumns(tokens, now), [tokens, now]);
  const referredColumns = useMemo(() => buildReferredColumns(now), [now]);

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
        <PromoterDirectory
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
          label="Campaigns Joined"
          value={rows.length.toLocaleString("en-US")}
          hint={`${activeCount} active`}
        />
        <StatTile
          label="Promotion links"
          value={rows.length.toLocaleString("en-US")}
          hint="(one per campaign)"
        />
        <StatTile
          label="Referred to"
          value={referredRows.length.toLocaleString("en-US")}
          hint={`${liveReferrals} still crediting`}
         // accent="var(--series-3)"
        />
      </StatRow>

      <Card padded={false}>
        {/* `Card` drops its padding so the table can run edge to edge; the header puts its own
            back, matching how `PromoterDirectory` pads content inside an unpadded card. */}
        <div className="px-4 pt-4">
          <CardHeader
            title="Campaigns you promote"
            subtitle="Campaigns you joined, and the promotion link to share for each"
          />
        </div>
        {isLoading || joinedQuery.isLoading ? (
          <SkeletonRows rows={3} cols={6} />
        ) : error ? (
          <ErrorState message={String(error)} onRetry={() => refetch()} />
        ) : joinedQuery.error ? (
          <ErrorState message={String(joinedQuery.error)} onRetry={() => joinedQuery.refetch()} />
        ) : (
          <DataTable
            rows={rows}
            columns={columns}
            rowKey={(r) => r.view.campaign}
                  initialSort={{ key: "id", dir: "asc" }}
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
                    Browse boneyard
                  </Link>
                }
              />
            }
          />
        )}
      </Card>

      {/*
        Referrals — campaigns somebody else's link brought this wallet to. Rendered even when
        empty, because "nobody has referred you" is a fair answer to a question the page now
        invites, and hiding the table would make the stat tile above point at nothing.
      */}
      <Card padded={false}>
        <div className="px-4 pt-4">
          <CardHeader
            title="Campaigns you were referred to"
            subtitle="Attributions you signed through a promoter's link"
          />
        </div>
        {isLoading || referredQuery.isLoading ? (
          <SkeletonRows rows={2} cols={5} />
        ) : referredQuery.error ? (
          <ErrorState
            message={String(referredQuery.error)}
            onRetry={() => referredQuery.refetch()}
          />
        ) : (
          <DataTable
            rows={referredRows}
            columns={referredColumns}
            rowKey={(r) => r.view.campaign}
            isRefreshing={referredQuery.isRefreshing}
            emptyState={
              <EmptyState
                title="No referrals yet"
                description="When you follow a promoter's tracking link and confirm the attribution, the campaign shows up here."
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
        {connected ? "Promoter dashboard" : "Promoters"}
      </h1>
      <p className="mt-0.5 text-xs text-ink-muted">
        {connected
          ? "Campaigns you joined. Open one to see progress, what it has paid you, and your tracking link."
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
      key: "project",
      header: "Project",
      sortValue: (r) => projectName(r.view),
      render: (r) =>
        hasProjectName(r.view) ? (
          <span className="text-ink-secondary">{projectName(r.view)}</span>
        ) : (
          <span className="font-normal text-ink-muted">{shortAddress(r.view.project)}</span>
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
 * Columns for the referral table.
 *
 * Takes no `tokens`: a referral is not being paid from this escrow, so a reward pool would be
 * noise. What matters instead is who referred them and whether the attribution is still crediting
 * that person — the two facts nothing in the app surfaced before.
 *
 * Sorted by the hook (`sortReferrals`: live first, then most recent) rather than by `initialSort`,
 * because the ordering depends on the clock and `DataTable`'s sort state is per-column.
 */
function buildReferredColumns(now: number): Column<ReferredCampaign>[] {
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
      key: "project",
      header: "Project",
      sortValue: (r) => projectName(r.view),
      render: (r) =>
        hasProjectName(r.view) ? (
          <span className="text-ink-secondary">{projectName(r.view)}</span>
        ) : (
          <span className="font-normal text-ink-muted">{shortAddress(r.view.project)}</span>
        ),
    },
    {
      key: "status",
      header: "Status",
      hideOnMobile: true,
      sortValue: (r) => r.view.status,
      render: (r) => <StatusPill status={r.view.status} />,
    },
    {
      key: "promoter",
      header: "Referred by",
      sortValue: (r) => r.promoter ?? r.promoterId,
      render: (r) =>
        // The wallet when `promoterOf` resolved, the opaque id when it did not — the attribution
        // is real either way, so the row shows what it has rather than an em dash.
        r.promoter ? (
          <span className="text-ink-secondary">{shortAddress(r.promoter)}</span>
        ) : (
          <span className="font-mono text-[11px] text-ink-muted">
            {shortAddress(r.promoterId, 8, 6)}
          </span>
        ),
    },
    {
      key: "attribution",
      header: "Attribution",
      numeric: true,
      sortValue: (r) => r.expiresAt,
      render: (r) => {
        // Same first-paint rule as every other clock-dependent cell: `useNow` reports 0 until
        // hydration, and "expired" is the one thing that must not flash.
        if (now === 0) return <span className="text-ink-muted">—</span>;

        return classifyTouch(r, now) === "live" ? (
          <span className="text-good">{formatTimeUntil(r.expiresAt, now)} left</span>
        ) : (
          <span className="text-ink-muted">Expired</span>
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
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy Promotion link"}
      {/* Announced to screen readers, which see no color change. */}
      <span role="status" aria-live="polite" className="sr-only">
        {state === "copied" ? "Tracking link copied" : state === "failed" ? "Copy failed" : ""}
      </span>
    </button>
  );
}
