/**
 * Drives the campaign *detail* page in a headless browser.
 *
 * The read layer is proven by `live.test.ts`, and the build proves the page compiles. Neither
 * answers the question this asks: does the detail page actually paint chain data, or does it
 * render a shell while every read fails? A client-only render failure is invisible to both.
 *
 * Usage: node scripts/screenshot-detail.mjs [campaignId] [outfile]
 *
 * Set `CHROME_PATH` when Playwright's bundled `headless_shell` cannot start. On this WSL box the
 * shell build is missing `libnspr4.so` while the full chromium build ships its own copies, so
 * point CHROME_PATH at `chrome-linux64/chrome` under the `chromium-<rev>` cache directory.
 */
import {chromium} from "playwright";
import {mkdirSync} from "node:fs";

const id = process.argv[2] ?? "1";
const out = process.argv[3] ?? `screenshots/campaign-${id}.png`;
const url = `http://localhost:3000/campaign/${id}`;

mkdirSync("screenshots", {recursive: true});

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH,
  args: ["--no-sandbox"],
});
const page = await browser.newPage({viewport: {width: 1440, height: 1200}});

const consoleErrors = [];
const pageErrors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text());
});
page.on("pageerror", (err) => pageErrors.push(err.message));

console.log(`→ ${url}`);
await page.goto(url, {waitUntil: "domcontentloaded", timeout: 60_000});

// Race the real outcomes against each other: whichever paints tells us what happened, instead
// of a bare timeout that cannot distinguish "slow" from "broken".
const outcome = await Promise.race([
  page.getByRole("heading", {name: /^KPIs/}).waitFor({timeout: 45_000}).then(() => "loaded"),
  page.getByText("not found").first().waitFor({timeout: 45_000}).then(() => "not-found"),
  page.getByText("Protocol not deployed").waitFor({timeout: 45_000}).then(() => "not-deployed"),
  page.getByText("Something went wrong").waitFor({timeout: 45_000}).then(() => "error"),
]).catch(() => "timeout");

console.log(`outcome: ${outcome}`);

await page.waitForTimeout(1_500);
await page.screenshot({path: out, fullPage: true});
console.log(`screenshot: ${out}`);

// Structural assertions — the image alone cannot prove the numbers came from the chain.
const meters = await page.locator('[role="meter"]').count();
const ladderRows = await page.locator("table tbody tr").count();
const statTiles = await page.locator("text=Reward pool").count();

console.log(`\nmeters: ${meters}`);
console.log(`ladder rows: ${ladderRows}`);
console.log(`reward-pool tile: ${statTiles}`);

const lines = await page.evaluate(() =>
  document.body.innerText.split("\n").filter((l) => l.trim()).slice(0, 55),
);
console.log("--- visible text (first 55 lines) ---");
for (const l of lines) console.log(`  ${l}`);

if (pageErrors.length) {
  console.log("\n--- page errors ---");
  for (const e of pageErrors) console.log(`  ${e}`);
}
if (consoleErrors.length) {
  console.log("\n--- console errors ---");
  for (const e of consoleErrors.slice(0, 10)) console.log(`  ${e}`);
}

await browser.close();

// A campaign with KPIs must paint at least one ladder row and one meter. Anything less means
// the panels rendered empty, which a screenshot could easily hide.
const painted = outcome === "loaded" && ladderRows > 0 && meters > 0;
if (!painted || pageErrors.length > 0) {
  console.log("\nFAIL: detail page did not paint chain data");
  process.exitCode = 1;
} else {
  console.log("\nOK: detail page painted chain data");
}
