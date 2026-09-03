/**
 * The origin this deployment is reached at, for metadata that has to be absolute.
 *
 * ## Why this exists, rather than a relative path
 *
 * `og:image` and `og:url` are read by a crawler on someone else's machine, so a path is not enough —
 * they have to be fully qualified. Next resolves relative metadata URLs against `metadataBase`, and per
 * `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/generate-metadata.md`, *"using a
 * relative path in a URL-based metadata field without configuring a `metadataBase` will cause a build
 * error"*. `/b/<wallet>` sets `openGraph.url` from `cardPath`, so this is not optional — without it the
 * share card is a broken production build, and in dev an inferred `http://localhost:3000` lands in the
 * `og:image` of every card that gets shared. A share image nobody outside this machine can fetch is the
 * one failure the whole phase exists to avoid.
 *
 * ## Why not `window.location.origin`
 *
 * That is what `trackingLink` uses, and it is right there — but only because a tracking link is built in
 * the browser by the promoter who is about to copy it. Metadata is rendered on the server for a client
 * that will never run JavaScript, and there is no `window` at that moment. The origin has to be
 * configured, not observed.
 *
 * Set `NEXT_PUBLIC_SITE_URL` to whatever host links are actually shared as — the tunnel host in dev, the
 * real domain in production. It is public by nature: it ends up in the HTML of every page.
 */

/** Where the app runs when nothing says otherwise. Matches `next dev`'s default port. */
const LOCAL_ORIGIN = "http://localhost:3000";

/**
 * The configured origin as a `URL`, falling back to localhost.
 *
 * Falls back rather than throwing on a malformed value, because this is evaluated while the root layout
 * module loads: a typo in an env var would otherwise 500 every route in the app, including the ones that
 * have no metadata to resolve. The cost of the fallback is a wrong `og:image` host on shared links, which
 * is a bad share card rather than an outage.
 *
 * Takes the raw value as an argument so the rules are testable without mutating `process.env`; the
 * default reads the variable, which is what callers use.
 */
export function siteUrl(raw: string | undefined = process.env.NEXT_PUBLIC_SITE_URL): URL {
  const trimmed = raw?.trim();
  if (!trimmed) return new URL(LOCAL_ORIGIN);
  try {
    // A bare host — `boneyard.xyz` — is what someone setting this will write half the time, and `new URL`
    // rejects it outright. Assume https, which is the only scheme a shared link should carry anyway.
    return new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return new URL(LOCAL_ORIGIN);
  }
}
