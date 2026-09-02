"use client";

import {useMemo, useState} from "react";
import {useAccount} from "wagmi";
import {Card, CardHeader} from "@/components/ui/Card";
import {TxErrorMessage} from "@/components/ui/TxErrorMessage";
import {Notice} from "@/components/ui/Notice";
import {useReportUserAction, isPending, type TxState} from "@/hooks/useWriteCampaign";
import {useCampaignPromoters} from "@/hooks/useCampaignPromoters";
import {useCampaignTouches} from "@/hooks/useCampaignTouches";
import {useKolReportState} from "@/hooks/useKolReportState";
import {useObservedActions} from "@/hooks/useObservedActions";
import {
  buildKolTargets,
  describeCeiling,
  planKolReport,
  planObservedReport,
  nextTierSeed,
  type CeilingStatus,
  type KolTarget,
  type ObservedReferral,
  type TierSeed,
} from "@/lib/reporting";
import {eventSourceSummary, type EventSource} from "@/lib/kpiSource";
import {catalogSignature} from "@/lib/eventNames";
import {isProjectWallet} from "@/lib/viewerRole";
import {shortAddress, formatTokenAmount} from "@/lib/format";
import {KPI_KIND_LABEL} from "@/lib/types";
import type {CampaignDetail} from "@/lib/campaignDetail";
import type {CampaignView} from "@/lib/types";

