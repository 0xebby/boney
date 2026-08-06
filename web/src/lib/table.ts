/**
 * Pure table sorting logic, kept out of the React component so it can be unit-tested
 * without a DOM (decision F6).
 */

export type SortDir = "asc" | "desc";
export type SortState = {key: string; dir: SortDir} | null;

export type SortableColumn<T> = {
  key: string;
  sortValue?: (row: T) => number | string | bigint;
};

/**
 * Compares two cell values. BigInt is compared without narrowing to Number, so campaign
 * amounts beyond `Number.MAX_SAFE_INTEGER` sort correctly rather than collapsing to equal.
 */
export function compareValues(
  a: number | string | bigint,
  b: number | string | bigint,
): number {
  if (typeof a === "bigint" && typeof b === "bigint") {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (typeof a === "number" && typeof b === "number") {
    // Subtraction would return NaN for Infinity - Infinity; compare instead.
    return a < b ? -1 : a > b ? 1 : 0;
  }
  return String(a).localeCompare(String(b), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

/** Applies a sort state to rows. Never mutates the input, and is stable for equal keys. */
export function sortRows<T>(
  rows: readonly T[],
  columns: readonly SortableColumn<T>[],
  sort: SortState,
): T[] {
  if (!sort) return [...rows];

  const col = columns.find((c) => c.key === sort.key);
  if (!col?.sortValue) return [...rows];
  const value = col.sortValue;

  // Decorate with the original index so equal keys keep their relative order in both
  // directions — reversing a sorted array would otherwise scramble ties.
  return rows
    .map((row, index) => ({row, index}))
    .sort((x, y) => {
      const cmp = compareValues(value(x.row), value(y.row));
      if (cmp !== 0) return sort.dir === "desc" ? -cmp : cmp;
      return x.index - y.index;
    })
    .map((d) => d.row);
}

/**
 * Cycles a column's sort on click: unsorted → descending → ascending → unsorted.
 * Descending first, because for a metric column the largest value is what a reader wants.
 */
export function nextSortState(current: SortState, key: string): SortState {
  if (current?.key !== key) return {key, dir: "desc"};
  if (current.dir === "desc") return {key, dir: "asc"};
  return null;
}
