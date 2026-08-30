"use client";

import {useState, useMemo} from "react";
import Link from "next/link";
import {useAccount} from "wagmi";
import {Card, CardHeader} from "@/components/ui/Card";
import {TxErrorMessage} from "@/components/ui/TxErrorMessage";
import {Notice} from "@/components/ui/Notice";
import {
  useJoinCampaign,
  useSettleRewards,
  isPending,
  type TxState,
} from "@/hooks/useWriteCampaign";
import {usePromoterReputation} from "@/hooks/usePromoterReputation";
import {useEthosAttestation} from "@/hooks/useEthosAttestation";
import {canJoin, canSettle, derivePromoterId, trackingLink} from "@/lib/promoter";
import {settledRewards, settlementPayout} from "@/lib/campaign";
import {daysUntilExpiry} from "@/lib/boneyscore";
import {formatTokenAmount, formatDuration, shortAddress} from "@/lib/format";
import {KPI_KIND_LABEL} from "@/lib/types";
import type {CampaignDetail, PromoterState} from "@/lib/campaignDetail";

/**
 * Promoter-side panel: join a campaign, get a tracking link, and watch what it has paid.
 *
 * Eligibility comes from `lib/promoter`, which mirrors `Campaign.join`. A blocked action renders
 * with the contract's own reason rather than disappearing — "why can't I join?" is the question
 * this exists to answer.
 *
 * Settlement is normally invisible here, and that is not an omission. `Campaign.reportUserAction`
 * calls `_settle` inline, and `_settle` calls `escrowVault.release(promoter, pay)` — so crossing a
 * tier *is* the payment, and the tokens are in the promoter's wallet before progress is readable.
 * A claim button appears per KPI only when the chain says a crossed tier went unpaid, which is the
 * one state `Campaign.settle` exists to clear; the rest of the time showing one would imply rewards
 * wait to be collected when they never do.
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
  const settle = useSettleRewards();
  const {
    reputation,
    hasExpired,
    expiresAt,
    refetch: refetchReputation,
  } = usePromoterReputation(address);
  const attestation = useEthosAttestation();
  const [copied, setCopied] = useState(false);

  const joined = Boolean(promoter?.joined);

  // Predicted before joining so the panel can show what the link *will* be; once joined, the
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

  // A scored wallet under the gate is told both numbers by the requirement line above the button, so
  // the refusal beneath it would be the same sentence twice. An unscored wallet is not: its refusal
  // carries the "verify your Ethos profile" instruction that line has no room for.
  const scoreShortfall =
    joinEligibility.actionable === "attest" && (reputation ?? BigInt(0)) > BigInt(0);

  // Only inside the notice window; undefined the rest of the time so the panel stays quiet.
  const expiryNoticeDays = useMemo(
    () => daysUntilExpiry(expiresAt, nowSeconds),
    [expiresAt, nowSeconds],
  );

  // Per-KPI progress and what the contract has marked settled — which is what it has paid.
  //
  // `owed` is the gap: tiers whose threshold this promoter has crossed that `_settledTiers` has not
  // caught up to. `settlementPayout` caps it at the remaining pool rather than using the raw
  // `unsettledRewards`, so the button never advertises more than escrow can transfer.
  const perKpi = useMemo(() => {
    if (!promoter?.joined) return [];
    return detail.kpis.map((kpi) => {
      const state = promoter.perKpi.find((s) => s.kpiIndex === kpi.index);
      const settled = state?.settledTiers ?? 0;
      const progress = state?.progress ?? BigInt(0);
      return {
        kpi,
        progress,
        earned: settledRewards(kpi.tiers, settled),
        owed: settlementPayout(progress, kpi.tiers, settled, detail.remainingPool).payout,
        settledTiers: settled,
      };
    });
  }, [detail, promoter]);

  const totalEarned = perKpi.reduce((sum, k) => sum + k.earned, BigInt(0));
  const totalOwed = perKpi.reduce((sum, k) => sum + k.owed, BigInt(0));

  // `settledRewards` sums each crossed tier's full reward, but `Campaign._settle` advances
  // `_settledTiers` even when escrow could only cover part of a tier (it emits `PoolExhausted` for
  // the difference). So on a drained pool the figure above is what was owed, not what arrived.
  const poolDrained = detail.remainingPool === BigInt(0) && totalEarned > BigInt(0);

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
          Connect a wallet to join as a <b>promoter</b> and generate a <b>tracking link</b>.
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
          {detail.minReputation === BigInt(0) ? (
            <p className="text-xs text-ink-secondary">This campaign is open to all promoters.</p>
          ) : null}

          {/*
            Warn before the score drops, not after. A promoter who qualifies today but expires in a
            week can refresh now; the same person discovering it at a closed gate cannot.
          */}
          {!hasExpired && expiryNoticeDays !== undefined ? (
            <p className="text-xs text-ink-muted">
              {expiryNoticeDays === 0
                ? "Your verification expires today — re-verify to keep your score."
                : `Your verification expires in ${expiryNoticeDays} ${expiryNoticeDays === 1 ? "day" : "days"}.`}
            </p>
          ) : null}

          <button
            type="button"
            onClick={async () => {
              await join.join(detail.address, {campaignName: detail.name});
              onDone();
            }}
            disabled={!joinEligibility.ok || isPending(join.state)}
            title={joinEligibility.reason}
            className="rounded-md bg-brand px-4 py-2 text-sm font-semibold text-plane hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isPending(join.state) ? "Joining…" : "Join as promoter"}
          </button>

          {!joinEligibility.ok && !scoreShortfall ? (
            <p className="text-xs text-brand">{joinEligibility.reason}</p>
          ) : null}

          {/*
            A reputation shortfall is the one refusal a promoter can act on without leaving the page:
            an un-attested wallet scores 0 and would otherwise see a permanently dead button on
            every gated campaign. Verifying pulls their Ethos score and social media reach on chain, after
            which `reputation` refetches and the Join button may light up.

            An expired score is the same refusal with a different cause, so it needs its own copy:
            the promoter did verify, and telling them to "verify" a second time reads as if the first
            attempt silently failed.
          */}
          {joinEligibility.actionable === "attest" ? (
            <div className="space-y-2 rounded-md border border-hairline p-3">
              <p className="text-xs text-ink-secondary">
                {hasExpired
                  ? "Your verification has expired. BoneyScore reflects credibility now, not when you first verified, so scores age out and need refreshing. Re-verifying reads your current Ethos and reach."
                  : "BoneyScore combines your Ethos credibility with your X reach. Verifying reads both and records them on chain. Requires a claimed ethos profile."}
              </p>
              <button
                type="button"
                onClick={async () => {
                  const ok = await attestation.attest();
                  if (ok) {
                    await refetchReputation();
                    onDone();
                  }
                }}
                disabled={
                  attestation.state.status === "fetching" ||
                  attestation.state.status === "submitting"
                }
                className="rounded-md border border-series-1 px-3 py-1.5 text-xs font-medium text-series-1 hover:bg-series-1/10 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {attestation.state.status === "fetching"
                  ? "Reading Ethos…"
                  : attestation.state.status === "submitting"
                    ? `Recording ${attestation.state.done + 1} of ${attestation.state.total}…`
                    : hasExpired
                      ? "Re-verify my BoneyScore"
                      : "Verify my BoneyScore"}
              </button>

              {attestation.state.status === "error" ? (
                <p className="text-xs text-brand">{attestation.state.message}</p>
              ) : null}
              {attestation.state.status === "success" ? (
                <p className="text-xs text-ink-muted">
                  Ethos {attestation.state.ethos} · reach {attestation.state.reach} (
                  {attestation.state.followers.toLocaleString()} followers)
                  {attestation.state.smartFollowers > 0
                    ? ` · ${attestation.state.smartFollowers.toLocaleString()} smart followers`
                    : null}
                </p>
              ) : null}
            </div>
          ) : null}

          <TxFeedback state={join.state} onReset={join.reset} />
        </div>
      ) : (
        <div className="space-y-4">
          {/* Tracking link */}
          <div className="space-y-1.5">
            <label htmlFor="tracking-link" className="block text-xs text-ink-muted">
              Your Boneylink link
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
              {/* The link itself, for anyone who would rather follow it than paste it somewhere. */}
              {promoterId ? (
                <Link
                  href={`/r?c=${detail.address}&p=${promoterId}`}
                  className="shrink-0 rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-plane transition-opacity hover:opacity-90"
                  title="Open this tracking link and attribute the connected wallet"
                >
                  Attribute
                </Link>
              ) : null}
            </div>
            <p className="text-xs font-semibold text-ink-secondary">
              Traffic through your Boneylink is attributed to you for{" "}
              {formatDuration(Number(detail.attributionWindow))} after each visit.
            </p>
          </div>

          {/* Earnings summary */}
          <div className="border-t border-hairline pt-3">
            <div>
              <p className="text-xs text-ink-muted">Paid to your wallet</p>
              {/* Brand yellow across both halves: this is the one figure on the panel that is money
                  already in the promoter's wallet, and the symbol belongs to the number rather than to
                  the muted label above it. */}
              <p className="text-xl font-bold text-brand">
                {formatTokenAmount(totalEarned, token.decimals)}{" "}
                <span className="text-sm font-semibold">{token.symbol}</span>
              </p>
              {totalOwed > BigInt(0) ? (
                <p className="mt-1 text-xs text-brand">
                  {formatTokenAmount(totalOwed, token.decimals)} {token.symbol} was earned but
                  never paid out. Settling releases it to your wallet.
                </p>
              ) : null}
              {poolDrained ? (
                <p className="mt-1 text-xs text-brand">
                  This campaign&rsquo;s escrow is empty. Any tier crossed after it ran dry paid
                  less than its full reward.
                </p>
              ) : null}
            </div>

            <ul className="mt-3 space-y-2">
              {perKpi.map(({kpi, progress, earned, owed, settledTiers}) => {
                const eligibility = canSettle({
                  status: detail.status,
                  joined: true,
                  owed,
                  endedAtSeconds: Number(detail.endedAt),
                  claimGraceSeconds: Number(detail.claimGrace),
                  nowSeconds,
                  connected: isConnected,
                });

                return (
                  <li key={kpi.index} className="rounded border border-hairline px-3 py-2">
                    <p className="text-xs font-medium text-ink">{KPI_KIND_LABEL[kpi.spec.kind]}</p>
                    <p className="text-xs text-ink-muted">
                      {progress.toLocaleString("en-US")} credited · {settledTiers}/
                      {kpi.tiers.length} tiers · {formatTokenAmount(earned, token.decimals)}{" "}
                      {token.symbol} paid
                    </p>

                    {/*
                      Only rendered when the chain says a crossed tier went unpaid. `settle` would
                      succeed and transfer nothing otherwise, so an always-on button would cost the
                      promoter gas to learn they were already paid.
                    */}
                    {owed > BigInt(0) ? (
                      <div className="mt-2 space-y-1">
                        <button
                          type="button"
                          onClick={async () => {
                            if (!address) return;
                            await settle.settle(detail.address, address, kpi.index, {
                              campaignName: detail.name,
                              kpiLabel: KPI_KIND_LABEL[kpi.spec.kind],
                              symbol: token.symbol,
                              decimals: token.decimals,
                            });
                            onDone();
                          }}
                          disabled={!eligibility.ok || isPending(settle.state)}
                          title={eligibility.reason}
                          className="rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-plane hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {settle.pendingKpi === kpi.index && isPending(settle.state)
                            ? "Settling…"
                            : `Claim ${formatTokenAmount(owed, token.decimals)} ${token.symbol}`}
                        </button>
                        {!eligibility.ok ? (
                          <p className="text-xs text-brand">{eligibility.reason}</p>
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>

            <TxFeedback state={settle.state} onReset={settle.reset} />
          </div>
        </div>
      )}
    </Card>
  );
}

/** Shared transaction status line — see the note in ProjectActions. */
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
        <p className="text-ink-muted">Submitted — waiting for confirmation.</p>
      ) : null}
    </div>
  );
}
