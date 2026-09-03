"use client";

import {useMemo, useState} from "react";
import Link from "next/link";
import {useAccount} from "wagmi";
import {useCampaigns} from "@/hooks/useCampaigns";
import type {TokenMeta} from "@/lib/token";
import {useJoinedCampaigns} from "@/hooks/useJoinedCampaigns";
import {useCampaignAttributions} from "@/hooks/useCampaignAttributions";
import {useNow} from "@/hooks/useNow";
import {useBoneyChainId} from "@/hooks/useBoneyChain";
import {DataTable, type Column} from "@/components/ui/DataTable";
import {StatTile, StatRow} from "@/components/ui/StatTile";
import {StatusPill} from "@/components/ui/StatusPill";
import {Card, CardHeader} from "@/components/ui/Card";
import {EmptyState, ErrorState, SkeletonRows} from "@/components/ui/States";
import {PromoterDirectory} from "@/components/PromoterDirectory";
import {ReferredCampaigns} from "@/components/ReferredCampaigns";
import {trackingLink} from "@/lib/promoter";
import { projectName, hasProjectName } from "@/lib/projects";
import {classifyTouch} from "@/lib/referrals";
import {
  countLiveAttributions,
  promoterKey,
  type AttributionEntry,
} from "@/lib/attributions";
import {cardLink} from "@/lib/publicCard";
import {formatDateTime, formatTokenAmount, formatTimeUntil, shortAddress} from "@/lib/format";
import type {CampaignView} from "@/lib/types";

type JoinedRow = {
  view: CampaignView;
  promoterId: `0x${string}`;
  link: string;
};

/** One wallet attributed to this promoter, alongside the campaign it was attributed on. */
type ReferralRow = {
  view: CampaignView;
  entry: AttributionEntry;
};

/** One campaign this wallet promotes, with the wallets currently attributed to it there. */
type ReferralGroup = {
  view: CampaignView;
  entries: AttributionEntry[];
};

/**
 * `/promoters` — promoter dashboard.
 *
 * Two roles, two tables. A wallet can hold both at once and they are genuinely different
 * relationships, so neither is folded into the other:
 *
 *  - **Campaigns you promote** — memberships from `join()`, each with a tracking link to share.
 *  - **Campaigns you were referred to** — campaigns where *this* wallet signed a Touch through
 *    somebody else's link, rendered by `ReferredCampaigns`. The same card is on `/my`, which is the
 *    tab a wallet with no membership actually has: this page's nav entry appears only once the
 *    wallet holds one, so a pure referral could never reach it here.
 *
 * A wallet with no memberships still sees the referral table (and vice versa); each carries its own
 * empty state rather than the page hiding one behind the other.
 *
 * The dashboard does not total what each membership has paid — that requires one campaign-detail
 * read per membership to retrieve tier ladders and progress, which is better done on the detail
 * page where the full breakdown is useful. The summary here shows pool, status, and time remaining,
 * which are already present in the `CampaignView` the marketplace fetched.
 */
