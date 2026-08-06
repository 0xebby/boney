/**
 * Drives the project write path — fund and activate — through the real UI.
 *
 * Why this exists: `live.test.ts` proves the *read* layer against a real chain, and the unit
 * tests prove the encoder and the lifecycle guards in isolation. Neither touches the part of
 * phase 6 most likely to be wrong: whether the panel's buttons are actually wired to a wallet,
 * whether `simulateContract` is given arguments the chain accepts, and whether the two-step
 * approve→fund sequence completes. A component that renders perfectly and sends nothing looks
 * identical in a screenshot.
 *
 * Headless chromium has no wallet extension, so this injects a minimal EIP-1193 provider on
 * `window.ethereum` that bridges to a viem wallet client running in Node, keyed with the seeded
 * project account. Everything above the provider — wagmi's injected connector, the simulate step,
 * writeContract, the receipt wait, the panel's state machine — is the real code path.
 *
 * Usage: node scripts/drive-writes.mjs [campaignId]
 * Requires: anvil + deploy + seed, and `pnpm dev` on :3000.
 */
import {chromium} from "playwright";
import {createWalletClient, createPublicClient, http} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {anvil} from "viem/chains";
import {mkdirSync} from "node:fs";

/** Anvil account #1 — `PROJECT_PK` in script/SeedLocal.s.sol, owner of every seeded campaign. */
const PROJECT_PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

const campaignId = process.argv[2] ?? "2";
const RPC = "http://127.0.0.1:8545";

const account = privateKeyToAccount(PROJECT_PK);
const wallet = createWalletClient({account, chain: anvil, transport: http(RPC)});
const publicClient = createPublicClient({chain: anvil, transport: http(RPC)});

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
const page = await browser.newPage({viewport: {width: 1440, height: 1300}});

const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

/**
 * Node-side handler for the bridged provider.
 *
 * Writes are signed here rather than forwarded raw, because anvil's `eth_sendTransaction` would
 * need the account unlocked as a node account; signing locally is what a real wallet does.
 */
await page.exposeFunction("__walletRequest", async ({method, params = []}) => {
  switch (method) {
    case "eth_requestAccounts":
    case "eth_accounts":
      return [account.address];
    case "eth_chainId":
      return `0x${anvil.id.toString(16)}`;
    case "net_version":
      return String(anvil.id);
    case "eth_sendTransaction": {
      const [tx] = params;
      return wallet.sendTransaction({
        to: tx.to,
        data: tx.data,
        value: tx.value ? BigInt(tx.value) : undefined,
        gas: tx.gas ? BigInt(tx.gas) : undefined,
      });
    }
    case "wallet_switchEthereumChain":
      return null;
    default:
      // Every read the app makes still goes to the real node.
      return publicClient.request({method, params});
  }
});

// Install before any app script runs, so wagmi's connector discovers it during hydration.
await page.addInitScript(() => {
  const listeners = new Map();
  window.ethereum = {
    isMetaMask: true,
    request: (args) => window.__walletRequest(args),
    on: (event, handler) => {
      listeners.set(event, [...(listeners.get(event) ?? []), handler]);
    },
    removeListener: (event, handler) => {
      listeners.set(event, (listeners.get(event) ?? []).filter((h) => h !== handler));
    },
  };
});

const url = `http://localhost:3000/campaign/${campaignId}`;
console.log(`→ ${url}\n`);
await page.goto(url, {waitUntil: "domcontentloaded", timeout: 60_000});
await page.getByRole("heading", {name: /^KPIs/}).waitFor({timeout: 45_000});

// ── connect ──────────────────────────────────────────────────
console.log("wallet:");
await page.getByRole("button", {name: "Connect wallet"}).click();
const shortAddr = `${account.address.slice(0, 6)}…${account.address.slice(-4)}`;
await page.getByRole("button", {name: shortAddr}).waitFor({timeout: 20_000});
check("connected as project", true, shortAddr);

// The panel only appears for the project, so its presence is itself an assertion.
await page.getByText("Project Dashboard").waitFor({timeout: 20_000});
check("project dashboard visible", true);

// ── state before ─────────────────────────────────────────────
const statusBefore = await publicClient.readContract({
  address: await campaignAddress(campaignId),
  abi: [{type: "function", name: "status", inputs: [], outputs: [{type: "uint8"}], stateMutability: "view"}],
  functionName: "status",
});
console.log(`\nchain status before: ${statusBefore} (0=Pending)`);

// ── fund ─────────────────────────────────────────────────────
console.log("\nfund:");
const fundInput = page.locator("#fund-amount");
const hasFundForm = await fundInput.count();

