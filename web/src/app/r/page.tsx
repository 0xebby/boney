"use client";

import {useEffect, Suspense} from "react";
import {useSearchParams, useRouter} from "next/navigation";
import {useAccount, usePublicClient} from "wagmi";
import {useQuery} from "@tanstack/react-query";
import {Card, CardHeader} from "@/components/ui/Card";
import {EmptyState, ErrorState} from "@/components/ui/States";
import {useStoreTouch, type TxState} from "@/hooks/useWriteCampaign";
import {fetchCampaignDetail} from "@/lib/campaignDetail";
import {shortAddress, formatDuration} from "@/lib/format";
import {useNow} from "@/hooks/useNow";
import type {PublicClient} from "viem";

/**
 * `/r` — tracking-link landing page.
 *
 * A user clicking a KOL's link arrives here with `?c=campaign&p=promoterId`. This page signs the
 * Touch, relays it to the registry, and redirects to the campaign detail page. If the signature
 * lands, future actions on that campaign will credit the KOL until the touch expires or another
 * KOL signs a fresher one.
 */
function AttributionPageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const {isConnected} = useAccount();
  const client = usePublicClient();
  const now = useNow();

  const campaign = (searchParams.get("c") as `0x${string}`) || undefined;
  const promoterId = (searchParams.get("p") as `0x${string}`) || undefined;

  const {data: detail, isLoading, error, refetch} = useQuery({
    queryKey: ["campaignDetailForAttribution", campaign],
    enabled: Boolean(client && campaign),
    queryFn: async () => {
      if (!client || !campaign) return null;
      return await fetchCampaignDetail(client as PublicClient, campaign);
    },
  });

  const storeTouchTx = useStoreTouch();

  const handleConfirm = () => {
    if (campaign && promoterId) {
      storeTouchTx.storeTouch(campaign, promoterId);
    }
  };

  // Redirect to the campaign once confirmed.
  useEffect(() => {
    if (storeTouchTx.state.status === "confirmed" && campaign) {
      setTimeout(() => router.push(`/campaign/${campaign}`), 1500);
    }
  }, [storeTouchTx.state.status, campaign, router]);

  if (!campaign || !promoterId) {
    return (
      <Card>
        <EmptyState
          title="Invalid tracking link"
          description="This link is missing required parameters. Ask the promoter for a fresh link."
        />
      </Card>
    );
  }

  if (isLoading) {
    return (
      <Card>
        <div className="flex items-center justify-center p-8">
          <div className="h-6 w-32 animate-pulse rounded bg-surface-2" />
        </div>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <ErrorState message={String(error)} onRetry={refetch} />
      </Card>
    );
  }

  if (!detail) {
    return (
      <Card>
        <EmptyState
          title="Campaign not found"
          description="This campaign does not exist or is not deployed on the current network."
        />
      </Card>
    );
  }

  const expiresAt = storeTouchTx.touch
    ? Number(storeTouchTx.touch.expiresAt)
    : Number(detail.attributionWindow) + now;
  const remaining = expiresAt - now;

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Card>
        <CardHeader
          title="Confirm attribution"
          subtitle={`Campaign ${shortAddress(campaign)}`}
        />

        <div className="space-y-4 p-5">
          {!isConnected ? (
            <p className="text-sm text-muted">
              Connect a wallet to confirm that you were referred by this promoter. Future actions on
              this campaign will credit them until the attribution expires.
            </p>
          ) : storeTouchTx.state.status === "idle" ? (
            <>
              <p className="text-sm text-muted">
                You are confirming attribution to promoter{" "}
                <span className="font-mono text-text">{shortAddress(promoterId)}</span>.
              </p>

              <button
                onClick={handleConfirm}
                className="w-full rounded bg-accent px-4 py-2 text-sm font-medium text-text-inverse hover:bg-accent/90 disabled:opacity-50"
              >
                Confirm attribution
              </button>
            </>
          ) : (
            <>
              <div className="space-y-2">
                <p className="text-sm text-muted">
                  You are confirming attribution to promoter{" "}
                  <span className="font-mono text-text">{shortAddress(promoterId)}</span>.
                </p>

                {storeTouchTx.touch && (
                  <p className="text-xs text-muted">
                    Attribution expires in{" "}
                    <span className="text-text">{formatDuration(remaining)}</span>.
                  </p>
                )}
              </div>

              <TxFeedback state={storeTouchTx.state} onReset={storeTouchTx.reset} />

              {storeTouchTx.state.status === "confirmed" && (
                <p className="text-sm text-success">
                  Attribution confirmed. Redirecting to the campaign...
                </p>
              )}
            </>
          )}
        </div>
      </Card>
    </div>
  );
}

export default function AttributionPage() {
  return (
    <Suspense fallback={<div className="h-32 animate-pulse rounded bg-surface-2" />}>
      <AttributionPageContent />
    </Suspense>
  );
}

function TxFeedback({state, onReset}: {state: TxState; onReset: () => void}) {
  if (state.status === "idle") return null;

  if (state.status === "error") {
    return (
      <div className="rounded border border-error/20 bg-error/5 p-3">
        <p className="text-sm text-error">{state.message}</p>
        <button
          onClick={onReset}
          className="mt-2 text-xs text-error underline hover:no-underline"
        >
          Try again
        </button>
      </div>
    );
  }

  const label = state.status === "preparing" ? "Awaiting signature..." : "Submitting...";
  return (
    <div className="rounded border border-accent/20 bg-accent/5 p-3">
      <p className="text-sm text-accent">{label}</p>
    </div>
  );
}
