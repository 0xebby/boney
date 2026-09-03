"use client";

import {useMemo, useState} from "react";
import Link from "next/link";
import {useCampaignPromoters} from "@/hooks/useCampaignPromoters";
import {useCampaignAttributions} from "@/hooks/useCampaignAttributions";
import {useBoneyChainId} from "@/hooks/useBoneyChain";
import {useNow} from "@/hooks/useNow";
import type {TokenMeta} from "@/lib/token";
import {Card} from "@/components/ui/Card";
import {StatTile, StatRow} from "@/components/ui/StatTile";
import {StatusPill} from "@/components/ui/StatusPill";
import {EmptyState, ErrorState, SkeletonRows} from "@/components/ui/States";
import {trackingLink} from "@/lib/promoter";
import {cardLink} from "@/lib/publicCard";
import {countPromoters, countDistinctPromoters} from "@/lib/promoters";
import {
  countDistinctReferrals,
  countLiveAttributions,
  promoterKey,
  type AttributionEntry,
} from "@/lib/attributions";
import {classifyTouch} from "@/lib/referrals";
import {projectName} from "@/lib/projects";
import {formatDate, formatTokenAmount, shortAddress} from "@/lib/format";
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
  const attributions = useCampaignAttributions(campaigns);
  const now = useNow();

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
  const referralWallets = countDistinctReferrals(attributions.entries);
  const liveReferrals = countLiveAttributions(attributions.entries, now);
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
        <StatTile
          label="Referred wallets"
          value={attributions.isLoading ? "—" : referralWallets.toLocaleString("en-US")}
          hint={`${liveReferrals} still crediting`}
        />
      </StatRow>

      {/*
        A partial read must announce itself. Rendering a clipped directory as if it were the whole
        thing would tell a visitor "three promoters" when the real answer is "three, plus however
        many joined before the window we could afford to read".
      */}
      {directory.scannedFrom !== undefined ? (
        <p className="rounded-md border border-hairline bg-surface-1 px-3 py-2 text-xs text-ink-muted">
          Showing memberships from block {directory.scannedFrom.toString()} onward. Earlier ones
          are not listed — this chain&rsquo;s history is longer than one scan can cover.
        </p>
      ) : null}

      {directory.truncated ? (
        <p className="rounded-md border border-hairline bg-surface-1 px-3 py-2 text-xs text-ink-muted">
          More memberships exist than one read returns, so the counts below are a floor rather than
          the whole directory.
        </p>
      ) : null}

      {attributions.scannedFrom !== undefined || attributions.truncated ? (
        <p className="rounded-md border border-hairline bg-surface-1 px-3 py-2 text-xs text-ink-muted">
          The referral lists below are partial:{" "}
          {attributions.scannedFrom !== undefined
            ? `attributions signed before block ${attributions.scannedFrom.toString()} are not listed.`
            : "more attributions exist than one read returns."}
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
            description="Once projects create campaigns and promoters start promoting, they appear here."
          />
        </Card>
      ) : totalMemberships === 0 ? (
        <Card>
          <EmptyState
            title="No promoters yet"
            description="Nobody is promoting a campaign on this network yet. Connect a wallet to be the first."
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
                referralsByPromoter={attributions.byPromoter}
                referralsLoading={attributions.isLoading}
                now={now}
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
  referralsByPromoter,
  referralsLoading,
  now,
  token,
}: {
  view: CampaignView;
  promoters: {promoter: `0x${string}`; promoterId: `0x${string}`; reputation: bigint}[];
  /** Referrals keyed by `promoterKey`, from `useCampaignAttributions`. */
  referralsByPromoter: Map<string, AttributionEntry[]>;
  referralsLoading: boolean;
  /** Unix seconds, or `0` before the clock is live. */
  now: number;
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
            {projectName(view)}
          </Link>
          <span className="tnum text-xs text-ink-muted">#{view.campaignId.toString()}</span>
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
          <li key={promoter.promoter} className="px-4 py-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-3">
                <PromoterName wallet={promoter.promoter} />
                {promoter.reputation > BigInt(0) ? (
                  <span className="tnum text-xs text-ink-muted">
                    reputation {promoter.reputation.toLocaleString("en-US")}
                  </span>
                ) : null}
              </div>

              <VisitLink campaign={view.campaign} promoterId={promoter.promoterId} />
            </div>

            <ReferralList
              loading={referralsLoading}
              now={now}
              referrals={referralsByPromoter.get(promoterKey(view.campaign, promoter.promoterId))}
            />
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** How many referral wallets are listed before the rest go behind a control. */
const REFERRALS_SHOWN = 6;

/**
 * The referral wallets currently attributed to one promoter on one campaign.
 *
 * One row per wallet, since `AttributionRegistry` holds one touch per `(campaign, user)`. A lapsed
 * attribution is listed and marked rather than dropped: it happened, and it is why a promoter's
 * count can exceed what is still crediting.
 */
function ReferralList({
  loading,
  now,
  referrals,
}: {
  loading: boolean;
  /** Unix seconds, or `0` before the clock is live. */
  now: number;
  referrals?: readonly AttributionEntry[];
}) {
  const [expanded, setExpanded] = useState(false);

  if (loading) {
    return <p className="mt-1.5 text-xs text-ink-muted">Reading attributions&hellip;</p>;
  }

  const rows = referrals ?? [];
  if (rows.length === 0) {
    return <p className="mt-1.5 text-xs text-ink-muted">No wallets attributed yet.</p>;
  }

  const live = countLiveAttributions(rows, now);
  const shown = expanded ? rows : rows.slice(0, REFERRALS_SHOWN);

  return (
    <div className="mt-1.5">
      <p className="text-xs text-ink-muted">
        {rows.length} referral{rows.length === 1 ? "" : "s"} &middot; {live} still crediting
      </p>
      <ul className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1">
        {shown.map((entry) => (
          <li key={entry.referral}>
            <ReferralWallet entry={entry} now={now} />
          </li>
        ))}
        {!expanded && rows.length > REFERRALS_SHOWN ? (
          <li>
            <button
              className="text-xs text-brand hover:underline"
              onClick={() => setExpanded(true)}
              type="button"
            >
              +{rows.length - REFERRALS_SHOWN} more
            </button>
          </li>
        ) : null}
      </ul>
    </div>
  );
}

/**
 * One attributed wallet, linked to its BoneyCard where that card exists.
 *
 * An expired attribution is dimmed and says so on hover; a live one names when it lapses.
 */
function ReferralWallet({entry, now}: {entry: AttributionEntry; now: number}) {
  const href = cardLink(entry.referral, useBoneyChainId());
  const expired = classifyTouch(entry, now) === "expired";
  const label = shortAddress(entry.referral);
  const title = expired
    ? "Attribution expired — actions no longer credit this promoter"
    : `Credits this promoter until ${formatDate(entry.expiresAt)}`;
  const tone = expired ? "text-ink-muted" : "text-ink-secondary";

  return href ? (
    <Link className={`font-mono text-xs ${tone} hover:underline`} href={href} title={title}>
      {label}
      {expired ? " (expired)" : ""}
    </Link>
  ) : (
    <span className={`font-mono text-xs ${tone}`} title={title}>
      {label}
      {expired ? " (expired)" : ""}
    </span>
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
 * The promoter's tracking link, offered both ways: attribute through it now, or copy it to share.
 *
 * The primary control leads straight to the attribution flow and is always present. The copy
 * control needs the absolute link, built from `window.location.origin`, so it appears only once
 * that origin is known rather than copying a link to nowhere during the server render.
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

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {link ? (
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
      ) : null}

      <Link
        href={`/r?c=${campaign}&p=${promoterId}`}
        className="rounded bg-brand px-2 py-1 text-xs font-semibold text-plane transition-opacity hover:opacity-90"
        title="Attribute yourself to this promoter"
      >
        Attribute
      </Link>
    </div>
  );
}
