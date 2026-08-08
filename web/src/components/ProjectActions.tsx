"use client";

import {useState} from "react";
import {useAccount} from "wagmi";
import {Card, CardHeader} from "@/components/ui/Card";
import {useFundCampaign, useCampaignLifecycle} from "@/hooks/useWriteCampaign";
import {isPending, type TxState} from "@/hooks/useWriteCampaign";
import {
  lifecycleAvailability,
  fundingShortfall,
  actionLabel,
  type LifecycleAction,
  type ActionAvailability,
} from "@/lib/lifecycle";
import {formatTokenAmount, toAmountInput} from "@/lib/format";
import {parseAmount} from "@/lib/validation";
import type {CampaignDetail} from "@/lib/campaignDetail";

/**
 * Project-side controls: fund the escrow, then drive the campaign through its lifecycle.
 *
 * Which buttons are live comes from `lib/lifecycle`, which mirrors the contract's guards. A
 * blocked action still renders — disabled, with the reason — because "why can't I activate?" is
 * the question the panel exists to answer, and hiding the button answers it with silence.
 *
 * Destructive actions (`cancel`, `end`) require a second click to confirm: they are irreversible
 * on chain and `cancel` in particular cannot be undone once a campaign is Pending-no-more.
 */

/** Actions that cannot be walked back, so they get a confirm step. */
const NEEDS_CONFIRM: ReadonlySet<LifecycleAction> = new Set(["cancel", "end"]);

