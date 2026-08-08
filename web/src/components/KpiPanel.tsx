"use client";

import {Card} from "@/components/ui/Card";
import {Meter} from "@/components/ui/Meter";
import {DataTable, type Column} from "@/components/ui/DataTable";
import {nextTier, tierProgressRatio, crossedTierCount} from "@/lib/campaign";
import {formatTokenAmount, compactNumber, formatRatio, shortAddress} from "@/lib/format";
import {decodeEventSource, knownSignature, effectiveScale} from "@/lib/kpiSource";
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
  decimals,
  symbol,
  promoterState,
  chainId,
}: {
  kpi: KpiDetail;
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
          <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
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

      <EventSourceLine params={kpi.spec.params} chainId={chainId} />

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
 */
function EventSourceLine({
  params,
  chainId,
}: {
  params: `0x${string}`;
  chainId?: number;
}) {
  const source = decodeEventSource(params);
  if (!source) return null;

  const signature = knownSignature(source.topic0);
  const scale = effectiveScale(source);
  // Undefined on anvil, which has no explorer — the address then renders as plain text.
  const href = chainId === undefined ? undefined : explorerAddressUrl(chainId, source.source);

  return (
    <div className="mb-4 rounded border border-hairline bg-surface-2 px-3 py-2">
      <p className="text-[10px] uppercase tracking-wide text-ink-muted">Tracking</p>
      <p className="mt-0.5 font-mono text-xs text-ink">
        {signature ?? `${source.topic0.slice(0, 10)}…`}
      </p>
      <p className="mt-0.5 text-xs text-ink-muted">
        on{" "}
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="font-mono underline hover:text-ink"
          >
            {shortAddress(source.source)}
          </a>
        ) : (
          <span className="font-mono">{shortAddress(source.source)}</span>
        )}
        {scale > BigInt(1) ? ` · ${scale.toLocaleString("en-US")} per unit` : null}
      </p>
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
