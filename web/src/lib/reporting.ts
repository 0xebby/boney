import {classifyTouch, type TouchStatus} from "./referrals";
import {nextTier} from "./campaign";
import type {RewardTier} from "./types";

/**
 * Planning `reportUserAction` calls from a KOL selection — the dev reporting tool.
 *
 * Pure and React-free (decision F6); the log scan lives in `useCampaignTouches` and the writes in
 * `useReportUserAction`. Everything that can credit the *wrong wallet* lives here, where a fixture
 * can prove it.
 *
 * ## Why a KOL selection needs planning at all
 *
 * `Campaign.reportUserAction(kpiIndex, user, newTotal, evidence)` takes a **referral** wallet, not
 * a promoter. It resolves the payee itself: `_resolvePromoterId(user)` reads the stored touch, and
 * a wallet with no live touch reverts `NoAttribution(user)`. So "report for this KOL" is not a call
 * the contract offers — it has to be turned into one call per referral currently attributed to
 * that KOL, which is what `planKolReport` does.
 *
 * Vocabulary, per `indexerCore`'s note: the ABI calls the attributed wallet `user` and those
 * strings are load-bearing, so they stay at the boundary. Here it is a **referral**. The web app
 * says "promoter" where the contracts say KOL; this file is named for the contract-side concept
 * because the dev tool it backs is explicitly a testing affordance over `reportUserAction`.
 */

/** One referral attributed to some promoter on one campaign, as reconstructed from a log. */
export type TouchEntry = {
  referral: `0x${string}`;
  promoterId: `0x${string}`;
  signedAt: bigint;
  expiresAt: bigint;
  /** Block the touch landed in, so a superseding touch can be picked out. */
  blockNumber: bigint;
};

/**
 * Collapses raw touch logs to one row per referral, keeping the newest.
 *
 * `AttributionRegistry` stores only the latest touch per `(campaign, user)` pair and accepts a new
 * one only when `signedAt` is strictly greater, so a referral who re-signed under a *different*
 * promoter appears in the log history under both — but only the newest is live on chain. Ordering
 * by `signedAt` (not block number) matches the contract's own comparison, so the row kept here is
 * the row `_resolvePromoterId` will read.
 */
export function latestTouches(entries: readonly TouchEntry[]): TouchEntry[] {
  const byReferral = new Map<string, TouchEntry>();

  for (const entry of entries) {
    const key = entry.referral.toLowerCase();
    const seen = byReferral.get(key);
    if (!seen || entry.signedAt > seen.signedAt) byReferral.set(key, entry);
  }

  return [...byReferral.values()];
}

/** A referral row with its live/expired classification resolved. */
export type ReferralTarget = TouchEntry & {status: TouchStatus};

/** One row in the KOL dropdown. */
export type KolTarget = {
  promoter: `0x${string}`;
  promoterId: `0x${string}`;
  /** Every referral whose newest touch names this KOL, live or expired. */
  referrals: ReferralTarget[];
  /** The subset that would actually credit — `status === "live"`. */
  live: ReferralTarget[];
  /**
   * Why this KOL cannot be reported for right now, or undefined when it can. Rendered as the
   * disabled reason rather than hiding the row: "why can't I report for this KOL?" is the question
   * the dropdown exists to answer, matching how `ProjectActions` treats blocked lifecycle actions.
   */
  blocked?: string;
};

/**
 * Builds the KOL dropdown for a campaign.
 *
 * Every promoter who joined is listed, including those nothing can be reported for — a KOL missing
 * from the list would read as a bug in the scan rather than as an un-attributed promoter.
 *
 * `expired` is reported separately from `none` because the two are different facts and the fix
 * differs: an expired touch needs the referral to re-sign, while `none` means that KOL's link was
 * never used. Collapsing them into "cannot report" would hide which.
 */
export function buildKolTargets(
  promoters: readonly {promoter: `0x${string}`; promoterId: `0x${string}`}[],
  touches: readonly TouchEntry[],
  nowSeconds: number,
): KolTarget[] {
  const byPromoterId = new Map<string, ReferralTarget[]>();

  for (const touch of latestTouches(touches)) {
    const key = touch.promoterId.toLowerCase();
    const row: ReferralTarget = {...touch, status: classifyTouch(touch, nowSeconds)};
    const list = byPromoterId.get(key);
    if (list) list.push(row);
    else byPromoterId.set(key, [row]);
  }

  return promoters.map(({promoter, promoterId}) => {
    const referrals = (byPromoterId.get(promoterId.toLowerCase()) ?? [])
      .slice()
      .sort((a, b) => (a.signedAt === b.signedAt ? 0 : a.signedAt > b.signedAt ? -1 : 1));
    const live = referrals.filter((r) => r.status === "live");

    let blocked: string | undefined;
    if (referrals.length === 0) {
      blocked = "no attribution touch — reportUserAction would revert NoAttribution";
    } else if (live.length === 0) {
      blocked = `attribution expired (${referrals.length} referral${
        referrals.length === 1 ? "" : "s"
      }) — the referral must re-sign a touch`;
    }

    return blocked === undefined
      ? {promoter, promoterId, referrals, live}
      : {promoter, promoterId, referrals, live, blocked};
  });
}

