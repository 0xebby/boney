/**
 * The nav's shape and active state, decided away from the markup that renders it.
 *
 * Two consumers now render the same nav — the top bar from `sm` up, and `NavDrawer` below it — so
 * "which items, in what order" and "which one is current" have to be one answer rather than two
 * that drift. Pure and React-free for the same reason `relayCore.ts` and `indexerCore.ts` are: the
 * project's tests are `.ts` under a `node` environment (`vitest.config.mts`), so logic living here
 * is provable by fixture while the components stay thin enough not to need a DOM to check.
 */

export type NavItem = {href: string; label: string; icon: string};

/**
 * The nav in display order.
 *
 * The first item is "Campaigns" rather than "Boneyard" on purpose. The brand mark beside it already
 * links to `/`, and the list page leads with a `boneyard` hero — three copies of the name on one
 * screen reads as a stutter, so only the mark and the hero carry it.
 *
 * Create is deliberately NOT in this list. It is the primary action of the whole product, so it sits
 * in the bar's right-hand cluster as a filled button rather than reading as one more peer link.
 */
const PUBLIC_NAV = [
  {href: "/", label: "Campaigns", icon: "▦"},
  {href: "/discover", label: "Discover", icon: "◍"},
  {href: "/docs", label: "Docs", icon: "◌"},
] as const;

const MY_CAMPAIGNS = {href: "/my", label: "My Campaigns", icon: "◈"} as const;
const BONEYCARD = {href: "/card", label: "BoneyCard", icon: "⬡"} as const;
const PROMOTERS = {href: "/promoters", label: "Promoters", icon: "◎"} as const;

/**
 * The nav in display order, with the personal entries spliced into the positions they occupy when
 * present — "My Campaigns" beside the marketplace it filters, "BoneyCard" and "Promoters" beside
 * Discover, and Docs last either way. Building the list rather than rendering conditionals inline
 * keeps that ordering in one place instead of spread across two components' JSX.
 *
 * Three entries are personal rather than public, and appear only once they have something to show. A
 * tab that can only ever render "nothing here" is a dead end that costs a navigation to discover:
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
export function navItems({
  isConnected,
  isPromoter,
}: {
  isConnected: boolean;
  isPromoter: boolean;
}): NavItem[] {
  const [campaigns, discover, docs] = PUBLIC_NAV;
  return [
    campaigns,
    ...(isConnected ? [MY_CAMPAIGNS] : []),
    discover,
    ...(isConnected ? [BONEYCARD] : []),
    ...(isPromoter ? [PROMOTERS] : []),
    docs,
  ];
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
