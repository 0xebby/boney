import {kpiKindFromIndex, type KpiKind} from "./types";

/**
 * Boneyard points — the fold that turns indexed protocol history into a leaderboard.
 *
 * Pure and React-free. Every rule here is a statement about rows the subgraph already holds, so no
 * action needs to be re-emitted or backfilled for it to score.
 */

/** Points for joining one campaign as a promoter. */
export const POINTS_JOIN = 250;

/** Points for signing an attribution on one campaign. */
export const POINTS_TOUCH = 100;

/** Points per credited action, to the referral who performed it. */
export const POINTS_REFERRAL_ACTION = 10;

/** Points per credited action, to the promoter who drove it. */
export const POINTS_PROMOTER_ACTION = 25;

/** Points per credited report on a magnitude KPI, to the referral. */
export const POINTS_REFERRAL_REPORT = 25;

/** Points per credited report on a magnitude KPI, to the promoter. */
export const POINTS_PROMOTER_REPORT = 60;

/** KPI kinds whose credited amount is a token quantity rather than a count of actions. */
const MAGNITUDE_KINDS: readonly KpiKind[] = ["Tvl", "Volume"];

/** One KPI's unit, as needed to score the credits against it. */
export type PointsKpi = {
  /** `<campaign>-<index>`, matching the subgraph's `Kpi.id`. */
  id: string;
  /** `Types.KpiKind` as an int. */
  kind: number;
  /** `1` reads a token amount from the first data word, `0` counts logs, `undefined` for neither. */
  amountMode: number | undefined;
};

/** One `Promoter` row that carries a wallet. */
export type PointsJoin = {promoterId: string; wallet: string};

/** One `Touch` row. */
export type PointsTouch = {user: string};

/** One `Credit` row. */
export type PointsCredit = {
  /** Lowercased campaign address. */
  campaign: string;
  kpiIndex: number;
  promoterId: string;
  /** The referral who performed the action. */
  user: string;
  /** Raw KPI units, as `ProgressCredited` emitted them. A delta, not a running total. */
  amount: bigint;
};

/** Everything the fold reads. */
export type PointsInput = {
  joins: readonly PointsJoin[];
  touches: readonly PointsTouch[];
  credits: readonly PointsCredit[];
  kpis: readonly PointsKpi[];
};

/** A per-bucket split, used for both event counts and the points they earned. */
export type PointsBreakdown = {
  joins: number;
  touches: number;
  referralActions: number;
  promoterActions: number;
};

/** One wallet's standing. */
export type PointsRow = {
  /** Lowercased wallet address. */
  wallet: string;
  /** 1-based, with ties sharing a rank and the next rank skipping. */
  rank: number;
  total: number;
  /** How many of each event this wallet has. */
  counts: PointsBreakdown;
  /** Points earned from each event. */
  earned: PointsBreakdown;
};

/**
 * Whether a KPI's credited amount is a magnitude rather than a count of actions.
 *
 * @param kpi The KPI to classify, or `undefined` when no indexed KPI matches the credit.
 * @returns True when the amount is a token quantity and must not be multiplied into points.
 */
export function isMagnitudeKpi(kpi: PointsKpi | undefined): boolean {
  if (!kpi) return true;
  if (kpi.amountMode === 1) return true;
  return MAGNITUDE_KINDS.includes(kpiKindFromIndex(kpi.kind));
}

const emptyBreakdown = (): PointsBreakdown => ({
  joins: 0,
  touches: 0,
  referralActions: 0,
  promoterActions: 0,
});

/**
 * Largest amount one credit may contribute as an action count.
 *
 * A delta above this is treated as a magnitude and scored flat, since no `(user, KPI)` pair performs
 * that many actions between two reports.
 */
const MAX_ACTIONS_PER_CREDIT = 100_000;

type Accum = {counts: PointsBreakdown; earned: PointsBreakdown};

const lower = (value: string): string => value.toLowerCase();

/**
 * The accumulator for one wallet, created on first sight.
 *
 * @param map Accumulators so far, keyed by lowercased wallet.
 * @param wallet Lowercased wallet address.
 * @returns That wallet's accumulator.
 */
function bucketFor(map: Map<string, Accum>, wallet: string): Accum {
  const existing = map.get(wallet);
  if (existing) return existing;
  const created: Accum = {counts: emptyBreakdown(), earned: emptyBreakdown()};
  map.set(wallet, created);
  return created;
}

/**
 * How many actions a credit represents, and the points each side earns for it.
 *
 * @param credit The credit row.
 * @param kpi The KPI it was credited against, or `undefined` when none is indexed.
 * @returns Action count plus referral and promoter points, or `undefined` for a zero credit.
 */
