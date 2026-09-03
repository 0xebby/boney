"use client";

import {useMemo} from "react";
import Link from "next/link";
import {useReferredCampaigns} from "@/hooks/useReferredCampaigns";
import {useNow} from "@/hooks/useNow";
import {DataTable, type Column} from "@/components/ui/DataTable";
import {StatusPill} from "@/components/ui/StatusPill";
import {Card, CardHeader} from "@/components/ui/Card";
import {EmptyState, ErrorState, SkeletonRows} from "@/components/ui/States";
import {projectName, hasProjectName} from "@/lib/projects";
import {classifyTouch, sortReferrals, type ReferredCampaign} from "@/lib/referrals";
import {formatTimeUntil, shortAddress} from "@/lib/format";
import type {CampaignView} from "@/lib/types";

/**
 * The campaigns this wallet was referred to — the attributions it signed through somebody's link.
 *
 * Shown to every connected wallet rather than to promoters only. Signing a Touch takes no
 * membership, so a wallet whose whole history is "I followed a link once" is exactly the reader with
 * nowhere else to learn who it is attributed to and for how long.
 *
 * Rendered even when empty: "nobody has referred you" answers the question the card asks.
 *
 * @param campaigns Marketplace campaigns to look for attributions across.
 * @param isLoading Whether that marketplace list is still loading.
 * @returns The referrals card.
 */
export function ReferredCampaigns({
  campaigns,
  isLoading,
}: {
  campaigns: readonly CampaignView[];
  isLoading: boolean;
}) {
  const referredQuery = useReferredCampaigns(campaigns);
  const now = useNow();

  const rows = useMemo(
    () => sortReferrals(referredQuery.referred, now),
    [referredQuery.referred, now],
  );
  const columns = useMemo(() => buildReferredColumns(now), [now]);

  return (
    <Card padded={false}>
      <div className="px-4 pt-4">
        <CardHeader
          title="Campaigns you were referred to"
          subtitle="Attributions you signed through a promoter's boneylink"
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
          rows={rows}
          columns={columns}
          rowKey={(r) => r.view.campaign}
          isRefreshing={referredQuery.isRefreshing}
          emptyState={
            <EmptyState
              title="No referrals yet"
              description="When you follow a promoter's boneylink and confirm the attribution, the campaign shows up here."
            />
          }
        />
      )}
    </Card>
  );
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
      key: "name",
      header: "Campaign",
      // Sorts on the displayed title. Unnamed rows sort together under "Campaign #".
      sortValue: (r) =>
        hasProjectName(r.view) ? projectName(r.view) : `Campaign #${r.view.campaignId}`,
      render: (r) => (
        <span className="inline-flex items-center gap-2">
          <Link
            href={`/campaign/${r.view.campaignId}`}
            className="font-medium text-ink hover:underline"
          >
            {hasProjectName(r.view)
              ? projectName(r.view)
              : `Campaign #${r.view.campaignId.toString()}`}
          </Link>
          {hasProjectName(r.view) ? (
            <span className="tnum text-xs text-ink-muted">#{r.view.campaignId.toString()}</span>
          ) : null}
        </span>
      ),
    },
    {
      key: "project",
      header: "Project",
      // The project wallet — the title beside it names the campaign, not the project.
      hideOnMobile: true,
      sortValue: (r) => r.view.project.toLowerCase(),
      render: (r) => <span className="text-ink-muted">{shortAddress(r.view.project)}</span>,
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
