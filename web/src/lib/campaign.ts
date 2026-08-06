import type {CampaignView} from "./types";

/**
 * Campaign domain helpers — pure derivations for the marketplace table and detail view.
 * Status labels, time remaining, pool utilization, and tier math live here so they are
 * unit-testable without a DOM or a chain.
 */

/** The campaign is live and reporting. */
export function isLive(status: CampaignView["status"]): boolean {
  return status === "Active";
}

/**
 * Whether the claim grace window has passed and the project can reclaim unspent funds.
 *
 * `endedAt` is when `end()` was actually called, which is NOT `endTime`: a project can leave a
 * campaign un-ended long past its scheduled window, and `Campaign.reclaimUnspent` measures the
 * grace period from `endedAt`. Passing `endTime` here would show "reclaimable" while the contract
 * still reverts with `ClaimWindowOpen`. Callers that only have a `CampaignView` (the marketplace
 * table) do not have `endedAt` and must use `reclaimableFromView`, which is deliberately
 * conservative.
 *
 * Mirrors `Campaign.reclaimUnspent`: the contract reverts while `block.timestamp <= endedAt +
 * CLAIM_GRACE`, so the boundary second itself is still closed.
 */
export function isReclaimable(
  status: CampaignView["status"],
  endedAtSeconds: number,
  nowSeconds: number,
  graceSeconds: number,
): boolean {
  if (status === "Cancelled") return true;
  if (status !== "Ended") return false;
  if (endedAtSeconds <= 0) return false;
  return nowSeconds > endedAtSeconds + graceSeconds;
}

/**
 * Reclaim eligibility from a summary row alone, where `endedAt` is unknown.
 *
 * `endTime` is a lower bound on `endedAt`, so "the grace period could not possibly have elapsed
 * yet" is decidable while "it has elapsed" is not. Returns `false` in the undecidable case rather
 * than promising an action the contract may reject.
 */
export function reclaimableFromView(
  view: Pick<CampaignView, "status" | "endTime">,
  nowSeconds: number,
  graceSeconds: number,
): boolean {
  if (view.status === "Cancelled") return true;
  if (view.status !== "Ended") return false;
  return nowSeconds > Number(view.endTime) + graceSeconds;
}

/** Seconds until the project may reclaim, or 0 once the window is open. */
export function reclaimAvailableIn(
  endedAtSeconds: number,
  nowSeconds: number,
  graceSeconds: number,
): number {
  const opensAt = endedAtSeconds + graceSeconds;
  return nowSeconds > opensAt ? 0 : opensAt - nowSeconds + 1;
}

/** 0..1 fraction of the pool already paid out. */
export function utilization(view: Pick<CampaignView, "paidOut" | "rewardPool">): number {
  if (view.rewardPool === BigInt(0)) return 0;
  const paid = Number(view.paidOut);
  const pool = Number(view.rewardPool);
  if (!Number.isFinite(paid) || !Number.isFinite(pool) || pool <= 0) return 0;
  return Math.min(1, Math.max(0, paid / pool));
}

/** BigInt-literal-free comparison (avoids the ES2020 floor surprising people in tests). */
export function isZero(v: bigint): boolean {
  return v === BigInt(0);
}

/**
 * The next tier threshold a promoter is working toward, or `null` when the ladder is done.
 * `tiers` is the campaign's ladder for one KPI (threshold, reward) in ascending order.
 */
export function nextTier(
  progress: bigint,
  tiers: readonly {threshold: bigint; reward: bigint}[],
): {threshold: bigint; reward: bigint; index: number} | null {
  for (let i = 0; i < tiers.length; i++) {
    if (progress < tiers[i].threshold) return {...tiers[i], index: i};
  }
  return null;
}

/**
 * Total rewards earned across every tier whose threshold the promoter has crossed.
 * This is lifetime earned, settled or not — see `unsettledRewards` for what `settle` would pay.
 */
export function claimableRewards(
  progress: bigint,
  tiers: readonly {threshold: bigint; reward: bigint}[],
): bigint {
  let total = BigInt(0);
  for (const tier of tiers) {
    if (progress >= tier.threshold) total += tier.reward;
  }
  return total;
}