/**
 * Manual `reportUserAction` — a testing affordance for the project wallet.
 *
 * Progress is normally credited by `scripts/indexer.ts`, which watches each KPI's event source and
 * reports what it finds. This panel is that same job, run by hand, for a project that would rather
 * not stand up a cron to watch a testnet.
 *
 * **It reports what the chain says happened, not what would pay out.** The amount comes from the
 * KPI's declared event source — `useObservedActions` reads the logs, `planObservedReport` turns them
 * into calls — so a KOL whose referrals have done nothing produces no report, crosses no tier, and
 * pays nothing. This is worth stating because the panel used to do the opposite: it derived the
 * amount from the reward ladder (`nextTierSeed`, the gap to the next threshold), which meant every
 * click credited exactly enough to cross a tier and `Campaign.reportUserAction` settled it inline.
 * The button was a payout button wearing a report button's label.
 *
 * A KPI whose `params` declare no event source has nothing observable behind it, and every campaign
 * seeded before that feature is in that position. Rather than inventing a figure for them, the panel
 * blocks and offers an explicit simulate toggle — the old behavior, but opt-in, labelled, and
 * impossible to trigger by reflex.
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
  const isProject = isProjectWallet(address, detail.project);

  const [kolIndex, setKolIndex] = useState(0);
  const [kpiIndex, setKpiIndex] = useState(0);
  const [simulate, setSimulate] = useState(false);

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
    creditedTo,
    ceiling,
    configured: verifierConfigured,
    gated,
    isLoading: stateLoading,
    refetch: refetchState,
  } = useKolReportState({
    campaign: detail.address,
    promoter: kol?.promoter,
    promoterId: kol?.promoterId,
    referrals: liveReferrals,
    kpiIndex,
    kpiVerifier: kpi?.spec.verifier,
    enabled: isProject,
  });

  // What the KPI's event source says these referrals actually did. This is the report's basis.
  const activity = useObservedActions({
    campaign: detail.address,
    kpiIndex,
    params: kpi?.spec.params,
    referrals: liveReferrals,
    windows: touchScan.windows,
    enabled: isProject,
  });

  // The simulate opt-in only applies where it is offered: to a KPI with no event source. Checking
  // the toggle state alone let it latch — `simulate` survives a KPI change, and `SimulateToggle`
  // hides itself once a source exists, so ticking it on an unobservable KPI and then switching to an
  // observable one left the invented-amount path running with no affordance to turn it off. Every
  // consumer reads this rather than `simulate` so the readout and the plan cannot disagree about
  // which path is live.
  const simulating = simulate && activity.source === null;

  // Display only, both paths: which tier the KOL is standing in front of, so the breakdown can say
  // whether this report happens to release a payout. Never the reported amount — deriving the amount
  // from this is precisely the bug this panel was fixed for.
  const seed = kpi ? nextTierSeed(promoterProgress, kpi.tiers) : null;

  const plan = useMemo(() => {
    if (!kol || !kpi) return null;
    if (simulating) {
      return planKolReport({
        kol,
        amount: seed?.delta ?? BigInt(0),
        progress: promoterProgress,
        credited: creditedMap,
        aggregate: kpi.spec.aggregate,
      });
    }
    return planObservedReport({
      kol,
      observed: activity.observed,
      credited: creditedMap,
      creditedTo,
      aggregate: kpi.spec.aggregate,
      hasSource: activity.source !== null,
      progress: promoterProgress,
    });
  }, [
    kol,
    kpi,
    simulating,
    seed,
    promoterProgress,
    creditedMap,
    creditedTo,
    activity.observed,
    activity.source,
  ]);

  // What the report would actually be allowed to credit, against what was measured. Computed on the
  // observed path only: the simulate path credits an invented figure that Boney never saw, so its
  // ceiling is always 0 and saying so would just be noise on top of the warning it already carries.
  //
  // Each referral's *whole* observed total, not the selected KOL's segment of it — deliberately. The
  // ceiling this is compared against is `observedProgressOf(campaign, kpi, referral)`, which is
  // per-referral and cumulative across every promoter who held it. Narrowing this to one promoter's
  // share would compare a segment against a lifetime total and read as capped when nothing is.
  const measured = useMemo(
    () =>
      liveReferrals.reduce(
        (sum, r) => sum + (activity.observed.get(r.toLowerCase())?.observed ?? BigInt(0)),
        BigInt(0),
      ),
    [liveReferrals, activity.observed],
  );

  const ceilingStatus = useMemo(
    () =>
      simulating
        ? null
        : describeCeiling({gated, configured: verifierConfigured, ceiling, measured}),
    [simulating, gated, verifierConfigured, ceiling, measured],
  );

  if (!isProject) return null;

  const scanning = promoterScan.isLoading || touchScan.isLoading;
  const busy = isPending(report.state);
  const loading = stateLoading || activity.isLoading;

  const submit = async () => {
    if (!plan?.ok || !kpi || !kol) return;
    await report.report(detail.address, kpiIndex, kol.promoter, plan.calls, {
      campaignName: detail.name,
      kpiLabel: KPI_KIND_LABEL[kpi.spec.kind],
    });
    onDone();
    await Promise.all([touchScan.refetch(), refetchState(), activity.refetch()]);
  };

  return (
    <Card>
      <CardHeader title="Report progress" />

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
            <ObservedField
              source={activity.source}
              observed={activity.observed}
              referrals={liveReferrals}
              promoterId={kol?.promoterId}
              loading={loading}
              unitLabel={kpi ? KPI_KIND_LABEL[kpi.spec.kind] : ""}
              simulate={simulate}
              seed={seed}
              decimals={token.decimals}
              symbol={token.symbol}
            />
          </div>

          {loading ? (
            <p className="text-xs text-ink-muted">Reading progress and scanning KPI events…</p>
          ) : plan === null ? null : plan.ok ? (
            // Narrowed on `plan.ok` directly rather than `plan?.ok && kol`: the conjunction leaves
            // `plan` as the full union in the else branch, so `plan.reason` below does not compile.
            kol ? (
              <PlanBreakdown
                plan={plan}
                progress={promoterProgress}
                kol={kol}
                seed={seed}
                simulate={simulate}
                unitLabel={kpi ? KPI_KIND_LABEL[kpi.spec.kind] : ""}
                decimals={token.decimals}
                symbol={token.symbol}
              />
            ) : null
          ) : activity.error ? (
            // The scan's own failure, said in place of the plan's reason: a failed scan observes
            // nothing, and "no actions observed" would report that as a fact about the referrals.
            <p className="text-xs text-brand">
              Cannot report: the KPI event scan failed, so nothing was observed.{" "}
              <span className="font-mono text-[11px] text-ink-secondary">
                {String(activity.error)}
              </span>
            </p>
          ) : (
            <p className="text-xs text-brand">Cannot report: {plan.reason}</p>
          )}

          {loading || ceilingStatus === null ? null : (
            <CeilingNotice status={ceilingStatus} unitLabel={kpi ? KPI_KIND_LABEL[kpi.spec.kind] : ""} />
          )}

          <SimulateToggle
            checked={simulate}
            onChange={setSimulate}
            hasSource={activity.source !== null}
          />

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!plan?.ok || busy || loading}
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

          {touchScan.source === "logs" && touchScan.scannedFrom !== undefined ? (
            <p className="text-xs text-ink-muted">
              Attribution history was scanned from block{" "}
              {touchScan.scannedFrom.toLocaleString("en-US")} only, touches signed before that
              block will not appear here.
            </p>
          ) : null}

          {touchScan.truncated ? (
            <p className="text-xs text-ink-muted">
              More referrals are attributed than one read returns, so some are missing from the KOL
              list.
            </p>
          ) : null}

          {activity.scannedFrom !== undefined ? (
            <p className="text-xs text-ink-muted">
              KPI events were scanned from block{" "}
              {activity.scannedFrom.toLocaleString("en-US")} only — actions before that block are not
              counted.
            </p>
          ) : null}

          {activity.failedWindows > 0 ? (
            <p className="text-xs text-brand">
              {activity.failedWindows} log window
              {activity.failedWindows === 1 ? "" : "s"} failed to load, Refetch...
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
 * What the KPI's event source was observed doing — the report's basis, not a figure to edit.
 *
 * Read-only for a stronger reason than the old amount field was: there is nothing here a dev could
 * legitimately change. The number is a measurement, and a box that let it be overwritten would put
 * the invented-payout bug straight back. Overriding it is the simulate toggle's job, which says so
 * out loud.
 *
 * The event is named where it is known (`eventNames.catalogSignature`) rather than shown as a topic
 * hash: "which contract am I waiting on" is the question a dev asks when the total is zero, and a
 * 32-byte hash does not answer it.
 */
