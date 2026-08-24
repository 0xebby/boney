import {describe, expect, it} from "vitest";
import {AMOUNT_MODE} from "./kpiSource";
import {actionNoun, describeThreshold, describeUnit, type UnitInput} from "./kpiUnits";

/**
 * The sentences a project and a referral read about scaling.
 *
 * Every case below is a string a person sees, so they are asserted whole rather than by substring: a
 * sentence that loses its second half is still "correct" under a `toContain`, and the second half is
 * where the arithmetic lives.
 */

/** The live lynx campaign's KPI 0 — `count` mode at `scale: 10`, which credited 51 deposits as 5. */
const LYNX_DEPOSIT: UnitInput = {
  amountMode: AMOUNT_MODE.count,
  kind: "Deposit",
  scale: BigInt(10),
  signature: "Deposit(address,uint256)",
};

/** The WETH preset — `dataWord0` at `1e15`, the mode scale was designed for. */
const WETH_VOLUME: UnitInput = {
  amountMode: AMOUNT_MODE.dataWord0,
  kind: "Deposit",
  scale: BigInt(1e15),
  signature: "Deposit(address,uint256)",
  token: {decimals: 18, symbol: "WETH"},
};

describe("actionNoun", () => {
  it("takes the noun from the event, not the category", () => {
    // Both KPIs on the lynx campaign carry `kind: Deposit`; only the signature distinguishes them,
    // so a sentence built from the kind would call the withdrawal a deposit.
    expect(actionNoun("Withdrawal(address,uint256)", "Deposit")).toEqual({
      many: "withdrawals",
      one: "withdrawal",
    });
  });

  /*
    Most event names are nouns; these are not. "10 depositeds" is the kind of wrong that reads as a
    bug in the page, so a past participle or a compound keeps its real name and borrows a noun.
  */
  it("borrows a noun rather than pluralizing a participle", () => {
    expect(actionNoun("SupplyExecuted(address,uint256)", "Custom")).toEqual({
      many: "SupplyExecuted events",
      one: "SupplyExecuted event",
    });
    expect(actionNoun("Deposited(address,uint256)", "Deposit")).toEqual({
      many: "Deposited events",
      one: "Deposited event",
    });
  });

  it("falls back to the kind label when no signature resolved", () => {
    expect(actionNoun(undefined, "Mint")).toEqual({many: "nft mints", one: "nft mint"});
    expect(actionNoun("   ", "Swap")).toEqual({many: "swaps", one: "swap"});
  });

  it("falls back when the signature will not parse", () => {
    // Arrives from a contract's storage, so this is a real input rather than a defensive branch.
    expect(actionNoun("not a signature", "Bridge")).toEqual({
      many: "bridge txs",
      one: "bridge tx",
    });
  });

  /*
    `KPI_KIND_LABEL` heads a table column; it was never meant to be pluralized mid-sentence. "10
    volume generateds = 1 unit" reads as a bug in the page rather than as a gap in what the chain
    published, so these degrade to the generic noun instead.
  */
  it("refuses to count a mass noun", () => {
    for (const kind of ["Custom", "Tvl", "Volume", "Stake", "ActiveUser"] as const) {
      expect(actionNoun(undefined, kind), kind).toEqual({many: "events", one: "event"});
    }
  });

  it("still names a mass-noun kind when the event does", () => {
    // The kind is uncountable but the event is not, and the event is the better source anyway.
    expect(actionNoun("Swap(address,uint256)", "Volume")).toEqual({many: "swaps", one: "swap"});
  });
});

