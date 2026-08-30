import type {ReactNode} from "react";

/** Which status the notice carries. */
export type NoticeTone = "critical" | "warning" | "good" | "info";

/**
 * Tone classes, spelled out per tone.
 *
 * Tailwind resolves class names statically, so an interpolated `border-${tone}/30` produces no CSS.
 */
const TONE: Record<NoticeTone, {box: string; title: string}> = {
  critical: {box: "border-critical/30 bg-critical/5", title: "text-critical"},
  warning: {box: "border-brand-dim/30 bg-brand/5", title: "text-brand"},
  good: {box: "border-good/30 bg-good/5", title: "text-good"},
  info: {box: "border-brand-dim bg-brand/5", title: "text-brand"},
};

/**
 * The one shape a standalone error, success, or caution message takes.
 *
 * A tinted box with a toned headline and muted body. Errors are announced to assistive tech; the
 * other tones are not, so a success confirmation does not interrupt a screen reader mid-sentence.
 *
 * @param tone Status the message carries.
 * @param title Headline sentence, in the tone's colour.
 * @param children Supporting detail, rendered muted under the headline.
 * @param detail Machine-readable cause, shown in mono for pasting into a report.
 * @param action Controls placed under the body, such as a retry button.
 * @param role Overrides the announced role; critical notices announce as `alert` by default.
 * @param className Extra classes for the wrapper.
 * @returns The notice box.
 */
export function Notice({
  tone,
  title,
  children,
  detail,
  action,
  role,
  className = "",
}: {
  tone: NoticeTone;
  title: ReactNode;
  children?: ReactNode;
  detail?: string;
  action?: ReactNode;
  role?: "alert" | "status";
  className?: string;
}) {
  const t = TONE[tone];

  return (
    <div
      role={role ?? (tone === "critical" ? "alert" : undefined)}
      className={`rounded border ${t.box} p-3 ${className}`}
    >
      <p className={`text-sm ${t.title}`}>{title}</p>
      {children ? <div className="mt-1 text-xs text-ink-muted">{children}</div> : null}
      {detail ? (
        <p className="mt-1.5 break-all font-mono text-[10px] leading-relaxed text-ink-secondary">
          {detail}
        </p>
      ) : null}
      {action ? <div className="mt-2 flex flex-wrap items-center gap-2">{action}</div> : null}
    </div>
  );
}