function ObservedField({
  source,
  observed,
  referrals,
  promoterId,
  loading,
  unitLabel,
  simulate,
  seed,
  decimals,
  symbol,
}: {
  source: EventSource | null;
  observed: ReadonlyMap<string, ObservedReferral>;
  referrals: readonly `0x${string}`[];
  /** The selected KOL's id, to pick its own segment out of each referral's split. */
  promoterId: `0x${string}` | undefined;
  loading: boolean;
  unitLabel: string;
  simulate: boolean;
  seed: TierSeed | null;
  decimals: number;
  symbol: string;
}) {
  // The selected KOL's share, and everything measured on these referrals. They differ whenever a
  // referral re-signed: `ObservedReferral.observed` is that referral's whole attributed history and the
  // chain splits it back per promoter, so showing the total here read as the previous promoter's work
  // plus this one's — the number a project was about to credit, attributed to the wrong wallet.
  const promoterKey = promoterId?.toLowerCase();
  let mine = BigInt(0);
  let total = BigInt(0);
  for (const referral of referrals) {
    const seen = observed.get(referral.toLowerCase());
    if (!seen) continue;
    total += seen.observed;
    if (promoterKey) mine += seen.byPromoter.get(promoterKey) ?? BigInt(0);
  }
  const earlier = total > mine ? total - mine : BigInt(0);

  // The simulate path keeps the old readout, relabelled to say what the figure is: invented, and
  // aimed squarely at a payout. Same number, no longer presented as a fact about anyone's activity.
  if (simulate) {
    return (
      <div>
        <span className="text-xs text-ink-muted">Simulated amount</span>
        <div className="mt-1 rounded border border-brand-dim/40 bg-surface-2 px-2 py-1.5 text-xs">
          {seed ? (
            <>
              <span className="font-mono text-ink">{seed.delta.toString()}</span>{" "}
              <span className="text-ink-muted">{unitLabel.toLowerCase()}</span>
            </>
          ) : (
            <span className="text-ink-muted">Ladder complete</span>
          )}
        </div>

        <p className="mt-1 text-[11px] text-brand">
          {seed ? (
            <>
              Invented figure: clears tier {seed.index + 1} at {seed.threshold.toString()} and pays{" "}
              {formatTokenAmount(seed.reward, decimals)} {symbol}. No event supports it.
            </>
          ) : (
            "Every tier is already crossed; there is nothing left to release."
          )}
        </p>
      </div>
    );
  }

  return (
    <div>
      <span className="text-xs text-ink-muted">Observed activity</span>
      <div className="mt-1 rounded border border-hairline bg-surface-2 px-2 py-1.5 text-xs">
        {loading ? (
          <span className="text-ink-muted">Scanning events…</span>
        ) : !source ? (
          <span className="text-ink-muted">No event source</span>
        ) : (
          <>
            <span className="font-mono text-ink">{mine.toString()}</span>{" "}
            <span className="text-ink-muted">{unitLabel.toLowerCase()}</span>
          </>
        )}
      </div>

      <p className="mt-1 text-[11px] text-ink-muted">
        {loading ? (
          " "
        ) : !source ? (
          "This KPI declares no event source, so nothing about it is observable."
        ) : earlier > BigInt(0) ? (
          <>
            This KOL&rsquo;s share of <span className="font-mono">{total.toString()}</span>;{" "}
            <span className="font-mono">{earlier.toString()}</span> credits an earlier promoter.
            Measured from {eventSourceSummary(source, catalogSignature(source.topic0))}
          </>
        ) : (
          <>Measured from {eventSourceSummary(source, catalogSignature(source.topic0))}</>
        )}
      </p>
    </div>
  );
}

