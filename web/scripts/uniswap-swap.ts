/**
 * Swaps WETH for USDC on Uniswap V3 (Base Sepolia) so the swap campaign's KPIs have something to credit.
 *
 * Usage:
 *   pnpm swap:weth-usdc --campaign <addr> --sender <addr> [--amount 0.001] [--dry-run]
 *   SWAP_SENDER_KEY=0x… pnpm swap:weth-usdc --campaign <addr> [--amount 0.001]   # signs and sends
 *
 * ## Why a script rather than a wallet click
 *
 * The campaign's two KPIs credit two *different* events from one transaction — the pool's `Swap` (one
 * per swap) and WETH's `Transfer` (the amount swapped in) — and both are only creditable for a wallet
 * that is already attributed to a promoter. A swap through a UI clears the first bar and tells you
 * nothing about the second, so the pre-flight here checks both: the swap succeeding, and the campaign
 * being able to credit this sender.
 *
 * ## The two things that quietly produce an uncreditable swap
 *
 *  - **Swapping ETH instead of WETH.** SwapRouter02 will happily wrap ETH for you, but then the WETH
 *    `Transfer` into the pool comes `from` the *router*, not from you — so the volume KPI credits
 *    nobody. This script always swaps WETH you already hold, wrapping first if asked.
 *  - **Recipient is not the sender.** The count KPI credits `topics[2]`, the swap's `recipient`. Sending
 *    the output somewhere else moves the credit with it. `recipient` here is always the sender.
 */
import {readFileSync, existsSync} from "node:fs";
import {resolve, dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {
  createPublicClient,
  createWalletClient,
  http,
  getAddress,
  formatEther,
  formatUnits,
  parseEther,
  parseAbiItem,
  type Hex,
  type PublicClient,
} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {baseSepolia} from "viem/chains";
import {CampaignAbi, AttributionRegistryAbi} from "../src/lib/abis";
import {GENERATED_DEPLOYMENTS} from "../src/lib/deployments";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");

/** Uniswap V3 SwapRouter02 on Base Sepolia — `sender` on every routed swap. */
const ROUTER = "0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4" as const;
/** The 0.3% WETH/USDC pool the campaign's count KPI watches. Fee tier must match it. */
const POOL = "0x46880b404CD35c165EDdefF7421019F8dD25F4Ad" as const;
const POOL_FEE = 3000;
const WETH = "0x4200000000000000000000000000000000000006" as const;
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;

/** 0.001 WETH — exactly the campaign's first volume tier, and ~$0.15 of testnet value. */
const DEFAULT_AMOUNT = "0.001";

const ROUTER_ABI = [
  parseAbiItem(
    "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
  ),
];

const WETH_ABI = [
  parseAbiItem("function deposit() payable"),
  parseAbiItem("function approve(address spender, uint256 amount) returns (bool)"),
  parseAbiItem("function allowance(address owner, address spender) view returns (uint256)"),
  parseAbiItem("function balanceOf(address owner) view returns (uint256)"),
];

const ERC20_ABI = [parseAbiItem("function balanceOf(address owner) view returns (uint256)")];

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

function envKey(name: string): Hex | undefined {
  if (process.env[name]) return process.env[name] as Hex;
  const path = resolve(REPO_ROOT, ".env");
  if (!existsSync(path)) return undefined;
  const line = readFileSync(path, "utf8")
    .split("\n")
    .find((l) => new RegExp(`^\\s*${name}\\s*=`).test(l));
  const value = line?.split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, "");
  return (value || undefined) as Hex | undefined;
}

/**
 * Whether this campaign could credit this wallet's swap.
 *
 * Two separate reasons it could not, and they need different fixes: no attribution at all (the wallet
 * has to follow a promoter's tracking link and sign a touch), or an attribution that has lapsed. The
 * swap still happens either way — this is a warning, not a gate, because emitting the events is
 * sometimes exactly what you want to test.
 */
async function checkAttribution(
  client: PublicClient,
  campaign: `0x${string}`,
  wallet: `0x${string}`,
): Promise<string> {
  const registry = GENERATED_DEPLOYMENTS[baseSepolia.id]?.attributionRegistry;
  if (!registry) return "no attribution registry known for this chain";

  try {
    const touch = await client.readContract({
      address: registry,
      abi: AttributionRegistryAbi,
      functionName: "touchOf",
      args: [campaign, wallet],
    });

    const zero = `0x${"00".repeat(32)}`;
    if (touch.promoterId === zero) {
      return "NOT attributed — this swap will emit both events and credit nobody. Sign a touch first.";
    }

    const now = BigInt(Math.floor(Date.now() / 1000));
    if (touch.expiresAt <= now) {
      return `attribution EXPIRED at ${new Date(Number(touch.expiresAt) * 1000).toISOString()} — re-sign a touch.`;
    }

    const promoter = await client.readContract({
      address: campaign,
      abi: CampaignAbi,
      functionName: "promoterOf",
      args: [touch.promoterId],
    });

    return `attributed to promoter ${promoter}, valid until ${new Date(Number(touch.expiresAt) * 1000).toISOString()}`;
  } catch (error) {
    return `could not read attribution: ${(error as Error).message}`;
  }
}

