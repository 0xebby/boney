"use client";

import {useMemo, useState} from "react";
import {useAccount} from "wagmi";
import {Card, CardHeader} from "@/components/ui/Card";
import {TxErrorMessage} from "@/components/ui/TxErrorMessage";
import {useReportUserAction, isPending, type TxState} from "@/hooks/useWriteCampaign";
import {useCampaignPromoters} from "@/hooks/useCampaignPromoters";
import {useCampaignTouches} from "@/hooks/useCampaignTouches";
import {useKolReportState} from "@/hooks/useKolReportState";
import {buildKolTargets, planKolReport, nextTierSeed, type TierSeed} from "@/lib/reporting";
import {shortAddress, formatTokenAmount} from "@/lib/format";
import {KPI_KIND_LABEL} from "@/lib/types";
import type {CampaignDetail} from "@/lib/campaignDetail";
import type {CampaignView} from "@/lib/types";

/**
 * Manual `reportUserAction` — a testing affordance for the project wallet.
 *
 * Progress is normally credited by `scripts/indexer.ts`, which watches each KPI's event source and
 * reports what it finds. That means nothing pays out until a real event source exists and emits, so
 * exercising the settlement path by hand meant a cast call. This panel is that call, with the
 * contract's guards resolved up front.
 *
 * **Project-only, by the contract's own rule.** `reportUserAction` accepts `msg.sender` only when
 * it is the project or the oracle coordinator (`NotReporter` otherwise), so a promoter or visitor
 * could never use this. It renders nothing for them rather than showing a panel that would revert.
 *
 * The KOL dropdown is the selection the dev actually thinks in, but it is not a call the contract
 * offers: `reportUserAction` takes a *referral* wallet and resolves the KOL from its stored touch.
 * `lib/reporting` does that translation and the breakdown below the dropdown shows the result, so
 * the wallet prompts are never a surprise.
 */
