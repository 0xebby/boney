"use client";

import Link from "next/link";
import {usePathname} from "next/navigation";
import {useEffect, useState, type ReactNode} from "react";
import {useAccount, useConnect, useDisconnect, useWalletClient} from "wagmi";
import {BoneField, BoneyB} from "@/components/ui/Bone";
import {RankBadge} from "@/components/ui/RankBadge";
import {NavDrawer} from "@/components/ui/NavDrawer";
import {usePromoterReputation} from "@/hooks/usePromoterReputation";
import {useIsPromoter} from "@/hooks/useIsPromoter";
import {useBoneyChainId} from "@/hooks/useBoneyChain";
import {isActiveNav, navItems} from "@/lib/nav";
import {rankOf} from "@/lib/ranks";
import {describeTxError} from "@/lib/txErrors";
import {DEV_STUB_WALLET, canonicalStubAllowlistMessage} from "@/lib/stubWallets";

/**
 * AppShell — a persistent top bar over a single full-width content column.
 * The bar is a product directory, not a settings menu: Campaigns (the list), My Campaigns,
 * Promoters, Docs — plus the Create call to action.
 *
 * **The nav has two presentations, one list.** From `sm` up it is a row of links in the bar. Below
 * `sm` it moves into `NavDrawer`, because at phone widths the bar cannot hold the brand mark, five
 * links and the wallet cluster at once — the previous single-bar layout resolved that by letting the
 * nav scroll horizontally, which hides destinations behind a gesture nothing advertises. Which items
 * appear, in what order, and which one is current all come from `lib/nav.ts` so the two
 * presentations cannot drift apart.
 *
 * Create is deliberately not in that list. It is the primary action of the whole product, so it
 * stays in the bar's right-hand cluster as a filled button at every width rather than reading as one
 * more peer link — and staying in the bar means it is reachable on a phone without opening anything.
 */

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

/**
 * The stub allowlist, for the admin wallet only.
 *
 * An address added here is scored by `lib/stubProfile` instead of Ethos, which is how a wallet with no
 * claimed Ethos profile can be driven through the join and attestation flow. Everyone else on the app
 * is scored by the real APIs.
 *
 * The address check below only decides whether this renders — the real gate is a signature the route
 * verifies against the admin wallet, because a browser-side check is not a boundary. That is why every
 * change costs a signing prompt.
 */
function DevStubWalletManager() {
  const {address} = useAccount();
  // Not wagmi's bare `useChainId`: on the first render of every load its store still reads
  // `chains[0]` — anvil — and a signature bound to the wrong chain fails verification.
  const chainId = useBoneyChainId();
  const {data: walletClient} = useWalletClient();
  const [wallet, setWallet] = useState("");
  const [wallets, setWallets] = useState<string[]>([]);
  const [persisted, setPersisted] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/stub-wallets", {cache: "no-store"});
        const body = (await response.json()) as {wallets?: string[]; persisted?: boolean};
        setWallets(body.wallets ?? []);
        setPersisted(body.persisted ?? true);
      } catch {
        setWallets([]);
      }
    })();
  }, []);

  if (!address || address.toLowerCase() !== DEV_STUB_WALLET.toLowerCase()) return null;

  const updateWallets = async (nextWallet: string, action: "add" | "remove") => {
    const trimmed = nextWallet.trim();
    if (!trimmed) {
      setError("Enter a wallet address.");
      return;
    }
    if (!walletClient) {
      setError("Connect the admin wallet to sign.");
      return;
    }

    setBusy(true);
    setError(null);

    try {
      // The address is normalised before signing so the text matches what the route will rebuild from
      // its own normalised copy — a mixed-case address would otherwise verify against a different
      // message than the one that was signed.
      const normalized = trimmed.toLowerCase();
      const issuedAt = Math.floor(Date.now() / 1000);
      const signature = await walletClient.signMessage({
        message: canonicalStubAllowlistMessage({action, wallet: normalized, chainId, issuedAt}),
      });

      const response = await fetch("/api/stub-wallets", {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({wallet: normalized, action, chainId, issuedAt, signature}),
      });

      const body = (await response.json()) as {
        wallets?: string[];
        persisted?: boolean;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(body.error ?? "Failed to update allowlist.");
      }

      setWallets(body.wallets ?? []);
      setPersisted(body.persisted ?? true);
      setWallet("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to update allowlist.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-md border border-dashed border-hairline bg-surface-2 px-3 py-2 text-left">
      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-muted">
        Dev stub allowlist
      </p>
      <p className="mt-1 text-[10px] text-ink-muted">
        These wallets get a fabricated BoneyScore instead of a real Ethos lookup. Every other wallet
        is scored by the live APIs. Each change takes a signature from this wallet.
      </p>

      <div className="mt-2 flex flex-col gap-2 sm:flex-row">
        <input
          value={wallet}
          onChange={(event) => setWallet(event.target.value)}
          placeholder="0x..."
          className="w-full rounded border border-hairline bg-surface-1 px-2 py-1.5 text-[11px] text-ink placeholder:text-ink-muted"
        />

        <button
          type="button"
          onClick={() => void updateWallets(wallet, "add")}
          disabled={busy}
          className="rounded-md bg-brand px-2.5 py-1.5 text-[11px] font-semibold text-plane disabled:opacity-50"
        >
          Add
        </button>

        <button
          type="button"
          onClick={() => void updateWallets(wallet, "remove")}
          disabled={busy || !wallet.trim()}
          className="rounded-md border border-hairline bg-surface-1 px-2.5 py-1.5 text-[11px] font-medium text-ink disabled:opacity-50"
        >
          Remove
        </button>
      </div>

      {wallets.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {wallets.map((entry) => (
            <span
              key={entry}
              className="rounded-full border border-hairline bg-surface-1 px-2 py-0.5 text-[10px] text-ink-muted"
            >
              {entry.slice(0, 6)}…{entry.slice(-4)}
            </span>
          ))}
        </div>
      ) : (
        <p className="mt-2 text-[10px] text-ink-muted">No stub wallets currently allowed.</p>
      )}

      {!persisted ? (
        <p className="mt-2 text-[10px] text-ink-muted">
          This deployment has no writable store, so the list falls back to its committed default and a
          change lasts only as long as this server instance.
        </p>
      ) : null}

      {error ? <p className="mt-2 text-[10px] text-critical">{error}</p> : null}
    </div>
  );
}

