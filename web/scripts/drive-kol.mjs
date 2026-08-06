/**
 * Drives the KOL path — join, promoter id, tracking link — through the real UI.
 *
 * The value here is the promoter id. `derivePromoterId` recomputes, in TypeScript, a hash the
 * contract builds with `keccak256(abi.encode(address(this), msg.sender))`. If the encoding drifts
 * by so much as argument order, the frontend hands KOLs a tracking link whose promoterId no touch
 * will ever match — and everything still *looks* fine, because a wrong hash is as plausible as a
 * right one. Only comparing against the chain catches it.
 *
 * Uses a fresh anvil account so the join is real rather than a replay of the seeded KOL.
 *
 * Usage: node scripts/drive-kol.mjs [joinableId] [gatedId]
 * Requires: anvil + deploy + seed, and `pnpm dev` on :3000.
 */
import {chromium} from "playwright";
import {createWalletClient, createPublicClient, http, keccak256, encodeAbiParameters} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {anvil} from "viem/chains";
import {mkdirSync} from "node:fs";

/** Anvil account #6 — untouched by SeedLocal, so it has joined nothing and has no reputation. */
const KOL_PK = "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e";

const joinableId = process.argv[2] ?? "1"; // minReputation 0
const gatedId = process.argv[3] ?? "0"; // minReputation 2500
const RPC = "http://127.0.0.1:8545";

const account = privateKeyToAccount(KOL_PK);
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
const page = await browser.newPage({viewport: {width: 1440, height: 1400}});
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
  const l = new Map();
  window.ethereum = {
    isMetaMask: true,
    request: (a) => window.__walletRequest(a),
    on: (e, h) => l.set(e, [...(l.get(e) ?? []), h]),
    removeListener: (e, h) => l.set(e, (l.get(e) ?? []).filter((x) => x !== h)),
  };
});

const {GENERATED_DEPLOYMENTS} = await import("../src/lib/deployments.ts");
const REGISTRY = GENERATED_DEPLOYMENTS[anvil.id].campaignRegistry;

const campaignAddress = (id) =>
  publicClient.readContract({
    address: REGISTRY,
    abi: [{type: "function", name: "campaignAt", inputs: [{type: "uint256"}], outputs: [{type: "address"}], stateMutability: "view"}],
    functionName: "campaignAt",
    args: [BigInt(id)],
  });

const promoterIdOnChain = (campaign, who) =>
  publicClient.readContract({
    address: campaign,
    abi: [{type: "function", name: "promoterIdOf", inputs: [{type: "address"}], outputs: [{type: "bytes32"}], stateMutability: "view"}],
    functionName: "promoterIdOf",
    args: [who],
  });

const goTo = async (id) => {
  await page.goto(`http://localhost:3000/campaign/${id}`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page.getByRole("heading", {name: /^KPIs/}).waitFor({timeout: 45_000});
};

// ── connect ──────────────────────────────────────────────────
await goTo(joinableId);
console.log("wallet:");
await page.getByRole("button", {name: "Connect wallet"}).click();
const short = `${account.address.slice(0, 6)}…${account.address.slice(-4)}`;
await page.getByRole("button", {name: short}).waitFor({timeout: 20_000});
check("connected as a fresh KOL", true, short);

// ── reputation gate ──────────────────────────────────────────
console.log("\nreputation gate:");
await goTo(gatedId);
await page.waitForTimeout(1_500);
const gatedJoin = page.getByRole("button", {name: /Join as promoter/});
check("join blocked below the reputation floor", await gatedJoin.isDisabled().catch(() => false));
const gatedReason = await page
  .getByText(/reputation/i)
  .first()
  .innerText()
  .catch(() => "");
check("reason names reputation", /reputation/i.test(gatedReason), gatedReason.slice(0, 80));

// ── join ─────────────────────────────────────────────────────
console.log("\njoin:");
await goTo(joinableId);
await page.waitForTimeout(1_500);

const campaign = await campaignAddress(joinableId);
const before = await promoterIdOnChain(campaign, account.address);
check("not joined before", /^0x0+$/.test(before));

const joinBtn = page.getByRole("button", {name: /Join as promoter/});
check("join offered on an open campaign", await joinBtn.isEnabled().catch(() => false));

await joinBtn.click();
await page
  .getByText("Your tracking link")
  .waitFor({timeout: 60_000})
  .catch(() => {});

const after = await promoterIdOnChain(campaign, account.address);
check("promoter id recorded on chain", !/^0x0+$/.test(after), after);

// The property this script exists for.
const expected = keccak256(
  encodeAbiParameters(
    [{type: "address"}, {type: "address"}],
    [campaign.toLowerCase(), account.address.toLowerCase()],
  ),
);
check("derivePromoterId matches the chain", after.toLowerCase() === expected.toLowerCase(), after);

// ── tracking link ────────────────────────────────────────────
console.log("\ntracking link:");
const link = await page.locator("#tracking-link").inputValue().catch(() => "");
check("link rendered", link.length > 0, link);
check("link carries the campaign", link.toLowerCase().includes(campaign.toLowerCase()));
check("link carries the on-chain promoter id", link.toLowerCase().includes(after.toLowerCase()));
check("link does not bake in an expiry", !/expire|exp=|until/i.test(link));

// ── claim state ──────────────────────────────────────────────
console.log("\nclaim:");
// A promoter who just joined has no credited progress, so every Claim must be disabled with a
// reason rather than offering a transaction that would revert or pay nothing.
const claimBtns = page.getByRole("button", {name: "Claim", exact: true});
const claimCount = await claimBtns.count();
check("a claim row per KPI", claimCount > 0, String(claimCount));

let allDisabled = true;
for (let i = 0; i < claimCount; i++) {
  if (await claimBtns.nth(i).isEnabled().catch(() => false)) allDisabled = false;
}
check("claim disabled with no progress", allDisabled);

await page.screenshot({path: "screenshots/kol-joined.png", fullPage: true});

if (pageErrors.length) {
  console.log("\n--- page errors ---");
  for (const e of pageErrors) console.log(`  ${e}`);
  failures += pageErrors.length;
}

await browser.close();
console.log(failures === 0 ? "\nOK: KOL join path verified against the chain" : `\nFAIL: ${failures} problem(s)`);
process.exitCode = failures === 0 ? 0 : 1;
