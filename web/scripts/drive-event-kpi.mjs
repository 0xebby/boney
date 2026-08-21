/**
 * Drives the event-sourced KPI loop end to end, on Base Sepolia, through the real UI.
 *
 * What this proves that a scripted test cannot: the attribution Touch is signed *in the browser*,
 * by the app's own EIP-712 code path on the `/r` page, and the resulting on-chain touch is what
 * lets a real WETH deposit — an event this protocol does not control and did not emit — become
 * campaign progress and a paid reward.
 *
 * The sequence:
 *   1. test user opens the promoter's tracking link and signs a Touch (browser)
 *   2. test user deposits real ETH into WETH (script — a wallet action, not a UI feature)
 *   3. `pnpm index` reads that log and reports it (run separately)
 *   4. the campaign page shows the credited progress and the settled tier (browser)
 *
 * Usage: node scripts/drive-event-kpi.mjs <campaignId> <step>
 *   step = touch    → 1 and 2
 *   step = verify   → 4
 *
 * Requires `pnpm dev` on :3000 and the wallet keys derived from the repo-root `.env`.
 *
 * On a WSL2 / minimal Linux host Playwright's bundled Chromium may be missing system libraries
 * (`libnspr4`, `libasound2`, …). Without root, fetch them into a local prefix and point the loader
 * at it rather than installing globally:
 *
 *     cd /tmp && mkdir -p pwlibs && cd pwlibs
 *     apt-get download libnspr4 libnss3 libasound2t64 libatk1.0-0t64 libatk-bridge2.0-0t64 \
 *       libcups2t64 libxkbcommon0 libatspi2.0-0t64 libxcomposite1 libxdamage1 libxfixes3 \
 *       libxrandr2 libgbm1 libpango-1.0-0 libcairo2
 *     for f in *.deb; do dpkg-deb -x "$f" extracted/; done
 *     LD_LIBRARY_PATH=/tmp/pwlibs/extracted/usr/lib/x86_64-linux-gnu node scripts/drive-event-kpi.mjs 5 verify
 */
import {chromium} from "playwright";
import {
  createWalletClient,
  createPublicClient,
  http,
  keccak256,
  toHex,
} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {baseSepolia} from "viem/chains";
import {mkdirSync, readFileSync} from "node:fs";

const campaignId = process.argv[2] ?? "5";
const step = process.argv[3] ?? "touch";
const RPC = process.env.BASE_SEPOLIA_RPC ?? "https://base-sepolia-rpc.publicnode.com";
const WETH = "0x4200000000000000000000000000000000000006";

/** 0.003 ETH — three units of progress at the campaign's 0.001 scale, clearing tier 1. */
const DEPOSIT_WEI = 3_000_000_000_000_000n;

const rootPk = readFileSync(new URL("../../.env", import.meta.url), "utf8")
  .split("\n")
  .find((l) => /^\s*PRIVATE_KEY\s*=/.test(l))
  .split("=")
  .slice(1)
  .join("=")
  .trim();

// Derived rather than stored: private, stable across runs, reproducible from the same .env
// without another secret on disk. Same scheme as seed-local.ts.
const promoter = privateKeyToAccount(keccak256(toHex(`${rootPk}:boney-promoter-0`)));
const user = privateKeyToAccount(keccak256(toHex(`${rootPk}:boney-eventuser-0`)));

const wallet = createWalletClient({account: user, chain: baseSepolia, transport: http(RPC)});
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
const page = await browser.newPage({viewport: {width: 1440, height: 1400}});
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

/**
 * Injected wallet for the *user*, not the promoter — the Touch is the user's consent, and
 * `storeTouch` recovers their address from the signature. Signing as anyone else reverts
 * `InvalidSignature`.
 */
