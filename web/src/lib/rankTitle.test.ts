import {describe, expect, it} from "vitest";
import {RANKS} from "./ranks";
import {rankTitle} from "./rankTitle";

describe("rankTitle", () => {
  it("names the three leading ranks", () => {
    expect(rankTitle(1)).toEqual({rank: 1, name: "Kingpin", glyph: "♚"});
    expect(rankTitle(2)).toEqual({rank: 2, name: "Cipher", glyph: "♝"});
    expect(rankTitle(3)).toEqual({rank: 3, name: "Lancer", glyph: "♞"});
  });

  it("leaves every rank below third untitled", () => {
    expect(rankTitle(4)).toBeUndefined();
    expect(rankTitle(97)).toBeUndefined();
  });

  it("returns nothing for a rank off the scale", () => {
    expect(rankTitle(0)).toBeUndefined();
    expect(rankTitle(-1)).toBeUndefined();
  });

  it("gives each title its own glyph and name", () => {
    const titles = [1, 2, 3].map((rank) => rankTitle(rank));
    expect(new Set(titles.map((title) => title?.glyph)).size).toBe(3);
    expect(new Set(titles.map((title) => title?.name)).size).toBe(3);
  });

  it("keeps every title clear of the BoneyScore band names", () => {
    const bands = new Set(RANKS.map((band) => band.name.toLowerCase()));
    for (const rank of [1, 2, 3]) {
      expect(bands.has(rankTitle(rank)!.name.toLowerCase())).toBe(false);
    }
  });
});