export function ReportPanel({
  view,
  detail,
  token,
  onDone,
  nowSeconds,
}: {
  /** The campaign row, for the promoter scan — which takes views, not detail records. */
  view: CampaignView;
  detail: CampaignDetail;
  /** Escrow token metadata, for rendering what a tier pays out. */
  token: {symbol: string; decimals: number};
  /** Refetch the detail record after a report lands, so progress and tiers move. */
  onDone: () => void;
  nowSeconds: number;
}) {
  const {address} = useAccount();
  const isProject = Boolean(address && address.toLowerCase() === detail.project.toLowerCase());

  const [kolIndex, setKolIndex] = useState(0);
  const [kpiIndex, setKpiIndex] = useState(0);

  const promoterScan = useCampaignPromoters(isProject ? [view] : []);
  const touchScan = useCampaignTouches(isProject ? detail.address : undefined);
  const report = useReportUserAction();

  const promoterGroups = promoterScan.groups;
  const kols = useMemo(
    () => buildKolTargets(promoterGroups[0]?.promoters ?? [], touchScan.touches, nowSeconds),
    [promoterGroups, touchScan.touches, nowSeconds],
  );

  const kol = kols[kolIndex];
  const kpi = detail.kpis[kpiIndex];

  // The KOL's ladder position plus each live referral's cumulative credit — see the hook for why
  // neither can be taken from `detail`.
  const liveReferrals = useMemo(() => (kol?.live ?? []).map((r) => r.referral), [kol]);
  const {
    progress: promoterProgress,
    credited: creditedMap,
    isLoading: stateLoading,
    refetch: refetchState,
  } = useKolReportState({
    campaign: detail.address,
    promoter: kol?.promoter,
    referrals: liveReferrals,
    kpiIndex,
    enabled: isProject,
  });

  // The amount is derived, not typed. Each report aims at exactly one thing — clearing the KOL's
  // next threshold on the selected KPI — so the tier that the (KOL, KPI) pair is standing in front
  // of determines the figure, and a free-text box could only be used to enter a different one.
  const seed = kpi ? nextTierSeed(promoterProgress, kpi.tiers) : null;
  const amount = seed?.delta ?? BigInt(0);

  const plan = useMemo(() => {
    if (!kol || !kpi) return null;
    return planKolReport({
      kol,
      amount,
      progress: promoterProgress,
      credited: creditedMap,
      aggregate: kpi.spec.aggregate,
    });
  }, [kol, kpi, amount, promoterProgress, creditedMap]);

  if (!isProject) return null;

  const scanning = promoterScan.isLoading || touchScan.isLoading;
  const busy = isPending(report.state);

  const submit = async () => {
    if (!plan?.ok || !kpi) return;
    await report.report(detail.address, kpiIndex, plan.calls);
    onDone();
    await Promise.all([touchScan.refetch(), refetchState()]);
  };

  return (
    <Card>
      <CardHeader
        title="Report progress"
        subtitle="Testing tool — credits a KOL by hand instead of waiting for the indexer"
      />

      {scanning ? (
        <p className="text-xs text-ink-muted">Scanning joins and attribution touches…</p>
      ) : kols.length === 0 ? (
        <p className="text-xs text-ink-muted">
          No promoter has joined this campaign yet, so there is nobody to credit.
        </p>
      ) : (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <KolSelect kols={kols} value={kolIndex} onChange={setKolIndex} />
            <KpiSelect kpis={detail.kpis} value={kpiIndex} onChange={setKpiIndex} />
            <AmountField
              seed={seed}
              loading={stateLoading}
              unitLabel={kpi ? KPI_KIND_LABEL[kpi.spec.kind] : ""}
              decimals={token.decimals}
              symbol={token.symbol}
            />
          </div>

          {stateLoading ? (
            <p className="text-xs text-ink-muted">Reading progress and credited totals…</p>
          ) : plan?.ok && kol ? (
            <PlanBreakdown
              plan={plan}
              progress={promoterProgress}
              kol={kol}
              unitLabel={kpi ? KPI_KIND_LABEL[kpi.spec.kind] : ""}
            />
          ) : plan ? (
            <p className="text-xs text-warning">Cannot report: {plan.reason}</p>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!plan?.ok || busy || stateLoading}
              className="rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-plane hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy
                ? report.total > 1
                  ? `Reporting ${report.sent + 1} of ${report.total}…`
                  : "Reporting…"
                : plan?.ok && plan.calls.length > 1
                  ? `Report (${plan.calls.length} txs)`
                  : "Report"}
            </button>

            {report.total > 1 && report.sent > 0 ? (
              <span className="text-xs text-ink-muted">
                {report.sent} of {report.total} confirmed
              </span>
            ) : null}
          </div>

          {touchScan.scannedFrom !== undefined ? (
            <p className="text-xs text-ink-muted">
              Attribution history was scanned from block{" "}
              {touchScan.scannedFrom.toLocaleString("en-US")} only — a touch signed before that
              block will not appear here.
            </p>
          ) : null}

          <TxFeedback state={report.state} onReset={report.reset} />
        </div>
      )}
    </Card>
  );
}

function KolSelect({
  kols,
  value,
  onChange,
}: {
  kols: ReturnType<typeof buildKolTargets>;
  value: number;
  onChange: (index: number) => void;
}) {
  return (
    <div>
      <label htmlFor="report-kol" className="text-xs text-ink-muted">
        KOL
      </label>
      <select
        id="report-kol"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1 w-full rounded border border-hairline bg-surface-2 px-2 py-1.5 text-xs text-ink"
      >
        {kols.map((k, i) => (
          // Blocked KOLs stay in the list, disabled, with the contract's own reason. Hiding them
          // would answer "why is this promoter missing?" with silence — same rule ProjectActions
          // follows for lifecycle actions it cannot run.
          <option key={k.promoter} value={i} disabled={Boolean(k.blocked)}>
            {shortAddress(k.promoter)}
            {k.blocked
              ? ` — ${k.blocked}`
              : ` — ${k.live.length} referral${k.live.length === 1 ? "" : "s"}`}
          </option>
        ))}
      </select>
    </div>
  );
}

