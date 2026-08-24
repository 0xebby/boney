/**
 * Prepares (and optionally sends) a Sygma bridge deposit that a Boney KPI will actually credit.
 *
 * Usage:
 *   pnpm sygma:deposit --campaign <addr> --sender <addr> [--rpc <url>] [--dry-run]
 *   SYGMA_SENDER_KEY=0x… pnpm sygma:deposit --campaign <addr>            # signs and sends
 *
 * ## Why a script rather than a wallet click
 *
 * The Sygma resource this uses is a **GMP (generic message) resource**, not ERC-20. `GmpHandler.deposit`
 * is `external view` — it validates the payload and returns; no token moves and no approval is needed.
 * The only cost is the bridge fee. That makes it the cheapest possible way to emit a `Deposit` event,
 * which is all a COUNT KPI needs.
 *
 * The payload cannot be copied between wallets, though, which is the reason this builds it rather than
 * hardcoding a known-good blob: `GmpHandler.deposit` ends with
 *
 *     require(depositor == executionDataDepositor, 'incorrect depositor in deposit data')
 *
 * so the sending address is embedded *inside* depositData. Replaying another wallet's transaction
 * reverts.
 *
 * ## What it checks before spending anything
 *
 * A Sygma deposit and a creditable Boney action are two different bars, and clearing the first while
 * missing the second burns a fee for nothing — the event lands, and `reportUserAction` then reverts
 * `NoAttribution` for that wallet. So the pre-flight covers both: the bridge accepting the call, and
 * the campaign being able to credit the sender.
 */
