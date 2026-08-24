"use client";

import {Card} from "@/components/ui/Card";
import {Meter} from "@/components/ui/Meter";
import {DataTable, type Column} from "@/components/ui/DataTable";
import {nextTier, tierProgressRatio, crossedTierCount} from "@/lib/campaign";
import {formatTokenAmount, compactNumber, formatRatio, shortAddress} from "@/lib/format";
import {shortTopic} from "@/lib/eventNames";
import {useTrackedEvent} from "@/hooks/useTrackedEvent";
import {explorerAddressUrl} from "@/lib/chains";
import {KPI_KIND_LABEL, type RewardTier} from "@/lib/types";
import type {KpiDetail, PromoterKpiState} from "@/lib/campaignDetail";

/**
 * One KPI: its target, the aggregate progress across all promoters, and the reward ladder.
 *
 * The ladder is a table rather than a chart — it is a small set of exact (threshold, reward)
 * pairs, and rounding a payout into a bar height would hide the number that matters. Progress
 * against the next tier is a meter, per the form heuristic.
 */

type LadderRow = RewardTier & {index: number; crossed: boolean; settled: boolean};

export function KpiPanel({
  kpi,
  campaign,
  campaignName,
  decimals,
  symbol,
  promoterState,
  chainId,
}: {
  kpi: KpiDetail;
  /** The campaign this KPI belongs to — half the key its verifier config is stored under. */
  campaign: `0x${string}`;
  /** The campaign's display name, used to label the watched contract when nothing else can. */
  campaignName?: string;
  decimals: number;
  symbol: string;
  /** Present only when the connected wallet has joined this campaign. */
  promoterState?: PromoterKpiState;
  /** Resolves the block explorer for an event source's contract; absent on local chains. */
  chainId?: number;
}) {
  const label = KPI_KIND_LABEL[kpi.spec.kind];
  const ladderTotal = kpi.tiers.reduce((sum, t) => sum + t.reward, BigInt(0));

  // Aggregate KPIs measure the whole campaign against one target; per-promoter KPIs measure
  // each promoter separately, so a campaign-wide "progress" number would be misleading.
  const progressBasis = promoterState?.progress ?? kpi.totalProgress;
  const next = nextTier(progressBasis, kpi.tiers);
  const crossed = crossedTierCount(progressBasis, kpi.tiers);

  const rows: LadderRow[] = kpi.tiers.map((t, index) => ({
    ...t,
    index,
    crossed: progressBasis >= t.threshold,
    settled: promoterState !== undefined && index < promoterState.settledTiers,
  }));

  const columns: Column<LadderRow>[] = [
    {
      key: "tier",
      header: "Tier",
      render: (r) => <span className="text-ink-muted">{r.index + 1}</span>,
      width: "56px",
    },
    {
      key: "threshold",
      header: "Threshold",
      numeric: true,
      render: (r) => compactNumber(Number(r.threshold)),
    },
    {
      key: "reward",
      header: "Reward",
      numeric: true,
      render: (r) => (
        <span>
          {formatTokenAmount(r.reward, decimals, {compact: true})}{" "}
          <span className="text-ink-muted">{symbol}</span>
        </span>
      ),
    },
    {
      key: "state",
      header: "State",
      render: (r) => <LadderState row={r} hasPromoter={promoterState !== undefined} />,
    },
  ];

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-bold text-brand">
            {label}
            {kpi.spec.aggregate ? (
              <span
                className="rounded border border-hairline px-1.5 py-0.5 text-[10px] font-normal uppercase tracking-wide text-ink-muted"
                title="Measured across all promoters combined, not per promoter"
              >
                aggregate
              </span>
            ) : null}
          </h3>
          <p className="mt-0.5 text-xs text-ink-muted">
            Target {compactNumber(Number(kpi.spec.target))} · {kpi.tiers.length} tier
            {kpi.tiers.length === 1 ? "" : "s"} · pool{" "}
            {formatTokenAmount(ladderTotal, decimals, {compact: true})} {symbol}
          </p>
        </div>

        <div className="text-right">
          <div className="text-lg font-semibold leading-tight text-ink">
            {compactNumber(Number(progressBasis))}
          </div>
          <div className="text-[11px] text-ink-muted">
            {promoterState ? "your progress" : "total progress"}
          </div>
        </div>
      </div>

      <div className="mb-4">
        {next ? (
          <Meter
            value={tierProgressRatio(progressBasis, kpi.tiers)}
            max={1}
            label={`Next: tier ${next.index + 1} at ${compactNumber(Number(next.threshold))}`}
            valueText={formatRatio(tierProgressRatio(progressBasis, kpi.tiers))}
          />
        ) : (
          <p className="text-xs text-good">
            All {kpi.tiers.length} tier{kpi.tiers.length === 1 ? "" : "s"} crossed
            {crossed > 0 ? " — ladder complete" : ""}
          </p>
        )}
      </div>

      <EventSourceLine
        campaign={campaign}
        kpi={kpi}
        campaignName={campaignName}
        chainId={chainId}
      />

      <div className="-mx-4 -mb-4 border-t border-hairline">
        <DataTable rows={rows} columns={columns} rowKey={(r) => String(r.index)} />
      </div>
    </Card>
  );
}

