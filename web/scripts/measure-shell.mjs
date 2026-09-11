// Measures the app shell's header with a connected promoter wallet and captures the strips that
// prove it: nav rows and header height at desktop/tablet widths, horizontal overflow at phone
// widths, plus the wallet menu and the nav drawer.
//
// The header is the one piece of chrome every page carries, and its failure mode is silent — it
// wraps to a second and third row as the nav list grows with the wallet's role, which no unit test
// sees. So it gets measured rather than eyeballed.
//
// Usage: node scripts/measure-shell.mjs [before|after] [baseUrl]
import {chromium} from "../node_modules/playwright/index.mjs";
import {mkdirSync} from "node:fs";

const phase = process.argv[2] ?? "after";
const base = process.argv[3] ?? "http://localhost:3005";
const OUT = new URL("../screenshots/", import.meta.url).pathname;
mkdirSync(OUT, {recursive: true});

// The one promoter on Base Sepolia: it has joined three campaigns and owns every seeded one, so it
// is the wallet that sees the longest nav list.
const ADDR = "0xba954e89ce301415964e9405f09f4cc7c668976a";
const ROW_WIDTHS = [640, 768, 1024, 1280, 1440];
const PHONE_WIDTHS = [320, 360, 375, 390, 414];

const browser = await chromium.launch({channel: "chrome", args: ["--no-sandbox"]});
const ctx = await browser.newContext({
  viewport: {width: 1440, height: 900},
  colorScheme: "dark",
  reducedMotion: "reduce",
  deviceScaleFactor: 2,
});

// The welcome modal covers the header on a first visit, and it is not what this measures.
await ctx.addInitScript(() => {
  try {
    window.localStorage.setItem("boney:welcome-seen", "1");
  } catch {}
});

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

const page = await ctx.newPage();
await page.goto(`${base}/discover`, {waitUntil: "networkidle", timeout: 90_000});

// Connect at desktop width, where the button is always on the row, then resize.
const connect = page.getByRole("button", {name: /^connect( wallet)?$/i});
for (let i = 0; i < 8; i++) {
  if (!(await connect.first().isVisible().catch(() => false))) break;
  await connect.first().click({timeout: 5_000}).catch(() => {});
  await page.waitForTimeout(800);
}
// The nav list grows once `useIsPromoter` resolves, so measuring before it settles measures the
// short list.
await page.waitForTimeout(3_000);

console.log(`\n${phase}: nav rows and header height (promoter wallet connected)`);
console.log("| width | nav items | nav rows | header height |");
console.log("| --- | --- | --- | --- |");
for (const width of ROW_WIDTHS) {
  await page.setViewportSize({width, height: 800});
  await page.waitForTimeout(400);
  const m = await page.evaluate(() => {
    const header = document.querySelector("header");
    const nav = header.querySelector("nav");
    // A `display: none` nav reports every link at top 0, which would read as one tidy row. Count
    // the links that are actually laid out.
    const links = nav
      ? [...nav.querySelectorAll("a")].filter((a) => a.getBoundingClientRect().height > 0)
      : [];
    const tops = links.map((a) => Math.round(a.getBoundingClientRect().top));
    return {
      headerH: Math.round(header.getBoundingClientRect().height),
      rows: new Set(tops).size,
      items: tops.length,
    };
  });
  console.log(
    `| ${width}px | ${m.items === 0 ? "drawer" : m.items} | ${m.items === 0 ? "—" : m.rows} | ${m.headerH}px |`,
  );
  if (width === 640 || width === 1440) {
    await page.screenshot({
      path: `${OUT}shell-${phase}-${width}.png`,
      clip: {x: 0, y: 0, width, height: 120},
    });
  }
}

console.log(`\n${phase}: phone row overflow (scrollWidth - innerWidth)`);
console.log("| width | overflow | wallet chip truncated | create label |");
console.log("| --- | --- | --- | --- |");
for (const width of PHONE_WIDTHS) {
  await page.setViewportSize({width, height: 800});
  await page.waitForTimeout(300);
  const m = await page.evaluate(() => {
    // The chip is a flex row, so the label inside it is what ellipses, not the button.
    const chip = document.querySelector("header button[title]");
    const label = chip?.querySelector(".truncate") ?? chip;
    const create = document.querySelector('header a[href="/create"]');
    return {
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      truncated: label ? label.scrollWidth > label.clientWidth : null,
      createLabel: create?.innerText.replace(/\s+/g, " ").trim() ?? null,
    };
  });
  console.log(`| ${width}px | ${m.overflow}px | ${m.truncated} | ${m.createLabel} |`);
}

// The drawer, which below `md` is the only way to every destination.
await page.setViewportSize({width: 390, height: 800});
await page.waitForTimeout(400);
await page.getByRole("button", {name: "Open navigation"}).click();
await page.waitForTimeout(500);
await page.screenshot({path: `${OUT}shell-drawer-390.png`});
await page.keyboard.press("Escape");
await page.waitForTimeout(300);

// The wallet menu, which only exists after this PR.
await page.setViewportSize({width: 1440, height: 900});
await page.waitForTimeout(400);
const chip = page.locator('header button[aria-haspopup="menu"]');
if (await chip.first().isVisible().catch(() => false)) {
  await chip.first().click();
  await page.waitForTimeout(400);
  await page.screenshot({path: `${OUT}shell-menu-1440.png`, clip: {x: 0, y: 0, width: 1440, height: 340}});
  const items = await page.evaluate(() => {
    const menu = document.querySelector('[role="menu"]');
    return menu ? [...menu.children].map((el) => el.innerText.replace(/\s+/g, " ").trim()) : null;
  });
  console.log(`\n${phase}: wallet menu items`, items);
} else {
  console.log(`\n${phase}: no wallet menu on the chip`);
}

await browser.close();
