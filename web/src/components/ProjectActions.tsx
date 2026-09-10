"use client";

import {useState} from "react";
import {useAccount} from "wagmi";
import {Card, CardHeader} from "@/components/ui/Card";
import {TxErrorMessage} from "@/components/ui/TxErrorMessage";
import {Notice} from "@/components/ui/Notice";
import {
  useExtendCampaign,
  useFundCampaign,
  useTopUpCampaign,
  useCampaignLifecycle,
} from "@/hooks/useWriteCampaign";
import {isPending, type TxState} from "@/hooks/useWriteCampaign";
import {
  lifecycleAvailability,
  fundingShortfall,
  actionLabel,
  type LifecycleAction,
  type ActionAvailability,
} from "@/lib/lifecycle";
import {formatDateTime, formatTokenAmount, fromDateTimeLocal, toAmountInput, toDateTimeLocal} from "@/lib/format";
import {parseAmount} from "@/lib/validation";
import {isProjectWallet} from "@/lib/viewerRole";
import type {CampaignDetail} from "@/lib/campaignDetail";

/**
 * Project-side controls: fund the escrow, then drive the campaign through its lifecycle.
 *
 * Which buttons are live comes from `lib/lifecycle`, which mirrors the contract's guards. A
 * blocked action still renders — disabled, with the reason — because "why can't I activate?" is
 * the question the panel exists to answer, and hiding the button answers it with silence.
 *
 * Every action confirms through the signing dialog before the wallet opens, which is where the
 * irreversibility of `cancel` and `end` is spelled out.
 */

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
  const isProject = isProjectWallet(address, detail.project);

  const fund = useFundCampaign();
  const extend = useExtendCampaign();
  const topUp = useTopUpCampaign();
  const lifecycle = useCampaignLifecycle();

  const [fundAmount, setFundAmount] = useState("");
  const [extensionEnd, setExtensionEnd] = useState("");
  const [topUpAmount, setTopUpAmount] = useState("");

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
    await lifecycle.execute(detail.address, action, {
      campaignName: detail.name,
      symbol: token.symbol,
      decimals: token.decimals,
    });
    onDone();
  };

  const submitFund = async (e: React.FormEvent) => {
    e.preventDefault();
    const amount = parseAmount(fundAmount, token.decimals);
    if (amount === null || amount === BigInt(0)) return;
    await fund.fund(campaignId, amount, detail.token, {
      campaignName: detail.name,
      symbol: token.symbol,
      decimals: token.decimals,
    });
    onDone();
  };

  const fundInvalid =
    fundAmount.trim() !== "" && parseAmount(fundAmount, token.decimals) === null;

  const extensionSeconds = fromDateTimeLocal(extensionEnd);
  const extensionValid =
    extensionSeconds > Number(detail.endTime) && extensionSeconds <= Number(detail.maximumEndTime);
  const extensionOpen = detail.status === "Active" || detail.status === "Paused";
  const topUpMinimum = (detail.initialRewardPool * BigInt(20)) / BigInt(100);
  const topUpThreshold = (detail.rewardPool * BigInt(90)) / BigInt(100);
  const topUpReady = detail.paidOut >= topUpThreshold;
  const topUpParsed = parseAmount(topUpAmount, token.decimals);
  const topUpInvalid = topUpAmount.trim() !== "" && topUpParsed === null;
  const topUpValid = topUpParsed !== null && topUpParsed >= topUpMinimum;

  const submitExtend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!extensionValid) return;
    await extend.extend(detail.address, BigInt(extensionSeconds), {
      campaignName: detail.name,
      symbol: token.symbol,
      decimals: token.decimals,
    });
    onDone();
  };

  const submitTopUp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!topUpValid || topUpParsed === null) return;
    await topUp.topUp(detail.address, topUpParsed, detail.token, {
      campaignName: detail.name,
      symbol: token.symbol,
      decimals: token.decimals,
    });
    onDone();
  };

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
              Fund Campaign Reward Pool ({formatTokenAmount(shortfall, token.decimals, {compact: true})}{" "}
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

      {isProject && detail.feature1Supported ? (
        <div className="mb-4 grid gap-4 border-b border-hairline pb-4 lg:grid-cols-2">
          <form onSubmit={submitExtend} className="space-y-2">
            <div className="flex items-baseline justify-between gap-3">
              <label htmlFor="extend-end" className="text-xs text-ink-muted">
                Extend reporting window
              </label>
              <span className="text-[11px] text-ink-muted">
                max {formatDateTime(Number(detail.maximumEndTime))}
              </span>
            </div>
            <input
              id="extend-end"
              type="datetime-local"
              value={extensionEnd}
              min={toDateTimeLocal(Number(detail.endTime) + 1)}
              max={toDateTimeLocal(Number(detail.maximumEndTime))}
              onChange={(e) => setExtensionEnd(e.target.value)}
              disabled={!extensionOpen || isPending(extend.state)}
              aria-invalid={extensionEnd !== "" && !extensionValid || undefined}
              className="w-full rounded border border-hairline bg-surface-2 px-2 py-1.5 text-xs text-ink disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={!extensionOpen || !extensionValid || isPending(extend.state)}
              className="rounded-md border border-hairline-strong px-3 py-1.5 text-xs font-medium text-ink hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-40"
            >
              {isPending(extend.state) ? "Extending…" : "Extend campaign"}
            </button>
            {extensionEnd !== "" && !extensionValid ? (
              <p className="text-xs text-critical">
                Choose a deadline after {formatDateTime(Number(detail.endTime))} and no later than the maximum.
              </p>
            ) : (
              <p className="text-xs text-ink-muted">
                Only the reporting deadline changes. KPI definitions and tiers remain fixed.
              </p>
            )}
            <TxFeedback state={extend.state} onReset={extend.reset} />
          </form>

          <form onSubmit={submitTopUp} className="space-y-2">
            <div className="flex items-baseline justify-between gap-3">
              <label htmlFor="top-up-amount" className="text-xs text-ink-muted">
                Top up reward pool
              </label>
              <button
                type="button"
                onClick={() => setTopUpAmount(toAmountInput(topUpMinimum, token.decimals))}
                className="text-xs text-brand hover:underline"
              >
                Use minimum ({formatTokenAmount(topUpMinimum, token.decimals, {compact: true})} {token.symbol})
              </button>
            </div>
            <div className="flex gap-2">
              <input
                id="top-up-amount"
                value={topUpAmount}
                onChange={(e) => setTopUpAmount(e.target.value)}
                placeholder="0.0"
                inputMode="decimal"
                aria-invalid={topUpInvalid || undefined}
                className={`min-w-0 flex-1 rounded border bg-surface-2 px-2 py-1.5 text-xs text-ink ${
                  topUpInvalid ? "border-critical" : "border-hairline"
                }`}
              />
              <button
                type="submit"
                disabled={!topUpReady || !topUpValid || isPending(topUp.state)}
                className="shrink-0 rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-plane hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {topUp.needsApproval ? "Approving…" : isPending(topUp.state) ? "Topping up…" : "Top up"}
              </button>
            </div>
            {topUpInvalid ? (
              <p className="text-xs text-critical">
                Enter an amount with at most {token.decimals} decimal places.
              </p>
            ) : (
              <p className="text-xs text-ink-muted">
                Available after {formatTokenAmount(topUpThreshold, token.decimals, {compact: true})} {token.symbol} is paid out; minimum {formatTokenAmount(topUpMinimum, token.decimals, {compact: true})} {token.symbol}.
              </p>
            )}
            <TxFeedback state={topUp.state} onReset={topUp.reset} />
          </form>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {availability.map((a) => (
          <ActionButton
            key={a.action}
            availability={a}
            disabled={!clockReady || isPending(lifecycle.state)}
            busy={lifecycle.action === a.action && isPending(lifecycle.state)}
            onClick={() => void runLifecycle(a.action)}
          />
        ))}
      </div>

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
  onClick,
}: {
  availability: ActionAvailability;
  disabled: boolean;
  busy: boolean;
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
        destructive
          ? "border-hairline-strong text-critical hover:bg-surface-hover"
          : "border-hairline-strong text-ink hover:bg-surface-hover"
      }`}
    >
      {busy ? "…" : actionLabel(action)}
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
 * A settled transaction — confirmed or failed — renders as a `ui/Notice`, the shape every status
 * message on the site takes. The two in-flight states stay as a muted line, announced through
 * `role="status"` so a screen reader hears the transition without the focus moving.
 */
function TxFeedback({state, onReset}: {state: TxState; onReset: () => void}) {
  if (state.status === "idle") return null;

  if (state.status === "confirmed") {
    return <Notice tone="good" role="status" title="Confirmed." className="mt-2" />;
  }

  if (state.status === "error") {
    return (
      <Notice
        tone="critical"
        className="mt-2"
        title={<TxErrorMessage message={state.message} detail={state.detail} onDismiss={onReset} />}
      />
    );
  }

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
      ) : null}
    </div>
  );
}
