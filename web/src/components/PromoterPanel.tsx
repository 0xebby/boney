"use client";

import {useState, useMemo} from "react";
import {useAccount} from "wagmi";
import {Card, CardHeader} from "@/components/ui/Card";
import {useJoinCampaign, useSettleRewards, isPending, type TxState} from "@/hooks/useWriteCampaign";
import {usePromoterReputation} from "@/hooks/usePromoterReputation";
import {
  canJoin,
  canSettle,
  claimWindowRemaining,
  derivePromoterId,
  trackingLink,
} from "@/lib/kol";
import {settlementPayout, settledRewards} from "@/lib/campaign";
import {formatTokenAmount, formatDuration, shortAddress} from "@/lib/format";
import {KPI_KIND_LABEL} from "@/lib/types";
import type {CampaignDetail, PromoterState} from "@/lib/campaignDetail";

/**
 * KOL-side panel: join a campaign, get a tracking link, watch progress, and claim.
 *
 * Eligibility comes from `lib/kol`, which mirrors `Campaign.join` and `Campaign.settle`. As in
 * the project panel, a blocked action renders with the contract's own reason rather than
 * disappearing — "why can't I claim?" is the question this exists to answer.
 */
export function PromoterPanel({
  detail,
  promoter,
  token,
  onDone,
  nowSeconds,
}: {
  detail: CampaignDetail;
  promoter: PromoterState | null;
  token: {symbol: string; decimals: number};
  onDone: () => void;
  nowSeconds: number;
}) {
  const {address, isConnected} = useAccount();
  const join = useJoinCampaign();
  const settleTx = useSettleRewards();
  const {reputation} = usePromoterReputation(address);
  const [copied, setCopied] = useState(false);

  const joined = Boolean(promoter?.joined);

  // Predicted before joining so the panel can show what the link *will* be; once joined, the
  // chain's own value wins — they must agree, and a live test asserts that.
  const promoterId = useMemo(() => {
    if (promoter?.joined) return promoter.promoterId;
    if (!address) return undefined;
    return derivePromoterId(detail.address, address);
  }, [promoter, address, detail.address]);

  const joinEligibility = canJoin({
    status: detail.status,
    alreadyJoined: joined,
    reputation: reputation ?? BigInt(0),
    minReputation: detail.minReputation,
    connected: isConnected,
  });

  // Per-KPI earned and claimable. These are two different questions — "what has this campaign
  // paid me" vs "what would pressing Claim move" — and on a healthy campaign the second is always
  // zero, because settlement happens inline when progress is reported. Showing only the claimable
  // figure made the panel read as if the promoter had earned nothing.
  const claims = useMemo(() => {
    if (!promoter?.joined) return [];
    return detail.kpis.map((kpi) => {
      const state = promoter.perKpi.find((s) => s.kpiIndex === kpi.index);
      const settled = state?.settledTiers ?? 0;
      const {payout, shortfall} = settlementPayout(
        state?.progress ?? BigInt(0),
        kpi.tiers,
        settled,
        detail.remainingPool,
      );
      return {
        kpi,
        payout,
        shortfall,
        progress: state?.progress ?? BigInt(0),
        earned: settledRewards(kpi.tiers, settled),
        settledTiers: settled,
      };
    });
  }, [detail, promoter]);

  const totalClaimable = claims.reduce((sum, c) => sum + c.payout, BigInt(0));
  const totalEarned = claims.reduce((sum, c) => sum + c.earned, BigInt(0));
  const windowLeft = claimWindowRemaining(
    detail.status,
    Number(detail.endedAt),
    Number(detail.claimGrace),
    nowSeconds,
  );

  const link =
    promoterId && typeof window !== "undefined"
      ? trackingLink(window.location.origin, detail.address, promoterId)
      : undefined;

  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      // Clipboard is permission-gated and unavailable over plain http on some browsers; the
      // input below is selectable, so a failure here is not worth an error state.
      setCopied(false);
    }
  };

  // Nothing to offer a disconnected visitor who cannot join either.
  if (!isConnected && !joined) {
    return (
      <Card>
        <CardHeader title="Promote this campaign" subtitle="Earn rewards for verified results" />
        <p className="text-xs text-ink-muted">
          Connect a wallet to join as a promoter and generate a tracking link.
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        title={joined ? "Your promoter dashboard" : "Promote this campaign"}
        subtitle={
          joined
            ? `Promoter ${shortAddress(promoterId ?? "0x", 10, 8)}`
            : "Join to earn rewards for verified results"
        }
      />

      {!joined ? (
        <div className="space-y-3">
          <p className="text-xs text-ink-secondary">
            {detail.minReputation === BigInt(0)
              ? "This campaign is open to all promoters."
              : `Requires a reputation of ${detail.minReputation.toString()}. Yours is ${(reputation ?? BigInt(0)).toString()}.`}
          </p>

          <button
            type="button"
            onClick={async () => {
              await join.join(detail.address);
              onDone();
            }}
            disabled={!joinEligibility.ok || isPending(join.state)}
            title={joinEligibility.reason}
            className="rounded-md bg-brand px-4 py-2 text-sm font-semibold text-plane hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isPending(join.state) ? "Joining…" : "Join as promoter"}
          </button>

          {!joinEligibility.ok ? (
            <p className="text-xs text-warning">{joinEligibility.reason}</p>
          ) : null}

          <TxFeedback state={join.state} onReset={join.reset} />
        </div>
      ) : (
        <div className="space-y-4">
          {/* Tracking link */}
          <div className="space-y-1.5">
            <label htmlFor="tracking-link" className="block text-xs text-ink-muted">
              Your tracking link
            </label>
            <div className="flex gap-2">
              <input
                id="tracking-link"
                readOnly
                value={link ?? ""}
                onFocus={(e) => e.currentTarget.select()}
                className="min-w-0 flex-1 rounded border border-hairline bg-surface-2 px-2 py-1.5 font-mono text-[11px] text-ink-secondary"
              />
              <button
                type="button"
                onClick={copy}
                className="shrink-0 rounded-md border border-hairline-strong px-3 py-1.5 text-xs font-medium text-ink hover:bg-surface-hover"
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <p className="text-xs text-ink-muted">
              Traffic through this link is attributed to you for{" "}
              {formatDuration(Number(detail.attributionWindow))} after each visit.
            </p>
          </div>

          {/* Earnings summary */}
          <div className="border-t border-hairline pt-3">
            <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
              {/* Earned leads: on a healthy campaign it is the only nonzero figure, because
                  reporting progress settles inline. Claimable sits beside it so a promoter can
                  see that nothing is stuck, rather than reading a lone "0" as "you earned 0". */}
              <div>
                <p className="text-xs text-ink-muted">Earned</p>
                <p className="text-xl font-semibold text-ink">
                  {formatTokenAmount(totalEarned, token.decimals)}{" "}
                  <span className="text-sm font-normal text-ink-muted">{token.symbol}</span>
                </p>
              </div>
              <div>
                <p className="text-xs text-ink-muted">Awaiting claim</p>
                <p className="text-base font-medium text-ink-secondary">
                  {formatTokenAmount(totalClaimable, token.decimals)}{" "}
                  <span className="text-xs font-normal text-ink-muted">{token.symbol}</span>
                </p>
              </div>
              {windowLeft !== null ? (
                <p className={`text-xs ${windowLeft === 0 ? "text-critical" : "text-warning"}`}>
                  {windowLeft === 0
                    ? "Claim window closed"
                    : `Claim window closes in ${formatDuration(windowLeft)}`}
                </p>
              ) : null}
            </div>

            {totalEarned > BigInt(0) && totalClaimable === BigInt(0) ? (
              <p className="mt-2 text-xs text-ink-muted">
                Paid straight to your wallet as each tier was crossed — no claim needed.
              </p>
            ) : null}

            <ul className="mt-3 space-y-2">
              {claims.map(({kpi, payout, shortfall, progress, earned, settledTiers}) => {
                const eligibility = canSettle({
                  status: detail.status,
                  joined,
                  endedAtSeconds: Number(detail.endedAt),
                  claimGraceSeconds: Number(detail.claimGrace),
                  nowSeconds,
                  payout,
                });

                return (
                  <li
                    key={kpi.index}
                    className="flex flex-wrap items-center justify-between gap-2 rounded border border-hairline px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-ink">
                        {KPI_KIND_LABEL[kpi.spec.kind]}
                      </p>
                      <p className="text-xs text-ink-muted">
                        {progress.toLocaleString("en-US")} credited ·{" "}
                        {settledTiers}/{kpi.tiers.length} tiers ·{" "}
                        {formatTokenAmount(earned, token.decimals)} {token.symbol} earned
                        {payout > BigInt(0)
                          ? ` · ${formatTokenAmount(payout, token.decimals)} ${token.symbol} claimable`
                          : ""}
                      </p>
                      {shortfall > BigInt(0) ? (
                        <p className="text-xs text-warning">
                          Pool can only cover part of what you earned.
                        </p>
                      ) : null}
                    </div>

                    <button
                      type="button"
                      onClick={async () => {
                        if (!address) return;
                        await settleTx.settle(detail.address, address, kpi.index);
                        onDone();
                      }}
                      disabled={!eligibility.ok || isPending(settleTx.state)}
                      title={eligibility.reason}
                      className="shrink-0 rounded-md border border-hairline-strong px-3 py-1.5 text-xs font-medium text-ink hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {settleTx.settling === kpi.index && isPending(settleTx.state)
                        ? "Claiming…"
                        : "Claim"}
                    </button>
                  </li>
                );
              })}
            </ul>

            <TxFeedback state={settleTx.state} onReset={settleTx.reset} />
          </div>
        </div>
      )}
    </Card>
  );
}

/** Shared transaction status line — see the note in ProjectActions. */
function TxFeedback({state, onReset}: {state: TxState; onReset: () => void}) {
  if (state.status === "idle") return null;

  return (
    <div role="status" aria-live="polite" className="mt-2 text-xs">
      {state.status === "preparing" ? (
        <p className="text-ink-muted">Confirm in your wallet…</p>
      ) : state.status === "submitted" ? (
        <p className="text-ink-muted">Submitted — waiting for confirmation.</p>
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
