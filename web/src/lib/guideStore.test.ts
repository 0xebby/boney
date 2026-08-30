import {describe, it, expect, afterEach, beforeEach} from "vitest";
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {readGuide, writeGuide} from "./guideStore";
import type {CampaignGuide} from "./campaignGuide";

/**
 * The campaign guide store.
 *
 * Every test redirects `BONEY_GUIDE_STORE` first: the default path is `.data/campaign-guides.json`
 * beside the running app, and a test that wrote there would change which guides the dev server serves.
 * That override also pins the backend — it wins over `NETLIFY`, which is what keeps these tests on the
 * filesystem when they run in CI on Netlify.
 *
 * The cases worth pinning are the ones where being wrong is invisible: a stored guide surviving a
 * re-read under a differently-cased address (otherwise a project publishes and the page shows the
 * catalog), an emptied guide actually being deleted (otherwise a withdrawal silently leaves the old
 * links up), and an unwritable store reporting `false` rather than throwing (otherwise the route
 * answers 500 instead of handing back the entry to commit).
 *
 * `GUIDE` is already in the form `sanitizeGuide` produces — every KPI entry carries its `kpiIndex`,
 * and the URLs are the normalized hrefs `safeExternalUrl` returns. What that buys is a round trip
 * asserted with `toEqual`: any difference is the store having changed the guide, not sanitizing doing
 * its job. The sanitizing itself is `campaignGuide.test.ts`'s subject.
 */

const CHAIN = 84532;
const CAMPAIGN = "0xAbC0000000000000000000000000000000000001";
const OTHER = "0xAbC0000000000000000000000000000000000002";
const GUIDE: CampaignGuide = {
  summary: "Bridge to Base and hold the position for a week.",
  siteUrl: "https://example.org/",
  kpis: [{action: "Bridge at least 0.01 ETH", kpiIndex: 0, url: "https://example.org/bridge"}],
};

const originalEnv = {
  BONEY_GUIDE_STORE: process.env.BONEY_GUIDE_STORE,
  NETLIFY: process.env.NETLIFY,
};

let dir: string;
let storeFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "boney-guide-store-"));
  storeFile = join(dir, "campaign-guides.json");
  process.env.BONEY_GUIDE_STORE = storeFile;
  delete process.env.NETLIFY;
});

afterEach(() => {
  rmSync(dir, {recursive: true, force: true});
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("the file backend", () => {
  it("reads back what it wrote", async () => {
    expect(await writeGuide(CHAIN, CAMPAIGN, GUIDE)).toBe(true);
    expect(await readGuide(CHAIN, CAMPAIGN)).toEqual(GUIDE);
  });

  it("keys on the address in any hex case", async () => {
    await writeGuide(CHAIN, CAMPAIGN.toLowerCase(), GUIDE);
    expect(await readGuide(CHAIN, CAMPAIGN.toUpperCase().replace("0X", "0x"))).toEqual(GUIDE);
  });

  it("answers null for a campaign with nothing stored", async () => {
    expect(await readGuide(CHAIN, CAMPAIGN)).toBeNull();
  });

  it("keeps one chain's guides out of another's", async () => {
    await writeGuide(CHAIN, CAMPAIGN, GUIDE);
    expect(await readGuide(1, CAMPAIGN)).toBeNull();
  });

  it("leaves other campaigns in place when one is written", async () => {
    await writeGuide(CHAIN, CAMPAIGN, GUIDE);
    await writeGuide(CHAIN, OTHER, {summary: "Something else entirely."});
    expect(await readGuide(CHAIN, CAMPAIGN)).toEqual(GUIDE);
    expect((await readGuide(CHAIN, OTHER))?.summary).toBe("Something else entirely.");
  });

  it("deletes the entry when every field is emptied", async () => {
    await writeGuide(CHAIN, CAMPAIGN, GUIDE);
    expect(await writeGuide(CHAIN, CAMPAIGN, {summary: "   "})).toBe(true);
    expect(await readGuide(CHAIN, CAMPAIGN)).toBeNull();
  });

  it("reads a corrupt store as empty rather than throwing", async () => {
    writeFileSync(storeFile, "{not json", "utf8");
    expect(await readGuide(CHAIN, CAMPAIGN)).toBeNull();
  });

  it("reads a store that is not an object as empty", async () => {
    writeFileSync(storeFile, "[]", "utf8");
    expect(await readGuide(CHAIN, CAMPAIGN)).toBeNull();
  });

  it("writes into a store that has never been created", async () => {
    // The absent store is the one unreadable-looking state a write must still proceed from —
    // otherwise the first guide on a fresh deploy could never be stored.
    expect(await writeGuide(CHAIN, CAMPAIGN, GUIDE)).toBe(true);
    expect(await readGuide(CHAIN, CAMPAIGN)).toEqual(GUIDE);
  });

  /**
   * `writeGuide` writes the whole store back, so a read it could not complete must stop the write
   * rather than merge into `{}`. Getting this wrong loses every other guide and reports success —
   * the failure the store's single key makes total.
   */
  it("refuses to write over a store it could not read", async () => {
    await writeGuide(CHAIN, CAMPAIGN, GUIDE);
    const before = readFileSync(storeFile, "utf8");

    writeFileSync(storeFile, "{not json", "utf8");
    expect(await writeGuide(CHAIN, OTHER, {summary: "Should not land."})).toBe(false);

    writeFileSync(storeFile, before, "utf8");
    expect(await readGuide(CHAIN, CAMPAIGN)).toEqual(GUIDE);
  });

  it("reports false rather than throwing when the path cannot be written", async () => {
    // A regular file where a directory would have to be: `mkdirSync` fails ENOTDIR, which is the
    // portable way to make the write fail without depending on permissions.
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "not a directory", "utf8");
    process.env.BONEY_GUIDE_STORE = join(blocker, "campaign-guides.json");

    expect(await writeGuide(CHAIN, CAMPAIGN, GUIDE)).toBe(false);
  });
});

describe("backend selection", () => {
  it("keeps using the file when NETLIFY is set but a store path is named", async () => {
    process.env.NETLIFY = "true";
    expect(await writeGuide(CHAIN, CAMPAIGN, GUIDE)).toBe(true);
    expect(await readGuide(CHAIN, CAMPAIGN)).toEqual(GUIDE);
  });

  it("reports unwritable rather than throwing when Blobs has no credentials", async () => {
    process.env.NETLIFY = "true";
    delete process.env.BONEY_GUIDE_STORE;
    expect(await readGuide(CHAIN, CAMPAIGN)).toBeNull();
    expect(await writeGuide(CHAIN, CAMPAIGN, GUIDE)).toBe(false);
  });
});
