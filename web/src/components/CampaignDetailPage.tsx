"use client";

import {useMemo, useCallback} from "react";
import Link from "next/link";
import {useAccount} from "wagmi";
import {useCampaignDetail, usePromoterState} from "@/hooks/useCampaignDetail";
import {useReferredCampaigns} from "@/hooks/useReferredCampaigns";
import {useCampaignGuide} from "@/hooks/useCampaignGuide";
import {useNow} from "@/hooks/useNow";
import {Card, CardHeader} from "@/components/ui/Card";
import {StatTile, StatRow} from "@/components/ui/StatTile";
import {StatusPill} from "@/components/ui/StatusPill";
import {Meter} from "@/components/ui/Meter";
import {EmptyState, ErrorState, SkeletonRows} from "@/components/ui/States";
import {KpiPanel} from "@/components/KpiPanel";
import {CampaignGuidePanel, hasGuideContent} from "@/components/CampaignGuidePanel";
import {ProjectActions} from "@/components/ProjectActions";
import {ProjectPromotersPanel} from "@/components/ProjectPromotersPanel";
import {ReportPanel} from "@/components/ReportPanel";
import {PromoterPanel} from "@/components/PromoterPanel";
import {utilization, isReclaimable, reclaimAvailableIn} from "@/lib/campaign";
import {projectName} from "@/lib/projects";
import {viewerRole, visibleSections} from "@/lib/viewerRole";
import {
  formatTokenAmount,
  formatPercent,
  formatTimeUntil,
  formatDuration,
  formatDate,
  shortAddress,
} from "@/lib/format";
import {explorerAddressUrl} from "@/lib/chains";
import type {PromoterKpiState} from "@/lib/campaignDetail";

