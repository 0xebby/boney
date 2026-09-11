"use client";

import {useMemo, useState} from "react";
import Link from "next/link";
import {useRouter} from "next/navigation";
import {useAccount} from "wagmi";
import {useCampaigns, useReputation} from "@/hooks/useCampaigns";
import {useCampaignKpiSpecs} from "@/hooks/useCampaignKpiSpecs";
import {useCampaignGuides} from "@/hooks/useCampaignGuides";
import {type TokenMeta} from "@/lib/token";
import {poolValue} from "@/lib/poolValue";
import {useJoinedCampaigns} from "@/hooks/useJoinedCampaigns";
import {useNow} from "@/hooks/useNow";
import {DataTable, type Column} from "@/components/ui/DataTable";
import {Figure} from "@/components/ui/StatTile";
import {StatusPill} from "@/components/ui/StatusPill";
import {JoinedBadge} from "@/components/ui/JoinedBadge";
import {Meter} from "@/components/ui/Meter";
import {Card} from "@/components/ui/Card";
import {ButtonLink} from "@/components/ui/Button";
import {JoinCampaignMenu} from "@/components/ui/JoinCampaignMenu";
import {CampaignFilters as CampaignFilterControls} from "@/components/CampaignFilters";
import {LeaderboardTeaser} from "@/components/LeaderboardTeaser";
import {EmptyState, ErrorState, SkeletonRows} from "@/components/ui/States";
import {
  filterCampaigns,
  summarize,
  EMPTY_FILTERS,
  type CampaignFilters,
} from "@/lib/filters";
import {joinOptions} from "@/lib/joinPicker";
import {utilization} from "@/lib/campaign";
import {summarizeKinds} from "@/lib/kpiSummary";
import {projectName, hasProjectName} from "@/lib/projects";
import type {ResolvedGuide} from "@/lib/campaignGuide";
import {formatTokenAmount, formatPercent, formatTimeUntil, formatUsd} from "@/lib/format";
import type {CampaignView, KpiSpec} from "@/lib/types";

