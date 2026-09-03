"use client";

import {useState} from "react";
import {Modal} from "./Modal";
import {promptSummary, type IntentRow, type IntentTone, type SignIntent} from "@/lib/signIntent";

/** Callout classes per tone, spelled out because Tailwind resolves class names statically. */
const TONE: Record<IntentTone, string> = {
  info: "border-brand-dim bg-brand/5 text-ink-secondary",
  warning: "border-brand-dim bg-brand/5 text-ink-secondary",
  critical: "border-critical bg-critical/5 text-ink-secondary",
};

/**
 * One fact about the pending prompt, with its explanation behind an info control.
 *
 * @param row The fact to render.
 * @returns The row.
 */
function IntentRowLine({row}: {row: IntentRow}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="border-b border-hairline/60 py-2 last:border-b-0">
      <div className="flex items-baseline justify-between gap-3">
        <dt className="flex items-baseline gap-1 text-xs text-ink-muted">
          {row.label}
          {row.hint ? (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              aria-label={`What ${row.label} means`}
              className="leading-none text-ink-muted transition-colors hover:text-brand"
            >
              <span aria-hidden className="text-[11px]">
                ⓘ
              </span>
            </button>
          ) : null}
        </dt>
        <dd
          className={`min-w-0 break-words text-right text-xs text-ink ${
            row.mono ? "font-mono" : "tnum"
          }`}
        >
          {row.value}
        </dd>
      </div>
      {open && row.hint ? (
        <p className="mt-1 text-[11px] leading-relaxed text-ink-muted">{row.hint}</p>
      ) : null}
    </div>
  );
}

/**
 * The confirmation shown before a wallet prompt opens.
 *
 * States what the signature does, lists the facts it commits to, and names the consequence, so the
 * wallet's own opaque prompt is never the first explanation the signer gets. Rendered by
 * `components/SignatureGate`, which owns the open state and resolves the caller's promise.
 *
 * @param intent What is about to be signed.
 * @param onConfirm Called when the signer accepts; the wallet opens next.
 * @param onCancel Called by the close control, Escape, the overlay, and Cancel.
 * @returns The dialog.
 */
export function ConfirmSignDialog({
  intent,
  onConfirm,
  onCancel,
}: {
  intent: SignIntent;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const tone = TONE[intent.tone ?? "info"];

  return (
    <Modal
      open
      onClose={onCancel}
      title={intent.title}
      closeLabel="Cancel without signing"
      footer={
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={onConfirm}
            className="min-h-11 w-full rounded-md bg-brand px-4 text-sm font-semibold text-plane transition-opacity hover:opacity-90"
          >
            {intent.confirmLabel}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="min-h-11 w-full rounded-md text-xs font-medium text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
          >
            Cancel
          </button>
        </div>
      }
    >
      <p className="text-xs leading-relaxed text-ink-secondary">{intent.summary}</p>

      <p className="mt-4 text-[10px] font-medium uppercase tracking-wider text-ink-muted">
        What you are signing
      </p>
      <dl className="mt-1">
        {intent.rows.map((row, i) => (
          <IntentRowLine key={`${row.label}-${i}`} row={row} />
        ))}
        <IntentRowLine
          row={{
            label: "Wallet prompts",
            value: promptSummary(intent.prompts),
            hint: "Each prompt is a separate approval in your wallet. A transaction costs gas; a signature does not.",
          }}
        />
      </dl>

      {intent.important ? (
        <div className={`mt-4 border-l-2 py-1.5 pl-3 ${tone}`}>
          <p className="text-[11px] font-semibold uppercase tracking-wide">Important</p>
          <p className="mt-0.5 text-[11px] leading-relaxed">{intent.important}</p>
        </div>
      ) : null}
    </Modal>
  );
}