function scoreCredit(
  credit: PointsCredit,
  kpi: PointsKpi | undefined,
): {actions: number; referral: number; promoter: number} | undefined {
  if (credit.amount <= BigInt(0)) return undefined;

  const raw = Number(credit.amount);
  const countable =
    !isMagnitudeKpi(kpi) && Number.isSafeInteger(raw) && raw <= MAX_ACTIONS_PER_CREDIT;

  if (!countable) {
    return {actions: 1, referral: POINTS_REFERRAL_REPORT, promoter: POINTS_PROMOTER_REPORT};
  }

  return {
    actions: raw,
    referral: raw * POINTS_REFERRAL_ACTION,
    promoter: raw * POINTS_PROMOTER_ACTION,
  };
}

/**
 * Rank every wallet that has earned a point.
 *
 * Joins score per campaign joined, attributions per campaign signed — the subgraph keeps one `Touch`
 * per `(campaign, user)` pair, so a re-signature is not a second row and cannot score twice. A
 * credited action pays the referral who performed it and the promoter who drove it, the promoter at
 * the higher rate.
 *
 * @param input Join, attribution, credit and KPI rows from the subgraph.
 * @returns Rows ordered by total descending then wallet ascending, ranked with ties sharing a rank.
 */
export function foldPoints(input: PointsInput): PointsRow[] {
  const kpiById = new Map(input.kpis.map((kpi) => [lower(kpi.id), kpi]));
  const walletOf = new Map(input.joins.map((join) => [lower(join.promoterId), lower(join.wallet)]));
  const accums = new Map<string, Accum>();

  for (const join of input.joins) {
    const bucket = bucketFor(accums, lower(join.wallet));
    bucket.counts.joins += 1;
    bucket.earned.joins += POINTS_JOIN;
  }

  for (const touch of input.touches) {
    const bucket = bucketFor(accums, lower(touch.user));
    bucket.counts.touches += 1;
    bucket.earned.touches += POINTS_TOUCH;
  }

  for (const credit of input.credits) {
    const kpi = kpiById.get(lower(`${credit.campaign}-${credit.kpiIndex}`));
    const score = scoreCredit(credit, kpi);
    if (!score) continue;

    const referral = bucketFor(accums, lower(credit.user));
    referral.counts.referralActions += score.actions;
    referral.earned.referralActions += score.referral;

    // `Credit` carries only the promoter's campaign-bound id. A credit whose promoter has no wallet
    // row scores its referral side alone rather than being dropped.
    const promoterWallet = walletOf.get(lower(credit.promoterId));
    if (!promoterWallet) continue;
    const promoter = bucketFor(accums, promoterWallet);
    promoter.counts.promoterActions += score.actions;
    promoter.earned.promoterActions += score.promoter;
  }

  const scored = [...accums.entries()]
    .map(([wallet, accum]) => ({
      wallet,
      total: totalOf(accum.earned),
      counts: accum.counts,
      earned: accum.earned,
    }))
    .filter((row) => row.total > 0)
    .sort((a, b) => b.total - a.total || a.wallet.localeCompare(b.wallet));

  let rank = 0;
  let previous: number | undefined;
  return scored.map((row, index) => {
    if (row.total !== previous) {
      rank = index + 1;
      previous = row.total;
    }
    return {...row, rank};
  });
}

/**
 * Credited actions on both sides of a wallet's history.
 *
 * @param row A wallet's standing.
 * @returns Actions performed as a referral plus actions driven as a promoter.
 */
export function actionsOf(row: PointsRow): number {
  return row.counts.referralActions + row.counts.promoterActions;
}

/**
 * Every point in a breakdown.
 *
 * @param breakdown Points per bucket.
 * @returns Their sum.
 */
export function totalOf(breakdown: PointsBreakdown): number {
  return (
    breakdown.joins +
    breakdown.touches +
    breakdown.referralActions +
    breakdown.promoterActions
  );
}

/**
 * A total as a fraction of the leading total, for a bar width.
 *
 * @param total This row's points.
 * @param top The leading row's points.
 * @returns A fraction from 0 to 1; 0 when there is no leader to compare against.
 */
export function pointsShare(total: number, top: number): number {
  if (top <= 0) return 0;
  return Math.min(1, Math.max(0, total / top));
}

/**
 * One wallet's row, matched case-insensitively.
 *
 * @param rows Ranked rows from `foldPoints`.
 * @param wallet The wallet to look up, in any case; `undefined` when none is connected.
 * @returns That wallet's row, or `undefined` when it has not scored.
 */
export function findPointsRow(
  rows: readonly PointsRow[],
  wallet: string | undefined,
): PointsRow | undefined {
  if (!wallet) return undefined;
  const needle = lower(wallet);
  return rows.find((row) => row.wallet === needle);
}