export function PromoterDashboard() {
  const {isConnected} = useAccount();
  const {campaigns, tokens, isLoading, error, refetch, deployed} = useCampaigns();
  const joinedQuery = useJoinedCampaigns(campaigns);
  const now = useNow();

  // Scoped to the memberships rather than the whole marketplace: only a campaign this wallet
  // promotes can carry a referral of its own.
  const joinedViews = useMemo(
    () => joinedQuery.joined.map(({view}) => view),
    [joinedQuery.joined],
  );
  const attributions = useCampaignAttributions(joinedViews);

  const rows = useMemo((): JoinedRow[] => {
    if (typeof window === "undefined") return [];
    const origin = window.location.origin;
    return joinedQuery.joined.map(({view, promoterId}) => ({
      view,
      promoterId,
      link: trackingLink(origin, view.campaign, promoterId),
    }));
  }, [joinedQuery.joined]);

  const activeCount = useMemo(
    () => rows.filter((r) => r.view.status === "Active").length,
    [rows],
  );

  const referralRows = useMemo((): ReferralRow[] => {
    return joinedQuery.joined.flatMap(({view, promoterId}) => {
      const entries = attributions.byPromoter.get(promoterKey(view.campaign, promoterId)) ?? [];
      return entries.map((entry) => ({view, entry}));
    });
  }, [joinedQuery.joined, attributions.byPromoter]);

  // Grouped per campaign rather than one flat list: a promoter id is minted per campaign, so a
  // wallet attributed on two campaigns is two separate attributions, and the campaign is what
  // decides whether the attribution is worth anything.
  const referralGroups = useMemo((): ReferralGroup[] => {
    const groups = joinedQuery.joined.map(({view, promoterId}) => ({
      view,
      entries: attributions.byPromoter.get(promoterKey(view.campaign, promoterId)) ?? [],
    }));
    return groups.sort(
      (a, b) =>
        b.entries.length - a.entries.length || Number(a.view.campaignId - b.view.campaignId),
    );
  }, [joinedQuery.joined, attributions.byPromoter]);

  const liveAttributed = useMemo(
    () => countLiveAttributions(referralRows.map((r) => r.entry), now),
    [referralRows, now],
  );

  const columns = useMemo(() => buildColumns(tokens, now), [tokens, now]);
  const walletColumns = useMemo(() => buildWalletColumns(now), [now]);

  if (!deployed) {
    return (
      <Card>
        <EmptyState
          title="Boneyard is not available on this network"
          description="Switch your wallet to a supported network to see campaigns."
        />
      </Card>
    );
  }

  if (!isConnected) {
    return (
      <div className="space-y-5">
        <Header connected={false} />
        <PromoterDirectory
          campaigns={campaigns}
          tokens={tokens}
          isLoading={isLoading}
          error={error}
          onRetry={() => refetch()}
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <Header />

      <StatRow>
        <StatTile
          label="Campaigns Promoted"
          value={rows.length.toLocaleString("en-US")}
          hint={`${activeCount} active`}
        />
        <StatTile
          label="Promotion links"
          value={rows.length.toLocaleString("en-US")}
          hint="(one per campaign)"
        />
        <StatTile
          label="Wallets you referred"
          value={attributions.isLoading ? "—" : referralRows.length.toLocaleString("en-US")}
          hint={`${liveAttributed} still crediting`}
        />
      </StatRow>

      <Card padded={false}>
        {/* `Card` drops its padding so the table can run edge to edge; the header puts its own
            back, matching how `PromoterDirectory` pads content inside an unpadded card. */}
        <div className="px-4 pt-4">
          <CardHeader
            title="Campaigns you promote"
            subtitle="Campaigns you promote, and your boneylink to share for each"
          />
        </div>
        {isLoading || joinedQuery.isLoading ? (
          <SkeletonRows rows={3} cols={6} />
        ) : error ? (
          <ErrorState message={String(error)} onRetry={() => refetch()} />
        ) : joinedQuery.error ? (
          <ErrorState message={String(joinedQuery.error)} onRetry={() => joinedQuery.refetch()} />
        ) : (
          <DataTable
            rows={rows}
            columns={columns}
            rowKey={(r) => r.view.campaign}
                  initialSort={{key: "name", dir: "asc"}}
            isRefreshing={joinedQuery.isRefreshing}
            emptyState={
              <EmptyState
                title="Not Promoting Any Campaign Yet."
                description="Browse the boneyard and promote campaigns that match your audience. Each one gives you a tracking link to share."
                action={
                  <Link
                    href="/"
                    className="rounded-md border border-hairline-strong px-3 py-1.5 text-xs font-medium text-ink hover:bg-surface-hover"
                  >
                    Browse Boneyard
                  </Link>
                }
              />
            }
          />
        )}
      </Card>

      {/*
        The wallets this promoter's own links brought in, grouped by the campaign they were
        attributed on. `AttributionRegistry` holds one touch per (campaign, wallet), so a wallet
        appears once per campaign under whichever promoter it most recently signed for.
      */}
      <Card padded={false}>
        <div className="px-4 pt-4">
          <CardHeader title="Wallets you referred" />
        </div>
        {isLoading || joinedQuery.isLoading || attributions.isLoading ? (
          <SkeletonRows rows={2} cols={4} />
        ) : attributions.error ? (
          <ErrorState message={String(attributions.error)} onRetry={() => attributions.refetch()} />
        ) : (
          <>
            {attributions.scannedFrom !== undefined || attributions.truncated ? (
              <p className="px-4 pb-2 text-xs text-ink-muted">
                {attributions.scannedFrom !== undefined
                  ? `Attributions signed before block ${attributions.scannedFrom.toString()} are not listed.`
                  : "More attributions exist than one read returns, so this is a floor."}
              </p>
            ) : null}
            {referralGroups.length === 0 ? (
              <EmptyState
                title="No wallets attributed to you yet"
                description="When somebody follows one of your boneylinks and confirms the attribution, their wallet shows up here."
              />
            ) : (
              <div className={attributions.isRefreshing ? "opacity-60" : undefined}>
                {referralGroups.map((group) => (
                  <ReferralGroupRows
                    key={group.view.campaign}
                    columns={walletColumns}
                    group={group}
                    now={now}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </Card>

      <ReferredCampaigns campaigns={campaigns} isLoading={isLoading} />
    </div>
  );
}

/**
 * The heading says different things to different visitors: a connected promoter is looking at
 * their own memberships, an anonymous one is browsing everybody's.
 */
function Header({connected = true}: {connected?: boolean}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="font-display text-2xl text-ink">
          {connected ? "Promoter dashboard" : "Promoters"}
        </h1>
        <p className="mt-0.5 text-xs text-ink-muted">
          {connected
            ? "Campaigns you promote. Open one to see progress, what it has paid you, and your tracking link."
            : "Promoters active on each campaign, and the links they share. Connect a wallet to promote and get your own."}
        </p>
      </div>

      {/*
        This page is per-campaign; the card is the cumulative view of the same memberships — level,
        tiers crossed, referrals, milestones. Offered only to a connected wallet because that is what
        `/card` needs to have anything of its own to show, and it matches how the nav gates the entry.
      */}
      {connected ? (
        <Link
          className="shrink-0 rounded border border-hairline px-2.5 py-1.5 text-xs font-semibold text-brand hover:bg-surface-hover"
          href="/card"
        >
          Your BoneyCard →
        </Link>
      ) : null}
    </header>
  );
}

function buildColumns(tokens: Record<string, TokenMeta>, now: number): Column<JoinedRow>[] {
  const meta = (r: JoinedRow) =>
    tokens[r.view.token.toLowerCase()] ?? {symbol: "", decimals: 18};

  return [
    {
      key: "name",
      header: "Campaign",
      // Sorts on the displayed title. Unnamed rows sort together under "Campaign #".
      sortValue: (r) =>
        hasProjectName(r.view) ? projectName(r.view) : `Campaign #${r.view.campaignId}`,
      render: (r) => (
        <span className="inline-flex items-center gap-2">
          <Link
            href={`/campaign/${r.view.campaignId}`}
            className="font-medium text-ink hover:underline"
          >
            {hasProjectName(r.view)
              ? projectName(r.view)
              : `Campaign #${r.view.campaignId.toString()}`}
          </Link>
          {hasProjectName(r.view) ? (
            <span className="tnum text-xs text-ink-muted">#{r.view.campaignId.toString()}</span>
          ) : null}
        </span>
      ),
    },
    {
      key: "project",
      header: "Project",
      // The project wallet — the title beside it names the campaign, not the project.
      hideOnMobile: true,
      sortValue: (r) => r.view.project.toLowerCase(),
      render: (r) => <span className="text-ink-muted">{shortAddress(r.view.project)}</span>,
    },
    {
      key: "status",
      header: "Status",
      sortValue: (r) => r.view.status,
      render: (r) => <StatusPill status={r.view.status} />,
    },
    {
      key: "pool",
      header: "Reward pool",
      numeric: true,
      hideOnMobile: true,
      sortValue: (r) => r.view.rewardPool,
      render: (r) => {
        const m = meta(r);
        return (
          <span>
            {formatTokenAmount(r.view.rewardPool, m.decimals, {compact: true})}{" "}
            <span className="text-ink-muted">{m.symbol}</span>
          </span>
        );
      },
    },
    {
      key: "link",
      header: "Boneylink link",
      sortValue: () => 0,
      render: (r) => (
        <div className="flex items-center gap-1.5">
          <CopyLinkButton link={r.link} />
          <OpenLinkButton campaign={r.view.campaign} promoterId={r.promoterId} />
        </div>
      ),
    },
    {
      key: "ends",
      header: "Ends in",
      numeric: true,
      // The tracking link is the reason this table exists, so it keeps its slot on a phone and the
      // countdown yields — the campaign's own page carries it.
      hideOnMobile: true,
      sortValue: (r) => r.view.endTime,
      render: (r) => {
        if (now === 0) return <span className="text-ink-muted">—</span>;
        return (
          <span className={Number(r.view.endTime) <= now ? "text-ink-muted" : undefined}>
            {formatTimeUntil(r.view.endTime, now)}
          </span>
        );
      },
    },
  ];
}

/**
 * Columns for one campaign's attributed wallets.
 *
 * Carries no campaign column: the campaign is the group heading above the table. The referral's
 * wallet links to its BoneyCard where that card exists, which is the only place in the app a
 * promoter can read back what a wallet they referred has done.
 *
 * @param now Unix seconds, or `0` before the clock is live.
 * @returns The column set.
 */
function buildWalletColumns(now: number): Column<AttributionEntry>[] {
  return [
    {
      key: "referral",
      header: "Wallet",
      sortValue: (e) => e.referral,
      render: (e) => <ReferralWallet wallet={e.referral} />,
    },
    {
      key: "signed",
      header: "Signed",
      hideOnMobile: true,
      sortValue: (e) => e.signedAt,
      render: (e) => <span className="text-ink-secondary">{formatDateTime(e.signedAt)}</span>,
    },
    {
      key: "attribution",
      header: "Attribution",
      numeric: true,
      sortValue: (e) => e.expiresAt,
      render: (e) => {
        // Same first-paint rule as the referral table: `useNow` reports 0 until hydration, and
        // "expired" is the one thing that must not flash.
        if (now === 0) return <span className="text-ink-muted">—</span>;

        return classifyTouch(e, now) === "live" ? (
          <span className="text-good">{formatTimeUntil(e.expiresAt, now)} left</span>
        ) : (
          <span className="text-ink-muted">Expired</span>
        );
      },
    },
  ];
}

/**
 * One campaign's block inside "Wallets you referred" — its heading, then its attributed wallets.
 *
 * A campaign this wallet joined but nobody has followed a link on is still listed, with a line
 * saying so: which of the links has produced nothing is as useful as which has.
 *
 * @param columns The wallet column set from `buildWalletColumns`.
 * @param group The campaign and the wallets currently attributed to this promoter on it.
 * @param now Unix seconds, or `0` before the clock is live.
 * @returns The campaign's heading and table.
 */
function ReferralGroupRows({
  columns,
  group,
  now,
}: {
  columns: Column<AttributionEntry>[];
  group: ReferralGroup;
  now: number;
}) {
  const live = countLiveAttributions(group.entries, now);

  return (
    <div className="border-t border-hairline">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-4 py-2">
        <Link
          href={`/campaign/${group.view.campaignId}`}
          className="text-sm font-medium text-ink hover:underline"
        >
          {projectName(group.view)}
          <span className="tnum ml-2 text-xs font-normal text-ink-muted">
            #{group.view.campaignId.toString()}
          </span>
        </Link>
        <span className="text-xs text-ink-muted">
          {group.entries.length === 1 ? "1 wallet" : `${group.entries.length} wallets`}
          {now === 0 ? null : ` · ${live} still crediting`}
        </span>
      </div>
      {group.entries.length === 0 ? (
        <p className="px-4 pb-2 text-xs text-ink-muted">No wallets attributed yet.</p>
      ) : (
        <DataTable
          rows={group.entries}
          columns={columns}
          rowKey={(e) => e.referral}
          initialSort={{key: "signed", dir: "desc"}}
        />
      )}
    </div>
  );
}

/**
 * A referred wallet, linked to its BoneyCard where that card exists.
 *
 * The link is dropped off the chain the card serves rather than rendered as a link to nowhere.
 */
function ReferralWallet({wallet}: {wallet: `0x${string}`}) {
  const href = cardLink(wallet, useBoneyChainId());
  const label = shortAddress(wallet);

  return href ? (
    <Link className="font-mono text-xs text-ink-secondary hover:underline" href={href}>
      {label}
    </Link>
  ) : (
    <span className="font-mono text-xs text-ink-secondary">{label}</span>
  );
}

/**
 * Follows a tracking link into the attribution flow, as the alternative to copying it.
 *
 * Points at the relative `/r` route rather than the absolute link `CopyLinkButton` carries, so it
 * needs no origin and works during the server render.
 *
 * @param campaign Address of the campaign the link credits against.
 * @param promoterId Campaign-scoped promoter id the link attributes to.
 * @returns The link control.
 */
function OpenLinkButton({
  campaign,
  promoterId,
}: {
  campaign: `0x${string}`;
  promoterId: `0x${string}`;
}) {
  return (
    <Link
      href={`/r?c=${campaign}&p=${promoterId}`}
      // The row is itself clickable; following the link must not also navigate to the campaign.
      onClick={(e) => e.stopPropagation()}
      className="rounded bg-brand px-2 py-1 text-xs font-semibold text-plane transition-opacity hover:opacity-90"
      title="Open this tracking link and attribute the connected wallet"
    >
      Attribute
    </Link>
  );
}

/**
 * Copy-to-clipboard for a tracking link, with the confirmation the bare `writeText` call lacked.
 *
 * Copying is invisible by nature — nothing on screen changes — so without feedback the only way
 * to know it worked is to paste somewhere and check. This is its own component rather than
 * inline JSX because it owns state, and `buildColumns` is a pure function called from a `useMemo`.
 *
 * The failure path matters as much as the success one. `navigator.clipboard` is permission-gated
 * and absent over plain http on some browsers, and an unhandled rejection there would leave the
 * user believing they had copied a link they had not. So the promise is caught and the button
 * says so, mirroring `PromoterPanel`.
 */
function CopyLinkButton({link}: {link: string}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  const copy = async (e: React.MouseEvent) => {
    // The row is itself clickable; copying must not also navigate.
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(link);
      setState("copied");
    } catch {
      setState("failed");
    }
    setTimeout(() => setState("idle"), 2_000);
  };

  return (
    <button
      type="button"
      onClick={copy}
      className={`flex items-center gap-1.5 rounded border px-2 py-1 text-xs transition-colors ${
        state === "copied"
          ? "border-good/40 text-good"
          : state === "failed"
            ? "border-critical/40 text-critical"
            : "border-hairline text-ink-secondary hover:bg-surface-hover hover:text-ink"
      }`}
      title={state === "failed" ? link : "Copy tracking link"}
    >
      <span aria-hidden className="text-[10px]">
        {state === "copied" ? "✓" : state === "failed" ? "!" : "⎘"}
      </span>
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy Promotion link"}
      {/* Announced to screen readers, which see no color change. */}
      <span role="status" aria-live="polite" className="sr-only">
        {state === "copied" ? "Tracking link copied" : state === "failed" ? "Copy failed" : ""}
      </span>
    </button>
  );
}
