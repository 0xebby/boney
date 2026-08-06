import {describe, it, expect} from "vitest";
import {compareValues, sortRows, nextSortState, type SortableColumn} from "./table";

type Row = {id: string; name: string; pool: bigint; used: number};

const COLUMNS: SortableColumn<Row>[] = [
  {key: "name", sortValue: (r) => r.name},
  {key: "pool", sortValue: (r) => r.pool},
  {key: "used", sortValue: (r) => r.used},
  {key: "actions"}, // unsortable
];

const ROWS: Row[] = [
  {id: "a", name: "Genesis mint", pool: BigInt(50_000), used: 20},
  {id: "b", name: "Swap drive", pool: BigInt(12_000), used: 0},
  {id: "c", name: "Bridge quest", pool: BigInt(8_000), used: 20},
];

describe("compareValues", () => {
  it("orders bigints without narrowing to Number", () => {
    // Both of these collapse to the same float; only exact bigint comparison distinguishes them.
    const a = BigInt("9007199254740993");
    const b = BigInt("9007199254740992");
    expect(Number(a) === Number(b)).toBe(true);
    expect(compareValues(a, b)).toBe(1);
  });

  it("orders numbers", () => {
    expect(compareValues(1, 2)).toBeLessThan(0);
    expect(compareValues(2, 1)).toBeGreaterThan(0);
    expect(compareValues(2, 2)).toBe(0);
  });

  it("does not return NaN for equal infinities", () => {
    expect(compareValues(Infinity, Infinity)).toBe(0);
  });

  it("compares strings case-insensitively and numeric-aware", () => {
    expect(compareValues("apple", "Banana")).toBeLessThan(0);
    expect(compareValues("item 2", "item 10")).toBeLessThan(0);
  });
});

describe("sortRows", () => {
  it("returns a copy, never mutating the input", () => {
    const before = [...ROWS];
    const out = sortRows(ROWS, COLUMNS, {key: "pool", dir: "asc"});
    expect(ROWS).toEqual(before);
    expect(out).not.toBe(ROWS);
  });

  it("sorts ascending and descending by bigint", () => {
    expect(sortRows(ROWS, COLUMNS, {key: "pool", dir: "asc"}).map((r) => r.id)).toEqual([
      "c",
      "b",
      "a",
    ]);
    expect(sortRows(ROWS, COLUMNS, {key: "pool", dir: "desc"}).map((r) => r.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("sorts by string", () => {
    expect(sortRows(ROWS, COLUMNS, {key: "name", dir: "asc"}).map((r) => r.id)).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("returns the original order when unsorted", () => {
    expect(sortRows(ROWS, COLUMNS, null).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("ignores an unsortable or unknown column", () => {
    expect(sortRows(ROWS, COLUMNS, {key: "actions", dir: "desc"}).map((r) => r.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(sortRows(ROWS, COLUMNS, {key: "nope", dir: "desc"}).map((r) => r.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  /**
   * Ties must keep their input order in BOTH directions. A naive implementation that sorts
   * ascending then calls `.reverse()` scrambles equal rows — rows "a" and "c" both have
   * used=20, so reversing would emit them as c,a.
   */
  it("is stable for tied values in both directions", () => {
    const asc = sortRows(ROWS, COLUMNS, {key: "used", dir: "asc"});
    expect(asc.map((r) => r.id)).toEqual(["b", "a", "c"]);

    const desc = sortRows(ROWS, COLUMNS, {key: "used", dir: "desc"});
    expect(desc.map((r) => r.id)).toEqual(["a", "c", "b"]);
  });

  it("handles empty and single-row inputs", () => {
    expect(sortRows([], COLUMNS, {key: "pool", dir: "asc"})).toEqual([]);
    expect(sortRows([ROWS[0]], COLUMNS, {key: "pool", dir: "asc"})).toEqual([ROWS[0]]);
  });
});

describe("nextSortState", () => {
  it("starts descending on a fresh column", () => {
    expect(nextSortState(null, "pool")).toEqual({key: "pool", dir: "desc"});
  });

  it("cycles desc → asc → cleared", () => {
    const first = nextSortState(null, "pool");
    const second = nextSortState(first, "pool");
    expect(second).toEqual({key: "pool", dir: "asc"});
    expect(nextSortState(second, "pool")).toBeNull();
  });

  it("switching columns restarts at descending", () => {
    expect(nextSortState({key: "pool", dir: "asc"}, "used")).toEqual({
      key: "used",
      dir: "desc",
    });
  });
});
