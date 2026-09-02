import {describe, it, expect, afterEach} from "vitest";
import {existsSync, mkdirSync, readdirSync, rmSync, writeFileSync} from "node:fs";
import {dirname} from "node:path";
import {cachePath, loadTimestampCache, saveTimestampCache} from "./timestampCache";

/** A chain id no fixture uses, so the test never touches a real cache file. */
const CHAIN = 987_654_321;

afterEach(() => {
  rmSync(cachePath(CHAIN), {force: true});
});

describe("cachePath", () => {
  it("keys the file by chain id", () => {
    expect(cachePath(CHAIN)).toContain(`block-timestamps-${CHAIN}.json`);
    expect(cachePath(1)).not.toBe(cachePath(CHAIN));
  });
});

describe("saveTimestampCache / loadTimestampCache", () => {
  it("round-trips block numbers past Number.MAX_SAFE_INTEGER", () => {
    const huge = BigInt("9007199254740993");
    saveTimestampCache(CHAIN, new Map([[BigInt(46_230_075), BigInt(1_756_000_000)], [huge, BigInt(7)]]));

    const back = loadTimestampCache(CHAIN);
    expect(back.get(BigInt(46_230_075))).toBe(BigInt(1_756_000_000));
    expect(back.get(huge)).toBe(BigInt(7));
    expect(back.size).toBe(2);
  });

  it("reads back an empty map when no cache was ever written", () => {
    expect(loadTimestampCache(CHAIN).size).toBe(0);
  });

  it("reads back an empty map rather than throwing on a corrupt file", () => {
    mkdirSync(dirname(cachePath(CHAIN)), {recursive: true});
    writeFileSync(cachePath(CHAIN), "{not json");
    expect(loadTimestampCache(CHAIN).size).toBe(0);
  });

  it("leaves no temp file behind, so a concurrent pass sees only whole files", () => {
    saveTimestampCache(CHAIN, new Map([[BigInt(1), BigInt(2)]]));
    const strays = readdirSync(dirname(cachePath(CHAIN))).filter((f) => f.endsWith(".tmp"));
    expect(strays).toEqual([]);
    expect(existsSync(cachePath(CHAIN))).toBe(true);
  });

  it("replaces the previous contents rather than merging into them", () => {
    saveTimestampCache(CHAIN, new Map([[BigInt(1), BigInt(10)]]));
    saveTimestampCache(CHAIN, new Map([[BigInt(2), BigInt(20)]]));

    const back = loadTimestampCache(CHAIN);
    expect(back.has(BigInt(1))).toBe(false);
    expect(back.get(BigInt(2))).toBe(BigInt(20));
  });
});
