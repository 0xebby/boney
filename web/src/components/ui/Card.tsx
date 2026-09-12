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
 * The title is `text-ink`, matching table headers in `ui/DataTable` and stat tile labels in
 * `ui/StatTile`. Labels are not a yellow register: yellow is reserved for the brand mark, primary
 * and add buttons, links, the active nav item and the focus ring, so that seeing it anywhere means
 * "this is the brand, or this is something you can press". A page of yellow section titles spends
 * that signal on chrome nobody clicks, and leaves the one button that matters competing with it.
 * Hierarchy here is carried by weight and size instead.
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
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        {subtitle ? <p className="mt-0.5 text-xs text-ink-muted">{subtitle}</p> : null}
      </div>
      {action}
    </div>
  );
}
