/**
 * Isolates one question: after a lifecycle write lands, does the panel repaint from fresh chain
 * state without a reload?
 *
 * The fund/activate drive left `pause became available` failing, with `cancel became
 * unavailable` passing in the same run — so the status *did* reach the UI. That points at the
 * refetch boundary rather than the guard logic, and this script separates the two by polling the
 * button state instead of sampling it once.
 *
 * Usage: node scripts/drive-refetch.mjs [campaignId]
 */
import {chromium} from "playwright";
import {createWalletClient, createPublicClient, http} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {anvil} from "viem/chains";

const PROJECT_PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const campaignId = process.argv[2] ?? "2";
const RPC = "http://127.0.0.1:8545";

const account = privateKeyToAccount(PROJECT_PK);
const wallet = createWalletClient({account, chain: anvil, transport: http(RPC)});
const publicClient = createPublicClient({chain: anvil, transport: http(RPC)});

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH,
  args: ["--no-sandbox"],
});
const page = await browser.newPage({viewport: {width: 1440, height: 1300}});
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

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
      return publicClient.request({method, params});
  }
});

await page.addInitScript(() => {
  const listeners = new Map();
  window.ethereum = {
    isMetaMask: true,
    request: (args) => window.__walletRequest(args),
    on: (e, h) => listeners.set(e, [...(listeners.get(e) ?? []), h]),
    removeListener: (e, h) =>
      listeners.set(e, (listeners.get(e) ?? []).filter((x) => x !== h)),
  };
});

await page.goto(`http://localhost:3000/campaign/${campaignId}`, {
  waitUntil: "domcontentloaded",
  timeout: 60_000,
});
await page.getByRole("heading", {name: /^KPIs/}).waitFor({timeout: 45_000});
await page.getByRole("button", {name: "Connect wallet"}).click();
await page
  .getByRole("button", {name: `${account.address.slice(0, 6)}…${account.address.slice(-4)}`})
  .waitFor({timeout: 20_000});
await page.getByText("Project Dashboard").waitFor({timeout: 20_000});

const chainStatus = async () =>
  Number(
    await publicClient.readContract({
      address: await addr(),
      abi: [{type: "function", name: "status", inputs: [], outputs: [{type: "uint8"}], stateMutability: "view"}],
      functionName: "status",
    }),
  );

const btn = (name) => page.getByRole("button", {name, exact: true});
const enabled = async (name) => btn(name).isEnabled().catch(() => false);

const snapshot = async (label) => {
  const [pause, unpause, end, cancel, activate] = await Promise.all([
    enabled("Pause"),
    enabled("Resume"),
    enabled("End campaign"),
    enabled("Cancel"),
    enabled("Activate"),
  ]);
  console.log(
    `  ${label.padEnd(22)} chain=${await chainStatus()}  ` +
      `pause=${pause} resume=${unpause} end=${end} cancel=${cancel} activate=${activate}`,
  );
  return {pause, unpause, end, cancel, activate};
};

console.log(`\ncampaign #${campaignId} — button state vs chain status:`);
await snapshot("on load");

// Poll rather than sample once: this distinguishes "never repaints" from "repaints late".
const pauseWithin = async (ms) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await enabled("Pause")) return Math.round(ms - (deadline - Date.now()));
    await page.waitForTimeout(250);
  }
  return null;
};

const status = await chainStatus();

if (status === 1) {
  console.log("\ncampaign is Active — driving pause:");
  await btn("Pause").click();
  await page.getByText("Confirmed.", {exact: false}).first().waitFor({timeout: 60_000}).catch(() => {});
  console.log(`  chain status after pause: ${await chainStatus()} (2=Paused)`);

  // Now the inverse question: does Resume light up?
  const deadline = Date.now() + 15_000;
  let resumeAt = null;
  while (Date.now() < deadline) {
    if (await enabled("Resume")) {
      resumeAt = 15_000 - (deadline - Date.now());
      break;
    }
    await page.waitForTimeout(250);
  }
  await snapshot("after pause");
  console.log(
    resumeAt === null
      ? "  RESULT: panel never repainted (refetch is not reaching the guards)"
      : `  RESULT: panel repainted after ~${Math.round(resumeAt)}ms`,
  );
} else if (status === 0) {
  console.log("\ncampaign is Pending — activate, then time the repaint:");
  await btn("Activate").click();
  await page.getByText("Confirmed.", {exact: false}).first().waitFor({timeout: 60_000}).catch(() => {});
  const at = await pauseWithin(15_000);
  await snapshot("after activate");
  console.log(
    at === null
      ? "  RESULT: panel never repainted within 15s"
      : `  RESULT: pause enabled after ~${at}ms (drive-writes waited only 2500ms)`,
  );
} else {
  console.log(`\ncampaign status ${status} — not Pending or Active, nothing to drive.`);
}

if (pageErrors.length) {
  console.log("\npage errors:");
  for (const e of pageErrors) console.log(`  ${e}`);
}

await browser.close();

async function addr() {
  const {GENERATED_DEPLOYMENTS} = await import("../src/lib/deployments.ts");
  return publicClient.readContract({
    address: GENERATED_DEPLOYMENTS[anvil.id].campaignRegistry,
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
}
