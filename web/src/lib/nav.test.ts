import {describe, expect, it} from "vitest";
import {drawerNavItems, isActiveNav, navItems, walletNavItems} from "./nav";

/**
 * Three consumers render this nav — the top bar, the wallet chip's menu and the mobile drawer — so
 * the split between them, the ordering and the active state are asserted here rather than trusted
 * to match across three JSX trees.
 */

const GATING = [
  [false, false],
  [true, false],
  [false, true],
  [true, true],
] as const;

const barLabels = () => navItems().map((item) => item.label);
const menuLabels = (isConnected: boolean, isPromoter: boolean) =>
  walletNavItems({isConnected, isPromoter}).map((item) => item.label);
const drawerLabels = (isConnected: boolean, isPromoter: boolean) =>
  drawerNavItems({isConnected, isPromoter}).map((item) => item.label);

const PERSONAL = ["My Campaigns", "BoneyCard", "Promoters"];

describe("navItems", () => {
  it("is the four public destinations in display order", () => {
    expect(barLabels()).toEqual(["Campaigns", "Discover", "Boneyboard", "Docs"]);
  });

  /**
   * The whole point of the split: the bar's length stops being a function of the wallet, which is
   * what stood the header up to 201px at 640px when a promoter connected.
   */
  it("never carries a personal destination, whatever the wallet is", () => {
    for (const label of PERSONAL) {
      expect(barLabels()).not.toContain(label);
    }
  });

  it("keeps Docs last", () => {
    expect(barLabels().at(-1)).toBe("Docs");
  });

  /** The board is public, so it sits in the bar next to the page it pairs with. */
  it("keeps Boneyboard directly after Discover", () => {
    const labels = barLabels();
    expect(labels.indexOf("Boneyboard")).toBe(labels.indexOf("Discover") + 1);
  });

  /** One destination carries the mark at a time — a second would read as noise rather than news. */
  it("marks Boneyboard as the new destination and nothing else", () => {
    expect(navItems().filter((item) => item.isNew).map((item) => item.label)).toEqual([
      "Boneyboard",
    ]);
  });

  it("never lists Create, which is the bar's button rather than a peer link", () => {
    expect(barLabels().map((label) => label.toLowerCase())).not.toContain("create");
  });

  /** The array is handed to a component that maps over it; a shared frozen literal would be a trap. */
  it("returns a fresh array each call", () => {
    expect(navItems()).not.toBe(navItems());
  });
});

describe("walletNavItems", () => {
  it("offers nothing to a visitor with no wallet", () => {
    expect(menuLabels(false, false)).toEqual([]);
  });

  it("offers the two connection-gated entries once a wallet connects", () => {
    expect(menuLabels(true, false)).toEqual(["My Campaigns", "BoneyCard"]);
  });

  it("adds Promoters for a wallet that holds a membership", () => {
    expect(menuLabels(true, true)).toEqual(["My Campaigns", "BoneyCard", "Promoters"]);
  });

  /**
   * `useIsPromoter` reads the chain and can resolve before wagmi reports the connection, so this
   * combination is reachable rather than hypothetical. Promoters should still appear.
   */
  it("handles promoter-without-connected, which the two async reads can produce", () => {
    expect(menuLabels(false, true)).toEqual(["Promoters"]);
  });

  /**
   * The card is the one personal entry that is worth opening with no history at all — a wallet that
   * has never joined anything still has a score, a rank and a list of campaigns it qualifies for. So
   * it follows the connection rather than `useIsPromoter`, and appears before Promoters does.
   */
  it("shows BoneyCard on the connection alone, ahead of Promoters", () => {
    const withBoth = menuLabels(true, true);
    expect(withBoth.indexOf("BoneyCard")).toBeLessThan(withBoth.indexOf("Promoters"));
  });

  it("offers only personal destinations, never a public one", () => {
    for (const [connected, promoter] of GATING) {
      for (const label of menuLabels(connected, promoter)) {
        expect(PERSONAL).toContain(label);
      }
    }
  });
});

describe("drawerNavItems", () => {
  /** Below `md` the drawer is the only nav, so everything both other surfaces reach lives in it. */
  it("is the bar's list followed by the wallet menu's, for every wallet", () => {
    for (const [connected, promoter] of GATING) {
      expect(drawerLabels(connected, promoter)).toEqual([
        ...barLabels(),
        ...menuLabels(connected, promoter),
      ]);
    }
  });

  it("reaches every personal destination a connected promoter has", () => {
    expect(drawerLabels(true, true)).toEqual([
      "Campaigns",
      "Discover",
      "Boneyboard",
      "Docs",
      "My Campaigns",
      "BoneyCard",
      "Promoters",
    ]);
  });

  it("is the four public entries and nothing else with no wallet", () => {
    expect(drawerLabels(false, false)).toEqual(["Campaigns", "Discover", "Boneyboard", "Docs"]);
  });

  it("never repeats a destination", () => {
    for (const [connected, promoter] of GATING) {
      const hrefs = drawerNavItems({isConnected: connected, isPromoter: promoter}).map((i) => i.href);
      expect(new Set(hrefs).size).toBe(hrefs.length);
    }
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

  /** The menu marks its current item too, so the same test has to hold for a personal href. */
  it("lights a wallet-menu destination when it is the page being viewed", () => {
    expect(isActiveNav("/card", "/card")).toBe(true);
    expect(isActiveNav("/my", "/my")).toBe(true);
    expect(isActiveNav("/", "/card")).toBe(false);
  });
});