/**
 * The opt-in that re-enables crediting progress nothing happened for.
 *
 * Exists because the panel's original job — exercising settlement on a campaign with no event source
 * — is still a real need, and blocking it outright would leave every campaign seeded before event
 * sourcing untestable. But it is off by default and named for what it does: the label says the
 * figure is invented and that a payout follows, because the failure mode here was a dev reaching for
 * a button that quietly paid out.
 *
 * Hidden entirely when the KPI *does* have an event source. There, simulating would mean overriding
 * a measurement that exists — a thing worth having no affordance for at all.
 */
function SimulateToggle({
  checked,
  onChange,
  hasSource,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  hasSource: boolean;
}) {
  if (hasSource) return null;

  return (
    <label className="flex items-start gap-2 text-xs">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 accent-brand"
      />
      <span>
        <span className="text-ink-secondary">Simulate un-observed progress</span>
        <span className="block text-[11px] text-ink-muted">
          Credits enough to clear the next tier and pays it out, with no on-chain activity behind it.
          Testing only — this is not what the indexer would report.
        </span>
      </span>
    </label>
  );
}

/**
 * What the button is about to do, per referral.
 *
 * Shown rather than summarised because the calls are the part a dev needs to be able to check: the
 * per-referral figure is a measurement, `newTotal` is cumulative, and a wrong figure here credits a
 * real wallet on chain.
 *
 * Whether a payout follows is stated conditionally, from the projected progress against the next
 * threshold. The old copy said settlement runs inline and left it there, which was true but read as
 * "this pays out" — and back then it always did, because the amount was the threshold gap. Now most
 * reports credit progress and pay nothing, so the line has to distinguish the two cases.
 */
