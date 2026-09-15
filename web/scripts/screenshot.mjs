/**
 * Captures the campaign list and reports its rendered state.
 *
 * Usage: node scripts/screenshot.mjs [url] [outfile]
 * Set `CHROME_PATH` when Playwright's bundled browser is unavailable.
 */
import {chromium} from "playwright";
import {mkdirSync} from "node:fs";

const url = process.argv[2] ?? "http://localhost:3000";
const out = process.argv[3] ?? "screenshots/campaigns.png";

mkdirSync("screenshots", {recursive: true});

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH,
  args: ["--no-sandbox"],
});
const page = await browser.newPage({viewport: {width: 1440, height: 900}});

// Capture browser errors.
const consoleErrors = [];
const pageErrors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text());
});
page.on("pageerror", (err) => pageErrors.push(err.message));

console.log(`→ ${url}`);
await page.goto(url, {waitUntil: "domcontentloaded", timeout: 60_000});

// Wait for a rendered data outcome.
const outcome = await Promise.race([
  page
    .locator('a[href^="/campaign/"]')
    .first()
    .waitFor({timeout: 45_000})
    .then(() => "rows"),
  page
    .getByText("No campaigns yet")
    .waitFor({timeout: 45_000})
    .then(() => "empty"),
  page
    .getByText("Protocol not deployed")
    .waitFor({timeout: 45_000})
    .then(() => "not-deployed"),
]).catch(() => "timeout");

console.log(`outcome: ${outcome}`);

// Allow meters and formatted values to settle.
await page.waitForTimeout(1_500);
await page.screenshot({path: out, fullPage: true});
console.log(`screenshot: ${out}`);

const rowCount = await page.locator('a[href^="/campaign/"]').count();
const tiles = await page
  .locator("main, body")
  .first()
  .evaluate(() => {
    const text = document.body.innerText;
    return text.split("\n").filter((l) => l.trim()).slice(0, 40);
  });

console.log(`\ncampaign rows: ${rowCount}`);
console.log("--- visible text (first 40 lines) ---");
for (const line of tiles) console.log(`  ${line}`);

if (pageErrors.length) {
  console.log("\n--- page errors ---");
  for (const e of pageErrors) console.log(`  ${e}`);
}
if (consoleErrors.length) {
  console.log("\n--- console errors ---");
  for (const e of consoleErrors.slice(0, 10)) console.log(`  ${e}`);
}

await browser.close();

// Missing or broken data is a failure.
if (outcome === "timeout" || outcome === "not-deployed" || pageErrors.length > 0) {
  process.exitCode = 1;
}