/**
 * Splits `total` into `count` shares, remainder to the last.
 *
 * Integer division loses the remainder, and a report that lands one unit short of a threshold does
 * not cross the tier — the whole point of the call. Giving the remainder to the last share keeps
 * the sum exact, the same correction `indexerCore.splitActions` makes for verifier evidence.
 */
export function splitAmount(total: bigint, count: number): bigint[] {
  if (count <= 0) return [];

  const share = total / BigInt(count);
  const out: bigint[] = [];
  let assigned = BigInt(0);

  for (let i = 0; i < count; i++) {
    const value = i === count - 1 ? total - assigned : share;
    assigned += value;
    out.push(value);
  }

  return out;
}

/** The next tier a KOL would cross, and what it takes to get there. */
export type TierSeed = {
  /** Ladder position, zero-based. */
  index: number;
  threshold: bigint;
  /** Token payout crossing this tier releases — display only; never the reported amount. */
  reward: bigint;
  /** KPI units to add. This is what the amount field is seeded with. */
  delta: bigint;
};

/**
 * The tier a report should aim at, and the progress that gets there.
 *
 * This is what seeds the amount field, so the panel opens on the number that releases the next
 * payout rather than an empty box the dev has to derive by reading the ladder.
 *
 * `delta` and `reward` are different units and must not be confused: `reportUserAction` credits
 * **KPI units**, and the tier's `reward` is the **token** payout that crossing it releases. Seeding
 * the field with `reward` would report a token amount as progress — usually a wildly wrong number,
 * since rewards carry 18 decimals and thresholds are small integers. `reward` is carried here only
 * so the panel can say what the report will pay out.
 *
 * Null when every tier is crossed: there is nothing left to release, and a report at that point is
 * a no-op the contract returns early on (`delta == 0`).
 */
export function nextTierSeed(progress: bigint, tiers: readonly RewardTier[]): TierSeed | null {
  const next = nextTier(progress, tiers);
  if (!next) return null;

  return {
    index: next.index,
    threshold: next.threshold,
    reward: next.reward,
    delta: next.threshold - progress,
  };
}

/** One `reportUserAction` call, ready to send. */
export type PlannedReport = {
  referral: `0x${string}`;
  /** Cumulative, as the ABI requires — this referral's credited total plus its share. */
  newTotal: bigint;
  /** The share itself, for display. */
  delta: bigint;
  /**
   * Per-action evidence backing `delta`, when the report is sourced from observed logs.
   *
   * Only meaningful for a verifier-gated KPI, which decodes it as `TouchWindowVerifier.Action[]`;
   * `verifier == address(0)` ignores the argument, so the caller sends `"0x"` rather than paying
   * calldata for a blob nothing reads. Absent on a simulated report, which has no actions behind it.
   */
  actions?: readonly {timestamp: bigint; amount: bigint}[];
};

export type ReportPlan =
  | {ok: true; calls: PlannedReport[]; totalDelta: bigint; projectedProgress: bigint}
  | {ok: false; reason: string};

/**
 * Turns "credit this KOL by `amount`" into the calls that do it — the **simulated** path.
 *
 * Nothing here consults what any referral actually did: the caller supplies the figure, and the
 * only thing this decides is how to spread it. That makes it the wrong default. A report built this
 * way credits progress no on-chain event supports, and because `Campaign.reportUserAction` settles
 * inline, an amount that happens to clear the next threshold pays a tier out on the spot. Seeding
 * that amount from `nextTierSeed` — the gap to the next rung — is how the panel used to guarantee a
 * payout on every click, for referrals that had done nothing at all. `planObservedReport` is the
 * honest path; this one is reachable only behind an explicit simulate opt-in, for KPIs whose
 * `params` declare no event source and therefore have nothing observable to report.
 *
 * `amount` is the progress to add to the KOL, spread across its live referrals so the KOL's total
 * advances by exactly that much. Spreading rather than repeating matters: `newTotal` is cumulative
 * per `(user, kpiIndex)`, so sending the same figure to three referrals credits the KOL three
 * times over, and the projected progress shown next to the button would be a lie.
 *
 * Refusals mirror named contract behavior, so the panel can explain a block without simulating:
 *
 *  - aggregate KPI → `AggregateKpi(kpiIndex)`; those never credit an individual promoter (D7).
 *  - no live referral → `NoAttribution(user)`.
 *  - zero amount → `Campaign` returns early on `delta == 0`. Since the amount is derived from
 *    `nextTierSeed`, zero means the ladder is finished rather than a mistyped figure.
 *
 * A referral whose share rounds to zero is dropped rather than sent: same early return, and it
 * would show up as a wallet confirmation that did nothing.
 */