/**
 * How many tiers of the ladder the promoter has crossed.
 *
 * Mirrors `Campaign._settle`'s loop, which walks the ladder in order from `_settledTiers` and
 * stops at the first un-crossed threshold. Thresholds are ascending by construction (the
 * constructor enforces it), so this is the count of a prefix.
 */
export function crossedTierCount(
  progress: bigint,
  tiers: readonly {threshold: bigint}[],
): number {
  let count = 0;
  while (count < tiers.length && progress >= tiers[count].threshold) count++;
  return count;
}

/**
 * Rewards a `settle` call would pay right now: the crossed tiers not yet marked settled.
 *
 * `settledTiers` is the contract's `_settledTiers[promoter][kpiIndex]` — a *count* of the next
 * unsettled tier index, not a bitmap. The contract advances that counter even when the pool
 * cannot cover a tier (it emits `PoolExhausted` for the shortfall), so a settled tier is never
 * revisited and this must not re-count it.
 */
export function unsettledRewards(
  progress: bigint,
  tiers: readonly {threshold: bigint; reward: bigint}[],
  settledTiers: number,
): bigint {
  const crossed = crossedTierCount(progress, tiers);
  let total = BigInt(0);
  for (let i = settledTiers; i < crossed; i++) total += tiers[i].reward;
  return total;
}

/**
 * What `settle` would actually transfer, capped by the pool's remaining balance.
 *
 * `Campaign._settle` pays `min(reward, rewardPool - paidOut)` per tier, so a promoter whose
 * earned total exceeds the remaining pool is paid less than they earned. Surfacing the capped
 * figure keeps the UI from promising money the escrow cannot cover.
 */
export function settlementPayout(
  progress: bigint,
  tiers: readonly {threshold: bigint; reward: bigint}[],
  settledTiers: number,
  remainingPool: bigint,
): {payout: bigint; shortfall: bigint} {
  const owed = unsettledRewards(progress, tiers, settledTiers);
  const payout = owed > remainingPool ? remainingPool : owed;
  return {payout, shortfall: owed - payout};
}

/**
 * Rewards the contract has already marked settled for this promoter — what they have been paid.
 *
 * The counterpart to `unsettledRewards`: that is what `settle` *would* pay, this is what settling
 * already did. Together they are the "earned vs claimable" split the promoter dashboard shows.
 *
 * Caveat this deliberately keeps rather than hides: `Campaign._settle` advances `_settledTiers`
 * even when the pool could only cover part of a tier, so a tier settled during a `PoolExhausted`
 * event counts here despite having transferred less than its face reward. This figure is
 * therefore the contract's own settlement accounting, not a token-transfer total. Recovering the
 * true transferred amount would mean replaying `TierSettled` logs, which the detail page does not
 * read — and the shortfall is unrecoverable on chain regardless, so the ladder view is the
 * honest source.
 */
export function settledRewards(
  tiers: readonly {threshold: bigint; reward: bigint}[],
  settledTiers: number,
): bigint {
  // Defensive clamp: `settledTiers` comes from the chain, and a ladder shortened by a redeploy
  // against a stale address would otherwise index past the end.
  const upto = Math.min(settledTiers, tiers.length);
  let total = BigInt(0);
  for (let i = 0; i < upto; i++) total += tiers[i].reward;
  return total;
}

/** 0..1 progress toward the next tier, measured from the previous threshold. */
export function tierProgressRatio(
  progress: bigint,
  tiers: readonly {threshold: bigint; reward: bigint}[],
): number {
  const next = nextTier(progress, tiers);
  if (!next) return 1;

  const floor = next.index === 0 ? BigInt(0) : tiers[next.index - 1].threshold;
  const span = next.threshold - floor;
  if (span <= BigInt(0)) return 0;

  const done = progress - floor;
  return Math.min(1, Math.max(0, Number(done) / Number(span)));
}

/** Whether a campaign's window has started (`startTime`) or not yet. */
export function hasStarted(view: Pick<CampaignView, "startTime">, nowSeconds: number): boolean {
  return Number(view.startTime) <= nowSeconds;
}

/** Whether a campaign's window has ended (`endTime` passed). */
export function windowEnded(view: Pick<CampaignView, "endTime">, nowSeconds: number): boolean {
  return Number(view.endTime) <= nowSeconds;
}
