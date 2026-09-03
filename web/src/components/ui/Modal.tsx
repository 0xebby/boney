"use client";

import {useEffect, useId, useRef, type ReactNode} from "react";

/**
 * Modal — a centred dialog over a dimmed page, and a bottom sheet below `sm`.
 *
 * Carries the dialog behaviour the app expects of an overlay: Escape closes, focus moves into the
 * panel and returns to whatever held it before, Tab is trapped inside, and the page behind cannot
 * scroll. Hand-rolled for the same reason `ui/NavDrawer` is — the behaviour is a few effects, and
 * the semantics matter more than the features.
 *
 * @param open Whether the dialog is mounted.
 * @param onClose Called by Escape, the overlay, and the close control.
 * @param title Dialog heading, and its accessible name.
 * @param children Dialog body.
 * @param footer Controls pinned below the body, outside its scroll area.
 * @param closeLabel Accessible label for the close control.
 * @param hideTitle Drops the titled header row, leaving the close control over the body. The title
 *   stays the accessible name; the body carries the visible heading.
 * @param padded Whether the body gets the standard inset. False hands spacing to the caller.
 * @returns The dialog, or nothing while closed.
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  closeLabel = "Close dialog",
  hideTitle = false,
  padded = true,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  closeLabel?: string;
  hideTitle?: boolean;
  padded?: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;

    // Captured on open rather than passed in as a ref: the opener is often a promise-based gate
    // with no element to hand over, and whatever held focus is the right place to return to.
    const opener = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab") return;

      const panel = panelRef.current;
      if (!panel) return;

      const focusable = panel.querySelectorAll<HTMLElement>(
        "a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex='-1'])",
      );
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      // Wrapped by hand: the panel is not `inert`-isolated from the page behind it.
      if (event.shiftKey && (active === first || active === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      opener?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  const closeButton = (
    <button
      type="button"
      onClick={onClose}
      aria-label={closeLabel}
      className="flex size-11 shrink-0 items-center justify-center rounded-md text-ink-secondary transition-colors hover:bg-surface-hover hover:text-ink"
    >
      <span aria-hidden className="text-lg leading-none">
        ✕
      </span>
    </button>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
      {/*
        Decorative, like the drawer's: the dialog is already dismissible from the labelled close
        control and from Escape, so announcing a full-screen unnamed button adds noise, not a route out.
      */}
      <div aria-hidden onClick={onClose} className="animate-overlay-in absolute inset-0 bg-plane/80" />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="animate-dialog-in relative flex max-h-[92dvh] w-full flex-col rounded-t-xl border border-hairline bg-surface-1 outline-none sm:max-w-md sm:rounded-xl"
      >
        {hideTitle ? (
          <>
            <h2 id={titleId} className="sr-only">
              {title}
            </h2>
            {/* Over the body rather than above it: a header row holding nothing but the ✕ reads as a
                strip of dead chrome above the heading the body is carrying. */}
            <div className="absolute right-1 top-1 z-10">{closeButton}</div>
          </>
        ) : (
          <div className="flex items-start justify-between gap-3 border-b border-hairline pl-4 pr-2 py-2.5">
            <h2 id={titleId} className="mt-2 text-base font-bold text-brand">
              {title}
            </h2>
            {closeButton}
          </div>
        )}

        <div className={`min-h-0 flex-1 overflow-y-auto ${padded ? "px-4 py-3" : ""}`}>
          {children}
        </div>

        {footer ? <div className="border-t border-hairline px-4 py-3">{footer}</div> : null}
      </div>
    </div>
  );
}
