"use client";

import Link from "next/link";
import {usePathname} from "next/navigation";
import type {ReactNode} from "react";
import {useAccount, useConnect, useDisconnect} from "wagmi";

/**
 * AppShell — the two-pane data-terminal layout: persistent left nav, main content.
 * The sidebar is a product directory, not a settings menu: Campaigns (list), Create,
 * My Campaigns, KOL, Docs.
 */

const NAV = [
  {href: "/", label: "Campaigns", icon: "▦"},
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

  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={() => (isConnected ? disconnect() : injected && connect({connector: injected}))}
        disabled={isPending || (!isConnected && !injected)}
        // `truncate` needs a width constraint to have anything to truncate against; without
        // `w-full` a long address widens the button past the sidebar instead of ellipsing.
        className="w-full truncate rounded-md border border-hairline-strong px-3 py-1.5 text-xs font-medium text-ink transition-colors hover:bg-surface-hover disabled:opacity-50"
        title={isConnected ? `${address} — click to disconnect` : "Connect an injected wallet"}
      >
        {isPending ? "Connecting…" : isConnected ? short : "Connect wallet"}
      </button>

      {!isConnected && !injected ? (
        <p className="text-[10px] leading-relaxed text-ink-muted">
          No browser wallet detected.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-[10px] leading-relaxed text-critical">
          {error.message.includes("rejected") ? "Connection rejected." : "Could not connect."}
        </p>
      ) : null}
    </div>
  );
}

export function AppShell({children}: {children: ReactNode}) {
  const pathname = usePathname();

  return (
    <div className="min-h-screen">
      <div className="flex">
        {/* Sidebar — fixed, persistent */}
        <aside className="sticky top-0 hidden h-screen w-52 shrink-0 flex-col border-r border-hairline bg-surface-1 px-3 py-4 md:flex">
          <Link href="/" className="mb-6 px-2">
            <span className="text-sm font-bold tracking-tight text-ink">boney</span>
            <span className="ml-1 text-[10px] uppercase tracking-wider text-ink-muted">
              protocol
            </span>
          </Link>

          <nav aria-label="Main" className="flex flex-col gap-0.5">
            {NAV.map(({href, label, icon}) => {
              const active = pathname === href || (href !== "/" && pathname.startsWith(href));
              return (
                <Link
                  key={href}
                  href={href}
                  aria-current={active ? "page" : undefined}
                  className={`flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] transition-colors ${
                    active
                      ? "bg-surface-2 font-medium text-ink"
                      : "text-ink-secondary hover:bg-surface-hover hover:text-ink"
                  }`}
                >
                  <span aria-hidden className="w-4 text-center text-xs opacity-70">
                    {icon}
                  </span>
                  {label}
                </Link>
              );
            })}
          </nav>

          <div className="mt-auto space-y-2 px-2">
            <WalletButton />
            <p className="text-[10px] leading-relaxed text-ink-muted">
              v0 · anvil local · not audited
            </p>
          </div>
        </aside>

        {/* Main column */}
        <div className="min-w-0 flex-1">
          <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-8">{children}</div>
        </div>
      </div>
    </div>
  );
}
