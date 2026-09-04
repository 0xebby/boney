"use client";

import Link from "next/link";
import {Card, CardHeader} from "@/components/ui/Card";
import {Figure} from "@/components/ui/StatTile";
import {ErrorState} from "@/components/ui/States";
import {useCampaignPromoters} from "@/hooks/useCampaignPromoters";
import {countPromoters, countDistinctPromoters} from "@/lib/promoters";
import {collectPromoters, summarize, ALL_CAMPAIGNS} from "@/lib/discovery";
import {rankOf} from "@/lib/ranks";
import {compactNumber} from "@/lib/format";
import type {CampaignView} from "@/lib/types";

/**
 * Who is already promoting on Boneyard, as four figures beside the campaign overview.
 *
 * Every number comes from the same read `/discover` uses, under the same query key, so arriving
 * here and then browsing the directory costs one scan rather than two. The scores are the ones
 * recorded at the start and are labelled that way — `lib/discovery` explains why they drift.
 */

/**
 * @param campaigns The marketplace's campaigns. Empty until they load, which is what defers the
 *   promoter scan — the hook stays disabled while the list is empty.
 */
export function PromotersSummary({campaigns}: {campaigns: readonly CampaignView[]}) {
  const {groups, scannedFrom, truncated, isLoading, error, refetch} =
    useCampaignPromoters(campaigns);

  const promoters = collectPromoters(groups, ALL_CAMPAIGNS);
  const stats = summarize(promoters);
  const memberships = countPromoters(groups);
  const distinct = countDistinctPromoters(groups);

  return (
    <Card>
      <CardHeader
        title="Discover promoters"
        action={
          <Link href="/discover" className="shrink-0 text-xs font-medium text-brand hover:underline">
            Browse promoters →
          </Link>
        }
      />

      {error ? (
        <ErrorState message={String(error)} onRetry={() => refetch()} />
      ) : isLoading || campaigns.length === 0 ? (
        <FigureSkeleton />
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:gap-5">
          <Figure
            label="Promoters"
            value={compactNumber(distinct)}
            hint="Distinct wallets"
          />
          <Figure
            label="Promotions"
            value={compactNumber(memberships)}
            hint="Campaign memberships"
          />
          <Figure label="Median starting score" value={compactNumber(stats.medianScore)} />
          <Figure
            label="Top starting score"
            value={compactNumber(stats.topScore)}
            hint={stats.count > 0 ? rankOf(stats.topScore).name : undefined}
          />
        </div>
      )}

      {truncated ? (
        <p className="mt-4 rounded-md border border-hairline bg-surface-1 px-3 py-2 text-xs text-ink-muted">
          More memberships exist than one read returns, so these figures cover a floor rather than
          every promoter on the network.
        </p>
      ) : scannedFrom !== undefined ? (
        <p className="mt-4 rounded-md border border-hairline bg-surface-1 px-3 py-2 text-xs text-ink-muted">
          Counted from block {scannedFrom.toString()} onward. Promoters who joined earlier are not
          included — this chain&rsquo;s history is longer than one scan can cover.
        </p>
      ) : null}
    </Card>
  );
}

/** Placeholder in the figure grid's shape, so the card does not resize when the scan lands. */
function FigureSkeleton() {
  return (
    <div className="grid animate-pulse grid-cols-2 gap-4 sm:gap-5" aria-hidden>
      {Array.from({length: 4}).map((_, i) => (
        <div key={i} className="flex flex-col gap-2">
          <div className="h-3 w-20 rounded bg-surface-2" />
          <div className="h-7 w-16 rounded bg-surface-2 sm:h-8" />
        </div>
      ))}
    </div>
  );
}
