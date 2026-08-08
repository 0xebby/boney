"use client";

import {useMemo, useState} from "react";
import Link from "next/link";
import {useCampaignPromoters} from "@/hooks/useCampaignPromoters";
import {Card, CardHeader} from "@/components/ui/Card";
import {StatTile, StatRow} from "@/components/ui/StatTile";
import {StatusPill} from "@/components/ui/StatusPill";
import {RankBadge} from "@/components/ui/RankBadge";
import {EmptyState, ErrorState, SkeletonRows} from "@/components/ui/States";
import {shortAddress} from "@/lib/format";
import {PURE_REACH_CEILING, type Rank} from "@/lib/ranks";
import {
  collectPromoters,
  filterPromoters,
  toggleRank,
  summarize,
  ALL_CAMPAIGNS,
  type RankedPromoter,
} from "@/lib/discovery";
import type {CampaignView} from "@/lib/types";

/**
 * `/discover` — browse promoters by BoneyScore rank.
 *
 * The promoter directory answers "who is promoting what". This answers the question a project asks
 * before funding a campaign: "who could I get, and how good are they". Same underlying scan
 * (`useCampaignPromoters`), different axis — ranked and filterable rather than grouped by campaign.
 *
 * Two honesty constraints shape the whole page:
 *
 *  - **Scores here are snapshots.** `PromoterJoined.reputation` is what the promoter scored at join
 *    time, and attestations expire. Every score is labelled "at join"
 *  a project choosing promoters off a stale number should know
 *    it is
 *    stale. Reading current scores would cost one `scoreOf` call per wallet.
 *  - **Rank is not endorsement.** Ranks at or below the pure-reach ceiling are reachable on
 *    follower count alone, so those rows carry a marker rather than being quietly listed alongside
 *    ranks that required real credibility.
 */
