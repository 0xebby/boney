/**
 * Drives event-source probe findings through the Base Sepolia create form.
 *
 * Usage: node scripts/drive-event-probe.mjs
 * Requires the app on :3000 and an injected read-only wallet to mount the form.
 */
import {chromium} from "playwright";
import {createPublicClient, http, keccak256, toHex} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {baseSepolia} from "viem/chains";
import {mkdirSync, readFileSync} from "node:fs";

const RPC = process.env.BASE_SEPOLIA_RPC ?? "https://base-sepolia-rpc.publicnode.com";
const WETH = "0x4200000000000000000000000000000000000006";
const ZERO = "0x0000000000000000000000000000000000000000";

/** Address with a balance and no deployed code. */
const EOA = "0x489CA0f9df3d91AB3A1605c9f9729460ca7e319D";

const rootPk = readFileSync(new URL("../../.env", import.meta.url), "utf8")
  .split("\n")
  .find((l) => /^\s*PRIVATE_KEY\s*=/.test(l))
  .split("=")
  .slice(1)
  .join("=")
  .trim();

const account = privateKeyToAccount(keccak256(toHex(`${rootPk}:boney-probe-driver`)));
const publicClient = createPublicClient({chain: baseSepolia, transport: http(RPC)});

mkdirSync("screenshots", {recursive: true});

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `: ${detail}` : ""}`);
  if (!ok) failures++;
};

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH,
  args: ["--no-sandbox"],
});
const page = await browser.newPage({viewport: {width: 1440, height: 1600}});
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

// The read-only provider mounts the connected create form.
await page.exposeFunction("__walletRequest", async ({method, params = []}) => {
  switch (method) {
    case "eth_requestAccounts":
    case "eth_accounts":
      return [account.address];
    case "eth_chainId":
      return `0x${baseSepolia.id.toString(16)}`;
    case "net_version":
      return String(baseSepolia.id);
    case "wallet_switchEthereumChain":
      return null;
    default:
      return publicClient.request({method, params});
  }
});

await page.addInitScript(() => {
  const l = new Map();
  window.ethereum = {
    isMetaMask: true,
    request: (a) => window.__walletRequest(a),
    on: (e, h) => l.set(e, [...(l.get(e) ?? []), h]),
    removeListener: (e, h) => l.set(e, (l.get(e) ?? []).filter((x) => x !== h)),
  };
});

await page.goto("http://localhost:3000/create", {
  waitUntil: "domcontentloaded",
  timeout: 60_000,
});

await page.getByRole("button", {name: /Connect wallet/i}).click().catch(() => {});
await page.waitForTimeout(2_500);

// Event-source fields remain collapsed until enabled.
const toggle = page.getByLabel(/Credit progress from on-chain events/i).first();
await toggle.waitFor({timeout: 30_000});
check("create form mounted with the event-source toggle", true);

await toggle.check();
await page.waitForTimeout(500);

const sourceField = page.getByLabel("Source contract").first();
const signatureField = page.getByLabel("Event signature").first();
check("toggle reveals the source fields", await sourceField.isVisible());

/**
 * Runs one source/signature probe case.
 * @param {string} source Source contract address.
 * @param {string} signature Event signature.
 * @param {{expect: string, matching: RegExp}} expected Expected result.
 * @returns {Promise<void>}
 */
async function probe(source, signature, {expect, matching}) {
  // Dispatch one input event per field update.
  await sourceField.evaluate((el, val) => {
    const input = el;
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    ).set;
    nativeInputValueSetter.call(input, val);
    input.dispatchEvent(new Event("input", {bubbles: true}));
    input.dispatchEvent(new Event("change", {bubbles: true}));
  }, source);
  await signatureField.evaluate((el, val) => {
    const input = el;
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    ).set;
    nativeInputValueSetter.call(input, val);
    input.dispatchEvent(new Event("input", {bubbles: true}));
    input.dispatchEvent(new Event("change", {bubbles: true}));
  }, signature);

  const badge = page.locator(`[data-probe-severity="${expect}"]`).first();
  try {
    await badge.waitFor({timeout: 45_000});
  } catch {
    const body = await page.locator("body").innerText();
    check(
      `${expect}: ${source.slice(0, 10)}… ${signature || "(no signature)"}`,
      false,
      `no ${expect} badge appeared`,
    );
    console.log(`    page text: ${body.replace(/\s+/g, " ").slice(0, 300)}`);
    return;
  }

  const text = await badge.innerText();
  const ok = matching.test(text);
  check(`${expect}: ${source.slice(0, 10)}… ${signature || "(no signature)"}`, ok, text.trim());
}

console.log("\nprobe cases:");

// Live contract and event.
await probe(WETH, "Deposit(address,uint256)", {
  expect: "ok",
  matching: /emitting Deposit\(address,uint256\)/i,
});

// Live contract without the requested event.
await probe(WETH, "Transfer(address,uint256)", {
  expect: "warn",
  matching: /no Transfer\(address,uint256\) in the last|idle/i,
});

// Address without deployed code.
await probe(EOA, "Deposit(address,uint256)", {
  expect: "error",
  matching: /no contract deployed/i,
});

// Zero-address preset.
await probe(ZERO, "Transfer(address,address,uint256)", {
  expect: "error",
  matching: /zero address/i,
});

await page.screenshot({path: "screenshots/event-probe.png", fullPage: true});

// Probe findings do not block submission.
const submit = page.getByRole("button", {name: /Create Campaign/i}).first();
if (await submit.count()) {
  check("an error finding does not disable submit", !(await submit.isDisabled()));
}

if (pageErrors.length) {
  console.log("\n--- page errors ---");
  for (const e of pageErrors) console.log(`  ${e}`);
  failures += pageErrors.length;
}

await browser.close();
console.log(
  failures === 0 ? "\nOK: probe verified in the real form" : `\nFAIL: ${failures} problem(s)`,
);
process.exitCode = failures === 0 ? 0 : 1;