function PlanBreakdown({
  plan,
  progress,
  kol,
  seed,
  simulate,
  unitLabel,
  decimals,
  symbol,
}: {
  plan: Extract<ReturnType<typeof planObservedReport>, {ok: true}>;
  progress: bigint;
  kol: KolTarget;
  /** The next uncrossed tier, for saying whether this report releases it. */
  seed: TierSeed | null;
  simulate: boolean;
  unitLabel: string;
  decimals: number;
  symbol: string;
}) {
  const crosses = seed !== null && plan.projectedProgress >= seed.threshold;

  // What the same calls credit to *other* promoters. A cumulative `newTotal` covers a referral's whole
  // attributed history, so a report can carry work from a spell under someone else — stated here
  // because it moves nobody the panel has selected, and an unexplained gap between the figures reads
  // as the plan losing units.
  const elsewhere = plan.calls.reduce((sum, call) => sum + call.elsewhere, BigInt(0));
  const unit = unitLabel.toLowerCase();
  const txCount = `${plan.calls.length} transaction${plan.calls.length === 1 ? "" : "s"}`;

  return (
    <div className="rounded border border-hairline bg-surface-2 p-3 text-xs">
      <p className="text-ink-secondary">
        {plan.totalDelta === BigInt(0) ? (
          <>
            {shortAddress(kol.promoter)} stays at{" "}
            <span className="font-mono text-ink">{progress.toString()}</span> {unit}: the{" "}
            <span className="font-mono text-ink">{elsewhere.toString()}</span> in {txCount} credits an
            earlier promoter.
          </>
        ) : (
          <>
            {shortAddress(kol.promoter)} goes from{" "}
            <span className="font-mono text-ink">{progress.toString()}</span> to{" "}
            <span className="font-mono text-ink">{plan.projectedProgress.toString()}</span> {unit}{" "}
            across {txCount}.
            {elsewhere > BigInt(0) ? (
              <>
                {" "}
                A further <span className="font-mono text-ink">{elsewhere.toString()}</span> credits
                earlier promoters.
              </>
            ) : null}
          </>
        )}
      </p>

      <ul className="mt-2 space-y-1">
        {plan.calls.map((call) => (
          <li key={call.referral} className="flex justify-between gap-3 font-mono text-ink-muted">
            <span>{shortAddress(call.referral)}</span>
            <span>
              +{call.delta.toString()}
              {call.elsewhere > BigInt(0) ? (
                <span className="text-ink-muted"> (+{call.elsewhere.toString()} earlier)</span>
              ) : null}{" "}
              → newTotal {call.newTotal.toString()}
            </span>
          </li>
        ))}
      </ul>

      <p className={`mt-2 ${crosses ? "text-brand" : "text-ink-muted"}`}>
        {plan.totalDelta === BigInt(0) ? (
          "Credits an earlier promoter only, so no tier moves and nothing pays out here."
        ) : crosses && seed ? (
          <>
            Crosses tier {seed.index + 1} at {seed.threshold.toString()}, so this pays{" "}
            {formatTokenAmount(seed.reward, decimals)} {symbol} inline —{" "}
            {simulate
              ? "for progress no event supports."
              : "settlement runs in the same transaction as the report."}
          </>
        ) : seed ? (
          <>
            Credits progress only. Tier {seed.index + 1} needs {seed.threshold.toString()}{" "}
            {unitLabel.toLowerCase()}, so nothing pays out yet.
          </>
        ) : (
          "Every tier is already crossed; this credits progress and pays nothing."
        )}
      </p>
    </div>
  );
}

/**
 * Boney's ceiling, stated before the click.
 *
 * The gap this closes: a gated KPI credits `min(claim, ceiling)`, and a report that lands before the
 * relayer has scanned **succeeds and credits nothing**. No revert, no error, a clean receipt, and a
 * progress bar that does not move. Confirmed on Base Sepolia — a claim of 12 confirmed successfully and
 * left progress at 0.
 *
 * Every other warning in this panel describes something the contract would *reject*. This one
 * describes something it will silently accept and discard, which is why it renders even when the plan
 * is otherwise fine.
 *
 * `clear` still renders. A quiet "will credit in full" is what makes the other states legible as
 * exceptions rather than as the panel having noticed nothing.
 */
function CeilingNotice({status, unitLabel}: {status: CeilingStatus; unitLabel: string}) {
  const unit = unitLabel.toLowerCase();

  if (status.kind === "ungated") return null;

  if (status.kind === "unconfigured") {
    return (
      <p className="text-xs text-brand">
        Boney&rsquo;s verifier has no configuration for this KPI, so every report will credit nothing —
        permanently.
      </p>
    );
  }

  if (status.kind === "blocked") {
    return (
      <p className="text-xs text-brand">
        Boney has observed <span className="font-mono">0</span> {unit} for these referrals, so this
        report will confirm successfully but credits nothing.
      </p>
    );
  }

  if (status.kind === "capped") {
    return (
      <p className="text-xs text-brand">
        Boney has observed <span className="font-mono">{status.ceiling.toString()}</span> of the{" "}
        <span className="font-mono">{status.measured.toString()}</span> {unit} measured here, so this
        report will be trimmed to the smaller figure.
      </p>
    );
  }

  return (
    <p className="text-xs text-ink-muted">
      Boney has independently observed <span className="font-mono">{status.ceiling.toString()}</span>{" "}
      {unit}, so this report will credit in full.
    </p>
  );
}

/** Mirrors `ProjectActions`' status line, including `role="status"` so a mined tx is announced. */
function TxFeedback({state, onReset}: {state: TxState; onReset: () => void}) {
  if (state.status === "idle") return null;

  if (state.status === "confirmed") {
    return <Notice tone="good" role="status" title="Confirmed." />;
  }

  if (state.status === "error") {
    return (
      <Notice
        tone="critical"
        title={<TxErrorMessage message={state.message} detail={state.detail} onDismiss={onReset} />}
      />
    );
  }

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
      ) : null}
    </div>
  );
}
