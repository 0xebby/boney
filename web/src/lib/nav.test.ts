import {describe, expect, it} from "vitest";
import {isActiveNav, navItems} from "./nav";

/**
 * Two consumers render this nav — the top bar and the mobile drawer — so ordering and active state
 * are asserted here rather than trusted to match across two JSX trees.
 */

const labelsFor = (isConnected: boolean, isPromoter: boolean) =>
  navItems({isConnected, isPromoter}).map((item) => item.label);

describe("navItems", () => {
  it("shows only the public entries to a visitor with no wallet", () => {
    expect(labelsFor(false, false)).toEqual(["Campaigns", "Discover", "Boneyboard", "Docs"]);
  });

  /** My Campaigns sits beside the marketplace it filters, not appended at the end. */
  it("splices My Campaigns in after Campaigns once a wallet is connected", () => {
    expect(labelsFor(true, false)).toEqual([
      "Campaigns",
      "My Campaigns",
      "Discover",
      "Boneyboard",
      "BoneyCard",
      "Docs",
    ]);
  });

  it("splices Promoters in after Discover for a wallet that holds a membership", () => {
    expect(labelsFor(true, true)).toEqual([
      "Campaigns",
      "My Campaigns",
      "Discover",
      "Boneyboard",
      "BoneyCard",
      "Promoters",
      "Docs",
    ]);
  });

  /**
   * `useIsPromoter` reads the chain and can resolve before wagmi reports the connection, so this
   * combination is reachable rather than hypothetical. Promoters should still appear.
   */
  it("handles promoter-without-connected, which the two async reads can produce", () => {
    expect(labelsFor(false, true)).toEqual([
      "Campaigns",
      "Discover",
      "Boneyboard",
      "Promoters",
      "Docs",
    ]);
  });

  /**
   * The card is the one personal entry that is worth opening with no history at all — a wallet that
   * has never joined anything still has a score, a rank and a list of campaigns it qualifies for. So
   * it follows the connection rather than `useIsPromoter`, and appears before Promoters does.
   */
  it("shows BoneyCard on the connection alone, ahead of Promoters", () => {
    expect(labelsFor(true, false)).toContain("BoneyCard");
    expect(labelsFor(false, false)).not.toContain("BoneyCard");

    const withBoth = labelsFor(true, true);
    expect(withBoth.indexOf("BoneyCard")).toBeLessThan(withBoth.indexOf("Promoters"));
  });

  /** The board is public, so it appears with no wallet and does not move when one connects. */
  it("shows Boneyboard in every combination, always after Discover", () => {
    for (const [connected, promoter] of [
      [false, false],
      [true, false],
      [false, true],
      [true, true],
    ] as const) {
      const labels = labelsFor(connected, promoter);
      expect(labels).toContain("Boneyboard");
      expect(labels.indexOf("Boneyboard")).toBe(labels.indexOf("Discover") + 1);
    }
  });

  it("keeps Docs last in every combination", () => {
    for (const [connected, promoter] of [
      [false, false],
      [true, false],
      [false, true],
      [true, true],
    ] as const) {
      expect(labelsFor(connected, promoter).at(-1)).toBe("Docs");
    }
  });

  it("never lists Create, which is the bar's button rather than a peer link", () => {
    expect(labelsFor(true, true).map((l) => l.toLowerCase())).not.toContain("create");
  });
});

describe("isActiveNav", () => {
  it("lights Campaigns only on the root, not on every path beneath it", () => {
    expect(isActiveNav("/", "/")).toBe(true);
    expect(isActiveNav("/docs", "/")).toBe(false);
    expect(isActiveNav("/campaign/12", "/")).toBe(false);
  });

  it("lights an item on its own path", () => {
    expect(isActiveNav("/docs", "/docs")).toBe(true);
  });

  /** Reading one campaign should keep the list tab lit, so descendants count. */
  it("lights an item on a path below it", () => {
    expect(isActiveNav("/promoters/0xabc", "/promoters")).toBe(true);
  });

  /**
   * The reason this is a function rather than an inline `startsWith`. `/mythical` is not a child of
   * `/my`, and a bare prefix test would light My Campaigns on it.
   */
  it("does not light an item on a path that merely shares its prefix", () => {
    expect(isActiveNav("/mythical", "/my")).toBe(false);
    expect(isActiveNav("/documentation", "/docs")).toBe(false);
  });

  it("is unaffected by a trailing segment boundary being the only difference", () => {
    expect(isActiveNav("/my/", "/my")).toBe(true);
  });
});
