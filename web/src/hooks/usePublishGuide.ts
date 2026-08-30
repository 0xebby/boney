"use client";

import {useCallback, useState} from "react";
import {useWalletClient} from "wagmi";
import {useBoneyChainId} from "@/hooks/useBoneyChain";
import {canonicalGuideMessage, isEmptyGuide, type CampaignGuide} from "@/lib/campaignGuide";
import {useConfirmSignature} from "@/components/SignatureGate";
import {publishGuideIntent, type IntentContext} from "@/lib/writeIntents";

/**
 * Publishes a campaign's off-chain guide, signed by the project wallet.
 *
 * One signature, no transaction and no gas: the campaign already exists on chain by the time this
 * runs, and all `/api/campaign-guide` needs is proof that the caller holds the key
 * `CampaignConfig.project` names. That check is what keeps the store from being an open field for
 * outbound links shown to referrals — see the route.
 *
 * Kept out of `useCreateCampaign` deliberately. Creation is a transaction whose success or failure is
 * the campaign's; publishing a guide is a separate, optional, non-chain step that can fail on its own
 * without the campaign being any less created. Folding the two into one state machine would make a
 * refused signature look like a failed creation.
 */
export type PublishState =
  | {status: "idle"}
  /** Waiting on the wallet to sign the guide. */
  | {status: "signing"}
  | {status: "saving"}
  | {status: "saved"}
  /** Every field was blank or dropped, so the store treated it as a withdrawal. */
  | {status: "cleared"}
  /**
   * The deployment cannot store guides — a read-only filesystem, which is the Netlify case.
   *
   * Carries the entry to paste into `campaignGuide.CATALOG`, because the alternative is telling a
   * project their guide is gone and leaving them to retype it.
   */
  | {status: "unwritable"; message: string; entry: unknown}
  | {status: "error"; message: string};

export function usePublishGuide() {
  const {data: walletClient} = useWalletClient();
  const chainId = useBoneyChainId();
  const confirmSignature = useConfirmSignature();
  const [state, setState] = useState<PublishState>({status: "idle"});

  const reset = useCallback(() => setState({status: "idle"}), []);

  const publish = useCallback(
    async (campaign: `0x${string}`, guide: CampaignGuide, ctx?: IntentContext) => {
      if (!walletClient) {
        setState({status: "error", message: "Connect the project wallet to publish the guide."});
        return;
      }

      if (!(await confirmSignature(publishGuideIntent(campaign, isEmptyGuide(guide), ctx)))) return;

      let signature: `0x${string}`;
      try {
        setState({status: "signing"});
        signature = await walletClient.signMessage({
          account: walletClient.account,
          // The canonical form, not the raw draft: the project signs what will be stored, and the
          // server rebuilds this same string from its own sanitized copy.
          message: canonicalGuideMessage({campaign, chainId, guide}),
        });
      } catch (cause) {
        // Overwhelmingly a rejected signature, which is a choice rather than a fault — so it reads as
        // "not published" rather than as an error to retry.
        setState({
          status: "error",
          message: cause instanceof Error ? cause.message : "The signature was not provided.",
        });
        return;
      }

      try {
        setState({status: "saving"});
        const response = await fetch("/api/campaign-guide", {
          body: JSON.stringify({campaign, chainId, guide, signature}),
          headers: {"content-type": "application/json"},
          method: "POST",
        });

        const body = (await response.json().catch(() => ({}))) as {
          entry?: unknown;
          error?: string;
          message?: string;
        };

        if (response.status === 501) {
          setState({
            entry: body.entry,
            message: body.message ?? "This deployment cannot store guides.",
            status: "unwritable",
          });
          return;
        }
        if (!response.ok) {
          setState({status: "error", message: body.message ?? `Request failed (${response.status}).`});
          return;
        }

        setState({status: isEmptyGuide(guide) ? "cleared" : "saved"});
      } catch (cause) {
        setState({
          status: "error",
          message: cause instanceof Error ? cause.message : "Could not reach the guide store.",
        });
      }
    },
    [walletClient, chainId, confirmSignature],
  );

  return {publish, reset, state};
}
