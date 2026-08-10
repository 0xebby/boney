import type {ReactNode} from "react";

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <p className="text-sm font-medium text-ink">{title}</p>
      {description ? (
        <p className="max-w-sm text-xs leading-relaxed text-ink-muted">{description}</p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

/**
 * Skeleton rows for first load only.
 * On refetch, hold the previous render at reduced opacity instead — a skeleton flash
 * on every poll causes a layout jump.
 */
export function SkeletonRows({rows = 5, cols = 6}: {rows?: number; cols?: number}) {
  return (
    <div className="animate-pulse" aria-hidden>
      {Array.from({length: rows}).map((_, r) => (
        <div key={r} className="flex items-center gap-4 border-b border-hairline px-4 py-3">
          {Array.from({length: cols}).map((_, c) => (
            <div
              key={c}
              className="h-3 rounded bg-surface-2"
              style={{width: c === 0 ? "22%" : `${10 + ((r + c) % 3) * 4}%`}}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * `detail` is the machine-readable cause — a contract's `ErrorName(args)`, an HTTP status. It
 * renders under the message in mono at reduced weight so it is available to paste into a bug
 * report without competing with the sentence a user is meant to read.
 */
export function ErrorState({
  message,
  detail,
  onRetry,
}: {
  message: string;
  detail?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <p className="flex items-center gap-1.5 text-sm font-medium text-critical">
        <span aria-hidden>⚠</span> Something went wrong
      </p>
      <p className="max-w-md text-xs leading-relaxed text-ink-muted">{message}</p>
      {detail ? (
        <p className="max-w-md break-all font-mono text-[10px] leading-relaxed text-ink-secondary">
          {detail}
        </p>
      ) : null}
      {onRetry ? (
        <button
          onClick={onRetry}
          className="mt-2 rounded-md border border-hairline-strong px-3 py-1.5 text-xs font-medium text-ink hover:bg-surface-hover"
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}