export function CampaignsPage() {
  const {campaigns, tokens, isLoading, isRefreshing, error, refetch, deployed, chainId} =
    useCampaigns();
  const {reputation} = useReputation();
  const {isConnected} = useAccount();
  const router = useRouter();
  const [filters, setFilters] = useState<CampaignFilters>(EMPTY_FILTERS);

  /*
    What each campaign measures, for the KPI column.

    One read per KPI across the page, fetched once and never polled — see `useCampaignKpiSpecs` for
    why a `KpiSpec` cannot change under a reader. Keyed on the campaign set rather than the list
    object, so `useCampaigns`' 30s poll does not drag this along with it.
  */
  const {specs: kpiSpecs, dropped: kpiSpecsDropped} = useCampaignKpiSpecs(campaigns);

  /*
    What each campaign is *for*, in the project's own words. The committed catalog is in the bundle,
    so a row that has an entry reads immediately; a project-published guide arrives a moment later
    and lands in the same cache the campaign page reads.
  */
  const guides = useCampaignGuides(useMemo(() => campaigns.map((c) => c.campaign), [campaigns]));

  /*
    Which of these the connected wallet has already joined.

    Costs nothing extra here: `AppShell` runs this exact query on every route through
    `useIsPromoter`, and both go through the same `useCampaigns` key, so this is a third observer
    of one cache entry rather than a second fan-out. It returns an empty list with no wallet
    connected, so a disconnected visitor issues no reads and sees no markers.
  */
  const {joined, refetch: refetchJoined} = useJoinedCampaigns(campaigns);

  // Lowercased so a checksummed address from one source still matches a lowercase one from
  // another — the two happen to agree today, but a mismatch would silently drop every marker.
  const joinedAddresses = useMemo(
    () => new Set(joined.map((j) => j.view.campaign.toLowerCase())),
    [joined],
  );

  // Wall-clock time via an external store — see `useNow`. Returns 0 until the clock is live,
  // which keeps the server prerender and client hydration in agreement.
  const now = useNow();

  const visible = useMemo(
    () => filterCampaigns(campaigns, filters, reputation),
    [campaigns, filters, reputation],
  );
  const summary = useMemo(() => summarize(visible), [visible]);

  // Reward pools are stablecoin-denominated, so the summary tiles read in dollars and campaigns
  // escrowing different tokens still share one total — see `poolValue`.
  //
  // Derived from `visible`, not `campaigns`, because `summary` is: filtering the list should
  // retotal what the filter produced rather than leave the row reporting rows it no longer shows.
  const value = useMemo(() => poolValue(visible, tokens), [visible, tokens]);

  const columns = useMemo(
    () => buildColumns(tokens, now, joinedAddresses, kpiSpecs, guides, chainId),
    [tokens, now, joinedAddresses, kpiSpecs, guides, chainId],
  );

  /*
    What the promote menu offers — built from `campaigns`, not `visible`.

    The table's filters narrow what a visitor is reading; they are not a statement about what they
    are allowed to join. Sourcing the menu from the filtered list would make "Ended only" empty it.
  */
  const joinable = useMemo(
    () => joinOptions(campaigns, {reputation, joinedAddresses, connected: isConnected}),
    [campaigns, reputation, joinedAddresses, isConnected],
  );

  if (!deployed) {
    return (
      <Card>
        <EmptyState
          title="Boneyard is not available on this network"
          description="Switch your wallet to base sepolia network to see campaigns."
        />
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      {/*
        The list page doubles as the landing page, so it opens with what the marketplace does rather
        than with its own name: the top bar already carries the wordmark, and a second one below it
        spent the first screen saying "Boneyard" twice and nothing else.

        One left-aligned lockup on the table's own axis — headline, the line that explains it, the
        two actions with a caption each, the way in for anyone who wants the mechanics first, and the
        live figures under a hairline. The figures are evidence for the headline rather than a panel
        of their own, so they sit inside the lockup instead of in a card.
      */}
      <header className="pt-2 sm:pt-4">
        <h1 className="animate-rise-in max-w-[18ch] text-balance font-display text-4xl leading-tight text-ink sm:text-5xl">
          Pay only for verified growth.
        </h1>

        <p className="animate-rise-in mt-3 max-w-[48ch] text-balance text-sm leading-snug text-ink-secondary [animation-delay:60ms] sm:mt-4 sm:text-base">
          The marketplace for verifiable Web3 growth: projects escrow rewards, promoters earn them
          per verified result.
        </p>

        {/* The two actions the page exists to start, ranked by register: one solid primary for the
            project side, the brand outline for the promoter's. Promoting is a menu rather than a
            link because the campaign has to be chosen, and the choice is the part a promoter needs
            help with — every offerable campaign is listed, with the ones this wallet cannot promote
            yet saying why.

            A fixed measure each rather than halves of a band: side by side they read as a pair, and
            a caption under each states what that side of the marketplace does. Stacked below `sm`,
            where half a phone is not a button, and spaced wider there so a caption groups with the
            button above it instead of reading as four loose lines. */}
        <div className="mt-5 flex flex-col gap-6 sm:mt-6 sm:flex-row sm:items-start sm:gap-6">
          <div className="flex flex-col gap-2 sm:w-64">
            <ButtonLink href="/create" variant="primary" full>
              Create a campaign
            </ButtonLink>

            <p className="text-balance text-xs leading-snug text-ink-muted">
              Set the KPIs, escrow the reward pool, pay for verified results.
            </p>
          </div>

          <JoinCampaignMenu
            options={joinable}
            onJoined={refetchJoined}
            loading={isLoading}
            variant="brand-outline"
            caption="Generate a boneylink, share it, earn per verified result."
            className="sm:w-64"
          />
        </div>

        {/* The mechanics, as a quiet link inside the lockup. It used to sit under the table, which
            put the explanation after the thing it explains. */}
        <p className="mt-5 text-xs">
          <Link href="/docs" className="text-brand underline-offset-2 hover:underline">
            See how it works
          </Link>
        </p>

        {/* What the marketplace is paying out and how much of it has landed, reading left to right
            with the pool set larger as the figure everything else is a share of. One hairline above
            them and no box: each carries its own label, so a panel with a border would only fence
            off four numbers that belong to the sentence at the top of the page. */}
        <div className="mt-6 grid grid-cols-2 gap-4 border-t border-hairline pt-5 sm:mt-7 lg:grid-cols-4">
          <Figure
            label="Total reward pool"
            value={formatUsd(value.pool, {compact: true})}
            size="lg"
          />
          <Figure
            label="Active campaigns"
            value={summary.activeCount.toLocaleString("en-US")}
            qualifier={`of ${summary.count.toLocaleString("en-US")}`}
          />
          <Figure label="Rewards earned" value={formatUsd(value.paidOut, {compact: true})} />
          <Figure label="Pool utilization" value={formatPercent(value.paidOut, value.pool)} />
        </div>
      </header>

      {/* The project column's measure, as a property the column and its cells both read: a wide
          share of the viewport while the row is a name and one number, the desktop 220px from `md`,
          where the five columns that share the row with it come back. */}
      <Card padded={false} className="[--project-col:62vw] md:[--project-col:220px]">
        {/* The table’s own header carries what the list is showing and the one control that
            changes it — filters live behind it rather than in a row of their own above the panel.
            Padded to the table’s own cell inset, so the title starts where the first column does. */}
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-hairline px-2 py-2.5 sm:px-3">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="text-sm font-bold text-ink">Browse campaigns</h2>

            {visible.length !== campaigns.length ? (
              <span className="tnum text-xs text-ink-muted">
                {visible.length} of {campaigns.length}
              </span>
            ) : null}

            {/* Said out loud rather than absorbed: those rows show a KPI count, not a kind, and a
                column that quietly stopped describing the tail of the list would read as “no KPIs
                here”. */}
            {kpiSpecsDropped > 0 ? (
              <span className="text-xs text-ink-muted">
                KPI kinds not loaded for {kpiSpecsDropped} campaign
                {kpiSpecsDropped === 1 ? "" : "s"}
              </span>
            ) : null}
          </div>

          <CampaignFilterControls filters={filters} setFilters={setFilters} />
        </div>

        {isLoading ? (
          <SkeletonRows rows={4} cols={7} />
        ) : error ? (
          <ErrorState message={String(error)} onRetry={() => refetch()} />
        ) : (
          <DataTable
            rows={visible}
            columns={columns}
            rowKey={(c) => c.campaign}
            initialSort={{key: "project", dir: "asc"}}
            isRefreshing={isRefreshing}
            /* The whole row opens the campaign, so a reader aiming at a status or a number lands
               somewhere instead of nowhere. The project name stays a real link inside it — it is
               how you open one in a new tab — and stops the click from being handled twice. */
            onRowClick={(c) => router.push(`/campaign/${c.campaignId}`)}
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
                      Create a campaign
                    </Link>
                  ) : null
                }
              />
            }
          />
        )}
      </Card>

      {/* Who is already earning, below the table rather than above it: the panel renders nothing
          until the subgraph answers, so an empty slot here costs the page nothing. */}
      <LeaderboardTeaser />
    </div>
  );
}

