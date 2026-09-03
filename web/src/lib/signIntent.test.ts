import {describe, it, expect} from "vitest";
import {addressRow, amountRow, fallbackIntent, promptSummary} from "./signIntent";

const WALLET = "0x98405c5776a63547E7cB16000ba04Ca53d9fb2F8" as const;

describe("promptSummary", () => {
  it("collapses a run of the same kind", () => {
    expect(promptSummary(["transaction", "transaction"])).toBe("2 transactions");
    expect(promptSummary(["signature"])).toBe("1 signature");
  });

  it("keeps mixed runs in wallet order", () => {
    expect(promptSummary(["signature", "transaction"])).toBe("1 signature, then 1 transaction");
    expect(promptSummary(["transaction", "signature", "signature"])).toBe(
      "1 transaction, then 2 signatures",
    );
  });

  it("names the empty case rather than rendering nothing", () => {
    expect(promptSummary([])).toBe("no prompts");
  });
});

describe("addressRow", () => {
  it("abbreviates and marks the value as mono", () => {
    const row = addressRow("Wallet", WALLET, "why");
    expect(row.value).not.toBe(WALLET);
    expect(row.value).toBe("0x9840…b2F8");
    expect(row.mono).toBe(true);
    expect(row.hint).toBe("why");
  });
});

describe("amountRow", () => {
  it("appends the symbol when one is known", () => {
    expect(amountRow("Amount", BigInt(1500) * BigInt(10) ** BigInt(18), 18, "bUSD").value).toBe(
      "1,500 bUSD",
    );
  });

  it("omits the symbol when it is not", () => {
    expect(amountRow("Amount", BigInt(1500) * BigInt(10) ** BigInt(18), 18).value).toBe("1,500");
  });

  it("reads a 6-decimal token in its own units", () => {
    expect(amountRow("Amount", BigInt(2_500_000), 6, "USDC").value).toBe("2.5 USDC");
  });
});

describe("fallbackIntent", () => {
  it("claims nothing about the action it is standing in for", () => {
    const intent = fallbackIntent();
    expect(intent.rows).toEqual([]);
    expect(intent.prompts).toEqual(["transaction"]);
    expect(intent.title).toBe("Confirm in your wallet");
  });

  it("carries the prompt list it was given", () => {
    expect(fallbackIntent(["signature"]).prompts).toEqual(["signature"]);
  });
});
