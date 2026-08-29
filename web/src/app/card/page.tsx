"use client";

import {useCallback} from "react";
import Link from "next/link";
import {useAccount} from "wagmi";
import {BoneyCard} from "@/components/BoneyCard";
import {useBoneyCard} from "@/hooks/useBoneyCard";
import {useEthosAttestation} from "@/hooks/useEthosAttestation";
import {cardPath} from "@/lib/publicCard";

/**
 * `/card` — the connected wallet's BoneyCard.
 *
 * A thin container: the hook does the IO, `lib/boneycard.ts` does the deciding, `BoneyCard` does the
 * rendering. What lives here is only the wiring between the card's verify affordance and
 * `useEthosAttestation`, plus the progress that submission reports back.
 *
 * Verification is deliberately reachable only from the "verify to join" group inside the card and
 * never from the header. It costs one transaction per weighted schema, sequentially, and asking for
 * that before a promoter has seen anything work is the wrong first impression — the campaigns with no
 * reputation floor are the honest opening.
 */
export default function Page() {
  const {address} = useAccount();
  const card = useBoneyCard(address);
  const {refetchReputation} = card;
  const {state, attest, reset} = useEthosAttestation();

  /**
   * Verify, then re-read the score the chain keeps.
   *
   * The refetch is the half that makes the transition visible. `useEthosAttestation` submits and
   * reports success but owns no query, so without this the cached `scoreOf` stays where it was and
   * every campaign it just unlocked keeps sitting under "Verify to join" — asking for a verification
   * that has already been paid for. `PromoterPanel` does the same after its own attest.
   */
  const onVerify = useCallback(async () => {
    if (await attest()) await refetchReputation();
  }, [attest, refetchReputation]);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl text-ink">BoneyCard</h1>
          <p className="mt-1 text-sm text-ink-muted">
            What Boneyard knows about you so far. Your score and audience are here now; campaigns,
            referrals and payouts fill in as you promote.
          </p>
        </div>

        {/*
          The public version of this card, at the address that owns it. Offered only when connected
          because the link *is* the address — there is nothing to share without one.

          It is a link rather than a copy-to-clipboard button so the destination is visible before it
          is sent anywhere: `/b/<wallet>` is walletless and server-rendered, and a promoter is
          entitled to see exactly what a stranger sees before they post it.
        */}
        {address ? (
          <Link
            className="shrink-0 rounded border border-hairline px-2.5 py-1.5 text-xs font-semibold text-brand hover:bg-surface-hover"
            href={cardPath(address)}
          >
            View your public card →
          </Link>
        ) : null}
      </div>

      {state.status !== "idle" ? <AttestProgress state={state} onDismiss={reset} /> : null}

      <BoneyCard
        wallet={address}
        score={card.score}
        scoreLoading={card.scoreLoading}
        onChainExpired={card.onChainExpired}
        scale={card.scale}
        qualification={card.qualification}
        headline={card.headline}
        qualificationReady={card.qualificationReady}
        history={card.history}
        historyUnavailable={card.historyUnavailable}
        historyLoading={card.historyLoading}
        indexedBlock={card.indexedBlock}
        lag={card.lag}
        earnedToken={card.earnedToken}
        onVerify={onVerify}
        onRetryScore={() => void card.refetchScore()}
        onRetryHistory={() => void card.refetchHistory()}
      />
    </div>
  );
}

/**
 * Attestation progress.
 *
 * The submission count is worth surfacing rather than hiding behind one spinner: it is one
 * transaction per schema, sent sequentially because the verifier consumes a nonce per signature, so
 * a promoter who sees "1 of 3" understands why their wallet is asking again.
 */
function AttestProgress({
  state,
  onDismiss,
}: {
  state: ReturnType<typeof useEthosAttestation>["state"];
  onDismiss: () => void;
}) {
  const text =
    state.status === "fetching"
      ? "Reading your Ethos profile and audience…"
      : state.status === "submitting"
        ? `Submitting attestation ${state.done + 1} of ${state.total} — one transaction each.`
        : state.status === "success"
          ? `Verified. Ethos ${state.ethos.toLocaleString()}, reach ${state.reach.toLocaleString()} are now on chain.`
          : state.status === "error"
            ? state.message
            : "";

  const tone =
    state.status === "error"
      ? "border-critical/50 text-critical"
      : state.status === "success"
        ? "border-good/50 text-ink"
        : "border-hairline text-ink-secondary";

  return (
    <div className={`flex items-start justify-between gap-3 rounded border bg-surface-2 p-3 ${tone}`}>
      <p className="text-xs">{text}</p>
      {state.status === "success" || state.status === "error" ? (
        <button className="text-xs text-ink-muted underline" onClick={onDismiss} type="button">
          dismiss
        </button>
      ) : null}
    </div>
  );
}
