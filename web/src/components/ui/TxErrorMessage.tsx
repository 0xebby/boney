"use client";

import {useState} from "react";

/**
 * The error line for a failed write.
 *
 * `message` is plain language and always visible; `detail` is the contract's own
 * `ErrorName(args)` and stays collapsed behind "Details". Both matter for different readers — the
 * sentence is what a promoter acts on, the raw name is what gets pasted into a bug report — and
 * showing them at equal weight is what made the old output unreadable.
 *
 * Rendered at `text-xs` to match the inline feedback in `ProjectActions` and `PromoterPanel`; the
 * `role="alert"` lives on the wrapper in those components, so it is deliberately not repeated here.
 */
export function TxErrorMessage({
  message,
  detail,
  onDismiss,
  dismissLabel = "Dismiss",
}: {
  message: string;
  detail?: string;
  onDismiss?: () => void;
  dismissLabel?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <span className="text-critical">
      {message}{" "}
      {detail ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="text-ink-muted underline hover:text-ink"
        >
          {open ? "Hide details" : "Details"}
        </button>
      ) : null}
      {detail && onDismiss ? " · " : null}
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          className="text-ink-muted underline hover:text-ink"
        >
          {dismissLabel}
        </button>
      ) : null}
      {open && detail ? (
        <span className="mt-1 block break-all rounded border border-hairline bg-surface-2 px-2 py-1 font-mono text-[10px] leading-relaxed text-ink-secondary">
          {detail}
        </span>
      ) : null}
    </span>
  );
}