export function AppShell({children}: {children: ReactNode}) {
  const pathname = usePathname();
  const {isConnected} = useAccount();
  const {isPromoter} = useIsPromoter();
  const nav = navItems({isConnected, isPromoter});

  const navLink = ({href, label, icon}: {href: string; label: string; icon: string}) => {
    const active = isActiveNav(pathname, href);
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
      {/* The bone wallpaper, behind every page. Decoration only — nothing above it moves for it. */}
      <BoneField />

      {/* Keyboard users should not have to tab the whole nav to reach content. */}
      <a
        href="#content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:border focus:border-hairline-strong focus:bg-surface-1 focus:px-3 focus:py-1.5 focus:text-[13px] focus:text-ink"
      >
        Skip to content
      </a>

      {/*
        One bar at every width, but the nav inside it changes form. From `sm` up the links sit in the
        bar; below `sm` they move into the drawer and only its trigger remains, which is what keeps
        the brand mark, Create and the wallet button all reachable at 375px without a scrolling nav.
      */}
      <header className="sticky top-0 z-40 border-b border-hairline bg-surface-1">
        <div className="mx-auto flex w-full max-w-6xl items-center gap-2 px-4 py-2.5 sm:gap-4 sm:px-6 lg:px-8">
          <NavDrawer items={nav} />

          {/* The mark leads the wordmark at the same colour and height, so the pair reads as one
              lockup rather than an icon parked beside a word. */}
          <Link href="/" className="flex shrink-0 items-center gap-1.5 text-brand">
            <BoneyB className="h-5 w-auto shrink-0 sm:h-6" />
            <span className="font-display text-xl lowercase leading-none sm:text-2xl">
              boneyard
            </span>
          </Link>

          <nav
            aria-label="Main"
            className="-mx-1 hidden min-w-0 flex-1 gap-0.5 overflow-x-auto px-1 sm:flex"
          >
            {nav.map(navLink)}
          </nav>

          {/*
            Below `sm` the nav is gone from the bar, so nothing is left to absorb the free space and
            push the wallet cluster right. This does that job at phone widths only.
          */}
          <div className="flex-1 sm:hidden" />

          <div className="flex shrink-0 items-center gap-2 sm:gap-2.5">
            <span className="animate-blink hidden text-[10px] font-bold uppercase tracking-wider text-brand xl:inline">
              beta
            </span>

            <Link
              href="/create"
              aria-current={pathname === "/create" ? "page" : undefined}
              className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-md bg-brand px-3 text-[13px] font-semibold text-plane transition-opacity hover:opacity-90 sm:min-h-0 sm:py-1.5"
            >
              <span aria-hidden className="text-xs">
                ＋
              </span>
              <span className="hidden sm:inline">Create a campaign</span>
              <span className="sm:hidden">Create</span>
            </Link>

            {/*
              The rank badge is an indicator, not a control, and it is the first thing worth dropping
              when the bar runs out of room — its full sentence is already carried in the `sr-only`
              span inside `WalletRank`, so nothing is lost to a screen reader.
            */}
            <span className="hidden sm:flex">
              <WalletRank />
            </span>
            <WalletButton />
          </div>
        </div>

        <div className="mx-auto w-full max-w-6xl px-4 pb-3 sm:px-6 lg:px-8">
          <DevStubWalletManager />
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
