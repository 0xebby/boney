/**
 * Gives the five-project demo fixture real, creditable activity.
 *
 * Usage:
 *   pnpm demo:seed attribute --campaign <addr>      # promoter joins, referral signs a touch
 *   pnpm demo:seed weth      [--wrap 0.005] [--unwrap 0.002]
 *   pnpm demo:seed aave      [--amount 0.002]
 *   pnpm demo:seed nft       [--qty 3]
 *   pnpm demo:seed status    --campaign <addr>
 *
 * ## Three wallets, three roles
 *
 * All three keys live in the repo-root `.env`, which is what lets this run unattended:
 *
 *   ETHOS_PK              the promoter. Registers, joins, receives tier payouts.
 *   REFERRAL_PRIVATE_KEY  the referral. Signs the touch and performs the real on-chain action.
 *   PRIVATE_KEY           the project. Relays the touch and is the only wallet `reportUserAction` takes.
 *
 * The referral both signs *and* acts, which is the part a seed-derived throwaway wallet cannot do:
 * `script/promoter.sh` uses one of those because it only ever needs a signature, but wrapping ETH or
 * minting an NFT needs gas and a real balance.
 *
 * ## Why `attribute` is separate from the actions
 *
 * A campaign credits nothing for a wallet with no live touch — `reportUserAction` reverts
 * `NoAttribution` — and the touch must be signed **before** the activity, because the floor every
 * observed total is measured from is the referral's *first* touch. Activity that predates it is
 * correctly excluded and simply never credits. So: attribute first, act second, always.
 *
 * ## Sygma and Uniswap are not here
 *
 * They already have purpose-built scripts with hard-won details this one would only duplicate badly —
 * `sygma-deposit.ts` (the GMP payload embeds the sender, so it cannot be copied between wallets) and
 * `uniswap-swap.ts` (the router pays the pool from its own stranded ETH, so the WETH leg credits
 * nothing). Run those directly.
 */
import {readFileSync, existsSync} from "node:fs";
import {resolve, dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {
  createPublicClient,
  createWalletClient,
  http,
  formatEther,
  parseEther,
  parseAbiItem,
  type Hex,
  type PublicClient,
} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {baseSepolia} from "viem/chains";
import {CampaignAbi, AttributionRegistryAbi} from "../src/lib/abis";
import {
  attributionDomain,
  buildTouch,
  fetchEffectiveMaxDuration,
  fetchMaxTouchDuration,
  TOUCH_EIP712_TYPES,
} from "../src/lib/attribution";
import {derivePromoterId} from "../src/lib/promoter";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const WETH = "0x4200000000000000000000000000000000000006" as const;
const AAVE_POOL = "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27" as const;
const NFT = "0x6ad3F605fEDe1E2a4547A98b1CD106BD1b74b3C5" as const;

const WETH_ABI = [
  parseAbiItem("function deposit() payable"),
  parseAbiItem("function withdraw(uint256 wad)"),
  parseAbiItem("function approve(address spender, uint256 amount) returns (bool)"),
  parseAbiItem("function balanceOf(address) view returns (uint256)"),
];
const AAVE_ABI = [
  parseAbiItem(
    "function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)",
  ),
];
const NFT_ABI = [
  parseAbiItem("function mint(uint256 quantity) payable"),
  parseAbiItem("function PRICE() view returns (uint256)"),
  parseAbiItem("function totalMinted() view returns (uint256)"),
];

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

function envKey(name: string): Hex {
  if (process.env[name]) return process.env[name] as Hex;
  const path = resolve(REPO_ROOT, ".env");
  if (!existsSync(path)) throw new Error(`no .env at ${path}`);
  const line = readFileSync(path, "utf8")
    .split("\n")
    .find((l) => new RegExp(`^\\s*${name}\\s*=`).test(l));
  const v = line?.split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, "");
  if (!v) throw new Error(`${name} missing from .env`);
  return v as Hex;
}

const rpc = arg("--rpc") ?? "https://base-sepolia-rpc.publicnode.com";
const client = createPublicClient({transport: http(rpc)}) as PublicClient;

const promoter = privateKeyToAccount(envKey("ETHOS_PK"));
const referral = privateKeyToAccount(envKey("REFERRAL_PRIVATE_KEY"));
const project = privateKeyToAccount(envKey("PRIVATE_KEY"));