export function ProjectActions({
  campaignId,
  detail,
  token,
  onDone,
  nowSeconds,
}: {
  /**
   * Registry id, required by `Boney.fundCampaign` — it resolves the id through
   * `registry.campaignAt`, so the campaign's own address is not a substitute.
   */
  campaignId: bigint;
  detail: CampaignDetail;
  token: {symbol: string; decimals: number};
  /** Refetch the detail record after a write lands. */
  onDone: () => void;
  nowSeconds: number;
}) {
  const {address} = useAccount();
  const isProject = Boolean(address && address.toLowerCase() === detail.project.toLowerCase());

  const fund = useFundCampaign();
  const lifecycle = useCampaignLifecycle();

  const [fundAmount, setFundAmount] = useState("");
  const [confirming, setConfirming] = useState<LifecycleAction | null>(null);

  const shortfall = fundingShortfall(detail.escrowBalance, detail.rewardPool);

  // The clock gates time-dependent guards. Before the client clock is live (nowSeconds === 0) the
  // server render and the hydration would disagree about whether a window has closed, so the panel
  // holds every action disabled for that first frame rather than flashing a wrong state.
  const clockReady = nowSeconds > 0;

  const availability = lifecycleAvailability({
    status: detail.status,
    isProject,
    escrowBalance: detail.escrowBalance,
    rewardPool: detail.rewardPool,
    startTime: Number(detail.startTime),
    endTime: Number(detail.endTime),
    endedAtSeconds: Number(detail.endedAt),
    claimGraceSeconds: Number(detail.claimGrace),
    nowSeconds,
    remainingPool: detail.remainingPool,
  });

  // A non-project visitor sees the panel only if there is something they can actually do — which
  // is `end` past the window, the one action the contract opens to anyone.
  const anyAvailable = availability.some((a) => a.available);
  if (!isProject && !anyAvailable) return null;

  const runLifecycle = async (action: LifecycleAction) => {
    if (NEEDS_CONFIRM.has(action) && confirming !== action) {
      setConfirming(action);
      return;
    }
    setConfirming(null);
    await lifecycle.execute(detail.address, action);
    onDone();
  };

  const submitFund = async (e: React.FormEvent) => {
    e.preventDefault();
    const amount = parseAmount(fundAmount, token.decimals);
    if (amount === null || amount === BigInt(0)) return;
    await fund.fund(campaignId, amount, detail.token);
    onDone();
  };

  const fundInvalid =
    fundAmount.trim() !== "" && parseAmount(fundAmount, token.decimals) === null;

  return (
    <Card>
      <CardHeader
        title="Project Dashboard"
        subtitle={isProject ? "You own this campaign" : "Open actions on this campaign"}
      />

      {/* Fund — only meaningful while escrow is short and the campaign has not ended. */}
      {isProject && shortfall > BigInt(0) && detail.status === "Pending" ? (
        <form onSubmit={submitFund} className="mb-4 space-y-2 border-b border-hairline pb-4">
          <div className="flex items-baseline justify-between gap-3">
            <label htmlFor="fund-amount" className="text-xs text-ink-muted">
              Fund escrow
            </label>
            <button
              type="button"
              onClick={() => setFundAmount(toAmountInput(shortfall, token.decimals))}
              className="text-xs text-brand hover:underline"
            >
              Fill shortfall ({formatTokenAmount(shortfall, token.decimals, {compact: true})}{" "}
              {token.symbol})
            </button>
          </div>

          <div className="flex gap-2">
            <input
              id="fund-amount"
              value={fundAmount}
              onChange={(e) => setFundAmount(e.target.value)}
              placeholder="0.0"
              inputMode="decimal"
              aria-invalid={fundInvalid || undefined}
              className={`min-w-0 flex-1 rounded border bg-surface-2 px-2 py-1.5 text-xs text-ink ${
                fundInvalid ? "border-critical" : "border-hairline"
              }`}
            />
            <button
              type="submit"
              disabled={isPending(fund.state) || fundInvalid || !fundAmount.trim()}
              className="shrink-0 rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-plane hover:opacity-90 disabled:opacity-50"
            >
              {fund.needsApproval
                ? "Approving…"
                : isPending(fund.state)
                  ? "Funding…"
                  : "Fund"}
            </button>
          </div>

          {fundInvalid ? (
            <p className="text-xs text-critical">
              Enter an amount with at most {token.decimals} decimal places.
            </p>
          ) : (
            <p className="text-xs text-ink-muted">
              Escrow holds {formatTokenAmount(detail.escrowBalance, token.decimals, {compact: true})}{" "}
              of {formatTokenAmount(detail.rewardPool, token.decimals, {compact: true})}{" "}
              {token.symbol}. Activation needs the full pool.
            </p>
          )}

          <TxFeedback state={fund.state} onReset={fund.reset} />
        </form>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {availability.map((a) => (
          <ActionButton
            key={a.action}
            availability={a}
            disabled={!clockReady || isPending(lifecycle.state)}
            busy={lifecycle.action === a.action && isPending(lifecycle.state)}
            confirming={confirming === a.action}
            onClick={() => void runLifecycle(a.action)}
          />
        ))}
      </div>

      {confirming ? (
        <p className="mt-2 text-xs text-warning">
          {confirming === "cancel"
            ? "Cancelling is permanent and returns escrow to you. Click again to confirm."
            : "Ending starts the settlement window and cannot be undone. Click again to confirm."}{" "}
          <button
            type="button"
            onClick={() => setConfirming(null)}
            className="text-ink-muted underline hover:text-ink"
          >
            Never mind
          </button>
        </p>
      ) : null}

      <TxFeedback state={lifecycle.state} onReset={lifecycle.reset} />
    </Card>
  );
}

/**
 * One lifecycle button.
 *
 * A blocked action renders disabled with its reason as the accessible title rather than being
 * omitted, so the panel explains the contract's rules instead of appearing arbitrary.
 */
function ActionButton({
  availability,
  disabled,
  busy,
  confirming,
  onClick,
}: {
  availability: ActionAvailability;
  disabled: boolean;
  busy: boolean;
  confirming: boolean;
  onClick: () => void;
}) {
  const {action, available, reason} = availability;
  const destructive = action === "cancel" || action === "end";

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!available || disabled}
      title={reason}
      aria-describedby={reason ? `${action}-reason` : undefined}
      className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        confirming
          ? "border-warning text-warning"
          : destructive
            ? "border-hairline-strong text-critical hover:bg-surface-hover"
            : "border-hairline-strong text-ink hover:bg-surface-hover"
      }`}
    >
      {busy ? "…" : confirming ? `Confirm ${actionLabel(action).toLowerCase()}` : actionLabel(action)}
      {reason ? (
        <span id={`${action}-reason`} className="sr-only">
          {" "}
          — {reason}
        </span>
      ) : null}
    </button>
  );
}

/**
 * Transaction status line.
 *
 * `role="status"` so a screen reader hears the transition without the focus moving; a mined
 * transaction is announced, not just recolored.
 */
function TxFeedback({state, onReset}: {state: TxState; onReset: () => void}) {
  if (state.status === "idle") return null;

  return (
    <div role="status" aria-live="polite" className="mt-2 text-xs">
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
        <p className="text-critical">
          {state.message}{" "}
          <button
            type="button"
            onClick={onReset}
            className="text-ink-muted underline hover:text-ink"
          >
            Dismiss
          </button>
        </p>
      )}
    </div>
  );
}
