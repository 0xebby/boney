// Before/after evidence for the home page: full-page shots at 1440 and 390, the two states that
// only appear on a click (the promote menu and the filters popover), and the numbers the redesign
// is judged on — page height, where the first table row starts, and how tall a row is.
//
// The sticky header is pinned to `static` before a full-page shot, otherwise the capture stamps it
// across the middle of the image where the scroll happened to be.
//
// Usage: node scripts/shoot-home.mjs [before|after] [baseUrl]
import {chromium} from "../node_modules/playwright/index.mjs";
import {mkdirSync} from "node:fs";

const phase = process.argv[2] ?? "after";
const base = process.argv[3] ?? "http://localhost:3005";
const OUT = new URL("../screenshots/", import.meta.url).pathname;
mkdirSync(OUT, {recursive: true});

// The one promoter on Base Sepolia: it can open the promote menu on campaigns it has not joined.
const ADDR = "0xba954e89ce301415964e9405f09f4cc7c668976a";

const browser = await chromium.launch({channel: "chrome", args: ["--no-sandbox"]});

/**
 * A context for one shot.
 *
 * @param width Viewport width.
 * @param connected Whether to inject the read-only wallet.
 * @param welcomeSeen Whether to pre-dismiss the welcome modal. Only the `before` phase has one —
 *   after this PR there is no modal and the key is dead.
 */
async function makeContext({width, connected = false, welcomeSeen = phase === "before"}) {
  const ctx = await browser.newContext({
    viewport: {width, height: 900},
    colorScheme: "dark",
    reducedMotion: "reduce",
  });

  if (welcomeSeen) {
    await ctx.addInitScript(() => {
      try {
        window.localStorage.setItem("boney:welcome-seen", "1");
      } catch {}
    });
  }

  if (!connected) return ctx;

  // An injected wallet that can read and refuses to sign: enough to reach every connected state
  // without a key anywhere near the browser.
  await ctx.exposeFunction("__walletRequest", async ({method}) => {
    switch (method) {
      case "eth_requestAccounts":
      case "eth_accounts":
        return [ADDR];
      case "eth_chainId":
        return "0x14a34";
      case "net_version":
        return "84532";
      case "wallet_switchEthereumChain":
        return null;
      default:
        throw new Error(`unsupported ${method}`);
    }
  });
  await ctx.addInitScript(() => {
    const listeners = new Map();
    window.ethereum = {
      isMetaMask: true,
      request: (args) => window.__walletRequest(args),
      on: (event, handler) => listeners.set(event, [...(listeners.get(event) ?? []), handler]),
      removeListener: (event, handler) =>
        listeners.set(event, (listeners.get(event) ?? []).filter((x) => x !== handler)),
    };
  });
  return ctx;
}

/** Loads the home page and waits for the campaign reads to land. */
async function load(ctx) {
  const page = await ctx.newPage();
  await page.goto(base, {waitUntil: "domcontentloaded", timeout: 90_000});
  await page.waitForLoadState("networkidle", {timeout: 60_000}).catch(() => {});
  await page.waitForTimeout(1_500);
  return page;
}

/** Clicks Connect until the header stops offering it. */
async function connect(page) {
  const button = page.getByRole("button", {name: /^connect( wallet)?$/i});
  for (let i = 0; i < 8; i++) {
    if (!(await button.first().isVisible().catch(() => false))) break;
    await button.first().click({timeout: 5_000}).catch(() => {});
    await page.waitForTimeout(800);
  }
  await page.waitForLoadState("networkidle", {timeout: 60_000}).catch(() => {});
  await page.waitForTimeout(2_500);
}

/** Page height, where the first row starts, how tall it is, and horizontal overflow. */
async function measure(page) {
  return page.evaluate(() => {
    const row = document.querySelector("tbody tr");
    const box = row?.getBoundingClientRect();
    return {
      height: document.documentElement.scrollHeight,
      rowTop: box ? Math.round(box.top + window.scrollY) : null,
      rowHeight: box ? Math.round(box.height) : null,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
}

/** A full-page shot with the header unpinned, plus the measurements for that width. */
async function full({width, name}) {
  const ctx = await makeContext({width});
  const page = await load(ctx);

  await page.evaluate(() => window.scrollTo(0, 0));
  const numbers = await measure(page);

  await page.addStyleTag({content: "header{position:static!important}"}).catch(() => {});
  const file = `${OUT}${name}.png`;
  await page.screenshot({path: file, fullPage: true});
  console.log(
    `${file} — ${numbers.height}px tall, first row at ${numbers.rowTop}px, ` +
      `row ${numbers.rowHeight}px, overflow ${numbers.overflow}px`,
  );
  await ctx.close();
}

/** The first-visit modal, which only a context with nothing in storage sees. */
async function welcome() {
  const ctx = await makeContext({width: 1440, welcomeSeen: false});
  const page = await load(ctx);
  await page.waitForTimeout(1_500);
  const file = `${OUT}home-before-welcome-1440.png`;
  await page.screenshot({path: file});
  console.log(file);
  await ctx.close();
}

/** The promote menu open, with a wallet that can actually join something. */
async function menu() {
  const ctx = await makeContext({width: 1440, connected: true});
  const page = await load(ctx);
  await connect(page);

  await page.getByRole("button", {name: /promote a campaign/i}).first().click({timeout: 10_000});
  await page.waitForTimeout(600);

  const file = `${OUT}home-after-menu-1440.png`;
  await page.screenshot({path: file});
  console.log(file);
  await ctx.close();
}

/** The filters popover open, framed on the table header it hangs off. */
async function filters() {
  const ctx = await makeContext({width: 1440});
  const page = await load(ctx);

  const trigger = page.getByRole("button", {name: /^filters$/i});
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click({timeout: 10_000});
  await page.waitForTimeout(400);

  const header = await trigger.boundingBox();
  const file = `${OUT}home-after-filters-1440.png`;
  await page.screenshot({
    path: file,
    clip: header
      ? {x: 0, y: Math.max(0, header.y - 80), width: 1440, height: 560}
      : undefined,
  });
  console.log(file);
  await ctx.close();
}

await full({width: 1440, name: `home-${phase}-1440`});
await full({width: 390, name: `home-${phase}-390`});

if (phase === "before") {
  await welcome();
} else {
  await menu();
  await filters();
}

await browser.close();