function KpiSelect({
  kpis,
  value,
  onChange,
}: {
  kpis: CampaignDetail["kpis"];
  value: number;
  onChange: (index: number) => void;
}) {
  return (
    <div>
      <label htmlFor="report-kpi" className="text-xs text-ink-muted">
        KPI
      </label>
      <select
        id="report-kpi"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1 w-full rounded border border-hairline bg-surface-2 px-2 py-1.5 text-xs text-ink"
      >
        {kpis.map((k) => (
          <option key={k.index} value={k.index} disabled={k.spec.aggregate}>
            [{k.index}] {KPI_KIND_LABEL[k.spec.kind]}
            {k.spec.aggregate ? " — aggregate, never credits a KOL" : ""}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * The amount, derived from the selected KOL and KPI rather than typed.
 *
 * Read-only by design: a report exists to release the next tier, so the figure is whatever closes
 * the gap to that threshold, and every other figure is either short of it (paying nothing) or past
 * it (crediting progress the promoter did not earn). Rendered as text, not a disabled input — a
 * greyed-out box reads as "temporarily unavailable" and invites the dev to look for the enable.
 *
 * The tier's payout is shown beside the delta but is never the delta; see `nextTierSeed` for why
 * conflating KPI units with an 18-decimal token amount is the mistake worth designing against.
 */
function AmountField({
  seed,
  loading,
  unitLabel,
  decimals,
  symbol,
}: {
  seed: TierSeed | null;
  loading: boolean;
  unitLabel: string;
  decimals: number;
  symbol: string;
}) {
  return (
    <div>
      <span className="text-xs text-ink-muted">Amount to credit</span>
      <div className="mt-1 rounded border border-hairline bg-surface-2 px-2 py-1.5 text-xs">
        {loading ? (
          <span className="text-ink-muted">Reading progress…</span>
        ) : seed ? (
          <>
            <span className="font-mono text-ink">{seed.delta.toString()}</span>{" "}
            <span className="text-ink-muted">{unitLabel.toLowerCase()}</span>
          </>
        ) : (
          <span className="text-ink-muted">Ladder complete</span>
        )}
      </div>

      <p className="mt-1 text-[11px] text-ink-muted">
        {loading ? (
          " "
        ) : seed ? (
          <>
            Clears tier {seed.index + 1} at {seed.threshold.toString()} — pays{" "}
            {formatTokenAmount(seed.reward, decimals)} {symbol}
          </>
        ) : (
          "Every tier is already crossed; there is nothing left to release."
        )}
      </p>
    </div>
  );
}

/**
 * What the button is about to do, per referral.
 *
 * Shown rather than summarised because the calls are the part a dev needs to be able to check: the
 * amount is spread across referrals, `newTotal` is cumulative, and a wrong figure here credits a
 * real wallet on chain.
 */
function PlanBreakdown({
  plan,
  progress,
  kol,
  unitLabel,
}: {
  plan: Extract<ReturnType<typeof planKolReport>, {ok: true}>;
  progress: bigint;
  kol: ReturnType<typeof buildKolTargets>[number];
  unitLabel: string;
}) {
  return (
    <div className="rounded border border-hairline bg-surface-2 p-3 text-xs">
      <p className="text-ink-secondary">
        {shortAddress(kol.promoter)} goes from{" "}
        <span className="font-mono text-ink">{progress.toString()}</span> to{" "}
        <span className="font-mono text-ink">{plan.projectedProgress.toString()}</span>{" "}
        {unitLabel.toLowerCase()} across {plan.calls.length} transaction
        {plan.calls.length === 1 ? "" : "s"}.
      </p>

      <ul className="mt-2 space-y-1">
        {plan.calls.map((call) => (
          <li key={call.referral} className="flex justify-between gap-3 font-mono text-ink-muted">
            <span>{shortAddress(call.referral)}</span>
            <span>
              +{call.delta.toString()} → newTotal {call.newTotal.toString()}
            </span>
          </li>
        ))}
      </ul>

      <p className="mt-2 text-ink-muted">
        Settlement runs inline: each report credits progress and pays any tier it crosses in the
        same transaction.
      </p>
    </div>
  );
}

/** Mirrors `ProjectActions`' status line, including `role="status"` so a mined tx is announced. */
function TxFeedback({state, onReset}: {state: TxState; onReset: () => void}) {
  if (state.status === "idle") return null;

  return (
    <div role="status" aria-live="polite" className="text-xs">
      {state.status === "preparing" ? (
        <p className="text-ink-muted">Confirm in your wallet…</p>
      ) : state.status === "submitted" ? (
        <p className="text-ink-muted">
          Submitted — waiting for confirmation.{" "}
          <span className="font-mono text-[11px] text-ink-secondary">
            {state.hash.slice(0, 10)}…
          </span>
        </p>
      ) : state.status === "confirmed" ? (
        <p className="text-good">Confirmed.</p>
      ) : (
        <p>
          <TxErrorMessage message={state.message} detail={state.detail} onDismiss={onReset} />
        </p>
      )}
    </div>
  );
}
