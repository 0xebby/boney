"use client";

import {useMemo, useState} from "react";
import Link from "next/link";
import {useCampaignPromoters} from "@/hooks/useCampaignPromoters";
import {useBoneyChainId} from "@/hooks/useBoneyChain";
import type {TokenMeta} from "@/lib/token";
import {Card} from "@/components/ui/Card";
import {StatTile, StatRow} from "@/components/ui/StatTile";
import {StatusPill} from "@/components/ui/StatusPill";
import {EmptyState, ErrorState, SkeletonRows} from "@/components/ui/States";
import {trackingLink} from "@/lib/promoter";
import {cardLink} from "@/lib/publicCard";
import {countPromoters, countDistinctPromoters} from "@/lib/promoters";
import {formatTokenAmount, shortAddress} from "@/lib/format";
import type {CampaignView} from "@/lib/types";

/**
 * The public promoter directory — who is promoting what, and the link to reach them through.
 *
 * This is what `/promoters` shows a visitor with no wallet connected. The page used to show a
 * connect wall there, which was the wrong trade for the one visitor type most likely to be new:
 * someone evaluating the marketplace has no reason to connect a wallet before they can see whether
 * anyone is actually using it. Browsing needs no signature, so it should need no wallet.
 *
 * A connected promoter still gets the dashboard — this replaces nothing for them.
 *
 * Every tracking link here is public by construction: it is what a promoter shares to be found,
 * and it carries no authority. Following one only offers to sign a Touch, which the visitor's own
 * wallet must approve, so listing links cannot be used to attribute anyone against their will.
 */