if (hasFundForm) {
  await page.getByRole("button", {name: /Fill shortfall/}).click();
  const filled = await fundInput.inputValue();
  check("shortfall autofilled", filled !== "" && filled !== "0", filled);

  await page.getByRole("button", {name: "Fund", exact: true}).click();

  // Approve then fund — two transactions, so this waits for the terminal state rather than
  // asserting on the intermediate one.
  await page
    .getByText("Confirmed.", {exact: false})
    .first()
    .waitFor({timeout: 60_000})
    .catch(() => {});

  const escrow = await escrowBalance(campaignId);
  const pool = await rewardPool(campaignId);
  check("escrow now covers the pool", escrow >= pool, `${escrow} / ${pool}`);
} else {
  // Not a product failure — the fund form only exists on an underfunded Pending campaign, so
  // this just means the seed has already moved past that state. Re-seed to exercise it.
  console.log("  SKIP  fund form absent: campaign is already funded or past Pending");
}

await page.screenshot({path: "screenshots/write-funded.png", fullPage: true});

// ── activate ─────────────────────────────────────────────────
console.log("\nactivate:");
// The guard should have flipped this button live once escrow covered the pool.
const activateBtn = page.getByRole("button", {name: "Activate", exact: true});
await activateBtn.waitFor({timeout: 20_000});
check("activate enabled after funding", await activateBtn.isEnabled());

await activateBtn.click();
await page
  .getByText("Confirmed.", {exact: false})
  .first()
  .waitFor({timeout: 60_000})
  .catch(() => {});

const statusAfter = await publicClient.readContract({
  address: await campaignAddress(campaignId),
  abi: [{type: "function", name: "status", inputs: [], outputs: [{type: "uint8"}], stateMutability: "view"}],
  functionName: "status",
});
console.log(`chain status after: ${statusAfter} (1=Active)`);
check("campaign is Active on chain", Number(statusAfter) === 1, String(statusAfter));

// The panel must reflect the new status without a reload — onDone refetches.
//
// `exact: true` is load-bearing. Playwright's `name` option is a case-insensitive *substring*
// match by default, and each blocked button carries its reason in an sr-only span — so the
// Resume button's "Only a paused campaign can be resumed" also matches a loose "Pause", giving
// a strict-mode violation that reads as a product failure when it is a selector bug.
// Locate by *leading* text rather than accessible name. A blocked action carries its reason in
// an sr-only span, so its accessible name is "Cancel — A campaign can only be…" — an exact-name
// match finds nothing, and "no such element" is indistinguishable from "button is disabled"
// unless the assertion is written against disabled-state on a button that always exists.
const actionBtn = (label) =>
  page.locator("button").filter({hasText: new RegExp(`^${label}`)}).first();

const pauseBtn = actionBtn("Pause");
await page
  .getByRole("button", {name: "Pause", exact: true})
  .waitFor({timeout: 15_000})
  .catch(() => {});
check("pause became available", await pauseBtn.isEnabled().catch(() => false));

// Cancel is Pending-only — once active, cancelling would be a rug, so it must be disabled.
check("cancel became unavailable", await actionBtn("Cancel").isDisabled().catch(() => false));

await page.screenshot({path: "screenshots/write-activated.png", fullPage: true});

if (pageErrors.length) {
  console.log("\n--- page errors ---");
  for (const e of pageErrors) console.log(`  ${e}`);
  failures += pageErrors.length;
}

await browser.close();

console.log(failures === 0 ? "\nOK: write path drove real transactions" : `\nFAIL: ${failures} problem(s)`);
process.exitCode = failures === 0 ? 0 : 1;

// ── helpers ──────────────────────────────────────────────────

async function campaignAddress(id) {
  const {GENERATED_DEPLOYMENTS} = await import("../src/lib/deployments.ts");
  const registry = GENERATED_DEPLOYMENTS[anvil.id].campaignRegistry;
  return publicClient.readContract({
    address: registry,
    abi: [
      {
        type: "function",
        name: "campaignAt",
        inputs: [{type: "uint256"}],
        outputs: [{type: "address"}],
        stateMutability: "view",
      },
    ],
    functionName: "campaignAt",
    args: [BigInt(id)],
  });
}

async function escrowBalance(id) {
  const {GENERATED_DEPLOYMENTS} = await import("../src/lib/deployments.ts");
  const vault = GENERATED_DEPLOYMENTS[anvil.id].escrowVault;
  return publicClient.readContract({
    address: vault,
    abi: [
      {
        type: "function",
        name: "balanceOf",
        inputs: [{type: "address"}],
        outputs: [{type: "uint256"}],
        stateMutability: "view",
      },
    ],
    functionName: "balanceOf",
    args: [await campaignAddress(id)],
  });
}

async function rewardPool(id) {
  return publicClient.readContract({
    address: await campaignAddress(id),
    abi: [
      {
        type: "function",
        name: "rewardPool",
        inputs: [],
        outputs: [{type: "uint256"}],
        stateMutability: "view",
      },
    ],
    functionName: "rewardPool",
  });
}
