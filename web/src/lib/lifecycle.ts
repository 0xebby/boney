import {isReclaimable} from "./campaign";
import type {CampaignStatus} from "./types";

/**
 * Which project-side lifecycle actions a campaign will actually accept right now.
 *
 * Pure and React-free (F6) because this is a mirror of the guards in `Campaign.sol`, and a mirror
 * that drifts is worse than no mirror at all: it either offers a button that reverts, or hides one
 * the contract would have allowed. Every rule below names the Solidity guard it reflects, and the
 * unit tests assert the same status/funding/clock combinations the contract branches on.
 *
 * This is not a security boundary — `onlyProject` and every status check are enforced on chain.
 * It decides what to *render*, and gives a reason when an action is unavailable so the UI can
 * explain rather than just disable.
 */

export type LifecycleAction =
  | "activate"
  | "pause"
  | "unpause"
  | "end"
  | "cancel"
  | "reclaimUnspent";

/** Availability of one action, with the reason it is blocked when it is. */
export type ActionAvailability = {
  action: LifecycleAction;
  available: boolean;
  /** User-facing explanation, present only when `available` is false. */
  reason?: string;
};

/** The chain-derived facts every guard is decided from. */
export type LifecycleContext = {
  status: CampaignStatus;
  /** Caller is `cfg.project` — `onlyProject` on every action except `end`. */
  isProject: boolean;
  /** Escrow balance held for this campaign, for `activate`'s NotFunded check and reclaim's zero check. */
  escrowBalance: bigint;
  rewardPool: bigint;
  startTime: number;
  endTime: number;
  /** When `end()`/`cancel()` ran; 0 while still open. Grace is measured from here, not endTime. */
  endedAtSeconds: number;
  claimGraceSeconds: number;
  nowSeconds: number;
  /** Accounting remainder (`rewardPool - paidOut`) — displayed, but never the reclaim precondition. */
  remainingPool: bigint;
};

const LABEL: Record<LifecycleAction, string> = {
  activate: "Activate",
  pause: "Pause",
  unpause: "Resume",
  end: "End campaign",
  cancel: "Cancel",
  reclaimUnspent: "Reclaim unspent",
};

export function actionLabel(action: LifecycleAction): string {
  return LABEL[action];
}

/**
 * `activate()` — Solidity: `onlyProject`, `WrongStatus` unless Pending, `NotFunded` unless the
 * vault covers `rewardPool` in full, and `OutsideWindow` once `endTime` has passed.
 *
 * Note the contract checks `block.timestamp >= endTime` only; a campaign whose `startTime` is
 * still in the future activates fine and simply waits, so there is deliberately no start check.
 */
function activateAvailability(ctx: LifecycleContext): ActionAvailability {
  if (!ctx.isProject) return blocked("activate", "Only the project can activate this campaign.");
  if (ctx.status !== "Pending") {
    return blocked("activate", `Campaign is ${ctx.status.toLowerCase()}, not pending.`);
  }
  if (ctx.escrowBalance < ctx.rewardPool) {
    return blocked("activate", "Escrow must hold the full reward pool before activating.");
  }
  if (ctx.nowSeconds >= ctx.endTime) {
    return blocked("activate", "The campaign window has already closed.");
  }
  return {action: "activate", available: true};
}

/** `pause()` — Solidity: `onlyProject onlyActive`. */
function pauseAvailability(ctx: LifecycleContext): ActionAvailability {
  if (!ctx.isProject) return blocked("pause", "Only the project can pause this campaign.");
  if (ctx.status !== "Active") {
    return blocked("pause", `Only an active campaign can be paused (currently ${ctx.status.toLowerCase()}).`);
  }
  return {action: "pause", available: true};
}

/** `unpause()` — Solidity: `onlyProject`, `WrongStatus` unless Paused. */
function unpauseAvailability(ctx: LifecycleContext): ActionAvailability {
  if (!ctx.isProject) return blocked("unpause", "Only the project can resume this campaign.");
  if (ctx.status !== "Paused") {
    return blocked("unpause", `Only a paused campaign can be resumed (currently ${ctx.status.toLowerCase()}).`);
  }
  return {action: "unpause", available: true};
}

