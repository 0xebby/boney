import {describe, it, expect} from "vitest";
import {
  harvestLogTimestamps,
  missingTimestamps,
  parseTimestamps,
  pruneTimestamps,
  serializeTimestamps,
  timestampBatches,
  type BlockTimestamps,
} from "./blockTimestamps";

/** A cache holding the blocks named, each with timestamp `1000 + 2n`. */
function cache(...blocks: number[]): BlockTimestamps {
  return new Map(blocks.map((b) => [BigInt(b), BigInt(1000 + 2 * b)]));
}

describe("harvestLogTimestamps", () => {
  it("takes a bigint timestamp straight off the log", () => {
    const into: BlockTimestamps = new Map();
    expect(
      harvestLogTimestamps([{blockNumber: BigInt(7), blockTimestamp: BigInt(1014)}], into),
    ).toBe(1);
    expect(into.get(BigInt(7))).toBe(BigInt(1014));
  });

  it("reads a hex-quantity timestamp", () => {
    const into: BlockTimestamps = new Map();
    harvestLogTimestamps([{blockNumber: BigInt(7), blockTimestamp: "0x3f6"}], into);
    expect(into.get(BigInt(7))).toBe(BigInt(1014));
  });

  it("reads a decimal-string and a number timestamp", () => {
    const into: BlockTimestamps = new Map();
    harvestLogTimestamps(
      [
        {blockNumber: BigInt(1), blockTimestamp: "1002"},
        {blockNumber: BigInt(2), blockTimestamp: 1004},
      ],
      into,
    );
    expect(into.get(BigInt(1))).toBe(BigInt(1002));
    expect(into.get(BigInt(2))).toBe(BigInt(1004));
  });

  it("skips a log the node sent no timestamp on", () => {
    const into: BlockTimestamps = new Map();
    expect(harvestLogTimestamps([{blockNumber: BigInt(7)}], into)).toBe(0);
    expect(into.size).toBe(0);
  });

  it("skips a pending log with no block number", () => {
    const into: BlockTimestamps = new Map();
    harvestLogTimestamps([{blockNumber: null, blockTimestamp: BigInt(1014)}], into);
    expect(into.size).toBe(0);
  });

  it("treats a zero timestamp as absent", () => {
    const into: BlockTimestamps = new Map();
    harvestLogTimestamps([{blockNumber: BigInt(7), blockTimestamp: BigInt(0)}], into);
    expect(into.size).toBe(0);
  });

  it("counts many logs from one block once", () => {
    const into: BlockTimestamps = new Map();
    const log = {blockNumber: BigInt(7), blockTimestamp: BigInt(1014)};
    expect(harvestLogTimestamps([log, log, log], into)).toBe(1);
  });

  it("leaves a timestamp the cache already held", () => {
    const into = cache(7);
    expect(harvestLogTimestamps([{blockNumber: BigInt(7), blockTimestamp: BigInt(9)}], into)).toBe(0);
    expect(into.get(BigInt(7))).toBe(BigInt(1014));
  });
});

describe("missingTimestamps", () => {
  it("drops blocks the cache holds", () => {
    expect(missingTimestamps([BigInt(1), BigInt(2), BigInt(3)], cache(2))).toEqual([
      BigInt(1),
      BigInt(3),
    ]);
  });

  it("names a repeated block once", () => {
    expect(missingTimestamps([BigInt(5), BigInt(5), BigInt(5)], new Map())).toEqual([BigInt(5)]);
  });

  it("returns them ascending", () => {
    expect(missingTimestamps([BigInt(9), BigInt(2), BigInt(5)], new Map())).toEqual([
      BigInt(2),
      BigInt(5),
      BigInt(9),
    ]);
  });

  it("returns nothing when the cache covers everything", () => {
    expect(missingTimestamps([BigInt(1), BigInt(2)], cache(1, 2))).toEqual([]);
  });
});

describe("timestampBatches", () => {
  it("splits into bounded batches", () => {
    const blocks = [BigInt(1), BigInt(2), BigInt(3), BigInt(4), BigInt(5)];
    expect(timestampBatches(blocks, 2)).toEqual([
      [BigInt(1), BigInt(2)],
      [BigInt(3), BigInt(4)],
      [BigInt(5)],
    ]);
  });

  it("returns nothing for an empty list", () => {
    expect(timestampBatches([], 10)).toEqual([]);
  });

  it("rejects a non-positive size", () => {
    expect(() => timestampBatches([BigInt(1)], 0)).toThrow(/positive/);
  });
});

describe("pruneTimestamps", () => {
  it("leaves a cache already within the limit", () => {
    const c = cache(1, 2, 3);
    expect(pruneTimestamps(c, 3)).toBe(0);
    expect(c.size).toBe(3);
  });

  it("drops the lowest blocks first", () => {
    const c = cache(1, 2, 3, 4, 5);
    expect(pruneTimestamps(c, 2)).toBe(3);
    expect([...c.keys()]).toEqual([BigInt(4), BigInt(5)]);
  });

  it("rejects a non-positive limit", () => {
    expect(() => pruneTimestamps(cache(1), 0)).toThrow(/positive/);
  });
});

describe("serializeTimestamps and parseTimestamps", () => {
  it("round-trips a cache", () => {
    const c = cache(3, 1, 2);
    expect([...parseTimestamps(serializeTimestamps(c))]).toEqual([...cache(1, 2, 3)]);
  });

  it("round-trips block numbers past Number.MAX_SAFE_INTEGER", () => {
    const big = BigInt("46276493000000000000000");
    const c: BlockTimestamps = new Map([[big, BigInt(1)]]);
    expect(parseTimestamps(serializeTimestamps(c)).get(big)).toBe(BigInt(1));
  });

  it("reads an absent cache as empty", () => {
    expect(parseTimestamps(undefined).size).toBe(0);
  });

  it("reads a corrupt file as empty rather than throwing", () => {
    expect(parseTimestamps("{not json").size).toBe(0);
    expect(parseTimestamps('{"entries":"nope"}').size).toBe(0);
  });

  it("skips malformed entries and keeps the rest", () => {
    const text = '{"version":1,"entries":[["1","1002"],["oops","x"],[],["2","1004"]]}';
    expect([...parseTimestamps(text)]).toEqual([...cache(1, 2)]);
  });
});