export function CampaignDetailPage({campaignId}: {campaignId: bigint | undefined}) {
  const {view, detail, token, isLoading, error, notFound, refetch, deployed, chainId} =
    useCampaignDetail(campaignId);
  const {promoter, refetch: refetchPromoter} = usePromoterState(
    detail?.address,
    detail?.kpis.length ?? 0,
  );
  const {address, isConnected} = useAccount();
  const now = useNow();

  /*
    Whether this wallet has been referred here.

    Reuses the dashboard's hook with a single-campaign list rather than a new read: it is two point
    lookups (`touchOf`, then `promoterOf` when there is a touch), pinned and cached like the rest of
    the fan-outs. It returns an empty list with no wallet connected, so a visitor pays nothing for it.
  */
  const referredQuery = useReferredCampaigns(view ? [view] : []);

  /*
    The off-chain half of the campaign — what a referral is supposed to do about it. Resolves
    synchronously from the committed catalog on the first paint and upgrades if the project published
    its own; see `lib/campaignGuide` for why this cannot live on chain.
  */
  const {guide, refetch: refetchGuide} = useCampaignGuide(detail?.address);

  /*
    Which sections this reader gets. Not a permission — every fact behind it is public on chain (see
    `lib/viewerRole`) — but the page serves four different readers off one route, and showing all of
    them everything meant a referral got the escrow accounting while the project owner got the
    promoter-facing reward ladders. Neither can act on what they were shown.
  */
  const role = viewerRole({
    connected: isConnected,
    wallet: address,
    project: detail?.project ?? "",
    joined: Boolean(promoter?.joined),
    referred: referredQuery.referred.length > 0,
  });
  const sections = visibleSections(role);

  /**
   * Refetch after any write.
   *
   * Both halves are needed: joining changes per-promoter state, which lives in a separate query
   * from the campaign record. Refreshing only the campaign would leave a promoter looking at a
   * stale "not joined" panel right after they joined.
   */
  const refetchAll = useCallback(() => {
    refetch();
    void refetchPromoter();
  }, [refetch, refetchPromoter]);

  const promoterByKpi = useMemo(() => {
    const map = new Map<number, PromoterKpiState>();
    if (promoter?.joined) for (const s of promoter.perKpi) map.set(s.kpiIndex, s);
    return map;
  }, [promoter]);

  if (campaignId === undefined) {
    return (
      <Card>
        <EmptyState
          title="Invalid campaign id"
          description="Campaign ids are positive integers."
          action={<BackLink />}
        />
      </Card>
    );
  }

  if (!deployed) {
    return (
      <Card>
        <EmptyState
          title="Boneyard is not available on this network"
          description="Switch your wallet to a supported network to see this campaign."
          action={<BackLink />}
        />
      </Card>
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-5">
        <div className="h-6 w-48 animate-pulse rounded bg-surface-2" />
        <Card padded={false}>
          <SkeletonRows rows={3} cols={4} />
        </Card>
      </div>
    );
  }

  if (error) {
    return (
      <Card>
        <ErrorState message={String(error)} onRetry={refetch} />
      </Card>
    );
  }

  if (notFound || !view || !detail) {
    return (
      <Card>
        <EmptyState
          title={`Campaign #${campaignId.toString()} not found`}
          description="No campaign is registered with this id on the connected network."
          action={<BackLink />}
        />
      </Card>
    );
  }

  const clockReady = now > 0;
  const reclaimOpen = isReclaimable(
    detail.status,
    Number(detail.endedAt),
    now,
    Number(detail.claimGrace),
  );
  // Undefined on local chains — anvil has no block explorer, so the address renders as plain text.
  const explorer =
    chainId !== undefined ? explorerAddressUrl(chainId, detail.address) : undefined;

  return (
    <div className="space-y-5">
      <header className="space-y-2">
        <div className="flex items-center gap-2 text-xs text-ink-muted">
          <BackLink />
          <span aria-hidden>/</span>
          <span>Campaign #{detail.address ? campaignId.toString() : "—"}</span>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <h1 className="font-display text-2xl text-ink">
              Campaign #{campaignId.toString()}
            </h1>
            <StatusPill status={detail.status} />
          </div>

          <dl className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-muted">
            <div className="flex gap-1.5">
              <dt>Project</dt>
              <dd className="font-medium text-ink-secondary">
                {projectName({name: detail.name, project: detail.project})}
              </dd>
            </div>
            <div className="flex gap-1.5">
              <dt>Contract</dt>
              <dd className="font-medium text-ink-secondary">
                {explorer ? (
                  <a href={explorer} target="_blank" rel="noreferrer" className="hover:underline">
                    {shortAddress(detail.address)}
                  </a>
                ) : (
                  shortAddress(detail.address)
                )}
              </dd>
            </div>
          </dl>
        </div>
      </header>

      {/* 5.1 — escrow, utilization, window */}
      <StatRow>
        <StatTile
          label="Reward pool"
          value={formatTokenAmount(detail.rewardPool, token.decimals, {compact: true})}
          unit={token.symbol}
          //accent="var(--series-1)"
        />
        {/* Payout and custody figures travel with the utilization meter — see `SectionVisibility`. */}
        {sections.escrowTiles ? (
          <StatTile
            label="Paid out"
            value={formatTokenAmount(detail.paidOut, token.decimals, {compact: true})}
            unit={token.symbol}
            qualifier={`of ${formatTokenAmount(detail.rewardPool, token.decimals, {compact: true})}`}
            //accent="var(--series-3)"
          />
        ) : null}
        {/*
          Custody, not accounting. `remainingPool()` is `rewardPool - paidOut`, which a reclaim
          never touches — the tokens leave the vault but the subtraction stays put, so this tile
          would keep quoting the pre-reclaim figure forever. The vault balance is the only number
          that answers "how much is actually still escrowed", and it is what `reclaimUnspent`
          itself pays out. Same reason it also reads 0 on a campaign that was never funded.
        */}
        {sections.escrowTiles ? (
          <StatTile
            label="Remaining escrow"
            value={formatTokenAmount(detail.escrowBalance, token.decimals, {compact: true})}
            unit={token.symbol}
          />
        ) : null}
        <StatTile
          label={clockReady && Number(detail.endTime) <= now ? "Window closed" : "Ends in"}
          value={clockReady ? formatTimeUntil(detail.endTime, now) : "—"}
          hint={formatDate(detail.endTime)}
        />
      </StatRow>

      {/*
        What to actually do about this campaign. Mounted here, directly after the tiles, because it is
        the section a referral needs and every other block below is hidden from them — so this lands
        immediately under the header on their page and below the accounting on everyone else's.
      */}
      {sections.guide && hasGuideContent(detail, guide, role) ? (
        <CampaignGuidePanel
          chainId={chainId}
          detail={detail}
          guide={guide}
          onGuidePublished={refetchGuide}
          role={role}
        />
      ) : null}

      {/*
        5.1 — escrow, utilization, window.

        Hidden from a referral: they are not paid from this pool, and how much of it has been
        released is an arrangement between the project and its promoters. Both cards move together,
        so the grid goes with them rather than leaving a one-card row.
      */}
      {sections.poolUtilization || sections.escrowReturn ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {sections.poolUtilization ? (
            <Card className="lg:col-span-2">
              <CardHeader
                title="Pool utilization"
                subtitle="Share of escrow already released to promoters"
              />
              <Meter
                value={utilization(detail)}
                max={1}
                label={`${formatTokenAmount(detail.paidOut, token.decimals)} / ${formatTokenAmount(detail.rewardPool, token.decimals)} ${token.symbol}`}
                valueText={formatPercent(Number(detail.paidOut), Number(detail.rewardPool))}
                fullIsBad
              />

              <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-hairline pt-3 text-xs sm:grid-cols-4">
                <Field label="Starts" value={formatDate(detail.startTime)} />
                <Field label="Ends" value={formatDate(detail.endTime)} />
                <Field
                  label="Attribution window"
                  value={formatDuration(Number(detail.attributionWindow))}
                />
                <Field
                  label="Min. reputation"
                  value={
                    detail.minReputation === BigInt(0)
                      ? "Open to all"
                      : detail.minReputation.toLocaleString("en-US")
                  }
                />
              </dl>
            </Card>
          ) : null}

          {sections.escrowReturn ? (
            <Card>
              <CardHeader
                title="Escrow return"
                subtitle="Unspent funds after the settlement window"
              />
              {detail.status === "Ended" || detail.status === "Cancelled" ? (
                <div className="space-y-2 text-xs">
                  {reclaimOpen ? (
                    detail.escrowBalance > BigInt(0) ? (
                      <p className="text-good">
                        The settlement window has closed. The project can reclaim{" "}
                        {formatTokenAmount(detail.escrowBalance, token.decimals, {compact: true})}{" "}
                        {token.symbol}.
                      </p>
                    ) : (
                      /* Empty vault: already reclaimed, fully paid out, or never funded. All three
                         read the same from here, and `reclaimUnspent` reverts `NothingToReclaim` in
                         each — so don't offer a number the project cannot collect. */
                      <p className="text-ink-secondary">
                        The settlement window has closed and escrow is empty — nothing left to
                        reclaim.
                      </p>
                    )
                  ) : detail.status === "Cancelled" ? (
                    <p className="text-ink-secondary">
                      Cancelled — unspent escrow returns immediately.
                    </p>
                  ) : (
                    <p className="text-ink-secondary">
                      Promoters can still settle for{" "}
                      {clockReady && detail.endedAt > BigInt(0)
                        ? formatDuration(
                            reclaimAvailableIn(
                              Number(detail.endedAt),
                              now,
                              Number(detail.claimGrace),
                            ),
                          )
                        : formatDuration(Number(detail.claimGrace))}
                      . Reclaim unlocks after that.
                    </p>
                  )}
                  <p className="text-ink-muted">
                    Settlement grace: {formatDuration(Number(detail.claimGrace))} from when the
                    campaign was ended.
                  </p>
                </div>
              ) : (
                <p className="text-xs text-ink-muted">
                  Escrow is locked while the campaign is {detail.status.toLowerCase()}. Unspent funds
                  become reclaimable {formatDuration(Number(detail.claimGrace))} after it ends.
                </p>
              )}
            </Card>
          ) : null}
        </div>
      ) : null}

      {/* 6.2 — fund / activate / pause / end / reclaim */}
      <ProjectActions
        campaignId={campaignId}
        detail={detail}
        token={token}
        onDone={refetchAll}
        nowSeconds={now}
      />

      {/* Dev tool — manual reportUserAction; renders only for the project wallet. */}
      {view ? (
        <ReportPanel
          view={view}
          detail={detail}
          token={token}
          onDone={refetchAll}
          nowSeconds={now}
        />
      ) : null}

      {/* 7.1 / 7.2 — join, tracking link, progress */}
      <PromoterPanel
        detail={detail}
        promoter={promoter}
        token={token}
        onDone={refetchAll}
        nowSeconds={now}
      />

      {/* The project's own view: who joined and what each has been paid, in place of the ladders. */}
      {sections.promoterTable && view ? (
        <ProjectPromotersPanel view={view} detail={detail} token={token} chainId={chainId} />
      ) : null}

      {/* 5.2 — KPI panels with tier ladders and per-promoter progress */}
      {sections.kpis ? (
        <section className="space-y-3">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-sm font-bold text-brand">
              KPIs{" "}
              <span className="font-normal text-ink-muted">
                ({detail.kpis.length})
              </span>
            </h2>
            {promoter?.joined ? (
              <p className="text-xs text-ink-muted">
                Showing your progress · promoter {shortAddress(promoter.promoterId, 8, 6)}
              </p>
            ) : (
              <p className="text-xs text-ink-muted">Showing combined progress across promoters</p>
            )}
          </div>

          {detail.kpis.length === 0 ? (
            <Card>
              <EmptyState
                title="No KPIs configured"
                description="This campaign has no measurable milestones, so no rewards can be released."
              />
            </Card>
          ) : (
            <div className="space-y-4">
              {detail.kpis.map((kpi) => (
                <KpiPanel
                  key={kpi.index}
                  kpi={kpi}
                  campaign={detail.address}
                  campaignName={detail.name}
                  decimals={token.decimals}
                  symbol={token.symbol}
                  promoterState={promoterByKpi.get(kpi.index)}
                  chainId={chainId}
                />
              ))}
            </div>
          )}
        </section>
      ) : role === "disconnected" ? (
        /*
          A tier threshold only means something against "what would *I* be paid", so the ladders wait
          for a wallet. Said out loud rather than left as a gap — an absent section reads as a
          campaign with no KPIs, which is a different and much worse claim.
        */
        <Card>
          <EmptyState
            title={`${detail.kpis.length} KPI${detail.kpis.length === 1 ? "" : "s"} on this campaign`}
            description="Connect a wallet to see what each KPI measures and the reward tiers behind it."
          />
        </Card>
      ) : null}
    </div>
  );
}

function Field({label, value}: {label: string; value: string}) {
  return (
    <div>
      <dt className="text-ink-muted">{label}</dt>
      <dd className="mt-0.5 font-medium text-ink-secondary">{value}</dd>
    </div>
  );
}

function BackLink() {
  return (
    <Link href="/" className="hover:text-ink hover:underline">
      Campaigns
    </Link>
  );
}