/**
 * `end()` — the one action that is NOT `onlyProject`.
 *
 * Solidity: `WrongStatus` unless Active or Paused, then `OutsideWindow` if
 * `msg.sender != project && block.timestamp < endTime`. So the project may end early, and anyone
 * may end it once the window has closed — that is what stops a project stalling the claim grace.
 */
function endAvailability(ctx: LifecycleContext): ActionAvailability {
  if (ctx.status !== "Active" && ctx.status !== "Paused") {
    return blocked("end", `Only an active or paused campaign can be ended (currently ${ctx.status.toLowerCase()}).`);
  }
  if (!ctx.isProject && ctx.nowSeconds < ctx.endTime) {
    return blocked("end", "Anyone can end this campaign once its window closes; until then only the project can.");
  }
  return {action: "end", available: true};
}

/**
 * `cancel()` — Solidity: `onlyProject`, `WrongStatus` unless Pending.
 *
 * Pending-only by design: once active, promoters may have earned rewards, so cancelling would
 * be a rug.
 */
function cancelAvailability(ctx: LifecycleContext): ActionAvailability {
  if (!ctx.isProject) return blocked("cancel", "Only the project can cancel this campaign.");
  if (ctx.status !== "Pending") {
    return blocked("cancel", "A campaign can only be cancelled before it is activated.");
  }
  return {action: "cancel", available: true};
}

/**
 * `reclaimUnspent()` — Solidity: `onlyProject`, `ClaimWindowOpen` while
 * `block.timestamp <= endedAt + CLAIM_GRACE` for Ended, immediate for Cancelled, `WrongStatus`
 * otherwise, and `NothingToReclaim` when the balance is zero.
 *
 * The zero check is against the **escrow balance**, not `remainingPool()`. Those differ: the
 * contract's `remainingPool()` is the accounting figure `rewardPool - paidOut`, which is nonzero
 * on a campaign that was cancelled before it was ever funded. Reclaiming that would revert with
 * `NothingToReclaim` because the vault holds nothing.
 */
function reclaimAvailability(ctx: LifecycleContext): ActionAvailability {
  if (!ctx.isProject) return blocked("reclaimUnspent", "Only the project can reclaim escrow.");
  if (ctx.status !== "Ended" && ctx.status !== "Cancelled") {
    return blocked("reclaimUnspent", "Escrow is locked until the campaign ends.");
  }
  if (ctx.escrowBalance === BigInt(0)) {
    return blocked("reclaimUnspent", "No unspent escrow remains.");
  }
  if (!isReclaimable(ctx.status, ctx.endedAtSeconds, ctx.nowSeconds, ctx.claimGraceSeconds)) {
    return blocked("reclaimUnspent", "Promoters can still settle; reclaim unlocks after the claim window.");
  }
  return {action: "reclaimUnspent", available: true};
}

function blocked(action: LifecycleAction, reason: string): ActionAvailability {
  return {action, available: false, reason};
}

/**
 * Every action's availability, in the order the panel renders them.
 *
 * Returns all six rather than only the available ones: an action the project cannot take yet is
 * still worth showing with its reason, which is how the UI explains "fund before activating"
 * instead of silently omitting the button.
 */
export function lifecycleAvailability(ctx: LifecycleContext): ActionAvailability[] {
  return [
    activateAvailability(ctx),
    pauseAvailability(ctx),
    unpauseAvailability(ctx),
    endAvailability(ctx),
    cancelAvailability(ctx),
    reclaimAvailability(ctx),
  ];
}

/** Just the actions the contract would accept right now. */
export function availableActions(ctx: LifecycleContext): LifecycleAction[] {
  return lifecycleAvailability(ctx)
    .filter((a) => a.available)
    .map((a) => a.action);
}

/**
 * Remaining escrow the campaign needs before `activate()` will succeed.
 *
 * Clamped at zero so an over-funded campaign reports 0 rather than a negative shortfall.
 */
export function fundingShortfall(escrowBalance: bigint, rewardPool: bigint): bigint {
  return escrowBalance >= rewardPool ? BigInt(0) : rewardPool - escrowBalance;
}

/** Whether escrow covers the pool — the precondition `activate` checks. */
export function isFullyFunded(escrowBalance: bigint, rewardPool: bigint): boolean {
  return escrowBalance >= rewardPool;
}