export function PromoterDirectory({
  campaigns,
  tokens,
  isLoading,
  error,
  onRetry,
}: {
  campaigns: readonly CampaignView[];
  tokens: Record<string, TokenMeta>;
  isLoading: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  const directory = useCampaignPromoters(campaigns);

  // Campaigns with promoters first — a visitor is looking for people, and a wall of empty
  // campaigns above the populated ones buries the only rows that answer the question.
  const groups = useMemo(() => {
    return directory.groups
      .slice()
      .sort((a, b) => {
        if (a.promoters.length !== b.promoters.length) {
          return b.promoters.length - a.promoters.length;
        }
        return Number(b.view.campaignId - a.view.campaignId);
      });
  }, [directory.groups]);

  const totalMemberships = countPromoters(groups);
  const distinctPromoters = countDistinctPromoters(groups);
  const busy = isLoading || directory.isLoading;

  if (error) {
    return (
      <Card>
        <ErrorState message={String(error)} onRetry={onRetry} />
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      <StatRow>
        <StatTile
          label="Active promoters"
          value={busy ? "—" : distinctPromoters.toLocaleString("en-US")}
          hint="distinct wallets"
        />
        <StatTile
          label="Memberships"
          value={busy ? "—" : totalMemberships.toLocaleString("en-US")}
          hint="across all campaigns"
        />
        <StatTile
          label="Campaigns"
          value={busy ? "—" : groups.length.toLocaleString("en-US")}
          hint={`${groups.filter((g) => g.promoters.length > 0).length} with promoters`}
        />
      </StatRow>

      {/*
        A partial scan must announce itself. Rendering a clipped directory as if it were the whole
        thing would tell a visitor "three promoters" when the real answer is "three, plus however
        many joined before the window we could afford to read".
      */}
      {directory.scannedFrom !== undefined ? (
        <p className="rounded-md border border-hairline bg-surface-1 px-3 py-2 text-xs text-ink-muted">
          Showing joins from block {directory.scannedFrom.toString()} onward. Earlier memberships
          are not listed — this chain&rsquo;s history is longer than one scan can cover.
        </p>
      ) : null}

      {busy ? (
        <Card padded={false}>
          <SkeletonRows rows={3} cols={3} />
        </Card>
      ) : groups.length === 0 ? (
        <Card>
          <EmptyState
            title="No campaigns yet"
            description="Once projects create campaigns and promoters join them, they appear here."
          />
        </Card>
      ) : totalMemberships === 0 ? (
        <Card>
          <EmptyState
            title="No promoters yet"
            description="Nobody has joined a campaign on this network yet. Connect a wallet to be the first."
            action={
              <Link
                href="/"
                className="rounded-md border border-hairline-strong px-3 py-1.5 text-xs font-medium text-ink hover:bg-surface-hover"
              >
                Browse campaigns
              </Link>
            }
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {groups
            .filter((group) => group.promoters.length > 0)
            .map((group) => (
              <CampaignPromoterCard
                key={group.view.campaign}
                view={group.view}
                promoters={group.promoters}
                token={tokens[group.view.token.toLowerCase()]}
              />
            ))}
        </div>
      )}
    </div>
  );
}

function CampaignPromoterCard({
  view,
  promoters,
  token,
}: {
  view: CampaignView;
  promoters: {promoter: `0x${string}`; promoterId: `0x${string}`; reputation: bigint}[];
  token?: TokenMeta;
}) {
  return (
    <Card padded={false}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-hairline px-4 py-3">
        <div className="flex items-center gap-3">
          <Link
            href={`/campaign/${view.campaignId}`}
            className="text-sm font-medium text-ink hover:underline"
          >
            Campaign #{view.campaignId.toString()}
          </Link>
          <StatusPill status={view.status} />
        </div>

        <div className="flex items-center gap-3 text-xs text-ink-muted">
          <span>
            {promoters.length} promoter{promoters.length === 1 ? "" : "s"}
          </span>
          {token ? (
            <span className="tnum">
              {formatTokenAmount(view.rewardPool, token.decimals, {compact: true})} {token.symbol}
            </span>
          ) : null}
        </div>
      </div>

      <ul className="divide-y divide-hairline">
        {promoters.map((promoter) => (
          <li
            key={promoter.promoter}
            className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5"
          >
            <div className="flex min-w-0 items-center gap-3">
              <PromoterName wallet={promoter.promoter} />
              {promoter.reputation > BigInt(0) ? (
                <span className="tnum text-xs text-ink-muted">
                  reputation {promoter.reputation.toLocaleString("en-US")}
                </span>
              ) : null}
            </div>

            <VisitLink campaign={view.campaign} promoterId={promoter.promoterId} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

/**
 * A promoter's wallet, linked to their BoneyCard where that card exists.
 *
 * This is the page's one route to somebody else's card, and it is the reason `/b/<wallet>` is walletless:
 * a visitor browsing the directory with no wallet connected can open any promoter's history. The link is
 * dropped rather than disabled off the chain the card serves — `useBoneyChainId` reads anvil for a wallet
 * connected locally, and a card for the wrong deployment is worse than no link.
 */
function PromoterName({wallet}: {wallet: `0x${string}`}) {
  const href = cardLink(wallet, useBoneyChainId());
  const label = shortAddress(wallet);
  return href ? (
    <Link href={href} className="font-mono text-[13px] text-ink hover:underline">
      {label}
    </Link>
  ) : (
    <span className="font-mono text-[13px] text-ink">{label}</span>
  );
}

/**
 * The promoter's tracking link, offered both ways: follow it, or copy it.
 *
 * Following is the point — it is how a visitor arrives attributed to this promoter — but the link
 * is built from `window.location.origin`, which is unavailable during the server render. Until it
 * resolves the control renders disabled rather than as a link to nowhere.
 */
function VisitLink({campaign, promoterId}: {campaign: `0x${string}`; promoterId: `0x${string}`}) {
  const [copied, setCopied] = useState(false);

  const link = typeof window === "undefined"
    ? undefined
    : trackingLink(window.location.origin, campaign, promoterId);

  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
    setTimeout(() => setCopied(false), 2_000);
  };

  if (!link) {
    return <span className="text-xs text-ink-muted">—</span>;
  }

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <button
        type="button"
        onClick={copy}
        className={`rounded border px-2 py-1 text-xs transition-colors ${
          copied
            ? "border-good/40 text-good"
            : "border-hairline text-ink-secondary hover:bg-surface-hover hover:text-ink"
        }`}
        title="Copy this promoter's tracking link"
      >
        {copied ? "✓ Copied" : "⎘ Copy"}
        <span role="status" aria-live="polite" className="sr-only">
          {copied ? "Tracking link copied" : ""}
        </span>
      </button>

      <Link
        href={`/r?c=${campaign}&p=${promoterId}`}
        className="rounded border border-hairline-strong px-2 py-1 text-xs font-medium text-ink transition-colors hover:bg-surface-hover"
      >
        Visit
      </Link>
    </div>
  );
}
