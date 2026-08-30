"use client";

import Link from "next/link";
import {usePathname} from "next/navigation";
import {useEffect, useRef, useState} from "react";
import {isActiveNav, type NavItem} from "@/lib/nav";

/**
 * NavDrawer — the nav below `sm`, as a panel from the left rather than a strip across the top.
 *
 * The bar it replaces put the links in an `overflow-x-auto` strip beside the brand mark. That fits,
 * but the nav is what gets squeezed, and a horizontally scrolling nav is undiscoverable: the items
 * past the fold are invisible with no affordance saying they exist. A drawer trades one tap for
 * showing every destination at full label width, and at phone widths it is also the only way the
 * brand mark, Create and the wallet button fit on one line.
 *
 * Rendered only below `sm` (`sm:hidden` on the trigger). From `sm` up the top bar carries the nav on
 * its own row and this contributes nothing but an unmounted panel.
 *
 * The dialog behaviour here is hand-rolled rather than pulled from a headless-UI dependency, in
 * keeping with `DataTable` being hand-rolled for the same reason: the behaviour is a handful of
 * effects, and the semantics matter more than the features.
 */
export function NavDrawer({items}: {items: NavItem[]}) {
  const pathname = usePathname();
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  /**
   * Open state is the route the drawer was opened on, not a boolean.
   *
   * That makes "close on navigation" fall out of a render rather than needing an effect to
   * synchronise it: once `pathname` moves, `openedAt` no longer matches and the panel is closed with
   * no second render pass. Storing a boolean and clearing it in a `useEffect` keyed on `pathname` is
   * the obvious version and is what `react-hooks/set-state-in-effect` exists to reject — it is a
   * cascading render to express something already derivable.
   *
   * Closing is still explicit on the links themselves, because tapping the link for the page you are
   * already on does not change `pathname` and so would otherwise leave the panel sitting open.
   */
  const [openedAt, setOpenedAt] = useState<string | null>(null);
  const open = openedAt !== null && openedAt === pathname;
  const close = () => setOpenedAt(null);

  /**
   * Escape closes, and focus is managed across the open/close boundary.
   *
   * Focus moves into the panel on open so a keyboard or screen-reader user is placed inside the
   * thing that just appeared, and returns to the trigger on close so they resume where they were
   * rather than at the top of the document. Tab is trapped within the panel: a dialog that leaks
   * focus to the page behind it is worse than no dialog, because the focus ring disappears behind
   * the overlay.
   */
  useEffect(() => {
    if (!open) return;

    const trigger = triggerRef.current;
    panelRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpenedAt(null);
        return;
      }
      if (event.key !== "Tab") return;

      const panel = panelRef.current;
      if (!panel) return;

      const focusable = panel.querySelectorAll<HTMLElement>("a[href], button:not([disabled])");
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      // Wrapping by hand, because the panel is not `inert`-isolated from the page behind it.
      if (event.shiftKey && (active === first || active === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);

    // The page behind a drawer must not scroll under it — on iOS especially, a scrollable body
    // behind an overlay is how you end up somewhere unexpected after closing.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      trigger?.focus();
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpenedAt(pathname)}
        aria-expanded={open}
        aria-controls="nav-drawer"
        aria-label="Open navigation"
        // 44px square: this is the one control on the bar a thumb must hit reliably.
        className="flex size-11 shrink-0 items-center justify-center rounded-md text-ink-secondary transition-colors hover:bg-surface-hover hover:text-ink sm:hidden"
      >
        <span aria-hidden className="text-lg leading-none">
          ☰
        </span>
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 sm:hidden">
          {/*
            The overlay is a plain div rather than a button: it is decorative, and the dialog is
            already dismissible from the labelled Close control and from Escape. Announcing a
            full-screen button called nothing would add noise without adding a route out.
          */}
          <div
            aria-hidden
            onClick={close}
            className="absolute inset-0 overscroll-contain bg-plane/80"
          />

          <div
            ref={panelRef}
            id="nav-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="Main navigation"
            tabIndex={-1}
            className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col border-r border-hairline bg-surface-1 outline-none"
          >
            <div className="flex items-center justify-between gap-2 border-b border-hairline px-4 py-3">
              <span className="font-display text-xl lowercase leading-none text-brand">
                boneyard
              </span>
              <button
                type="button"
                onClick={close}
                aria-label="Close navigation"
                className="flex size-11 shrink-0 items-center justify-center rounded-md text-ink-secondary transition-colors hover:bg-surface-hover hover:text-ink"
              >
                <span aria-hidden className="text-lg leading-none">
                  ✕
                </span>
              </button>
            </div>

            {/*
              `overscroll-contain` as well as the body lock above: on iOS a scroll gesture that runs
              past the end of this list otherwise chains to the page behind the drawer, which is how
              you close it and find yourself somewhere else.
            */}
            <nav
              aria-label="Main"
              className="flex flex-1 flex-col gap-0.5 overflow-y-auto overscroll-contain p-2"
            >
              {items.map(({href, label}) => {
                const active = isActiveNav(pathname, href);
                return (
                  <Link
                    key={href}
                    href={href}
                    onClick={close}
                    aria-current={active ? "page" : undefined}
                    // `min-h-11` rather than padding alone: 44px is the smallest target that is
                    // reliably hittable with a thumb, and the bar's own 30px links are not.
                    className={`flex min-h-11 items-center rounded-md px-3 text-sm transition-colors ${
                      active
                        ? "bg-surface-2 font-semibold text-brand"
                        : "text-ink-secondary hover:bg-surface-hover hover:text-ink"
                    }`}
                  >
                    {label}
                  </Link>
                );
              })}
            </nav>
          </div>
        </div>
      ) : null}
    </>
  );
}