const wallet = (acct: typeof promoter) =>
  createWalletClient({account: acct, chain: baseSepolia, transport: http(rpc)});

/** Sends and waits, printing the outcome. Throws on revert so a chain of steps stops at the failure. */
async function send(label: string, hash: Hex): Promise<void> {
  const rc = await client.waitForTransactionReceipt({hash});
  console.log(`  ${label}: ${rc.status} — ${hash}`);
  if (rc.status !== "success") throw new Error(`${label} reverted`);
}

/**
 * Registers and joins the promoter, then stores a touch attributing the referral to them.
 *
 * Idempotent on both halves: `registerPromoter` and `join` are skipped when already done, and a touch
 * is only re-signed when the existing one has lapsed — `storeTouch` reverts `TouchNotNewer` on a
 * `signedAt` at or below the stored one, so re-running blindly would fail rather than no-op.
 */
async function attribute(campaign: `0x${string}`): Promise<void> {
  const registry = (await client.readContract({
    address: campaign,
    abi: CampaignAbi,
    functionName: "attributionRegistry",
  })) as `0x${string}`;
  const promoterId = derivePromoterId(campaign, promoter.address);

  const registered = (await client.readContract({
    address: registry,
    abi: AttributionRegistryAbi,
    functionName: "isRegistered",
    args: [campaign, promoterId],
  })) as boolean;
  if (!registered) {
    await send(
      "registerPromoter",
      await wallet(promoter).writeContract({
        address: registry,
        abi: AttributionRegistryAbi,
        functionName: "registerPromoter",
        args: [promoterId],
      }),
    );
  } else console.log("  registerPromoter: already registered");

  const joinedAs = (await client.readContract({
    address: campaign,
    abi: CampaignAbi,
    functionName: "promoterIdOf",
    args: [promoter.address],
  })) as Hex;
  if (joinedAs === `0x${"00".repeat(32)}`) {
    await send(
      "join",
      await wallet(promoter).writeContract({address: campaign, abi: CampaignAbi, functionName: "join"}),
    );
  } else console.log("  join: already joined");

  const existing = (await client.readContract({
    address: registry,
    abi: AttributionRegistryAbi,
    functionName: "touchOf",
    args: [campaign, referral.address],
  })) as {promoterId: Hex; signedAt: bigint; expiresAt: bigint};
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (BigInt(existing.expiresAt) > now && existing.promoterId === promoterId) {
    console.log(`  touch: already live (signedAt ${existing.signedAt})`);
    return;
  }

  const [window, maxDur] = await Promise.all([
    fetchEffectiveMaxDuration(client, registry, campaign),
    fetchMaxTouchDuration(client, registry),
  ]);
  const touch = buildTouch(campaign, promoterId, window, maxDur);
  const signature = await referral.signTypedData({
    domain: attributionDomain(baseSepolia.id, registry),
    types: TOUCH_EIP712_TYPES,
    primaryType: "Touch",
    message: touch,
  });

  // Relayed by the project, signed by the referral — the referral never needs gas for this part.
  await send(
    "storeTouch",
    await wallet(project).writeContract({
      address: registry,
      abi: AttributionRegistryAbi,
      functionName: "storeTouch",
      args: [referral.address, touch, signature, project.address],
    }),
  );
}

/** Wraps ETH, and optionally unwraps some — feeding the WETH campaign's three KPIs at once. */
async function weth(): Promise<void> {
  const wrap = parseEther(arg("--wrap") ?? "0.005");
  const unwrap = parseEther(arg("--unwrap") ?? "0.002");

  if (wrap > 0n) {
    await send(
      `deposit ${formatEther(wrap)} ETH`,
      await wallet(referral).writeContract({
        address: WETH,
        abi: WETH_ABI,
        functionName: "deposit",
        value: wrap,
      }),
    );
  }
  if (unwrap > 0n) {
    await send(
      `withdraw ${formatEther(unwrap)} WETH`,
      await wallet(referral).writeContract({
        address: WETH,
        abi: WETH_ABI,
        functionName: "withdraw",
        args: [unwrap],
      }),
    );
  }
  const bal = (await client.readContract({
    address: WETH,
    abi: WETH_ABI,
    functionName: "balanceOf",
    args: [referral.address],
  })) as bigint;
  console.log(`  referral WETH balance: ${formatEther(bal)}`);
}

