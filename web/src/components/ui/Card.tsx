import type {ReactNode} from "react";

/**
 * Card — the raised surface that charts, tables, and panels mount on.
 * Hairline ring, no shadow: a data terminal reads as flat planes, not floating sheets.
 */
export function Card({
  children,
  className = "",
  padded = true,
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border border-hairline bg-surface-1 ${padded ? "p-4" : ""} ${className}`}
    >
      {children}
    </div>
  );
}

/**
 * CardHeader — the section heading for a card.
 *
 * The title is bold brand yellow, matching table headers in `ui/DataTable` and stat tile labels in
 * `ui/StatTile`: labelling chrome is the one register yellow is safe in here (see the token
 * rationale at the top of `globals.css`). The subtitle stays muted — it is prose describing the
 * section, and yellowing both would flatten the heading against its own description.
 */
export function CardHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-3 flex items-start justify-between gap-4">
      <div>
        <h2 className="text-sm font-bold text-brand">{title}</h2>
        {subtitle ? <p className="mt-0.5 text-xs text-ink-muted">{subtitle}</p> : null}
      </div>
      {action}
    </div>
  );
}