describe("describeUnit", () => {
  it("states the cost of a unit for the campaign that got this wrong", () => {
    expect(describeUnit(LYNX_DEPOSIT)).toBe("10 deposits = 1 unit of progress.");
  });

  it("says an unscaled count KPI is one-for-one", () => {
    expect(describeUnit({...LYNX_DEPOSIT, scale: BigInt(1)})).toBe(
      "Each deposit counts as 1 unit of progress.",
    );
  });

  /*
    `kpiSource.effectiveScale` treats a stored zero as one. The sentence has to agree, or a KPI reads
    as crediting nothing while the indexer credits normally.
  */
  it("treats a zero scale as one, like the indexer does", () => {
    expect(describeUnit({...LYNX_DEPOSIT, scale: BigInt(0)})).toBe(
      "Each deposit counts as 1 unit of progress.",
    );
  });

  it("names a real token amount when the contract answered", () => {
    expect(describeUnit(WETH_VOLUME)).toBe("0.001 WETH = 1 unit of progress.");
  });

  it("says tokens when decimals are known but the symbol is not", () => {
    expect(describeUnit({...WETH_VOLUME, token: {decimals: 6}})).toBe(
      "1,000,000,000 tokens = 1 unit of progress.",
    );
  });

  /*
    A contract that would not answer `decimals()` is exactly the one whose decimals must not be
    guessed — Aave's Pool and Sygma's bridge implement neither. So the divisor is stated as itself,
    and the 18-decimal reading is offered as a hedge rather than as the answer.
  */
  it("hedges when the contract would not say its decimals", () => {
    expect(describeUnit({...WETH_VOLUME, token: undefined})).toBe(
      "1,000,000,000,000,000 base units = 1 unit of progress — 0.001 of an 18-decimal token.",
    );
  });

  it("warns that an unscaled volume KPI counts wei", () => {
    expect(describeUnit({...WETH_VOLUME, scale: BigInt(1), token: undefined})).toBe(
      "1 base unit = 1 unit of progress — thresholds will be very large for an 18-decimal token.",
    );
  });

  it("uses the generic noun rather than inventing one", () => {
    expect(describeUnit({amountMode: AMOUNT_MODE.count, kind: "Tvl", scale: BigInt(4)})).toBe(
      "4 events = 1 unit of progress.",
    );
  });
});

describe("describeThreshold", () => {
  /*
    The line that would have caught the lynx campaign: tier 1 sits at 50, which is 500 wraps. The
    project typed 50 into a field labelled "Tier 1 threshold" and nothing said otherwise.
  */
  it("restates a tier threshold as the work it takes", () => {
    expect(describeThreshold(BigInt(50), LYNX_DEPOSIT)).toBe("500 deposits");
  });

  it("groups large action counts", () => {
    expect(describeThreshold(BigInt(10000), LYNX_DEPOSIT)).toBe("100,000 deposits");
  });

  it("keeps the singular for a threshold of one action", () => {
    expect(describeThreshold(BigInt(1), {...LYNX_DEPOSIT, scale: BigInt(1)})).toBeNull();
    expect(describeThreshold(BigInt(1), {...LYNX_DEPOSIT, scale: BigInt(2)})).toBe("2 deposits");
  });

  /*
    Silent rather than redundant. "50 units = 50 deposits" restates the number it sits directly
    under, and a line that says nothing still costs the reader an eye movement.
  */
  it("says nothing when the threshold already is the action count", () => {
    expect(describeThreshold(BigInt(50), {...LYNX_DEPOSIT, scale: BigInt(1)})).toBeNull();
    expect(describeThreshold(BigInt(50), {...LYNX_DEPOSIT, scale: BigInt(0)})).toBeNull();
  });

  /*
    Under `dataWord0` a threshold is a token amount, not a number of actions — one large swap could
    cross an entire ladder. There is no action count to give, so none is invented.
  */
  it("has no answer for a volume KPI", () => {
    expect(describeThreshold(BigInt(50), WETH_VOLUME)).toBeNull();
  });

  it("ignores a non-positive threshold", () => {
    expect(describeThreshold(BigInt(0), LYNX_DEPOSIT)).toBeNull();
    expect(describeThreshold(BigInt(-5), LYNX_DEPOSIT)).toBeNull();
  });
});