export function planKolReport({
  kol,
  amount,
  progress,
  credited,
  aggregate,
}: {
  kol: KolTarget;
  amount: bigint;
  /** The KOL's current progress on this KPI, from `progressOf`. */
  progress: bigint;
  /** Each live referral's `userCreditedOf(referral, kpiIndex)`, keyed lowercase. */
  credited: ReadonlyMap<string, bigint>;
  aggregate: boolean;
}): ReportPlan {
  if (aggregate) {
    return {ok: false, reason: "aggregate KPIs never credit a promoter — reverts AggregateKpi"};
  }
  if (kol.blocked) return {ok: false, reason: kol.blocked};
  if (amount <= BigInt(0)) {
    return {
      ok: false,
      reason: "every tier on this KPI is already crossed — there is nothing left to release",
    };
  }

  const shares = splitAmount(amount, kol.live.length);
  const calls: PlannedReport[] = [];
  let totalDelta = BigInt(0);

  for (let i = 0; i < kol.live.length; i++) {
    const delta = shares[i]!;
    if (delta <= BigInt(0)) continue;

    const referral = kol.live[i]!.referral;
    const already = credited.get(referral.toLowerCase()) ?? BigInt(0);
    calls.push({referral, newTotal: already + delta, delta});
    totalDelta += delta;
  }

  if (calls.length === 0) {
    return {ok: false, reason: "amount is too small to split across this KOL's referrals"};
  }

  return {ok: true, calls, totalDelta, projectedProgress: progress + totalDelta};
}

/** What one referral was observed doing on a KPI's declared event source. */
export type ObservedReferral = {
  referral: `0x${string}`;
  /** Post-scaling total across every matched log, as `aggregateByActor` folds it. */
  observed: bigint;
  /** Per-log contributions, for verifier evidence. */
  actions: readonly {timestamp: bigint; amount: bigint}[];
};

/**
 * Whether Boney's independently observed total will let a report credit anything.
 *
 * ## The failure this exists to make visible
 *
 * A gated KPI credits `min(project's claim, Boney's observed total)`, and Boney's total is 0 until
 * `pnpm relay` has scanned. A report that lands first is **not** a revert — `Campaign` returns early
 * when the verified total does not exceed what is already credited, so the transaction *succeeds* and
 * credits nothing. Verified on Base Sepolia: a claim of 12 confirmed successfully and left progress at
 * 0, `paidOut` at 0.
 *
 * That is the worst shape a failure can take. There is no revert to surface, no error to catch, and the
 * receipt looks exactly like a working report. Without this readout the only symptom is a progress bar
 * that never moves, and the panel that caused it says nothing.
 *
 * So the ceiling is read and shown *before* the click. `observedProgressOf` exists on
 * `EventMetricKpiVerifier` for precisely this purpose and had no UI reader until now.
 */
export type CeilingStatus =
  /** The KPI names no verifier, so nothing caps the claim and there is no ceiling to show. */
  | {kind: "ungated"}
  /**
   * Gated, but Boney's verifier has no config for this KPI — `setKpiConfig` never ran. Every report
   * credits nothing, permanently, and no amount of relayer uptime fixes it.
   */
  | {kind: "unconfigured"}
  /** Configured, but nothing observed yet. The relayer has not caught up; a report now credits 0. */
  | {kind: "blocked"}
  /** Observed less than measured, so a report will be trimmed to the ceiling. */
  | {kind: "capped"; ceiling: bigint; measured: bigint}
  /** Observed at or above what was measured, so the ceiling will not bind. */
  | {kind: "clear"; ceiling: bigint};