async function main() {
  const rpc = arg("--rpc") ?? "https://base-sepolia-rpc.publicnode.com";
  const campaign = arg("--campaign") as `0x${string}` | undefined;
  const amount = parseEther(arg("--amount") ?? DEFAULT_AMOUNT);
  const wrap = process.argv.includes("--wrap");
  const dryRun = process.argv.includes("--dry-run");

  const key = envKey("SWAP_SENDER_KEY");
  const account = key ? privateKeyToAccount(key) : undefined;
  const sender = (arg("--sender") ?? account?.address) as `0x${string}` | undefined;

  if (!sender) {
    throw new Error(
      "Need a sender. Pass --sender <address> to simulate, or set SWAP_SENDER_KEY to send.",
    );
  }
  const from = getAddress(sender);

  const client = createPublicClient({chain: baseSepolia, transport: http(rpc)}) as PublicClient;

  const [eth, weth, usdc, allowance] = await Promise.all([
    client.getBalance({address: from}),
    client.readContract({address: WETH, abi: WETH_ABI, functionName: "balanceOf", args: [from]}),
    client.readContract({address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [from]}),
    client.readContract({address: WETH, abi: WETH_ABI, functionName: "allowance", args: [from, ROUTER]}),
  ]);

  console.log(`sender    ${from}`);
  console.log(`  ETH     ${formatEther(eth)}`);
  console.log(`  WETH    ${formatEther(weth)}`);
  console.log(`  USDC    ${formatUnits(usdc, 6)}`);
  console.log(`  allowed ${formatEther(allowance)} WETH to the router`);
  console.log(`swap      ${formatEther(amount)} WETH -> USDC on ${POOL} (fee ${POOL_FEE})`);

  if (campaign) {
    console.log(`campaign  ${await checkAttribution(client, getAddress(campaign), from)}`);
  } else {
    console.log("campaign  (pass --campaign to check this wallet can be credited)");
  }

  const needsWrap = weth < amount;
  if (needsWrap && !wrap) {
    throw new Error(
      `Holds ${formatEther(weth)} WETH but needs ${formatEther(amount)}. Pass --wrap to deposit the ` +
        `difference from ETH first — do NOT swap raw ETH, the router would then be the WETH sender and ` +
        `the volume KPI would credit nobody.`,
    );
  }

  // `amountOutMinimum: 0` — acceptable only because this is a testnet fixture whose whole purpose is
  // to emit the two events. Never do this with value at stake: it accepts any price.
  const params = {
    tokenIn: WETH,
    tokenOut: USDC,
    fee: POOL_FEE,
    recipient: from,
    amountIn: amount,
    amountOutMinimum: BigInt(0),
    sqrtPriceLimitX96: BigInt(0),
  } as const;

  const {result: quoted} = await client.simulateContract({
    address: ROUTER,
    abi: ROUTER_ABI,
    functionName: "exactInputSingle",
    args: [params],
    account: from,
  });
  console.log(`simulated ${formatUnits(quoted, 6)} USDC out`);

  if (dryRun || !account) {
    console.log(
      dryRun ? "\n--dry-run: nothing sent." : "\nNo SWAP_SENDER_KEY set, so nothing was sent.",
    );
    return;
  }

  const wallet = createWalletClient({account, chain: baseSepolia, transport: http(rpc)});

  if (needsWrap) {
    const missing = amount - weth;
    const hash = await wallet.writeContract({
      address: WETH,
      abi: WETH_ABI,
      functionName: "deposit",
      value: missing,
    });
    console.log(`wrap      ${formatEther(missing)} ETH -> WETH  ${hash}`);
    await client.waitForTransactionReceipt({hash});
  }

  if (allowance < amount) {
    // Exact-amount approval rather than unlimited: this is a wallet under test, not a wallet in use.
    const hash = await wallet.writeContract({
      address: WETH,
      abi: WETH_ABI,
      functionName: "approve",
      args: [ROUTER, amount],
    });
    console.log(`approve   ${formatEther(amount)} WETH  ${hash}`);
    await client.waitForTransactionReceipt({hash});
  }

  const hash = await wallet.writeContract({
    address: ROUTER,
    abi: ROUTER_ABI,
    functionName: "exactInputSingle",
    args: [params],
  });
  const receipt = await client.waitForTransactionReceipt({hash});
  console.log(`swap      ${hash}  (block ${receipt.blockNumber})`);

  const swapTopic = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
  const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const swaps = receipt.logs.filter(
    (l) => l.address.toLowerCase() === POOL.toLowerCase() && l.topics[0] === swapTopic,
  );
  const wethOut = receipt.logs.filter(
    (l) =>
      l.address.toLowerCase() === WETH.toLowerCase() &&
      l.topics[0] === transferTopic &&
      l.topics[1]?.toLowerCase().endsWith(from.slice(2).toLowerCase()),
  );

  console.log("");
  console.log(`credits   ${swaps.length} pool Swap log(s) with this wallet as recipient: KPI 0 +${swaps.length}`);
  console.log(`          ${wethOut.length} WETH Transfer log(s) from this wallet: KPI 1 +${formatEther(amount)} WETH`);
  console.log("");
  console.log("Now run `pnpm relay` (Boney observes) before `pnpm index` (the project claims).");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
