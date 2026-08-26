import {describe, it, expect} from "vitest";
import {siteUrl} from "./site";

/**
 * The origin rules for absolute metadata.
 *
 * The theme: **a misconfigured origin must degrade to a bad share card, never to a broken app.** This is
 * evaluated as the root layout module loads, so anything that throws here takes down every route rather
 * than the one field it was needed for.
 */

describe("siteUrl", () => {
  it("uses the configured origin", () => {
    expect(siteUrl("https://boneyard.xyz").toString()).toBe("https://boneyard.xyz/");
  });

  it("assumes https for a bare host", () => {
    // What someone actually types into an env file. `new URL` rejects it, and a shared link has no
    // business being http anyway.
    expect(siteUrl("boneyard.xyz").origin).toBe("https://boneyard.xyz");
  });

  it("keeps an explicit http origin, for a local tunnel", () => {
    expect(siteUrl("http://127.0.0.1:3000").origin).toBe("http://127.0.0.1:3000");
  });

  it("keeps a base path", () => {
    // Next composes relative metadata fields onto the end of this, so a subpath deployment survives.
    expect(siteUrl("https://example.com/app").toString()).toBe("https://example.com/app");
  });

  it("falls back to localhost when unset, empty, or whitespace", () => {
    for (const raw of [undefined, "", "   "]) {
      expect(siteUrl(raw).origin).toBe("http://localhost:3000");
    }
  });

  it("falls back rather than throwing on a malformed value", () => {
    // A layout that throws while its module evaluates is a 500 on every page in the app, to fix an
    // `og:image` host. The share card is worth less than the site.
    expect(siteUrl("http://").origin).toBe("http://localhost:3000");
  });

  it("tolerates surrounding whitespace", () => {
    expect(siteUrl(" https://boneyard.xyz \n").origin).toBe("https://boneyard.xyz");
  });
});
