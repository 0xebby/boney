/**
 * Drives the campaign filters and sorting to prove the interactive layer works.
 *
 * A static screenshot only proves the first paint. This clicks through the controls a user
 * would actually use and asserts the table responds — the filters are pure functions that are
 * unit-tested, but nothing except a real browser proves they are wired to the UI.
 */
import {chromium} from "playwright";
import {mkdirSync} from "node:fs";

const url = process.argv[2] ?? "http://localhost:3000";
mkdirSync("screenshots", {recursive: true});

const browser = await chromium.launch({args: ["--no-sandbox"]});
const page = await browser.newPage({viewport: {width: 1440, height: 900}});

const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

const rows = () => page.locator('a[href^="/campaign/"]');

// Read the id from the href rather than the cell text: the cell renders id and address
// adjacently ("#00x61c3…33e1"), so any text parse has to disambiguate the "0" of "0x".
const firstId = async () => {
  const href = await rows().first().getAttribute("href");
  return `#${href.split("/").pop()}`;
};
const check = (label, actual, expected) => {
  const ok = actual === expected;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}: ${actual}${ok ? "" : ` (expected ${expected})`}`);
  if (!ok) process.exitCode = 1;
};

await page.goto(url, {waitUntil: "domcontentloaded", timeout: 60_000});
await rows().first().waitFor({timeout: 45_000});

console.log("interaction checks:");
check("all campaigns shown", await rows().count(), 4);

// ── status filter ────────────────────────────────────────────
await page.getByRole("button", {name: "Active", exact: true}).click();
await page.waitForTimeout(300);
check("Active filter", await rows().count(), 2);

await page.getByRole("button", {name: "Ended", exact: true}).click();
await page.waitForTimeout(300);
check("Ended filter", await rows().count(), 1);

await page.getByRole("button", {name: "All", exact: true}).click();
await page.waitForTimeout(300);
check("back to All", await rows().count(), 4);

// ── search: numeric query is id-only ────────────────────────
const search = page.locator("#campaign-search");
await search.fill("2");
await page.waitForTimeout(300);
check("search '2' matches one id", await rows().count(), 1);
check("search '2' matched campaign #2", await firstId(), "#2");

await search.fill("");
await page.waitForTimeout(300);

// ── sorting ──────────────────────────────────────────────────
// Default sort is reward pool descending, so the 50K campaign leads.
check("default sort puts largest pool first", await firstId(), "#0");

await page.getByRole("button", {name: /Reward pool/}).click();
await page.waitForTimeout(300);
check("ascending sort puts smallest pool first", await firstId(), "#3");

await page.screenshot({path: "screenshots/campaigns-sorted-asc.png", fullPage: true});

// ── aria-sort is announced, not just visual ─────────────────
const ariaSort = await page
  .locator("th", {has: page.getByRole("button", {name: /Reward pool/})})
  .getAttribute("aria-sort");
check("aria-sort announced", ariaSort, "ascending");

if (errors.length) {
  console.log("\npage errors:");
  for (const e of errors) console.log(`  ${e}`);
  process.exitCode = 1;
}

await browser.close();
console.log(process.exitCode ? "\nFAILED" : "\nall interaction checks passed");