function buildColumns(
  tokens: Record<string, TokenMeta>,
  now: number,
  joinedAddresses: ReadonlySet<string>,
  kpiSpecs: Record<string, KpiSpec[]>,
  guides: Map<string, ResolvedGuide | null>,
  chainId?: number,
): Column<CampaignView>[] {
  const meta = (c: CampaignView) => tokens[c.token.toLowerCase()] ?? {symbol: "", decimals: 18};
  const hasJoined = (c: CampaignView) => joinedAddresses.has(c.campaign.toLowerCase());

  /*
    What this campaign measures, in words. Reads no chain state of its own: the kind comes from the
    specs the hook fetched once, and the hover text names the watched contract from the local catalog
    or — where a campaign watches the token it escrows, as most seeded ones do — the token metadata
    already loaded for the reward-pool column.
  */
  const kindSummary = (c: CampaignView) => {
    const specs = kpiSpecs[c.campaign.toLowerCase()];
    if (!specs) return null;

    return summarizeKinds(specs, {
      chainId,
      escrowToken: c.token.toLowerCase(),
      tokenSymbol: meta(c).symbol || undefined,
      campaignName: c.name,
    });
  };

  /** The project's own line about the campaign, from its guide. */
  const summaryFor = (c: CampaignView) =>
    guides.get(c.campaign.toLowerCase())?.summary?.trim() || undefined;

  return [
    {
      key: "project",
      header: "Project",
      // The campaign's on-chain name, which is what a project puts its own name in. The project
      // wallet stands in where a campaign was created without one.
      sortValue: (c) => (hasProjectName(c) ? projectName(c) : c.project.toLowerCase()),
      /*
        A custom property set on the panel, so an inline width can change at a breakpoint — see
        `--project-col` on the `Card` this table mounts in.

        The wide share holds until `md`, which is exactly where the columns it makes room for come
        back. Below that the row is a name, a sub-line and one number, and the sub-line carries the
        status, the end date, the gate and the share paid; capped at the desktop 220px it wrapped to
        a second line while the middle of the row sat empty.
      */
      width: "var(--project-col)",
      /*
        Capped at the column's own width, with the name truncating inside it.
        `overflow-x-auto` handles the table's total; this line only has to stop one cell from
        setting it. The table lays out `auto`, so a cell's widest possible content is what sizes
        its column: an uncapped name — or a `Promoting` badge that appears when the wallet connects
        and vanishes when it disconnects — moved every column to its right. The cap makes this
        column's measure a constant, so the badge is free to come and go.
      */
      render: (c) => {
        const summary = summaryFor(c);

        return (
          <div className="flex max-w-(--project-col) flex-col gap-0.5">
            <span className="flex items-center gap-2">
              <Link
                href={`/campaign/${c.campaignId}`}
                title={projectName(c)}
                className="min-w-0 truncate font-medium text-ink hover:underline"
                onClick={(e) => e.stopPropagation()}
              >
                {projectName(c)}
              </Link>
              {hasJoined(c) ? <JoinedBadge /> : null}
            </span>

            {/* What the campaign is for, in the project's own words, under the name it belongs to
                rather than in a 320px column of its own — most rows have nothing to put there, and
                a column of "No campaign info yet" was the widest thing on the page. Absent, this
                line is simply not rendered. */}
            {summary ? (
              <span className="hidden md:block">
                {/* `line-clamp-2` sets its own `display`, so the breakpoint has to live on a
                    wrapper rather than fight it for the same property. */}
                <span className="line-clamp-2 text-xs leading-snug text-ink-muted" title={summary}>
                  {summary}
                </span>
              </span>
            ) : null}

            {/* A phone drops five of the seven columns, which leaves it a name and a number. The
                four facts that decide whether a campaign is worth opening — what state it is in,
                when it ends, what it gates on, how much of the pool has moved — ride under the name
                instead, and go away from `md` up where the table shows them itself. */}
            <span className="text-[11px] leading-snug text-ink-muted md:hidden">
              {c.status}
              {now > 0 ? ` · ${formatTimeUntil(c.endTime, now)}` : ""}
              {c.minReputation === BigInt(0)
                ? " · open to all"
                : ` · min ${c.minReputation.toLocaleString("en-US")}`}
              {c.paidOut > BigInt(0)
                ? ` · ${formatPercent(Number(c.paidOut), Number(c.rewardPool))} paid`
                : ""}
            </span>
          </div>
        );
      },
    },
    {
      key: "status",
      header: "Status",
      // A phone spends the width on the name instead; the status leads the sub-line under it.
      hideOnMobile: true,
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
      key: "utilization",
      header: "Progress",
      sortValue: (c) => utilization(c),
      // The fixed width is also why this is one of the first columns dropped on a phone: 140px of a
      // 375px viewport spent on a bar, when the same percentage rides under the project name there.
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
      hideOnMobile: true,
      // Sorts on the label, so the column orders the way it reads. Rows whose specs have not landed
      // (or were left out by the read budget) sort together under the empty string.
      sortValue: (c) => kindSummary(c)?.sortValue ?? "",
      render: (c) => {
        const summary = kindSummary(c);

        // No specs yet: the count is what this column showed before, and it is never wrong — just
        // less useful than the kind. Better than an empty cell that reads as "no KPIs".
        if (!summary) {
          return <span className="text-ink-muted">{c.kpiCount.toString()}</span>;
        }

        // One line: `NFT mints +1` broken across two reads as two separate KPIs, and the column has
        // the room now that the summary is not a column of its own.
        return (
          <span title={summary.title} className="whitespace-nowrap text-ink-secondary">
            {summary.label}
            {summary.extra > 0 ? (
              <span className="ml-1 text-ink-muted">+{summary.extra}</span>
            ) : null}
          </span>
        );
      },
    },
    {
      key: "minRep",
      header: "Min. BoneyScore",
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
      header: "Ends",
      numeric: true,
      hideOnMobile: true,
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
