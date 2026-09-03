"use client";

import {useEffect, Suspense} from "react";
import Link from "next/link";
import {useSearchParams, useRouter} from "next/navigation";
import {useAccount, usePublicClient} from "wagmi";
import {useQuery} from "@tanstack/react-query";
import {Card, CardHeader} from "@/components/ui/Card";
import {EmptyState, ErrorState} from "@/components/ui/States";
import {TxErrorMessage} from "@/components/ui/TxErrorMessage";
import {Notice} from "@/components/ui/Notice";
import {useStoreTouch, type TxState} from "@/hooks/useWriteCampaign";
import {useBoneyChainId} from "@/hooks/useBoneyChain";
import {fetchCampaignDetail} from "@/lib/campaignDetail";
import {fetchBrowseCampaigns} from "@/lib/contracts";
import {AttributionRegistryAbi} from "@/lib/abis";
import {getDeployment} from "@/lib/chains";
import {derivePromoterId} from "@/lib/promoter";
import {classifyTouch, type StoredTouch} from "@/lib/referrals";
import {shortAddress, formatDuration, formatDateTime} from "@/lib/format";
import {useNow} from "@/hooks/useNow";
import type {PublicClient} from "viem";

/**
 * `/r` — tracking-link landing page.
 *
 * A referral clicking a promoter's link arrives here with `?c=campaign&p=promoterId`. This page signs the
 * Touch, relays it to the registry, and redirects to the campaign detail page. If the signature
 * lands, future actions on that campaign will credit the promoter until the touch expires or another
 * promoter signs a fresher one.
 */
function AttributionPageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const {address, isConnected} = useAccount();
  const chainId = useBoneyChainId();
  const client = usePublicClient({chainId});
  const registry = getDeployment(chainId)?.attributionRegistry;
  const now = useNow();

  const campaign = (searchParams.get("c") as `0x${string}`) || undefined;
  const promoterId = (searchParams.get("p") as `0x${string}`) || undefined;

  const {data, isLoading, error, refetch} = useQuery({
    queryKey: ["campaignForAttribution", campaign],
    enabled: Boolean(client && campaign),
    queryFn: async () => {
      if (!client || !campaign) return null;

      // The tracking link carries an address, but `/campaign/[id]` is keyed by the registry's
      // numeric id and rejects anything else. The registry has no address→id lookup, so the id
      // is recovered from the browse list — without it a confirmed attribution would redirect
      // the referral straight into an "Invalid campaign" page.
      const [detail, views] = await Promise.all([
        fetchCampaignDetail(client as PublicClient, campaign),
        fetchBrowseCampaigns(client as PublicClient, BigInt(0), BigInt(1000)),
      ]);

      const match = views.find((v) => v.campaign.toLowerCase() === campaign.toLowerCase());
      return {detail, campaignId: match?.campaignId};
    },
  });

  const detail = data?.detail;
  const campaignId = data?.campaignId;

  /*
    The touch already on record for this wallet, so the page can answer before asking for a
    signature. `storeTouch` refuses a second touch naming the promoter who already holds a live one,
    and without this read the refusal arrives as a reverted transaction the referral paid for.
  */
  const stored = useQuery({
    queryKey: ["storedTouch", chainId, campaign, address],
    enabled: Boolean(client && registry && campaign && address),
    staleTime: 15_000,
    queryFn: async (): Promise<StoredTouch | null> => {
      if (!client || !registry || !campaign || !address) return null;

      return (await (client as PublicClient).readContract({
        address: registry,
        abi: AttributionRegistryAbi,
        functionName: "touchOf",
        args: [campaign, address],
      })) as StoredTouch;
    },
  });

  // Only this promoter's own live window blocks a new touch. A different promoter's live touch is a
  // switch, which the registry allows, and a lapsed one can be re-signed by anybody.
  const held =
    stored.data &&
    promoterId &&
    stored.data.promoterId.toLowerCase() === promoterId.toLowerCase() &&
    classifyTouch(stored.data, now) === "live"
      ? stored.data
      : undefined;

  const storeTouchTx = useStoreTouch();

  const handleConfirm = () => {
    if (campaign && promoterId) {
      storeTouchTx.storeTouch(campaign, promoterId);
    }
  };

  // Redirect once confirmed. Falls back to the marketplace when the id could not be resolved,
  // which beats routing to a detail page that will refuse to render.
  useEffect(() => {
    if (storeTouchTx.state.status !== "confirmed") return;
    const target = campaignId === undefined ? "/" : `/campaign/${campaignId}`;
    const timer = setTimeout(() => router.push(target), 1500);
    return () => clearTimeout(timer);
  }, [storeTouchTx.state.status, campaignId, router]);

  if (!campaign || !promoterId) {
    return (
      <Card>
        <EmptyState
          title="Invalid tracking link"
          description="This link is missing required parameters. Ask the promoter for a fresh link."        />
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

  // A promoter id is `keccak256(campaign, promoter)`, so whether this link is the connected
  // wallet's own is derivable without a read.
  const isSelf =
    Boolean(address) &&
    derivePromoterId(campaign, address as `0x${string}`).toLowerCase() ===
      promoterId.toLowerCase();

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Card>
        <CardHeader
          title="Confirm attribution"
          subtitle={`Campaign ${shortAddress(campaign)}`}
        />

        <div className="space-y-4 p-5">
          {!isConnected ? (
            <p className="text-sm text-ink-muted">
              Connect a wallet to confirm that you were referred by this promoter. Future actions on
              this campaign will credit them until the attribution expires.
            </p>
          ) : storeTouchTx.state.status === "idle" ? (
            held ? (
              <AlreadyAttributed
                promoterId={promoterId}
                expiresAt={held.expiresAt}
                campaignId={campaignId}
              />
            ) : (
            <>
              {/*
                Said before the signature, because a wallet cannot see from the link that the
                promoter behind it is itself.
              */}
              {isSelf ? (
                <Notice tone="warning" title="This is your own promoter link">
                  Signing attributes <b>you</b> to yourself, so your own actions on this campaign
                  credit your promoter slot for {formatDuration(Number(detail.attributionWindow))}.
                  Share the link instead if you meant to attribute somebody else.
                </Notice>
              ) : null}

              <p className="text-sm text-ink-muted">
                You are confirming attribution to promoter{" "}
                <span className="font-mono text-ink">{shortAddress(promoterId)}</span>
                {isSelf ? " — your own" : ""}.
              </p>

              <button
                onClick={handleConfirm}
                className="w-full rounded-md bg-brand px-4 py-2 text-sm font-semibold text-plane hover:opacity-90 disabled:opacity-50"
              >
                Confirm attribution
              </button>
            </>
            )
          ) : (
            <>
              <div className="space-y-2">
                <p className="text-sm text-ink-muted">
                  You are confirming attribution to promoter{" "}
                  <span className="font-mono text-ink">{shortAddress(promoterId)}</span>.
                </p>

                {storeTouchTx.touch && (
                  <p className="text-xs text-ink-muted">
                    Attribution expires in{" "}
                    <span className="text-ink">{formatDuration(remaining)}</span>.
                  </p>
                )}
              </div>

              <TxFeedback state={storeTouchTx.state} onReset={storeTouchTx.reset} />

              {storeTouchTx.state.status === "confirmed" && (
                <Notice tone="good" title="Attribution confirmed">
                  Redirecting to the campaign…
                </Notice>
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

/**
 * The refusal, said before a signature is asked for.
 *
 * @param promoterId The promoter this link credits.
 * @param expiresAt Unix seconds the stored window runs to.
 * @param campaignId Registry id of the campaign, when it could be resolved.
 * @returns The panel shown in place of the confirm button.
 */
function AlreadyAttributed({
  promoterId,
  expiresAt,
  campaignId,
}: {
  promoterId: `0x${string}`;
  expiresAt: bigint;
  campaignId?: bigint;
}) {
  const now = useNow();
  const remaining = Number(expiresAt) - now;

  return (
    <div className="space-y-3">
      <Notice tone="info" title="You are already attributed to this promoter">
        Promoter <span className="font-mono text-ink">{shortAddress(promoterId)}</span> is credited
        for your actions on this campaign until {formatDateTime(expiresAt)}
        {remaining > 0 ? ` — ${formatDuration(remaining)} left` : ""}. The window cannot be extended
        by signing again; it runs out on its own.
      </Notice>

      <p className="text-xs text-ink-muted">
        A different promoter&rsquo;s link would switch your attribution, and this one works again
        once the window lapses.
      </p>

      {campaignId !== undefined ? (
        <Link
          href={`/campaign/${campaignId}`}
          className="block w-full rounded-md border border-hairline-strong px-4 py-2 text-center text-sm font-medium text-ink hover:bg-surface-hover"
        >
          Go to the campaign
        </Link>
      ) : null}
    </div>
  );
}

function TxFeedback({state, onReset}: {state: TxState; onReset: () => void}) {
  if (state.status === "idle") return null;

  if (state.status === "error") {
    return (
      <Notice
        tone="critical"
        title={
          <TxErrorMessage
            message={state.message}
            detail={state.detail}
            onDismiss={onReset}
            dismissLabel="Try again"
          />
        }
      />
    );
  }

  const label = state.status === "preparing" ? "Awaiting signature..." : "Submitting...";
  return <Notice tone="info" title={label} />;
}
