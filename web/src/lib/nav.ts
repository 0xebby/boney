/**
 * The nav's shape and active state, decided away from the markup that renders it.
 *
 * Three consumers now render this nav — the top bar, the wallet chip's menu, and `NavDrawer` — so
 * "which items, in what order" and "which one is current" have to be one answer rather than three
 * that drift. Pure and React-free for the same reason `relayCore.ts` and `indexerCore.ts` are: the
 * project's tests are `.ts` under a `node` environment (`vitest.config.mts`), so logic living here
 * is provable by fixture while the components stay thin enough not to need a DOM to check.
 */

export type NavItem = {
  href: string;
  label: string;
  /** Whether the nav marks this destination as newly added. At most one item carries it. */
  isNew?: boolean;
};

/**
 * The public destinations, in display order — the whole of the top bar.
 *
 * The first item is "Campaigns" rather than "Boneyard" on purpose. The brand mark beside it already
 * links to `/`, and the list page leads with a `boneyard` hero — three copies of the name on one
 * screen reads as a stutter, so only the mark and the hero carry it.
 *
 * Boneyboard follows Discover: both are public views of the same population, so they read as a pair.
 *
 * Create is deliberately NOT in this list. It is the primary action of the whole product, so it sits
 * in the bar's right-hand cluster as a filled button rather than reading as one more peer link.
 */
const PUBLIC_NAV = [
  {href: "/", label: "Campaigns"},
  {href: "/discover", label: "Discover"},
  {href: "/leaderboard", label: "Boneyboard", isNew: true},
  {href: "/docs", label: "Docs"},
] as const;

const MY_CAMPAIGNS = {href: "/my", label: "My Campaigns"} as const;
const BONEYCARD = {href: "/card", label: "BoneyCard"} as const;
const PROMOTERS = {href: "/promoters", label: "Promoters"} as const;

/**
 * The bar's list: the four public destinations, and only ever those four.
 *
 * The bar used to carry the personal entries too, which made its length a function of the wallet.
 * A connected promoter saw seven links between the brand and a right-hand cluster that never
 * shrinks, and the row could not hold them: measured, the nav took two rows from 1024px up, three
 * at 768px and seven at 640px, standing the header up to 201px tall. A fixed four is a row that
 * fits at every width, so the header's height stops depending on who is looking at it.
 */
export function navItems(): NavItem[] {
  return [...PUBLIC_NAV];
}

/**
 * The personal destinations, which hang off the wallet chip's menu rather than the bar.
 *
 * They belong to the wallet, not to the product, which is the argument for putting them behind the
 * thing that *is* the wallet. It also gives the chip something to do besides disconnect.
 *
 * All three appear only once they have something to show. A tab that can only ever render "nothing
 * here" is a dead end that costs a navigation to discover:
 *
 *  - **My Campaigns** needs a wallet to know whose campaigns to filter to.
 *  - **BoneyCard** needs one to have a score and a qualification list to compute. It is the only
 *    personal entry that is useful with *no* history at all — that is the whole point of it — so it
 *    is gated on the connection and nothing more, and it sits before Promoters because it is what a
 *    wallet sees before it has ever joined anything.
 *  - **Promoters** is a dashboard of memberships and tracking links, so it waits until the wallet
 *    actually holds one — see `useIsPromoter`.
 *
 * All three start hidden during the server render and the first client render, which is what keeps
 * hydration consistent: wagmi rehydrates its connection inside an effect, so there is no wallet to
 * read at markup time on either side. They appear a moment later rather than flashing wrong.
 */
export function walletNavItems({
  isConnected,
  isPromoter,
}: {
  isConnected: boolean;
  isPromoter: boolean;
}): NavItem[] {
  return [
    ...(isConnected ? [MY_CAMPAIGNS, BONEYCARD] : []),
    ...(isPromoter ? [PROMOTERS] : []),
  ];
}

/**
 * The drawer's list: public first, then personal.
 *
 * The drawer is the only nav below `md`, so it has to reach everything the bar and the wallet menu
 * reach between them — a phone that could only get to My Campaigns through the wallet chip would be
 * hiding a destination behind a control whose job is disconnecting. Public before personal so the
 * panel reads in the same order as the header does left to right.
 */
export function drawerNavItems(gating: {isConnected: boolean; isPromoter: boolean}): NavItem[] {
  return [...navItems(), ...walletNavItems(gating)];
}

/**
 * Whether a nav item is the page currently being viewed.
 *
 * `/` is special-cased because every path starts with it, so a prefix test would light up Campaigns
 * on every route in the app. It therefore matches only itself.
 *
 * Everything else matches its own path or a path *below* it, so `/campaign/12` keeps Campaigns lit
 * while reading one campaign. The descendant test is on a segment boundary rather than a bare
 * `startsWith`: `startsWith("/my")` also matches `/mythical`, which is not a child route and should
 * not light the tab. No route collides today, so this is a latent bug rather than a live one — but
 * the check costs one comparison and removes a trap from adding any route that happens to share a
 * prefix with an existing one.
 */
export function isActiveNav(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  if (pathname === href) return true;
  return pathname.startsWith(`${href}/`);
}