import {readFileSync, existsSync} from "node:fs";
import {resolve, dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {
  createPublicClient,
  createWalletClient,
  http,
  getAddress,
  concat,
  pad,
  toHex,
  formatEther,
  parseAbiItem,
  type Hex,
  type PublicClient,
} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {baseSepolia} from "viem/chains";
import {CampaignAbi, AttributionRegistryAbi} from "../src/lib/abis";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");

/** Sygma's Base Sepolia bridge — the contract campaign 1's KPI watches. */
const BRIDGE = "0x9D5C332Ebe0DaE36e07a4eD552Ad4d8c5067A61F" as const;

/**
 * A GMP resource registered on this bridge, and the destination domain it is routed to.
 *
 * Taken from a deposit that actually succeeded on this bridge (block 45719511) rather than from
 * Sygma's published config: their shared-configuration repo now serves an encrypted topology blob, and
 * the explorer API needs a key. The bridge has processed ~465 deposits across domains 2/3/5/6/7/8/9/
 * 11/12/15/16, so these are live values, not guesses.
 */
const RESOURCE_ID = "0x0000000000000000000000000000000000000000000000000000000000000600" as const;
const DEST_DOMAIN = 5;

/** Mirrors the working deposit. `GmpHandler` only requires `maxFee < MAX_FEE`. */
const MAX_FEE = BigInt(0xe7ef0); // 950,000
/** Any 4-byte selector; nothing executes on the destination in this fixture. */
const EXECUTE_FUNC_SIG = "0x12345678" as const;
const EXECUTE_CONTRACT = "0x1111111111111111111111111111111111111111" as const;

const BRIDGE_ABI = [
  parseAbiItem(
    "function deposit(uint8 destinationDomainID, bytes32 resourceID, bytes depositData, bytes feeData) payable returns (uint64, bytes)",
  ),
  parseAbiItem("function paused() view returns (bool)"),
  parseAbiItem("function _domainID() view returns (uint8)"),
  parseAbiItem("function _resourceIDToHandlerAddress(bytes32) view returns (address)"),
  parseAbiItem("function _feeHandler() view returns (address)"),
];
const FEE_ABI = [
  parseAbiItem(
    "function calculateFee(address sender, uint8 fromDomainID, uint8 destinationDomainID, bytes32 resourceID, bytes depositData, bytes feeData) view returns (uint256 fee, address tokenAddress)",
  ),
];

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
 * `GmpHandler`'s packed layout — lengths are 2 and 1 byte wide, not padded to 32, so this is
 * `encodePacked` territory and `abi.encode` would produce something the handler misreads:
 *
 *   maxFee                      uint256  32 bytes
 *   len(executeFuncSignature)   uint16    2 bytes
 *   executeFuncSignature        bytes     len
 *   len(executeContractAddress) uint8     1 byte
 *   executeContractAddress      bytes     len
 *   len(executionDataDepositor) uint8     1 byte
 *   executionDataDepositor      bytes     len   <- must equal the sender
 *   executionData               bytes     rest
 */
function buildDepositData(sender: `0x${string}`): Hex {
  return concat([
    pad(toHex(MAX_FEE), {size: 32}),
    pad(toHex(4), {size: 2}),
    EXECUTE_FUNC_SIG,
    pad(toHex(20), {size: 1}),
    EXECUTE_CONTRACT,
    pad(toHex(20), {size: 1}),
    sender,
    pad("0x00", {size: 32}), // executionData — empty payload, nothing executes downstream
  ]);
}

async function main() {
  const rpc = arg("--rpc") ?? "https://base-sepolia-rpc.publicnode.com";
  const campaign = arg("--campaign") as `0x${string}` | undefined;
  const dryRun = process.argv.includes("--dry-run");
  const key = envKey("SYGMA_SENDER_KEY");
  const account = key ? privateKeyToAccount(key) : undefined;
  const sender = (arg("--sender") ?? account?.address) as `0x${string}` | undefined;

  if (!sender) {
    throw new Error(
      "Need a sender. Pass --sender <address> to prepare calldata, or set SYGMA_SENDER_KEY to send.",
    );
  }
  const from = getAddress(sender);
  const client = createPublicClient({transport: http(rpc)}) as PublicClient;

  console.log(`sender   ${from}`);
  console.log(`bridge   ${BRIDGE}`);

  // ── bridge will accept the call ───────────────────────────────────────────────────────────────
  const [paused, domainID, handler, feeHandler] = await Promise.all([
    client.readContract({address: BRIDGE, abi: BRIDGE_ABI, functionName: "paused"}),
    client.readContract({address: BRIDGE, abi: BRIDGE_ABI, functionName: "_domainID"}),
    client.readContract({
      address: BRIDGE,
      abi: BRIDGE_ABI,
      functionName: "_resourceIDToHandlerAddress",
      args: [RESOURCE_ID],
    }),
    client.readContract({address: BRIDGE, abi: BRIDGE_ABI, functionName: "_feeHandler"}),
  ]);

  if (paused) throw new Error("bridge is paused — deposit would revert");
  if (Number(domainID) === DEST_DOMAIN) {
    throw new Error(`destination ${DEST_DOMAIN} is this chain's own domain — reverts DepositToCurrentDomain`);
  }
  if (handler === "0x0000000000000000000000000000000000000000") {
    throw new Error(`resource ${RESOURCE_ID} maps to no handler — reverts ResourceIDNotMappedToHandler`);
  }
  console.log(`  domain ${domainID} -> ${DEST_DOMAIN}, handler ${handler}, unpaused`);

  const depositData = buildDepositData(from);
  const [fee] = (await client.readContract({
    address: feeHandler as `0x${string}`,
    abi: FEE_ABI,
    functionName: "calculateFee",
    args: [from, Number(domainID), DEST_DOMAIN, RESOURCE_ID, depositData, "0x"],
  })) as [bigint, `0x${string}`];

  const balance = await client.getBalance({address: from});
  console.log(`  fee ${formatEther(fee)} ETH, sender holds ${formatEther(balance)} ETH`);
  if (balance < fee) throw new Error("sender cannot cover the bridge fee");

  // ── the campaign can actually credit this wallet ──────────────────────────────────────────────
  //
  // Checked separately from the bridge because the two bars are independent: the deposit can succeed
  // while the credit reverts NoAttribution, which spends the fee for nothing.
  if (campaign) {
    const registry = (await client.readContract({
      address: campaign,
      abi: CampaignAbi,
      functionName: "attributionRegistry",
    })) as `0x${string}`;
    const promoterId = (await client.readContract({
      address: registry,
      abi: AttributionRegistryAbi,
      functionName: "activePromoter",
      args: [campaign, from],
    })) as Hex;

    const attributed =
      promoterId !== "0x0000000000000000000000000000000000000000000000000000000000000000";
    console.log(
      `  attribution on ${campaign}: ${attributed ? `live (promoterId ${promoterId.slice(0, 10)}…)` : "NONE"}`,
    );
    if (!attributed) {
      console.log(
        "  ! the deposit would emit its event but credit nobody — reportUserAction reverts\n" +
          "    NoAttribution for this wallet. Sign a touch for it on this campaign first.",
      );
    }
  }

  // ── send, or hand back something pasteable ───────────────────────────────────────────────────
  if (dryRun || !account) {
    console.log("\nprepared call (not sent):");
    console.log(`  to           ${BRIDGE}`);
    console.log(`  value        ${fee} wei   (${formatEther(fee)} ETH)`);
    console.log(`  destDomain   ${DEST_DOMAIN}`);
    console.log(`  resourceID   ${RESOURCE_ID}`);
    console.log(`  depositData  ${depositData}`);
    console.log(`  feeData      0x`);
    if (!account) {
      console.log(
        `\n  No SYGMA_SENDER_KEY set, so this cannot be signed here. Send it from ${from}\n` +
          `  (the attributed wallet), or set SYGMA_SENDER_KEY and re-run.`,
      );
    }
    return;
  }

  const wallet = createWalletClient({account, chain: baseSepolia, transport: http(rpc)});
  const hash = await wallet.writeContract({
    address: BRIDGE,
    abi: BRIDGE_ABI,
    functionName: "deposit",
    args: [DEST_DOMAIN, RESOURCE_ID, depositData, "0x"],
    value: fee,
  });
  const receipt = await client.waitForTransactionReceipt({hash});
  console.log(`\ndeposit ${receipt.status} — ${hash}`);
  console.log(
    "Next: `pnpm relay` must observe it before `pnpm index` reports, or the report credits nothing.",
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
