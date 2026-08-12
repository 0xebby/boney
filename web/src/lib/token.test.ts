import {describe, expect, it} from "vitest";
import {denominations, UNKNOWN_TOKEN, type TokenMeta} from "./token";

const BUSD_A = "0x311b0dbcda74a11f74d9ff673d51d673d95fb716";
const BUSD_B = "0x2755562471b5f6239722ab164d126260f4d8dcc2";
const USDC = "0x0000000000000000000000000000000000000abc";
const NAMELESS = "0x0000000000000000000000000000000000000def";

const bUSD: TokenMeta = {symbol: "bUSD", decimals: 18};
const usdc: TokenMeta = {symbol: "USDC", decimals: 6};

const TOKENS: Record<string, TokenMeta> = {
  [BUSD_A]: bUSD,
  [BUSD_B]: bUSD,
  [USDC]: usdc,
  [NAMELESS]: UNKNOWN_TOKEN,
};

const at = (...addresses: string[]) => addresses.map((token) => ({token}));

describe("denominations", () => {
  it("returns nothing for an empty list", () => {
    expect(denominations([], TOKENS)).toEqual([]);
  });

  it("collapses repeats of one token to a single unit", () => {
    expect(denominations(at(BUSD_A, BUSD_A, BUSD_A), TOKENS)).toEqual([bUSD]);
  });

  /*
    The bug this module exists for: Base Sepolia carries two deployments of the same mock bUSD
    (campaigns 0-8 on one, 9-10 on the other), which made the landing page's total read
    "2 tokens" while every row beneath it said bUSD.
  */
  it("treats two deployments of the same symbol and scale as one unit", () => {
    expect(denominations(at(BUSD_A, BUSD_B), TOKENS)).toEqual([bUSD]);
  });

  it("keeps genuinely different tokens apart", () => {
    expect(denominations(at(BUSD_A, USDC), TOKENS)).toEqual([bUSD, usdc]);
  });

  it("keeps a shared symbol apart when the scale differs", () => {
    // Same name, different base units — adding these raw would be off by 10^12.
    const sixDecimalBusd: TokenMeta = {symbol: "bUSD", decimals: 6};
    const tokens = {[BUSD_A]: bUSD, [BUSD_B]: sixDecimalBusd};

    expect(denominations(at(BUSD_A, BUSD_B), tokens)).toEqual([bUSD, sixDecimalBusd]);
  });

  it("keeps unnamed tokens apart from each other", () => {
    // Both fell back to "???", which is an absence of metadata, not evidence of a shared unit.
    const other = "0x0000000000000000000000000000000000000fed";
    const tokens = {[NAMELESS]: UNKNOWN_TOKEN, [other]: UNKNOWN_TOKEN};

    expect(denominations(at(NAMELESS, other), tokens)).toHaveLength(2);
  });

  it("keeps an unnamed token apart from a named one", () => {
    expect(denominations(at(BUSD_A, NAMELESS), TOKENS)).toEqual([bUSD, UNKNOWN_TOKEN]);
  });

  it("treats metadata that has not loaded as unknown rather than throwing", () => {
    expect(denominations(at(BUSD_A), {})).toEqual([UNKNOWN_TOKEN]);
  });

  it("matches token addresses case-insensitively", () => {
    // Views can carry checksummed addresses while the metadata map is keyed lowercase.
    expect(denominations(at(BUSD_A.toUpperCase().replace("0X", "0x")), TOKENS)).toEqual([bUSD]);
  });

  it("returns units in first-appearance order", () => {
    expect(denominations(at(USDC, BUSD_A, USDC, BUSD_B), TOKENS)).toEqual([usdc, bUSD]);
  });
});
