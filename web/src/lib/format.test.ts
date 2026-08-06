import {describe, it, expect} from "vitest";
import {
  compactNumber,
  formatTokenAmount,
  formatPercent,
  shortAddress,
  formatDuration,
  formatTimeUntil,
  toAmountInput,
} from "./format";
import {parseAmount} from "./validation";

describe("toAmountInput", () => {
  /**
   * The round trip is the whole point: this value goes straight into an amount input that
   * `parseAmount` then reads back. A browser run caught the original implementation reusing
   * `formatTokenAmount`, whose grouped output ("8,000") `parseAmount` rejects and whose
   * 2-digit truncation would have silently underfunded the escrow.
   */
  const cases: [bigint, number][] = [
    [BigInt(0), 18],
    [BigInt(1), 18],
    [BigInt("8000000000000000000000"), 18],
    [BigInt("1234567890123456789"), 18],
    [BigInt("1000000"), 6],
    [BigInt("1"), 6],
    [BigInt("123456789012345678901234567890"), 18],
    [BigInt(42), 0],
  ];

  it("round-trips through parseAmount exactly", () => {
    for (const [value, decimals] of cases) {
      const text = toAmountInput(value, decimals);
      expect(parseAmount(text, decimals), `${value} @ ${decimals}dp → "${text}"`).toBe(value);
    }
  });

  it("never emits a thousands separator", () => {
    // A comma makes parseAmount return null, which disables the submit button with no
    // explanation the user can act on.
    expect(toAmountInput(BigInt("8000000000000000000000"), 18)).toBe("8000");
    expect(toAmountInput(BigInt("1000000000"), 6)).toBe("1000");
  });

  it("keeps full precision instead of truncating to 2 decimals", () => {
    // formatTokenAmount would render this "0.12"; funding that instead of the real shortfall
    // leaves the campaign short and activate() reverts with NotFunded.
    const value = BigInt("123456789012345678");
    expect(toAmountInput(value, 18)).toBe("0.123456789012345678");
    expect(formatTokenAmount(value, 18)).toBe("0.12");
    expect(parseAmount(toAmountInput(value, 18), 18)).toBe(value);
  });

  it("drops only trailing zeros, which do not change the value", () => {
    expect(toAmountInput(BigInt("1500000000000000000"), 18)).toBe("1.5");
    expect(toAmountInput(BigInt("2000000000000000000"), 18)).toBe("2");
  });

  it("handles a zero-decimal token", () => {
    expect(toAmountInput(BigInt(42), 0)).toBe("42");
  });

  it("stays exact beyond Number.MAX_SAFE_INTEGER", () => {
    const huge = BigInt("999999999999999999999999999");
    expect(parseAmount(toAmountInput(huge, 18), 18)).toBe(huge);
  });
});

describe("compactNumber", () => {
  it("keeps values under 10k exact", () => {
    expect(compactNumber(0)).toBe("0");
    expect(compactNumber(1_284)).toBe("1,284");
    expect(compactNumber(9_999)).toBe("9,999");
  });

  it("compacts thousands, millions, billions", () => {
    expect(compactNumber(12_900)).toBe("12.9K");
    expect(compactNumber(4_200_000)).toBe("4.2M");
    expect(compactNumber(1_500_000_000)).toBe("1.5B");
  });

  it("drops a trailing .0", () => {
    expect(compactNumber(12_000)).toBe("12K");
    expect(compactNumber(3_000_000)).toBe("3M");
  });

  it("handles negatives and non-finite input", () => {
    expect(compactNumber(-25_000)).toBe("-25K");
    expect(compactNumber(NaN)).toBe("—");
    expect(compactNumber(Infinity)).toBe("—");
  });
});

