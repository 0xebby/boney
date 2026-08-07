/**
 * Drives the event-source probe through the real create form, on Base Sepolia.
 *
 * What this proves that a unit test cannot: the probe's findings actually reach the DOM. The stub
 * tests in `kpiSource.test.ts` prove `probeEventSource` classifies a fake client's answers
 * correctly; they say nothing about whether `useEventSourceProbe` is wired to the form, whether the
 * debounce lets the query fire at all, or whether the findings render. A hook that resolves
 * correctly and renders nothing looks identical in a passing test suite.
 *
 * Base Sepolia rather than anvil because two of the four cases need a *live* contract: WETH at
 * `0x4200…0006` is deployed and actively emitting, which is the only way to reach the green
 * confirmation path.
 *
 * Cases driven:
 *   1. WETH + Deposit(address,uint256)  -> ok    (deployed, emitting)
 *   2. WETH + Transfer(address,uint256) -> warn  (deployed, wrong signature, no logs)
 *   3. EOA address                      -> error (no code)
 *   4. zero address                     -> error (preset placeholder left unfilled)
 *
 * Usage: node scripts/drive-event-probe.mjs
 * Requires `pnpm dev` on :3000. No wallet writes -- the probe is read-only -- but the form is gated
 * behind `isConnected`, so a provider still has to be injected.
 *
 * On WSL2 / minimal Linux, Playwright's chromium may need system libs in a local prefix:
 *   LD_LIBRARY_PATH=/tmp/pwlibs/extracted/usr/lib/x86_64-linux-gnu node scripts/drive-event-probe.mjs
 */
import {chromium} from "playwright";
import {createPublicClient, http, keccak256, toHex} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {baseSepolia} from "viem/chains";
import {mkdirSync, readFileSync} from "node:fs";

const RPC = process.env.BASE_SEPOLIA_RPC ?? "https://sepolia.base.org";
const WETH = "0x4200000000000000000000000000000000000006";
const ZERO = "0x0000000000000000000000000000000000000000";

/** An address with a balance but no code -- the "looks valid, emits nothing" case. */
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

// Read-only provider: the probe never signs, but `CreateCampaignPage` returns an
// "Connect a wallet" card unless wagmi reports a connection, so the form would never mount.
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

// The event-source fields are collapsed until the toggle is on -- most KPIs have no source, so
// showing five inputs by default would imply they are required.
const toggle = page.getByLabel(/Credit progress from on-chain events/i).first();
await toggle.waitFor({timeout: 30_000});
check("create form mounted with the event-source toggle", true);

await toggle.check();
await page.waitForTimeout(500);

const sourceField = page.getByLabel("Source contract").first();
const signatureField = page.getByLabel("Event signature").first();
check("toggle reveals the source fields", await sourceField.isVisible());

/**
 * Types a source/signature pair and waits for the probe to settle.
 *
 * The hook debounces and then makes two round trips to a public RPC, so this polls for a rendered
 * finding rather than sleeping a fixed interval -- a fixed sleep would either be flaky on a slow
 * endpoint or waste seconds on a fast one.
 */
async function probe(source, signature, {expect, matching}) {
  // Set values via evaluate so the hook fires once, not once per keystroke. fill() types character
  // by character, which resets the 600ms debounce on every pulse and stacks round trips behind a
  // public RPC that is already rate-limited.
  await sourceField.evaluate((el, val) => {
    const input = el as HTMLInputElement;
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, "value"
    )!.set!;
    nativeInputValueSetter.call(input, val);
    input.dispatchEvent(new Event("input", {bubbles: true}));
    input.dispatchEvent(new Event("change", {bubbles: true}));
  }, source);
  await signatureField.evaluate((el, val) => {
    const input = el as HTMLInputElement;
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, "value"
    )!.set!;
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

// 1. Live contract, live event -- the only case that can reach the green path.
await probe(WETH, "Deposit(address,uint256)", {
  expect: "ok",
  matching: /emitting Deposit\(address,uint256\)/i,
});

// 2. Live contract, signature it does not emit. Cannot be distinguished from "idle contract",
//    which is why this is a warning and not an error.
await probe(WETH, "Transfer(address,uint256)", {
  expect: "warn",
  matching: /no Transfer\(address,uint256\) in the last|idle/i,
});

// 3. A correctly-checksummed address holding no code. This is the failure the form could not
//    catch before the probe existed.
await probe(EOA, "Deposit(address,uint256)", {
  expect: "error",
  matching: /no contract deployed/i,
});

// 4. The ERC-721 preset ships this deliberately; a project that skips the address field would
//    otherwise deploy a KPI that credits nothing.
await probe(ZERO, "Transfer(address,address,uint256)", {
  expect: "error",
  matching: /zero address/i,
});

await page.screenshot({path: "screenshots/event-probe.png", fullPage: true});

// The probe is advisory: an error finding must not disable submission, because it reads the
// *connected* chain and a campaign may legitimately name a contract deployed moments later.
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
