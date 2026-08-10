"use client";

import Link from "next/link";
import {usePathname} from "next/navigation";
import type {ReactNode} from "react";
import {useAccount, useConnect, useDisconnect} from "wagmi";
import {RankBadge} from "@/components/ui/RankBadge";
import {usePromoterReputation} from "@/hooks/usePromoterReputation";
import {useIsPromoter} from "@/hooks/useIsPromoter";
import {rankOf} from "@/lib/ranks";
import {describeTxError} from "@/lib/txErrors";

/**
 * AppShell — a persistent top bar over a single full-width content column.
 * The bar is a product directory, not a settings menu: Campaigns (the list), My Campaigns,
 * Promoters, Docs — plus the Create call to action.
 *
 * The first item is "Campaigns" rather than "Boneyard" on purpose. The brand mark beside it
 * already links to `/`, and the list page leads with a `boneyard` hero — three copies of the name
 * on one screen reads as a stutter, so only the mark and the hero carry it.
 *
 * Create is deliberately NOT in this list. It is the primary action of the whole product, so it
 * sits in the right-hand cluster as a filled button rather than reading as one more peer link.
 *
 * Two entries are personal rather than public, and appear only once they have something to show.
 * A tab that can only ever render "nothing here" is a dead end that costs a navigation to discover:
 *
 *  - **My Campaigns** needs a wallet to know whose campaigns to filter to.
 *  - **Promoters** is a dashboard of memberships and tracking links, so it waits until the wallet
 *    actually holds one — see `useIsPromoter`.
 *
 * Both start hidden during the server render and the first client render, which is what keeps
 * hydration consistent: wagmi rehydrates its connection inside an effect, so there is no wallet to
 * read at markup time on either side. They appear a moment later rather than flashing wrong.
 */
const PUBLIC_NAV = [
  {href: "/", label: "Campaigns", icon: "▦"},
  {href: "/discover", label: "Discover", icon: "◍"},
  {href: "/docs", label: "Docs", icon: "◌"},
] as const;

const MY_CAMPAIGNS = {href: "/my", label: "My Campaigns", icon: "◈"} as const;
const PROMOTERS = {href: "/promoters", label: "Promoters", icon: "◎"} as const;

type NavItem = {href: string; label: string; icon: string};

/**
 * The nav in display order, with the personal entries spliced into the positions they occupy when
 * present — "My Campaigns" beside the marketplace it filters, "Promoters" beside Discover, and Docs
 * last either way. Building the list rather than rendering conditionals inline keeps that ordering
 * in one place instead of spread across the JSX.
 */
function navItems({
  isConnected,
  isPromoter,
}: {
  isConnected: boolean;
  isPromoter: boolean;
}): NavItem[] {
  const [campaigns, discover, docs] = PUBLIC_NAV;
  return [
    campaigns,
    ...(isConnected ? [MY_CAMPAIGNS] : []),
    discover,
    ...(isPromoter ? [PROMOTERS] : []),
    docs,
  ];
}

/**
 * Wallet connect / disconnect.
 *
 * Injected connector only (F2), so there is no wallet-picker modal: the first (and only)
 * configured connector is used directly. Connecting is the gate on every write flow, so the
 * failure case gets a visible message rather than a silent no-op.
 */