describe("formatTokenAmount", () => {
  it("formats whole 18-decimal amounts", () => {
    expect(formatTokenAmount(BigInt("1000000000000000000"), 18)).toBe("1");
    expect(formatTokenAmount(BigInt("1500000000000000000"), 18)).toBe("1.5");
  });

  it("groups thousands", () => {
    expect(formatTokenAmount(BigInt("10000000000000000000000"), 18)).toBe("10,000");
  });

  it("truncates to the requested precision and trims zeros", () => {
    // 1.23456… with maxFractionDigits 2 → "1.23"
    expect(formatTokenAmount(BigInt("1234560000000000000"), 18, {maxFractionDigits: 2})).toBe(
      "1.23",
    );
    expect(formatTokenAmount(BigInt("1200000000000000000"), 18, {maxFractionDigits: 2})).toBe(
      "1.2",
    );
  });

  it("supports 6-decimal tokens like USDC", () => {
    expect(formatTokenAmount(BigInt("2500000"), 6)).toBe("2.5");
    expect(formatTokenAmount(BigInt("1000000"), 6)).toBe("1");
  });

  it("does not lose precision on very large balances", () => {
    // Beyond Number.MAX_SAFE_INTEGER — float conversion would corrupt this.
    const huge = BigInt("123456789012345678901234567890");
    expect(formatTokenAmount(huge, 18, {maxFractionDigits: 0})).toBe("123,456,789,012");
  });

  it("handles zero and negatives", () => {
    expect(formatTokenAmount(BigInt(0), 18)).toBe("0");
    expect(formatTokenAmount(BigInt("-1500000000000000000"), 18)).toBe("-1.5");
  });

  it("compacts large whole amounts when asked", () => {
    const amount = BigInt("50000000000000000000000"); // 50,000
    expect(formatTokenAmount(amount, 18, {compact: true})).toBe("50K");
  });

  it("rejects negative decimals", () => {
    expect(() => formatTokenAmount(BigInt(1), -1)).toThrow(RangeError);
  });
});

describe("formatPercent", () => {
  it("computes a percentage with one decimal", () => {
    expect(formatPercent(45.67, 100)).toBe("45.7%");
    expect(formatPercent(1, 3)).toBe("33.3%");
  });

  it("drops a trailing .0", () => {
    expect(formatPercent(50, 100)).toBe("50%");
  });

  it("guards divide-by-zero", () => {
    expect(formatPercent(10, 0)).toBe("0%");
  });
});

describe("shortAddress", () => {
  it("truncates the middle", () => {
    expect(shortAddress("0x1234567890abcdef1234567890abcdef12345678")).toBe("0x1234…5678");
  });

  it("leaves short strings alone", () => {
    expect(shortAddress("0x1234")).toBe("0x1234");
  });
});

describe("formatDuration", () => {
  it("shows at most two units", () => {
    expect(formatDuration(3 * 86_400 + 4 * 3_600 + 12 * 60)).toBe("3d 4h");
    expect(formatDuration(12 * 3_600 + 30 * 60)).toBe("12h 30m");
    expect(formatDuration(45 * 60)).toBe("45m");
  });

  it("omits a zero second unit", () => {
    expect(formatDuration(3 * 86_400)).toBe("3d");
    expect(formatDuration(2 * 3_600)).toBe("2h");
  });

  it("handles sub-minute and negative input", () => {
    expect(formatDuration(0)).toBe("just now");
    expect(formatDuration(30)).toBe("30s");
    expect(formatDuration(-100)).toBe("just now");
  });
});

describe("formatTimeUntil", () => {
  const now = 1_000_000;

  it("reports remaining time", () => {
    expect(formatTimeUntil(now + 86_400, now)).toBe("1d");
  });

  it("reports ended for past timestamps", () => {
    expect(formatTimeUntil(now - 1, now)).toBe("ended");
    expect(formatTimeUntil(now, now)).toBe("ended");
  });

  it("accepts bigint timestamps from the chain", () => {
    expect(formatTimeUntil(BigInt(now + 3_600), now)).toBe("1h");
  });
});
