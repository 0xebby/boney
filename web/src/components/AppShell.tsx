"use client";

import Link from "next/link";
import {usePathname} from "next/navigation";
import {useEffect, useRef, useState, type ReactNode} from "react";
import {useAccount, useConnect, useDisconnect, useWalletClient} from "wagmi";
import {BoneField, BoneyB} from "@/components/ui/Bone";
import {Button, ButtonLink} from "@/components/ui/Button";
import {RankBadge} from "@/components/ui/RankBadge";
import {NavDrawer} from "@/components/ui/NavDrawer";
import {NavLabel} from "@/components/ui/NavLabel";
import {EthosMark} from "@/components/ui/EthosMark";
import {usePromoterReputation} from "@/hooks/usePromoterReputation";
import {useIsPromoter} from "@/hooks/useIsPromoter";
import {useBoneyChainId} from "@/hooks/useBoneyChain";
import {drawerNavItems, isActiveNav, navItems, walletNavItems, type NavItem} from "@/lib/nav";
import {rankOf} from "@/lib/ranks";
import {describeTxError} from "@/lib/txErrors";
import {DEV_STUB_WALLET, canonicalStubAllowlistMessage} from "@/lib/stubWallets";
import {useConfirmSignature} from "@/components/SignatureGate";
import {stubAllowlistIntent} from "@/lib/writeIntents";

/**
 * AppShell — a persistent top bar over a single full-width content column.
 * The bar is a product directory, not a settings menu: Campaigns (the list), Discover, Boneyboard,
 * Docs — plus the Create call to action.
 *
 * **The bar is four public links, and only ever four.** It used to carry the personal destinations
 * too, which made its length a function of the wallet: a connected promoter saw seven links between
 * the brand and a right-hand cluster that never shrinks, and the row could not hold them — measured,
 * the nav took two rows from 1024px up, three at 768px and seven at 640px, standing the header up to
 * 201px. My Campaigns, BoneyCard and Promoters belong to the wallet rather than to the product, so
 * they hang off the wallet chip's menu instead and the header's height stops depending on who is
 * looking at it.
 *
 * **The nav has three presentations, one list.** The bar from `md` up, the wallet chip's menu, and
 * `NavDrawer` below `md` — which carries both halves, so a phone reaches every destination from one
 * place. Which items appear, in what order, and which one is current all come from `lib/nav.ts` so
 * the presentations cannot drift apart.
 *
 * **Nothing in the header scrolls sideways.** The links used to share the brand row inside an
 * `overflow-x-auto` strip, which hides destinations behind a gesture nothing advertises. Its own
 * space on the row fits four labels at every width the bar renders at, and it wraps rather than
 * clipping if it ever cannot.
 *
 * The row has the same rule applied the other way. Every item in it was `shrink-0`, so at 375px the
 * row measured wider than the viewport and the whole page scrolled horizontally. The wallet cluster
 * may now shrink, the wallet label is shortened where the full one does not fit, the rank badge and
 * the wordmark wait for `lg`, and the Create button keeps its full label at every width. Anything
 * added to this row gets measured: `scripts/measure-shell.mjs` prints the header height and the
 * horizontal overflow at the widths that matter.
 *
 * Create is deliberately not in the nav list. It is the primary action of the whole product, so it
 * stays in the brand row's right-hand cluster as a filled button at every width rather than reading
 * as one more peer link — and staying there means it is reachable on a phone without opening
 * anything.
 */

/**
 * Wallet connect, and the menu the connected chip opens.
 *
 * Injected connector only (F2), so there is no wallet-picker modal: the first (and only)
 * configured connector is used directly. Connecting is the gate on every write flow, so the
 * failure case gets a visible message rather than a silent no-op.
 *
 * Connected, the chip is a menu button rather than a disconnect button. Clicking your own address
 * used to disconnect on the spot, with no confirmation and no undo beyond a second wallet prompt —
 * a destructive action on the one control you press to check which account you are on. It now opens
 * the wallet's own destinations with Disconnect last, which is both a confirmation step and the
 * place the personal nav entries went when they came out of the bar.
 *
 * Disconnected it stays a plain button: there is nothing to list.
 *
 * The disclosure is hand-rolled, matching `ui/JoinCampaignMenu` — Escape closes and returns focus to
 * the chip, the arrows walk the items, a pointer outside dismisses. Adding a headless-UI dependency
 * for two menus is a worse trade than fifty lines that do exactly this.
 *
 * @param menuItems The wallet's personal destinations, from `walletNavItems`.
 */
