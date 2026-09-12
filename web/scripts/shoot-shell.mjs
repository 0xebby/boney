// Full-page shots of the two routes the shell's label register shows up on: the home page with no
// wallet, and a campaign page read by the promoter wallet that owns it.
//
// The sticky header is pinned to `static` before the shot, otherwise a full-page capture stamps it
// across the middle of the image where the scroll happened to be.
//
// Usage: node scripts/shoot-shell.mjs [before|after] [baseUrl]
import {chromium} from "../node_modules/playwright/index.mjs";
import {mkdirSync} from "node:fs";

const phase = process.argv[2] ?? "after";
const base = process.argv[3] ?? "http://localhost:3005";
const OUT = new URL("../screenshots/", import.meta.url).pathname;
mkdirSync(OUT, {recursive: true});

const ADDR = "0xba954e89ce301415964e9405f09f4cc7c668976a";

const browser = await chromium.launch({channel: "chrome", args: ["--no-sandbox"]});

async function makeContext({connected}) {
  const ctx = await browser.newContext({
    viewport: {width: 1440, height: 900},
    colorScheme: "dark",
    reducedMotion: "reduce",
  });
  await ctx.addInitScript(() => {
    try {
      window.localStorage.setItem("boney:welcome-seen", "1");
    } catch {}
  });
  if (!connected) return ctx;

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

async function shoot({name, path, connected}) {
  const ctx = await makeContext({connected});
  const page = await ctx.newPage();
  await page.goto(`${base}${path}`, {waitUntil: "domcontentloaded", timeout: 90_000});
  await page.waitForLoadState("networkidle", {timeout: 60_000}).catch(() => {});
  await page.waitForTimeout(1_500);

  if (connected) {
    const connect = page.getByRole("button", {name: /^connect( wallet)?$/i});
    for (let i = 0; i < 8; i++) {
      if (!(await connect.first().isVisible().catch(() => false))) break;
      await connect.first().click({timeout: 5_000}).catch(() => {});
      await page.waitForTimeout(800);
    }
    await page.waitForLoadState("networkidle", {timeout: 60_000}).catch(() => {});
    await page.waitForTimeout(2_500);
  }

  await page.addStyleTag({content: "header{position:static!important}"}).catch(() => {});
  const file = `${OUT}${name}-${phase}-1440.png`;
  await page.screenshot({path: file, fullPage: true});
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  console.log(`${file} (${height}px tall)`);
  await ctx.close();
}

await shoot({name: "home-labels", path: "/", connected: false});
await shoot({name: "campaign-labels", path: "/campaign/3", connected: true});

await browser.close();
