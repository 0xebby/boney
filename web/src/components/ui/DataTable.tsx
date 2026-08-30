"use client";

import {useMemo, useState, type ReactNode} from "react";
import {sortRows, nextSortState, type SortState, type SortableColumn} from "@/lib/table";

/**
 * DataTable — dense, sortable, metric-heavy table.
 *
 * Hand-rolled rather than a data-grid dependency (decision F5): the column set is known and the
 * behavior is one `useMemo`. The sort logic itself lives in `lib/table.ts` so it is unit-tested
 * without a DOM — this component only owns state and markup.
 *
 * Semantics matter more than features: real `<th scope="col">` headers with `aria-sort`, so the
 * sort state is announced rather than implied by an arrow glyph.
 *
 * Headers are bold brand yellow. That is the one register yellow is safe in here — as chrome it
 * measures 12.75:1 on the app surface, where as a *fill* it fails every contrast check (see the
 * token rationale at the top of `globals.css`). The sans face is variable 300–700, so `font-bold`
 * is a real weight rather than a synthesised one; the display face is 400-only and must never take
 * a weight utility.
 *
 * Because every header now carries the brand colour, the sorted column is no longer distinguished
 * by colour — it is carried by the `▲`/`▼` glyph and by `aria-sort`, which was already the
 * accessible signal. Hover shifts opacity rather than colour so it cannot fight it.
 *
 * Unsorted columns show no glyph, but the slot is held with `invisible` rather than dropped: the
 * arrow sits inside the header's flex row (on the *left* for numeric columns, which reverse), so
 * collapsing it would shift every label sideways the moment you sort.
 */

export type Column<T> = SortableColumn<T> & {
  header: string;
  /** Right-align numeric columns so digits line up. */
  numeric?: boolean;
  render: (row: T) => ReactNode;
  /**
   * Drop this column below `md`.
   *
   * The container scrolls horizontally, so an unflagged column is not lost — it is just behind a
   * gesture nothing advertises, which in practice means unread. The working rule across the app is
   * roughly **three columns on a phone**: the one that identifies the row, plus the two that carry
   * whatever decision the table exists to support. Everything else is flagged, and remains one tap
   * away on the row's own page.
   */
  hideOnMobile?: boolean;
  width?: string;
  /** Screen-reader-only header text, when the visible header is an icon or blank. */
  srHeader?: string;
};

export type {SortState};

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  initialSort = null,
  onRowClick,
  emptyState,
  /** Dim the table during a refetch instead of swapping in a skeleton (avoids layout jump). */
  isRefreshing = false,
}: {
  rows: readonly T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  initialSort?: SortState;
  onRowClick?: (row: T) => void;
  emptyState?: ReactNode;
  isRefreshing?: boolean;
}) {
  const [sort, setSort] = useState<SortState>(initialSort);
  const sorted = useMemo(() => sortRows(rows, columns, sort), [rows, columns, sort]);

  if (rows.length === 0 && emptyState) return <>{emptyState}</>;

  return (
    <div
      className={`overflow-x-auto transition-opacity ${isRefreshing ? "opacity-60" : "opacity-100"}`}
    >
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-hairline">
            {columns.map((col) => {
              const active = sort?.key === col.key;
              const sortable = Boolean(col.sortValue);
              return (
                <th
                  key={col.key}
                  scope="col"
                  aria-sort={active ? (sort!.dir === "asc" ? "ascending" : "descending") : "none"}
                  style={col.width ? {width: col.width} : undefined}
                  className={`px-2 py-2 font-bold text-brand sm:px-3 ${
                    col.numeric ? "text-right" : "text-left"
                  } ${col.hideOnMobile ? "hidden md:table-cell" : ""}`}
                >
                  {sortable ? (
                    <button
                      type="button"
                      onClick={() => setSort((prev) => nextSortState(prev, col.key))}
                      className={`inline-flex items-center gap-1 text-xs transition-opacity hover:opacity-80 ${
                        col.numeric ? "flex-row-reverse" : ""
                      }`}
                    >
                      {col.header}
                      <span
                        aria-hidden
                        className={`text-[9px] ${active ? "opacity-70" : "invisible"}`}
                      >
                        {active && sort!.dir === "desc" ? "▼" : "▲"}
                      </span>
                    </button>
                  ) : (
                    <span className="text-xs">
                      {col.header}
                      {col.srHeader ? <span className="sr-only">{col.srHeader}</span> : null}
                    </span>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr
              key={rowKey(row)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={`border-b border-hairline last:border-0 ${
                onRowClick ? "cursor-pointer hover:bg-surface-hover" : ""
              }`}
            >
              {columns.map((col) => (
                <td
                  key={col.key}
                  className={`px-2 py-2.5 align-middle sm:px-3 ${
                    col.numeric ? "tnum text-right" : "text-left"
                  } ${col.hideOnMobile ? "hidden md:table-cell" : ""}`}
                >
                  {col.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
