import {NextResponse, type NextRequest} from "next/server";

/**
 * Canonicalises the casing of the first path segment.
 *
 * Next's router is case-sensitive, so `/Docs` is a different route from `/docs` and there is no page
 * at the former — it renders the 404. That is invisible on desktop, where every route is reached by
 * clicking a `<Link>`, and routine on a phone: iOS and Android keyboards auto-capitalise the first
 * word of a typed URL, so a hand-typed address bar entry arrives as `/Docs` and 404s. The page the
 * user was trying to read is the one most likely to be typed rather than clicked, since it is what
 * gets passed around as "read the docs".
 *
 * So this is a mobile bug with a desktop-invisible cause, and the fix belongs in front of the router
 * rather than in any one page.
 *
 * **Only the first segment, and only against an allowlist.** Lowercasing whole paths would be a
 * standing hazard here: campaign ids are numeric today (`/campaign/12`), but the moment any route
 * carries a checksummed address, a mixed-case EIP-55 string, or a base64 token, a blanket
 * `toLowerCase()` silently corrupts it. Restricting the rewrite to a known set of literal first
 * segments means this can only ever repair a route that exists, and can never touch a parameter.
 *
 * Anything not in the set falls through untouched, so an unknown path still 404s as it should — the
 * goal is fixing the casing of real routes, not inventing routes.
 *
 * Named `proxy` in `proxy.ts`, not `middleware`: the `middleware` file convention is deprecated as of
 * Next 16 and renamed to `proxy`. See
 * `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md`.
 */

/**
 * First path segments that name a real route, lowercase.
 *
 * Derived from `src/app/` — every directory with a `page.tsx`, plus `api`. Kept as a literal set
 * rather than read from the filesystem because a proxy runs on every request and may be deployed to
 * a CDN edge, where it has no filesystem to read.
 *
 * `api` is included so `/API/attest` resolves, but see `config.matcher`: request paths already under
 * `/api` are excluded from the proxy entirely, so this only catches miscased variants.
 */
const ROUTE_SEGMENTS = new Set([
  "api",
  "b",
  "campaign",
  "card",
  "create",
  "discover",
  "docs",
  "leaderboard",
  "my",
  "promoters",
  "r",
]);

export function proxy(request: NextRequest): NextResponse {
  const {pathname} = request.nextUrl;

  // `pathname` always starts with "/", so index 1 is the first segment. An empty first segment is
  // the root route, which has no casing to correct.
  const segments = pathname.split("/");
  const first = segments[1];
  if (!first) return NextResponse.next();

  const lower = first.toLowerCase();
  if (lower === first || !ROUTE_SEGMENTS.has(lower)) return NextResponse.next();

  segments[1] = lower;
  const url = request.nextUrl.clone();
  url.pathname = segments.join("/");

  // 308 rather than 307: the canonical casing is not going to change, so this is worth caching, and
  // 308 preserves the method for the same reason 307 does. Cloning `nextUrl` carries the query string
  // and hash across, which matters for `/R?c=…&p=…` — the referral link shape.
  return NextResponse.redirect(url, 308);
}

export const config = {
  /**
   * Everything except the paths where a redirect would be wrong or wasteful.
   *
   * `api` is excluded because an API client is not a browser: it did not typo the URL, and answering
   * a fetch with a redirect it may not follow is worse than the 404 it can act on. Static assets and
   * image optimisation are excluded because they are served straight from the filesystem and are
   * already correctly cased by whatever emitted them — running a proxy on each one is pure latency.
   *
   * The trailing `.*\\..*` clause skips anything with a file extension, which covers `favicon.ico`,
   * `robots.txt`, and the SVGs in `public/` without enumerating them.
   */
  matcher: ["/((?!api|_next/static|_next/image|.*\\..*).*)"],
};