/**
 * Classifies the ceiling against what the panel measured.
 *
 * `measured` is the sum across the referrals a report would cover, and `ceiling` the sum of their
 * `observedProgressOf`. Compared in aggregate rather than per referral because the panel reports a KOL
 * as one action; per-referral capping is the contract's job, and reproducing it here would be a second
 * implementation of the rule that decides payouts.
 *
 * **The two figures are not measuring quite the same thing**, which is why `capped` cannot be
 * described as a delay. `measured` comes from the browser's log scan (`useObservedActions`), which
 * folds every matched log for these referrals. `ceiling` comes from the relayer, which excludes
 * activity predating each user's own `signedAt`. So a gap is either the relayer being behind — which
 * the next run closes — or pre-attribution activity, which is excluded permanently and by design. This
 * function cannot tell them apart, so the copy must name both rather than promising either.
 */
export function describeCeiling(input: {
  /** Whether `KpiSpec.verifier` points at the guard wrapping Boney's verifier. */
  gated: boolean;
  /** Whether `EventMetricKpiVerifier.configOf(...).configured` is set. */
  configured: boolean;
  ceiling: bigint;
  measured: bigint;
}): CeilingStatus {
  if (!input.gated) return {kind: "ungated"};
  if (!input.configured) return {kind: "unconfigured"};
  if (input.ceiling === BigInt(0)) return {kind: "blocked"};
  if (input.ceiling < input.measured) {
    return {kind: "capped", ceiling: input.ceiling, measured: input.measured};
  }
  return {kind: "clear", ceiling: input.ceiling};
}

/**
 * Turns observed on-chain activity into the calls that credit it — the honest path.
 *
 * This is what a report is *supposed* to be: the KPI's `params` name a contract and an event
 * (`lib/kpiSource`), the logs say which attributed wallets triggered it and how much, and the
 * report records that. A referral who did nothing produces no call, so no tier is crossed and
 * nothing pays out. `planKolReport` cannot make that distinction — it credits whatever figure it is
 * handed — which is why this exists alongside it rather than on top of it.
 *
 * Same rules as `scripts/indexer.ts`, which reports the same numbers unattended:
 *
 *  - `observed` is **cumulative**, not a delta: it is everything the scan saw, so `newTotal` is the
 *    observed total itself and re-reporting the same range is the no-op `Campaign` returns early on.
 *  - A referral already credited at or above what was observed is dropped, not sent — `delta == 0`
 *    is an early return on chain and a pointless wallet confirmation here. This is also what makes
 *    the button idempotent: click it twice and the second click has nothing to do.
 *
 * Refusals mirror `planKolReport`'s so the panel renders one warning either way, plus the two this
 * path adds: a KPI with no event source has nothing to observe, and an observed total of zero means
 * the referrals genuinely have not acted yet.
 */
export function planObservedReport({
  kol,
  observed,
  credited,
  aggregate,
  hasSource,
  progress,
}: {
  kol: KolTarget;
  /** Observed activity per live referral, keyed lowercase. Absent referrals count as zero. */
  observed: ReadonlyMap<string, ObservedReferral>;
  /** Each live referral's `userCreditedOf(referral, kpiIndex)`, keyed lowercase. */
  credited: ReadonlyMap<string, bigint>;
  aggregate: boolean;
  /** Whether the KPI's `params` decoded to an event source at all. */
  hasSource: boolean;
  /** The KOL's current progress on this KPI, from `progressOf`. */
  progress: bigint;
}): ReportPlan {
  if (aggregate) {
    return {ok: false, reason: "aggregate KPIs never credit a promoter — reverts AggregateKpi"};
  }
  if (kol.blocked) return {ok: false, reason: kol.blocked};
  if (!hasSource) {
    return {
      ok: false,
      reason:
        "this KPI declares no event source, so there is no activity to observe — reporting a " +
        "figure anyway would credit progress nothing on chain supports",
    };
  }

  const calls: PlannedReport[] = [];
  let totalDelta = BigInt(0);
  let sawActivity = false;

  for (const target of kol.live) {
    const key = target.referral.toLowerCase();
    const seen = observed.get(key);
    if (!seen || seen.observed <= BigInt(0)) continue;
    sawActivity = true;

    const already = credited.get(key) ?? BigInt(0);
    if (seen.observed <= already) continue;

    calls.push({
      referral: target.referral,
      newTotal: seen.observed,
      delta: seen.observed - already,
      actions: seen.actions,
    });
    totalDelta += seen.observed - already;
  }

  if (calls.length === 0) {
    return {
      ok: false,
      reason: sawActivity
        ? "every observed action is already credited — nothing new to report"
        : "no KPI actions observed for this KOL's referrals yet",
    };
  }

  return {ok: true, calls, totalDelta, projectedProgress: progress + totalDelta};
}
