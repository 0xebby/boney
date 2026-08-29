import {describe, it, expect} from "vitest";
import {blockAtTimestamp, earliestCoveringTouch} from "./blockSearch";

/** A chain whose block `n` carries timestamp `1000 + 2n`, counting the reads it serves. */
function fixture(head: bigint) {
  const reads: bigint[] = [];
  const read = async (blockNumber: bigint) => {
    if (blockNumber > head) throw new Error(`block ${blockNumber} is past the head`);
    reads.push(blockNumber);
    return BigInt(1000) + blockNumber * BigInt(2);
  };
  return {read, reads};
}

describe("blockAtTimestamp", () => {
  it("lands on the block whose timestamp matches exactly", async () => {
    const {read} = fixture(BigInt(1000));
    expect(await blockAtTimestamp(read, BigInt(1200), BigInt(0), BigInt(1000))).toBe(BigInt(100));
  });

  it("rounds down when no block carries that timestamp", async () => {
    const {read} = fixture(BigInt(1000));
    expect(await blockAtTimestamp(read, BigInt(1201), BigInt(0), BigInt(1000))).toBe(BigInt(100));
  });

  it("returns the low bound when every block in range is later", async () => {
    const {read} = fixture(BigInt(1000));
    expect(await blockAtTimestamp(read, BigInt(1), BigInt(500), BigInt(1000))).toBe(BigInt(500));
  });

  it("returns the high bound when every block in range is earlier", async () => {
    const {read} = fixture(BigInt(1000));
    expect(await blockAtTimestamp(read, BigInt(9_999), BigInt(0), BigInt(1000))).toBe(BigInt(1000));
  });

  it("never reads past the high bound", async () => {
    const {read, reads} = fixture(BigInt(1000));
    await blockAtTimestamp(read, BigInt(9_999), BigInt(0), BigInt(1000));
    expect(reads.every((n) => n <= BigInt(1000))).toBe(true);
  });

  it("costs a logarithmic number of reads", async () => {
    const {read, reads} = fixture(BigInt(1_000_000));
    await blockAtTimestamp(read, BigInt(1_234_567), BigInt(0), BigInt(1_000_000));
    expect(reads.length).toBeLessThan(25);
  });

  it("reuses a shared cache across searches", async () => {
    const {read, reads} = fixture(BigInt(1_000_000));
    const cache = new Map<bigint, bigint>();

    await blockAtTimestamp(read, BigInt(1_234_567), BigInt(0), BigInt(1_000_000), cache);
    const first = reads.length;
    await blockAtTimestamp(read, BigInt(1_234_567), BigInt(0), BigInt(1_000_000), cache);

    expect(first).toBeGreaterThan(0);
    expect(reads.length).toBe(first);
  });

  it("returns the low bound without reading anything when the range is empty", async () => {
    const {read, reads} = fixture(BigInt(1000));
    expect(await blockAtTimestamp(read, BigInt(1200), BigInt(900), BigInt(800))).toBe(BigInt(900));
    expect(reads).toEqual([]);
  });
});

describe("earliestCoveringTouch", () => {
  it("reaches back one full touch duration from the campaign's start", () => {
    expect(earliestCoveringTouch(BigInt(10_000), BigInt(3_600))).toBe(BigInt(6_400));
  });

  it("floors at zero rather than going negative", () => {
    expect(earliestCoveringTouch(BigInt(100), BigInt(3_600))).toBe(BigInt(0));
  });

  it("is the start itself when touches cannot outlive their own block", () => {
    expect(earliestCoveringTouch(BigInt(10_000), BigInt(0))).toBe(BigInt(10_000));
  });
});