/**
 * Wraps, approves and supplies WETH to Aave.
 *
 * WETH rather than a faucet token because it is a live reserve on this pool (sampled: 2 recent
 * supplies) and the referral can obtain it from ETH it already holds, with no faucet in the loop.
 * `onBehalfOf` is the referral itself — that is `topics[2]` on `Supply`, which is what the KPI credits.
 */
async function aave(): Promise<void> {
  const amount = parseEther(arg("--amount") ?? "0.002");

  const held = (await client.readContract({
    address: WETH,
    abi: WETH_ABI,
    functionName: "balanceOf",
    args: [referral.address],
  })) as bigint;
  if (held < amount) {
    await send(
      `wrap ${formatEther(amount - held)} ETH first`,
      await wallet(referral).writeContract({
        address: WETH,
        abi: WETH_ABI,
        functionName: "deposit",
        value: amount - held,
      }),
    );
  }

  await send(
    "approve pool",
    await wallet(referral).writeContract({
      address: WETH,
      abi: WETH_ABI,
      functionName: "approve",
      args: [AAVE_POOL, amount],
    }),
  );
  await send(
    `supply ${formatEther(amount)} WETH`,
    await wallet(referral).writeContract({
      address: AAVE_POOL,
      abi: AAVE_ABI,
      functionName: "supply",
      args: [WETH, amount, referral.address, 0],
    }),
  );
}

/** Mints on the fixture's own NFT — one `Transfer` per token plus one `Minted` carrying the spend. */
async function nft(): Promise<void> {
  const qty = BigInt(arg("--qty") ?? "3");
  const price = (await client.readContract({
    address: NFT,
    abi: NFT_ABI,
    functionName: "PRICE",
  })) as bigint;
  const cost = price * qty;
  console.log(`  minting ${qty} at ${formatEther(price)} ETH each = ${formatEther(cost)} ETH`);

  await send(
    `mint ${qty}`,
    await wallet(referral).writeContract({
      address: NFT,
      abi: NFT_ABI,
      functionName: "mint",
      args: [qty],
      value: cost,
    }),
  );
  const total = (await client.readContract({
    address: NFT,
    abi: NFT_ABI,
    functionName: "totalMinted",
  })) as bigint;
  console.log(`  totalMinted now ${total}`);
}

async function status(campaign: `0x${string}`): Promise<void> {
  const registry = (await client.readContract({
    address: campaign,
    abi: CampaignAbi,
    functionName: "attributionRegistry",
  })) as `0x${string}`;
  const pid = (await client.readContract({
    address: registry,
    abi: AttributionRegistryAbi,
    functionName: "activePromoter",
    args: [campaign, referral.address],
  })) as Hex;
  const n = (await client.readContract({
    address: campaign,
    abi: CampaignAbi,
    functionName: "kpiCount",
  })) as bigint;
  console.log(`  referral attributed: ${pid === `0x${"00".repeat(32)}` ? "NO" : "yes"}`);
  for (let i = 0n; i < n; i++) {
    const [prog, tiersSettled] = await Promise.all([
      client.readContract({address: campaign, abi: CampaignAbi, functionName: "progressOf", args: [promoter.address, i]}),
      client.readContract({address: campaign, abi: CampaignAbi, functionName: "settledTiersOf", args: [promoter.address, i]}),
    ]);
    console.log(`  kpi ${i}: promoter progress ${prog}, tiers settled ${tiersSettled}`);
  }
}

async function main() {
  const cmd = process.argv[2];
  const campaign = arg("--campaign") as `0x${string}` | undefined;
  console.log(`promoter ${promoter.address}  referral ${referral.address}`);
  const ethBal = await client.getBalance({address: referral.address});
  console.log(`referral ETH ${formatEther(ethBal)}\n`);

  switch (cmd) {
    case "attribute":
      if (!campaign) throw new Error("attribute needs --campaign");
      return attribute(campaign);
    case "weth":
      return weth();
    case "aave":
      return aave();
    case "nft":
      return nft();
    case "status":
      if (!campaign) throw new Error("status needs --campaign");
      return status(campaign);
    default:
      throw new Error("usage: attribute|weth|aave|nft|status  (see the header)");
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
