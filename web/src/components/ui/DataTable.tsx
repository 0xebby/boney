"use client";

import {useMemo, useState, type ReactNode} from "react";
import {sortRows, nextSortState, type SortState, type SortableColumn} from "@/lib/table";

/**
 * DataTable — dense, sortable, metric-heavy table.
 */

export type Column<T> = SortableColumn<T> & {
  header: string;
  /** Right-align numeric columns so digits line up. */
  numeric?: boolean;
  render: (row: T) => ReactNode;
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
