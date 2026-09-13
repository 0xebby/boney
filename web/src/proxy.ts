import {NextResponse, type NextRequest} from "next/server";

/**
 * Canonicalises the casing of the first path segment.
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
  const segments = pathname.split("/");
  const first = segments[1];
  if (!first) return NextResponse.next();

  const lower = first.toLowerCase();
  if (lower === first || !ROUTE_SEGMENTS.has(lower)) return NextResponse.next();

  segments[1] = lower;
  const url = request.nextUrl.clone();
  url.pathname = segments.join("/");

  return NextResponse.redirect(url, 308);
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|.*\\..*).*)"],
};