/**
 * What this KPI measures, when it says so on chain.
 *
 * A KPI with no event source renders nothing — that is every campaign predating this feature, and
 * every KPI a project reports by hand, so absence is ordinary rather than a missing-data state.
 * When a source *is* declared, naming it matters: it is the difference between "trust the project's
 * numbers" and "these came from this contract's logs, go check".
 *
 * Naming it in words is what `useTrackedEvent` adds. This line used to render the raw topic hash
 * for anything outside the two `EVENT_PRESETS`, which meant both live real-protocol campaigns read
 * as `0x2b627736… on 0x8bAB…AE27` — technically complete and unreadable. The event name now comes
 * from the verifier's own on-chain config where there is one, and the contract from a verified
 * address catalog or the contract's own `name()`/`symbol()`.
 */
function EventSourceLine({
  campaign,
  kpi,
  campaignName,
  chainId,
}: {
  campaign: `0x${string}`;
  kpi: KpiDetail;
  /** The campaign's display name — the last-resort label for the watched contract. */
  campaignName?: string;
  chainId?: number;
}) {
  const {tracked, isLoading} = useTrackedEvent({
    campaign,
    kpiIndex: kpi.index,
    kind: kpi.spec.kind,
    verifier: kpi.spec.verifier,
    params: kpi.spec.params,
    campaignName,
  });

  if (!tracked) return null;

  // Undefined on anvil, which has no explorer — the address then renders as plain text.
  const href = chainId === undefined ? undefined : explorerAddressUrl(chainId, tracked.contract);
  const address = shortAddress(tracked.contract);

  return (
    <div
      className={`mb-4 rounded border border-hairline bg-surface-2 px-3 py-2 transition-opacity ${
        isLoading ? "opacity-70" : ""
      }`}
    >
      <p className="text-[10px] uppercase tracking-wide text-ink-muted">Tracking</p>

      <p
        className={`mt-0.5 break-all text-xs text-ink ${
          tracked.eventFrom === "kind" ? "" : "font-mono"
        }`}
      >
        {tracked.event}
        {/*
          Nothing on chain publishes a name for this topic, so the label above is the KPI's category
          rather than its event. Showing the topic keeps the line checkable instead of asking a
          reader to take the category on faith.
        */}
        {tracked.eventFrom === "kind" ? (
          <span
            className="ml-1.5 font-mono text-ink-muted"
            title="No event signature is published on chain for this topic — this is the KPI's category."
          >
            {shortTopic(tracked.topic0)}
          </span>
        ) : null}
      </p>

      <p className="mt-0.5 text-xs text-ink-muted">
        on{" "}
        {/* When the protocol name *is* the short address, printing it twice says nothing twice. */}
        {tracked.protocolFrom !== "address" ? <span className="text-ink-secondary">{tracked.protocol}</span> : null}
        {tracked.protocolFrom !== "address" ? " · " : null}
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="font-mono underline hover:text-ink"
          >
            {address}
          </a>
        ) : (
          <span className="font-mono">{address}</span>
        )}
        {tracked.scale > BigInt(1) ? ` · ${tracked.scale.toLocaleString("en-US")} per unit` : null}
      </p>

      {/* The verifier and the params blob name different events — see `TrackedEvent.drift`. */}
      {tracked.drift ? <p className="mt-1.5 text-xs text-warning">{tracked.drift}</p> : null}
    </div>
  );
}

/**
 * Ladder row state.
 *
 * "Crossed" and "settled" remain distinct facts on chain, but they are written in the same
 * transaction: `Campaign.reportUserAction` credits progress and then calls `_settle`, which pays
 * and advances `_settledTiers`. So a crossed-but-unsettled row is not a reward waiting to be
 * claimed — it means settlement did not complete, which is worth showing rather than smoothing
 * over. The permissionless `Campaign.settle` is the recovery path.
 */
function LadderState({row, hasPromoter}: {row: LadderRow; hasPromoter: boolean}) {
  if (!row.crossed) {
    return <span className="text-xs text-ink-muted">Locked</span>;
  }
  if (!hasPromoter) {
    return <span className="text-xs text-ink-secondary">Reached</span>;
  }
  if (row.settled) {
    return <span className="text-xs text-ink-secondary">Paid</span>;
  }
  return <span className="text-xs font-medium text-warning">Unsettled</span>;
}
