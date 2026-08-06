"use client";

import Link from "next/link";
import {usePathname} from "next/navigation";
import type {ReactNode} from "react";
import {useAccount, useConnect, useDisconnect} from "wagmi";

/**
 * AppShell — a persistent top bar over a single full-width content column.
 * The bar is a product directory, not a settings menu: Boneyard (list), Create,
 * My Campaigns, KOL, Docs.
 */

const NAV = [
  {href: "/", label: "Boneyard", icon: "▦"},
  {href: "/create", label: "Create", icon: "＋"},
  {href: "/my", label: "My Campaigns", icon: "◈"},
  {href: "/kol", label: "KOL", icon: "◎"},
  {href: "/docs", label: "Docs", icon: "◌"},
] as const;

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

  const failure = error
    ? error.message.includes("rejected")
      ? "Connection rejected."
      : "Could not connect."
    : null;
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

export function AppShell({children}: {children: ReactNode}) {
  const pathname = usePathname();

  const navLink = ({href, label, icon}: {href: string; label: string; icon: string}) => {
    const active = pathname === href || (href !== "/" && pathname.startsWith(href));
    return (
      <Link
        key={href}
        href={href}
        aria-current={active ? "page" : undefined}
        className={`flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] transition-colors ${
          active
            ? "bg-surface-2 font-medium text-ink"
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
    <div className="min-h-screen">
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
            <span className="text-sm font-bold tracking-tight text-ink">boney</span>
            <span className="ml-1 hidden text-[10px] uppercase tracking-wider text-ink-muted sm:inline">
              protocol
            </span>
          </Link>

          <nav
            aria-label="Main"
            className="-mx-1 flex min-w-0 flex-1 gap-0.5 overflow-x-auto px-1"
          >
            {NAV.map(navLink)}
          </nav>

          <div className="flex shrink-0 items-center gap-3">
            <span className="hidden text-[10px] text-ink-muted lg:inline">
              v0 · anvil local · not audited
            </span>
            <WalletButton />
          </div>
        </div>
      </header>

      <main id="content" className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
        {children}
      </main>
    </div>
  );
}
