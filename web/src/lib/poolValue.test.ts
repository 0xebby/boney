import {describe, expect, it} from "vitest";
import {poolValue, toDollars} from "@/lib/poolValue";
import {UNKNOWN_TOKEN, type TokenMeta} from "@/lib/token";

const BUSD = "0x2755562471b5f6239722ab164d126260f4d8dcc2";
const GYND = "0x0d442ec7bddb06b531dca3dd39abaff554170776";
const USDC = "0x0000000000000000000000000000000000000abc";
const NAMELESS = "0x0000000000000000000000000000000000000def";

const TOKENS: Record<string, TokenMeta> = {
  [BUSD]: {symbol: "bUSD", decimals: 18},
  [GYND]: {symbol: "GYND", decimals: 18},
  [USDC]: {symbol: "USDC", decimals: 6},
  [NAMELESS]: UNKNOWN_TOKEN,
};

const units = (whole: number, decimals: number) => BigInt(whole) * BigInt(10) ** BigInt(decimals);

const view = (token: string, pool: bigint, paid = BigInt(0)) => ({
  token,
  rewardPool: pool,
  paidOut: paid,
});

describe("toDollars", () => {
  it("reads a whole amount at the token's scale", () => {
    expect(toDollars(units(10_000, 18), 18)).toBe(10_000);
    expect(toDollars(units(10_000, 6), 6)).toBe(10_000);
  });

  it("keeps cents and truncates below them", () => {
    // String literals: these exceed MAX_SAFE_INTEGER, so a numeric one would round before BigInt.
    expect(toDollars(BigInt("1234500000000000000"), 18)).toBe(1.23);
    expect(toDollars(BigInt("10000000000000000"), 18)).toBe(0.01);
    expect(toDollars(BigInt("9999999999999999"), 18)).toBe(0);
  });

  it("handles a zero-decimal token", () => {
    expect(toDollars(BigInt(42), 0)).toBe(42);
  });

  it("stays exact past Number.MAX_SAFE_INTEGER in base units", () => {
    // 1e10 tokens at 18 decimals is 1e28 base units — far beyond a float's integer range.
    expect(toDollars(units(10_000_000_000, 18), 18)).toBe(10_000_000_000);
  });

  it("carries a negative amount through", () => {
    expect(toDollars(-units(5, 18), 18)).toBe(-5);
  });

  it("rejects negative decimals", () => {
    expect(() => toDollars(BigInt(1), -1)).toThrow(RangeError);
  });
});

describe("poolValue", () => {
  it("totals an empty list to zero", () => {
    expect(poolValue([], TOKENS)).toEqual({pool: 0, paidOut: 0});
  });

  it("totals pools and payouts in one token", () => {
    expect(
      poolValue([view(BUSD, units(19_500, 18), units(500, 18)), view(BUSD, units(5_000, 18))], TOKENS),
    ).toEqual({pool: 24_500, paidOut: 500});
  });

  /*
    The case this module exists for: the landing page read "2 tokens" instead of a total once the
    Gyndore campaign escrowed GYND alongside the bUSD ones.
  */
  it("totals across different tokens", () => {
    expect(
      poolValue([view(BUSD, units(24_500, 18)), view(GYND, units(10_000, 18))], TOKENS).pool,
    ).toBe(34_500);
  });

  it("reads each token at its own decimals", () => {
    // Same dollar value, three scales — a raw bigint sum would be off by 10^12.
    expect(
      poolValue(
        [view(BUSD, units(1_000, 18)), view(USDC, units(1_000, 6)), view(NAMELESS, units(1_000, 18))],
        TOKENS,
      ).pool,
    ).toBe(3_000);
  });

  it("matches token addresses case-insensitively", () => {
    const checksummed = "0x2755562471B5f6239722ab164d126260F4D8dCc2";
    expect(poolValue([view(checksummed, units(100, 18))], TOKENS).pool).toBe(100);
  });

  it("falls back to the unknown token's scale when metadata has not loaded", () => {
    expect(poolValue([view(BUSD, units(100, 18))], {}).pool).toBe(100);
  });
});
