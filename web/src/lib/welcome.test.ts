import {describe, expect, it} from "vitest";
import {
  shouldOpenWelcome,
  welcomeFigure,
  WELCOME_VERSION,
  type WelcomeFigure,
} from "@/lib/welcome";

const BUSD = {symbol: "bUSD", decimals: 18};
const units = (whole: number) => BigInt(whole) * BigInt(10) ** BigInt(18);

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
  it("leads with the escrowed total when the campaigns share one unit", () => {
    expect(welcomeFigure({pool: units(12_500), token: BUSD, activeCount: 2})).toEqual({
      label: "Escrowed right now",
      value: "12,500",
      unit: "bUSD in reward pools",
    } satisfies WelcomeFigure);
  });

  it("drops the fraction rather than showing cents at display size", () => {
    expect(welcomeFigure({pool: units(1_000) + BigInt(4e17), token: BUSD, activeCount: 1}).value).toBe(
      "1,000",
    );
  });

  it("falls back to the campaign count across mixed units", () => {
    expect(welcomeFigure({pool: units(12_500), activeCount: 3})).toEqual({
      label: "Live right now",
      value: "3",
      unit: "campaigns paying for results",
    } satisfies WelcomeFigure);
  });

  it("falls back when nothing is escrowed, and reads singular at one campaign", () => {
    expect(welcomeFigure({pool: BigInt(0), token: BUSD, activeCount: 1})).toEqual({
      label: "Live right now",
      value: "1",
      unit: "campaign paying for results",
    } satisfies WelcomeFigure);
  });

  it("says nothing is live rather than showing a dash", () => {
    expect(welcomeFigure({pool: BigInt(0), activeCount: 0})).toEqual({
      label: "Live right now",
      value: "0",
      unit: "campaigns paying for results",
    } satisfies WelcomeFigure);
  });
});