function WalletButton({menuItems}: {menuItems: NavItem[]}) {
  const pathname = usePathname();
  const {address, isConnected} = useAccount();
  const {connect, connectors, isPending, error} = useConnect();
  const {disconnect} = useDisconnect();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  /**
   * Open state is the route the menu was opened on, not a boolean — the same trick `NavDrawer` uses.
   * "Close on navigation" then falls out of a render instead of needing an effect to synchronise it.
   * Clicking the entry for the page you are already on does not move `pathname`, so the links close
   * it explicitly too.
   */
  const [openedAt, setOpenedAt] = useState<string | null>(null);
  const open = openedAt !== null && openedAt === pathname;
  const close = () => setOpenedAt(null);

  const injected = connectors[0];
  const short = address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "Connect wallet";
  // The head alone, for the widths where the full form does not fit. Truncation would otherwise put
  // a CSS ellipsis right after the one already in the address and render `0xba95……`.
  const head = address ? `${address.slice(0, 6)}…` : "";

  // Connect failures are wallet- and node-level, never contract reverts, so they go through the
  // same prose matching every other failure uses rather than a bespoke `includes("rejected")`.
  const failure = error ? describeTxError(error).message : null;
  const note = !isConnected && !injected ? "No browser wallet detected." : null;

  useEffect(() => {
    if (!open) return;

    const items = () =>
      Array.from(
        panelRef.current?.querySelectorAll<HTMLElement>("a[href], button:not([disabled])") ?? [],
      );

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpenedAt(null);
        triggerRef.current?.focus();
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;

      const focusable = items();
      if (focusable.length === 0) return;

      event.preventDefault();
      const at = focusable.indexOf(document.activeElement as HTMLElement);
      const step = event.key === "ArrowDown" ? 1 : -1;
      // From the trigger, ArrowDown lands on the first item and ArrowUp on the last.
      const next = at === -1 ? (step === 1 ? 0 : focusable.length - 1) : (at + step + focusable.length) % focusable.length;
      focusable[next].focus();
    };

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpenedAt(null);
    };

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  return (
    // `min-w-0` so this is the part of the bar that gives when the row runs out of room: the chip
    // truncates rather than pushing the header wider than the viewport.
    <div className="relative min-w-0">
      <Button
        ref={triggerRef}
        variant="secondary"
        full
        // The max-width bounds a long label, and `w-full` is what lets the wrapper's `min-w-0` reach
        // the chip — without it it kept its full width and spilled past the viewport on a 320px row.
        className="max-w-[11rem]"
        onClick={() =>
          isConnected
            ? setOpenedAt((was) => (was === pathname ? null : pathname))
            : injected && connect({connector: injected})
        }
        disabled={isPending || (!isConnected && !injected)}
        aria-haspopup={isConnected ? "menu" : undefined}
        aria-expanded={isConnected ? open : undefined}
        aria-controls={isConnected ? "wallet-menu" : undefined}
        title={isConnected ? `${address} — open wallet menu` : "Connect an injected wallet"}
      >
        {/* The label truncates, not the button: `text-overflow` needs a block container with inline
            content, and the button itself is a flex row. */}
        <span className="truncate">
          {/* "Connect wallet" is 40px of a 375px bar that has none to spare, and the shorter label
              says the same thing. */}
          {isPending ? (
            "Connecting…"
          ) : isConnected ? (
            // 384px is the measured width at which the row first holds `0x1234…abcd` whole. Below
            // it the head is the honest thing to show: the tail would be ellipsed away anyway, and
            // the arbitrary breakpoint is cheaper than the alternative, which is a second `…`
            // landing next to the one already in the address.
            <>
              <span className="min-[384px]:hidden">{head}</span>
              <span className="hidden min-[384px]:inline">{short}</span>
            </>
          ) : (
            <>
              <span className="sm:hidden">Connect</span>
              <span className="hidden sm:inline">Connect wallet</span>
            </>
          )}
        </span>
        {/* The caret says the chip opens something rather than doing something, which is the whole
            point of the change. It costs 15px of a phone row that has none, and below `sm` that 15px
            is the difference between an address and an ellipsis — so there it goes and the tap
            speaks for itself. */}
        {isConnected ? (
          <span
            aria-hidden
            className={`hidden shrink-0 text-[10px] leading-none transition-transform sm:block ${open ? "rotate-180" : ""}`}
          >
            ▾
          </span>
        ) : null}
      </Button>

      {open ? (
        <div
          ref={panelRef}
          id="wallet-menu"
          role="menu"
          aria-label="Wallet"
          className="absolute right-0 top-full z-30 mt-1 w-56 rounded-lg border border-hairline bg-surface-1 p-1 shadow-lg"
        >
          {menuItems.map(({href, label, isNew}) => (
            <ButtonLink
              key={href}
              href={href}
              variant="quiet"
              full
              align="start"
              role="menuitem"
              onClick={close}
              aria-current={isActiveNav(pathname, href) ? "page" : undefined}
              // The current page's treatment rides on an attribute selector rather than a swapped
              // class: `[aria-current=page]` outweighs the variant's own colour by specificity, so
              // it wins wherever Tailwind happens to order the two rules.
              className="aria-[current=page]:bg-surface-2 aria-[current=page]:font-semibold aria-[current=page]:text-brand"
            >
              <NavLabel label={label} isNew={isNew} />
            </ButtonLink>
          ))}

          {/* Last, and quiet until hovered: the destructive item in a menu should never be the one
              the eye lands on first. A hairline above it when there is anything above it to divide. */}
          <Button
            variant="danger-quiet"
            full
            align="start"
            role="menuitem"
            onClick={() => {
              close();
              disconnect();
            }}
            className={menuItems.length > 0 ? "mt-1 border-t border-hairline pt-1" : undefined}
          >
            Disconnect
          </Button>
        </div>
      ) : null}

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
  const confirmSignature = useConfirmSignature();
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

    if (!(await confirmSignature(stubAllowlistIntent(trimmed.toLowerCase(), action)))) return;

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
        These wallets get a fabricated BoneyScore of 20,500 or more — enough to clear every gate in
        the fixture — instead of a real Ethos lookup. Every other wallet is scored by the live APIs.
        Each change takes a signature from this wallet.
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
  const gating = {isConnected, isPromoter};

  /**
   * One nav destination as it appears in the top bar.
   *
   * Label only, at `text-xs`: the glyphs the bar used to carry cost width while naming nothing a
   * reader could act on.
   *
   * @param item The destination's href, label and whether it is marked new.
   * @returns The link element, keyed by href.
   */
  const navLink = ({href, label, isNew}: NavItem) => {
    const active = isActiveNav(pathname, href);
    return (
      <Link
        key={href}
        href={href}
        aria-current={active ? "page" : undefined}
        className={`shrink-0 rounded-md px-2 py-1 text-xs transition-colors ${
          active
            ? "bg-surface-2 font-semibold text-brand"
            : "text-ink-secondary hover:bg-surface-hover hover:text-ink"
        }`}
      >
        <NavLabel label={label} isNew={isNew} />
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
        One row: brand, nav, wallet cluster. Below `md` the nav's items live in the drawer instead —
        `sm` was too early, because 640–767px has room for the mark, Create and the wallet button but
        not for four more labels beside them, and it was where the bar wrapped worst.

        `py-2` rather than `py-2.5`: the controls in the row now carry their own 36px minimum from
        `ui/Button`, so the row's own padding does not need to make up the height.
      */}
      <header className="sticky top-0 z-40 border-b border-hairline bg-surface-1">
        <div className="mx-auto flex w-full max-w-6xl items-center gap-2 px-4 py-2 sm:gap-4 sm:px-6 lg:px-8">
          <NavDrawer items={drawerNavItems(gating)} />

          {/* The mark leads the wordmark at the same colour and height, so the pair reads as one
              lockup rather than an icon parked beside a word. The word costs ~104px and appears from
              `lg`, which is the first width where the row has room for it alongside four nav labels
              and the wallet cluster; below that the mark carries the identity alone — the drawer's
              own header spells it out again on open, and on a phone the ~104px it frees is what lets
              the Create button keep its full label. */}
          <Link href="/" className="flex shrink-0 items-center gap-1.5 text-brand">
            <BoneyB className="h-5 w-auto shrink-0 sm:h-6" />
            <span className="hidden font-display text-2xl lowercase leading-none lg:inline">
              boneyard
            </span>
          </Link>

          {/*
            `flex-wrap` rather than the `overflow-x-auto` this used to be: a horizontal scroller hides
            destinations behind a gesture nothing advertises, so if the list ever outgrows the row it
            takes a second line and every destination stays visible. With a fixed four items it does
            not, which is the point — but the fallback should still be visible rather than clipped.
          */}
          <nav
            aria-label="Main"
            className="-mx-1 hidden min-w-0 flex-1 flex-wrap items-center gap-0.5 px-1 md:flex"
          >
            {navItems().map(navLink)}
          </nav>

          {/* `ml-auto` rather than a spacer element, and `min-w-0` so the cluster is what compresses
              when the row is tight. */}
          <div className="ml-auto flex min-w-0 items-center gap-2 sm:gap-2.5">
            <span className="animate-blink hidden text-[10px] font-bold uppercase tracking-wider text-brand xl:inline">
              beta
            </span>

            <ButtonLink
              href="/create"
              variant="primary"
              aria-current={pathname === "/create" ? "page" : undefined}
              className="shrink-0"
            >
              {/* The fullwidth plus is 18px with its gap — the exact margin a 360px row lacks. It is
                  decorative beside a label that already says "Create", so it waits for `sm`. */}
              <span aria-hidden className="hidden text-xs sm:inline">
                ＋
              </span>
              <span className="hidden sm:inline">Create a campaign</span>
              {/* The article is the one word a 360px row cannot afford; "Create" alone was not a
                  label, it was a verb. */}
              <span className="sm:hidden">Create campaign</span>
            </ButtonLink>

            {/* From `lg`. It is an indicator rather than a control, and with the nav on the row from
                `md` it is the first thing worth dropping when the bar runs out of space — its full
                sentence is already carried by the `sr-only` span inside `WalletRank`, so nothing is
                lost to a screen reader. */}
            <span className="hidden lg:flex">
              <WalletRank />
            </span>
            <WalletButton menuItems={walletNavItems(gating)} />
          </div>
        </div>

        {/* `empty:hidden` because this renders for one wallet and nothing for everyone else: without
            it the row's padding still adds a strip of dead header height on every other session. */}
        <div className="mx-auto w-full max-w-6xl px-4 pb-3 empty:hidden sm:px-6 lg:px-8">
          <DevStubWalletManager />
        </div>
      </header>

      <main id="content" className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 lg:px-8">
        {children}
      </main>

      {/*
        The attributions, and nothing else. Both are footnotes: the product is the Boneyard, and who
        supplies the machinery under it is worth crediting but is not worth a reader's first glance.

        The Ethos credit used to sit above every page's own first element, inside `<main>`, where it
        read as a caption on whatever happened to be below it — a line about scoring standing over a
        table of campaigns, a form, a docs page. It says the same thing here and interrupts nothing.

        One wrapping row of muted 12px items, no card and no columns: three short lines do not need a
        layout.
      */}
      <footer className="mt-12 border-t border-hairline">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-center gap-x-5 gap-y-1.5 px-4 py-8 text-xs text-ink-muted sm:px-6 lg:px-8">
          <p>
            Powered by the{" "}
            <Link href="/docs" className="text-ink-secondary transition-colors hover:text-brand">
              Boney Protocol
            </Link>
          </p>

          {/* `--brand-ethos` on the mark and the name, so the credit reads as another party's rather
              than as Boney's own copy. */}
          <p title="A BoneyScore is composed from an Ethos credibility score and X reach.">
            BoneyScore is powered by{" "}
            <span className="inline-flex items-center gap-1 align-baseline font-semibold text-brand-ethos">
              <EthosMark className="h-3 w-3" />
              Ethos
            </span>{" "}
            credibility score
          </p>

          <p>Beta on Base Sepolia — testnet only, unaudited</p>
        </div>
      </footer>
    </div>
  );
}