await page.exposeFunction("__walletRequest", async ({method, params = []}) => {
  switch (method) {
    case "eth_requestAccounts":
    case "eth_accounts":
      return [user.address];
    case "eth_chainId":
      return `0x${baseSepolia.id.toString(16)}`;
    case "net_version":
      return String(baseSepolia.id);
    case "eth_signTypedData_v4": {
      // The property this whole script exists to exercise: the app builds the Touch digest, and
      // the chain must accept it. A field order or domain mismatch fails here, not silently.
      const [, typedData] = params;
      const parsed = typeof typedData === "string" ? JSON.parse(typedData) : typedData;
      return user.signTypedData({
        domain: parsed.domain,
        types: parsed.types,
        primaryType: parsed.primaryType,
        message: parsed.message,
      });
    }
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

const {GENERATED_DEPLOYMENTS} = await import("../src/lib/deployments.ts");
const deployment = GENERATED_DEPLOYMENTS[baseSepolia.id];

const campaign = await publicClient.readContract({
  address: deployment.campaignRegistry,
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
  args: [BigInt(campaignId)],
});

const promoterId = await publicClient.readContract({
  address: campaign,
  abi: [
    {
      type: "function",
      name: "promoterIdOf",
      inputs: [{type: "address"}],
      outputs: [{type: "bytes32"}],
      stateMutability: "view",
    },
  ],
  functionName: "promoterIdOf",
  args: [promoter.address],
});

console.log(`campaign ${campaignId} at ${campaign}`);
console.log(`promoter ${promoter.address} (${promoterId.slice(0, 12)}…)`);
console.log(`user     ${user.address}`);

if (step === "touch") {
  // ── sign the Touch through the real /r page ────────────────
  console.log("\nattribution:");
  await page.goto(`http://localhost:3000/r?c=${campaign}&p=${promoterId}`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });

  await page.getByRole("button", {name: "Connect wallet"}).click().catch(() => {});
  await page.waitForTimeout(2_000);

  const confirm = page.getByRole("button", {name: /Confirm attribution/});
  await confirm.waitFor({timeout: 30_000});
  check("attribution page offers confirmation", true);

  await confirm.click();
  await page.getByText(/Attribution confirmed|Redirecting/i).waitFor({timeout: 120_000});

  const stored = await publicClient.readContract({
    address: deployment.attributionRegistry,
    abi: [
      {
        type: "function",
        name: "activePromoter",
        inputs: [{type: "address"}, {type: "address"}],
        outputs: [{type: "bytes32"}],
        stateMutability: "view",
      },
    ],
    functionName: "activePromoter",
    args: [campaign, user.address],
  });

  // The signature the browser produced was accepted by the chain — EIP-712 encoding agrees.
  check(
    "touch stored on chain, signed in the browser",
    stored.toLowerCase() === promoterId.toLowerCase(),
    stored,
  );

  await page.screenshot({path: "screenshots/event-kpi-touch.png", fullPage: true});

  // ── real WETH deposit ──────────────────────────────────────
  console.log("\nWETH deposit:");
  const hash = await wallet.writeContract({
    address: WETH,
    abi: [{type: "function", name: "deposit", inputs: [], outputs: [], stateMutability: "payable"}],
    functionName: "deposit",
    value: DEPOSIT_WEI,
  });
  const receipt = await publicClient.waitForTransactionReceipt({hash});
  check("deposit landed", receipt.status === "success", hash);
  console.log(`  block ${receipt.blockNumber}`);
  console.log(`\nNext: pnpm index --rpc ${RPC} --campaign ${campaign} --from-block ${receipt.blockNumber}`);
}

if (step === "verify") {
  // ── the indexed result, in the UI ──────────────────────────
  console.log("\ncampaign page:");
  await page.goto(`http://localhost:3000/campaign/${campaignId}`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });

  // Connecting is not optional here. An unconnected wagmi falls back to `chains[0]` — anvil — and
  // the page reads campaign 5 from the *local* Boney address, where it does not exist. The error
  // that produces ("campaignView reverted") looks like a contract bug and is really a wrong-chain
  // read, so the driver connects before asserting anything.
  await page.getByRole("button", {name: "Connect wallet"}).click().catch(() => {});
  await page.getByRole("heading", {name: /^KPIs/}).waitFor({timeout: 45_000});
  await page.waitForTimeout(3_000);

  const body = await page.locator("body").innerText();

  check("KPI panel names the tracked event", /Deposit\(address,uint256\)/.test(body));
  check("panel labels it as tracking", /Tracking/i.test(body));

  const progress = await publicClient.readContract({
    address: campaign,
    abi: [
      {
        type: "function",
        name: "progressOf",
        inputs: [{type: "address"}, {type: "uint256"}],
        outputs: [{type: "uint256"}],
        stateMutability: "view",
      },
    ],
    functionName: "progressOf",
    args: [promoter.address, 0n],
  });
  check("promoter credited on chain", progress > 0n, `${progress} units`);

  const paidOut = await publicClient.readContract({
    address: campaign,
    abi: [
      {type: "function", name: "paidOut", inputs: [], outputs: [{type: "uint256"}], stateMutability: "view"},
    ],
    functionName: "paidOut",
  });
  // Settlement is inline: crossing a tier pays during reportUserAction, no claim needed.
  check("tier settled and paid", paidOut > 0n, `${paidOut} base units`);

  await page.screenshot({path: "screenshots/event-kpi-progress.png", fullPage: true});
}

if (pageErrors.length) {
  console.log("\n--- page errors ---");
  for (const e of pageErrors) console.log(`  ${e}`);
  failures += pageErrors.length;
}

await browser.close();
console.log(failures === 0 ? `\nOK: ${step} step verified against Base Sepolia` : `\nFAIL: ${failures} problem(s)`);
process.exitCode = failures === 0 ? 0 : 1;