export function DiscoverPage({
  campaigns,
  isLoading,
  error,
  onRetry,
}: {
  campaigns: readonly CampaignView[];
  isLoading: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  const directory = useCampaignPromoters(campaigns);
  const [campaign, setCampaign] = useState<string>(ALL_CAMPAIGNS);
  const [ranks, setRanks] = useState<string[]>([]);

  const all = useMemo(
    () => collectPromoters(directory.groups, campaign),
    [directory.groups, campaign],
  );
  const shown = useMemo(() => filterPromoters(all, {ranks, minScore: 0}), [all, ranks]);

  const summary = useMemo(() => summarize(all), [all]);

  const busy = isLoading || directory.isLoading;
  const withPromoters = directory.groups.filter((g) => g.promoters.length > 0);

  if (error) {
    return (
      <Card>
        <ErrorState message={String(error)} onRetry={onRetry} />
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      <header>
        <h1 className="font-display text-2xl text-ink">Discover promoters</h1>
        <p className="mt-0.5 text-xs text-ink-muted">
          Browse promoters by BoneyScore rank. Scores are as recorded when each promoter joined.
        </p>
      </header>

      <StatRow>
        <StatTile
          label="Promoters"
          value={busy ? "—" : summary.count.toLocaleString("en-US")}
          hint={campaign === ALL_CAMPAIGNS ? "distinct wallets" : "in this campaign"}
        />
        <StatTile
          label="Top BoneyScore"
          value={busy ? "—" : summary.topScore.toLocaleString("en-US")}
          hint="at join"
        />
        <StatTile
          label="Median"
          value={busy ? "—" : summary.medianScore.toLocaleString("en-US")}
          hint="typical promoter"
        />
        <StatTile
          label="Campaigns"
          value={busy ? "—" : withPromoters.length.toLocaleString("en-US")}
          hint="with promoters"
        />
      </StatRow>

      <Card padded={false}>
        <CardHeader title="Filters" subtitle="Pick a campaign, then narrow by rank" />
        <div className="space-y-3 p-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="campaign-select" className="text-xs text-ink-muted">
              Campaign
            </label>
            <select
              id="campaign-select"
              value={campaign}
              onChange={(e) => setCampaign(e.target.value)}
              className="w-full max-w-md rounded-md border border-hairline bg-surface-1 px-3 py-2 text-[13px] text-ink"
            >
              <option value={ALL_CAMPAIGNS}>All campaigns</option>
              {withPromoters.map((g) => (
                <option key={g.view.campaign} value={g.view.campaign}>
                  Campaign #{g.view.campaignId.toString()} — {g.promoters.length} promoter
                  {g.promoters.length === 1 ? "" : "s"}
                </option>
              ))}
            </select>
          </div>

          <RankFilter
            selected={ranks}
            counts={summary.distribution}
            onToggle={(id) => setRanks((prev) => toggleRank(prev, id))}
            onClear={() => setRanks([])}
          />
        </div>
      </Card>

      {directory.scannedFrom !== undefined ? (
        <p className="rounded-md border border-hairline bg-surface-1 px-3 py-2 text-xs text-ink-muted">
          Showing joins from block {directory.scannedFrom.toString()} onward. Promoters who joined
          earlier are not listed — this chain&rsquo;s history is longer than one scan can cover.
        </p>
      ) : null}

      {busy ? (
        <Card padded={false}>
          <SkeletonRows rows={5} cols={4} />
        </Card>
      ) : shown.length === 0 ? (
        <Card>
          <EmptyState
            title={all.length === 0 ? "No promoters yet" : "No promoters at these ranks"}
            description={
              all.length === 0
                ? "Once promoters join a campaign on this network they appear here, ranked by BoneyScore."
                : "Every promoter in this campaign sits outside the ranks you selected."
            }
            action={
              ranks.length > 0 ? (
                <button
                  type="button"
                  onClick={() => setRanks([])}
                  className="rounded-md border border-hairline-strong px-3 py-1.5 text-xs font-medium text-ink hover:bg-surface-hover"
                >
                  Clear rank filter
                </button>
              ) : (
                <Link
                  href="/"
                  className="rounded-md border border-hairline-strong px-3 py-1.5 text-xs font-medium text-ink hover:bg-surface-hover"
                >
                  Browse campaigns
                </Link>
              )
            }
          />
        </Card>
      ) : (
        <PromoterTable rows={shown} campaigns={campaigns} />
      )}

      <p className="text-xs text-ink-muted">
        <Link href="/docs" className="text-brand hover:underline">
          <Term>How Ranks work</Term>
        </Link>
        .
      </p>
    </div>
  );
}

/** Rank chips, each carrying its own population so an empty filter is visible before it is used. */
function RankFilter({
  selected,
  counts,
  onToggle,
  onClear,
}: {
  selected: string[];
  counts: {rank: Rank; count: number}[];
  onToggle: (id: string) => void;
  onClear: () => void;
}) {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <legend className="text-xs text-ink-muted">Rank</legend>
        {selected.length > 0 ? (
          <button
            type="button"
            onClick={onClear}
            className="text-xs text-ink-secondary hover:text-ink hover:underline"
          >
            Clear
          </button>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {counts.map(({rank, count}) => {
          const active = selected.includes(rank.id);
          return (
            <button
              key={rank.id}
              type="button"
              onClick={() => onToggle(rank.id)}
              aria-pressed={active}
              title={rank.blurb}
              className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors ${
                active
                  ? "border-brand bg-brand/10 text-ink"
                  : "border-hairline text-ink-secondary hover:bg-surface-hover hover:text-ink"
              }`}
            >
              <span className="font-medium">{rank.name}</span>
              <span className="tnum text-ink-muted">{count}</span>
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

function PromoterTable({
  rows,
  campaigns,
}: {
  rows: readonly RankedPromoter[];
  campaigns: readonly CampaignView[];
}) {
  const campaignId = (address: string) =>
    campaigns.find((c) => c.campaign.toLowerCase() === address.toLowerCase())?.campaignId;
  const statusOf = (address: string) =>
    campaigns.find((c) => c.campaign.toLowerCase() === address.toLowerCase())?.status;

  return (
    <Card padded={false}>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-hairline">
              <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-ink-muted">
                Promoter
              </th>
              <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-ink-muted">
                Rank
              </th>
              <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-ink-muted">
                BoneyScore
                <span className="sr-only"> at join</span>
              </th>
              <th
                scope="col"
                className="hidden px-3 py-2 text-left text-xs font-medium text-ink-muted md:table-cell"
              >
                Campaign
              </th>
              <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-ink-muted">
                <span className="sr-only">Tracking link</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const id = campaignId(row.entry.campaign);
              const status = statusOf(row.entry.campaign);
              return (
                <tr
                  key={`${row.entry.campaign}:${row.entry.promoter}`}
                  className="border-b border-hairline last:border-0"
                >
                  <td className="px-3 py-2.5 font-mono text-[13px] text-ink">
                    {shortAddress(row.entry.promoter)}
                  </td>
                  <td className="px-3 py-2.5">
                    <RankBadge rank={row.rank} />
                  </td>
                  <td className="tnum px-3 py-2.5 text-right text-ink">
                    {row.scoreAtJoin.toLocaleString("en-US")}
                  </td>
                  <td className="hidden px-3 py-2.5 md:table-cell">
                    {id === undefined ? (
                      <span className="text-ink-muted">—</span>
                    ) : (
                      <span className="flex items-center gap-2">
                        <Link
                          href={`/campaign/${id}`}
                          className="text-ink-secondary hover:text-ink hover:underline"
                        >
                          #{id.toString()}
                        </Link>
                        {status ? <StatusPill status={status} /> : null}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <VisitLink campaign={row.entry.campaign} promoterId={row.entry.promoterId} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/**
 * The promoter's tracking link, as a same-origin path.
 *
 * `trackingLink` builds the absolute URL a promoter shares, which needs an origin and so cannot be
 * built during the server render. In-app navigation needs no origin, so this stays relative and
 * renders identically on both passes.
 */
function VisitLink({campaign, promoterId}: {campaign: `0x${string}`; promoterId: `0x${string}`}) {
  const params = new URLSearchParams({c: campaign, p: promoterId});
  return (
    <Link
      href={`/r?${params.toString()}`}
      className="rounded border border-hairline-strong px-2 py-1 text-xs font-medium text-ink transition-colors hover:bg-surface-hover"
    >
      Visit
    </Link>
  );
}


function Term({ children }: { children: React.ReactNode }) {
  return <span className="font-medium text-ink">{children}</span>;
}