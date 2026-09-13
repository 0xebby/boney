import {describe, expect, it} from "vitest";
import {NextRequest} from "next/server";
import {proxy} from "./proxy";

/**
 * The proxy exists for one failure that never shows up on desktop: a hand-typed URL on a phone
 * arrives auto-capitalised as `/Docs`, which Next's case-sensitive router 404s. These assert both
 * halves — that a miscased real route is repaired, and that nothing else is touched.
 */

function requestFor(path: string): NextRequest {
  return new NextRequest(new URL(path, "https://boney.test"));
}

function locationOf(path: string): string | null {
  const response = proxy(requestFor(path));
  const location = response.headers.get("location");
  return location === null ? null : new URL(location).pathname + new URL(location).search;
}

describe("proxy", () => {
  it("repairs the autocapitalised first letter a phone keyboard produces", () => {
    const response = proxy(requestFor("/Docs"));
    expect(response.status).toBe(308);
    expect(locationOf("/Docs")).toBe("/docs");
  });

  it("repairs a fully uppercased route, which autocorrect also produces", () => {
    expect(locationOf("/DOCS")).toBe("/docs");
  });

  it.each([
    "/Discover",
    "/Create",
    "/My",
    "/Card",
    "/Promoters",
    "/Leaderboard",
    "/Campaign/12",
  ])("repairs %s, since every route is typeable, not just /docs", (path) => {
    expect(locationOf(path)).toBe(path.toLowerCase());
  });

  /**
   * The share surface is the one route that arrives typed or pasted rather than clicked, so a
   * capitalised `/B` is the likeliest miscasing of all — and the wallet after it must survive.
   */
  it("repairs the shared card's segment without touching the wallet", () => {
    expect(locationOf("/B/0xAbCdEf0123")).toBe("/b/0xAbCdEf0123");
  });

  it("leaves a correctly cased route alone rather than redirecting it in a loop", () => {
    expect(locationOf("/docs")).toBeNull();
  });

  it("leaves the root alone, which has no segment to correct", () => {
    expect(locationOf("/")).toBeNull();
  });

  /**
   * The guard that keeps this from becoming a data-corruption bug. Only the first segment is
   * lowercased, so a parameter that is case-significant — a checksummed address, a base64 token —
   * survives even though the segment in front of it was repaired.
   */
  it("lowercases only the first segment, never a parameter", () => {
    expect(locationOf("/Campaign/0xAbCdEf")).toBe("/campaign/0xAbCdEf");
  });

  it("carries the query string across, which the referral link depends on", () => {
    expect(locationOf("/R?c=0xAbC&p=0xDeF")).toBe("/r?c=0xAbC&p=0xDeF");
  });

  it("does not invent a route for a path that genuinely does not exist", () => {
    expect(locationOf("/Nonsense")).toBeNull();
  });
});
