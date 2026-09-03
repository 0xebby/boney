import {describe, expect, it} from "vitest";
import {
  shouldOpenWelcome,
  welcomeFigure,
  WELCOME_VERSION,
  type WelcomeFigure,
} from "@/lib/welcome";

describe("shouldOpenWelcome", () => {
  it("opens for a visitor who has stored nothing", () => {
    expect(shouldOpenWelcome({stored: null, search: ""})).toBe(true);
  });

  it("stays shut once the current version is dismissed", () => {
    expect(shouldOpenWelcome({stored: WELCOME_VERSION, search: ""})).toBe(false);
  });

  it("opens again when the stored version is an older one", () => {
    expect(shouldOpenWelcome({stored: "0", search: ""})).toBe(true);
  });

  it("reopens on ?welcome=1 for a visitor who dismissed it", () => {
    expect(shouldOpenWelcome({stored: WELCOME_VERSION, search: "?welcome=1"})).toBe(true);
    expect(shouldOpenWelcome({stored: WELCOME_VERSION, search: "welcome=1"})).toBe(true);
  });

  it("ignores the parameter at any other value", () => {
    expect(shouldOpenWelcome({stored: WELCOME_VERSION, search: "?welcome=0"})).toBe(false);
    expect(shouldOpenWelcome({stored: WELCOME_VERSION, search: "?welcome"})).toBe(false);
    expect(shouldOpenWelcome({stored: WELCOME_VERSION, search: "?c=0x1"})).toBe(false);
  });
});

describe("welcomeFigure", () => {
  it("leads with the escrowed total in dollars", () => {
    expect(welcomeFigure({pool: 12_500, activeCount: 2})).toEqual({
      label: "Escrowed right now",
      value: "$12,500",
      unit: "in reward pools",
    } satisfies WelcomeFigure);
  });

  it("totals campaigns escrowing different tokens into one figure", () => {
    // 24,500 bUSD across the fixture campaigns plus Gyndore's 10,000 GYND.
    expect(welcomeFigure({pool: 34_500, activeCount: 4}).value).toBe("$34,500");
  });

  it("drops the cents rather than showing them at display size", () => {
    expect(welcomeFigure({pool: 1_000.4, activeCount: 1}).value).toBe("$1,000");
  });

  it("falls back when nothing is escrowed, and reads singular at one campaign", () => {
    expect(welcomeFigure({pool: 0, activeCount: 1})).toEqual({
      label: "Live right now",
      value: "1",
      unit: "campaign paying for results",
    } satisfies WelcomeFigure);
  });

  it("says nothing is live rather than showing a dash", () => {
    expect(welcomeFigure({pool: 0, activeCount: 0})).toEqual({
      label: "Live right now",
      value: "0",
      unit: "campaigns paying for results",
    } satisfies WelcomeFigure);
  });
});