function WalletButton() {
  const {address, isConnected} = useAccount();
  const {connect, connectors, isPending, error} = useConnect();
  const {disconnect} = useDisconnect();

  const injected = connectors[0];
  const short = address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "Connect wallet";

  // Connect failures are wallet- and node-level, never contract reverts, so they go through the
  // same prose matching every other failure uses rather than a bespoke `includes("rejected")`.
  const failure = error ? describeTxError(error).message : null;
  const note = !isConnected && !injected ? "No browser wallet detected." : null;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => (isConnected ? disconnect() : injected && connect({connector: injected}))}
        disabled={isPending || (!isConnected && !injected)}
        // `truncate` needs a width constraint to have anything to truncate against; in the bar
        // that is a max-width, so a long address ellipses instead of squeezing the nav.
        className="max-w-[11rem] truncate rounded-md border border-hairline-strong px-3 py-1.5 text-xs font-medium text-ink transition-colors hover:bg-surface-hover disabled:opacity-50"
        title={isConnected ? `${address} — click to disconnect` : "Connect an injected wallet"}
      >
        {isPending ? "Connecting…" : isConnected ? short : "Connect wallet"}
      </button>

      {/*
        Anchored below the bar rather than in flow: these messages appear on a failed connect,
        and in a horizontal bar an in-flow paragraph would shove the whole header taller.
      */}
      {(failure ?? note) ? (
        <p
          role={failure ? "alert" : undefined}
          className={`absolute right-0 top-full z-10 mt-1 whitespace-nowrap rounded-md border border-hairline bg-surface-1 px-2 py-1 text-[10px] leading-relaxed ${
            failure ? "text-critical" : "text-ink-muted"
          }`}
        >
          {failure ?? note}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The connected wallet's BoneyScore rank, shown beside the wallet button.
 *
 * There is no separate "verified" flag to read, and none is needed: `scoreOf` returns 0 for a
 * wallet the registry has never seen, and `rankOf(0)` is `Drifter` — "no attestation on record".
 * The default state therefore falls out of the same read as every other rank, which is what keeps
 * the badge honest. A wallet that has never verified and one whose registry read is still in flight
 * are different things though, so this renders nothing until the query settles rather than
 * flashing `Drifter` at someone who is actually a Samurai.
 *
 * Muted tone throughout. `RankBadge`'s yellow is a caution aimed at a project vetting a stranger's
 * row; pointed at your own wallet it reads as a fault, when the actual message is "verify to get a
 * score" — which the tooltip says in the first person instead.
 *
 * Not a link, deliberately. Verification lives in `PromoterPanel`, behind a joinable campaign, so
 * there is no global route to send anyone to; linking to `/promoters` would imply you can verify
 * there. Until a standalone verify flow exists this stays an indicator.
 */
function WalletRank() {
  const {address, isConnected} = useAccount();
  const {reputation, hasExpired, isLoading} = usePromoterReputation(address);

  if (!isConnected || isLoading || reputation === undefined) return null;

  const score = Number(reputation);
  const rank = rankOf(score);

  // `scoreOf` drops values past their `maxAge`, so an expired wallet decays toward Drifter. Saying
  // "not verified" there would be wrong — they did verify, it just aged out.
  const detail = hasExpired
    ? `Your BoneyScore verification has expired — re-verify to restore it. Rank ${rank.name}.`
    : score > 0
      ? `Your BoneyScore is ${score.toLocaleString("en-US")}. Rank ${rank.name}.`
      : "Not verified yet — verify your BoneyScore on any campaign to read your Ethos score and X reach on chain.";

  return (
    <span className="flex shrink-0 items-center" title={detail}>
      <RankBadge rank={rank} tone="muted" />
      <span className="sr-only">{detail}</span>
    </span>
  );
}

export function AppShell({children}: {children: ReactNode}) {
  const pathname = usePathname();
  const {isConnected} = useAccount();
  const {isPromoter} = useIsPromoter();
  const nav = navItems({isConnected, isPromoter});

  const navLink = ({href, label, icon}: {href: string; label: string; icon: string}) => {
    const active = pathname === href || (href !== "/" && pathname.startsWith(href));
    return (
      <Link
        key={href}
        href={href}
        aria-current={active ? "page" : undefined}
        className={`flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] transition-colors ${
          active
            ? "bg-surface-2 font-semibold text-brand"
            : "text-ink-secondary hover:bg-surface-hover hover:text-ink"
        }`}
      >
        <span aria-hidden className="text-xs opacity-70">
          {icon}
        </span>
        {label}
      </Link>
    );
  };

  return (
    <div className="flex min-h-screen flex-col">
      {/* Keyboard users should not have to tab the whole nav to reach content. */}
      <a
        href="#content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:border focus:border-hairline-strong focus:bg-surface-1 focus:px-3 focus:py-1.5 focus:text-[13px] focus:text-ink"
      >
        Skip to content
      </a>

      {/*
        One bar at every width. The nav scrolls horizontally rather than collapsing, so a tablet
        user keeps both navigation and the wallet button — every write path stays reachable.
      */}
      <header className="sticky top-0 z-40 border-b border-hairline bg-surface-1">
        <div className="mx-auto flex w-full max-w-6xl items-center gap-4 px-4 py-2.5 sm:px-6 lg:px-8">
          <Link href="/" className="shrink-0">
            <span className="font-display text-2xl lowercase leading-none text-brand">
              boneyard
            </span>
          </Link>

          <nav
            aria-label="Main"
            className="-mx-1 flex min-w-0 flex-1 gap-0.5 overflow-x-auto px-1"
          >
            {nav.map(navLink)}
          </nav>

          <div className="flex shrink-0 items-center gap-2.5">
            {/*
              Brand yellow rather than the amber `--status-warning`: this is a badge on the product
              itself, not a status on a campaign row, and borrowing the warning hue here would put
              it in the same visual language as a Paused pill.
            */}
            <span className="animate-blink hidden text-[10px] font-bold uppercase tracking-wider text-brand xl:inline">
              beta
            </span>

            {/*
              The one filled control in the bar. Brand fill takes dark ink, not the light-yellow
              body ink — a yellow button with yellow text is unreadable. The label shortens on
              narrow screens so the CTA never squeezes the nav out of the row.
            */}
            <Link
              href="/create"
              aria-current={pathname === "/create" ? "page" : undefined}
              className="flex shrink-0 items-center gap-1.5 rounded-md bg-brand px-3 py-1.5 text-[13px] font-semibold text-plane transition-opacity hover:opacity-90"
            >
              <span aria-hidden className="text-xs">
                ＋
              </span>
              <span className="hidden sm:inline">Create a campaign</span>
              <span className="sm:hidden">Create</span>
            </Link>

            <WalletRank />
            <WalletButton />
          </div>
        </div>
      </header>

      <main id="content" className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 lg:px-8">
        {children}
      </main>

      {/*
        The protocol attribution lives here rather than in the bar: the product is the Boneyard,
        and the machinery underneath it is a footnote that links to where it is explained.
      */}
      <footer className="mt-12 border-t border-hairline">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-center gap-x-2 px-4 py-8 sm:px-6 lg:px-8">
          <p className="text-xs text-ink-muted">
            Powered by the{" "}
            <Link href="/docs" className="text-ink-secondary transition-colors hover:text-brand">
              Boney Protocol
            </Link>
          </p>
        </div>
      </footer>
    </div>
  );
}
