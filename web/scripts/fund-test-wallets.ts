/**
 * Tops up the fixture's test wallets with Base Sepolia ETH from the attestor key.
 *
 * Recipients are the wallets behind the named keys in the repo-root `.env`, plus any extra addresses
 * passed as arguments. The funder is `ATTESTOR_PRIVATE_KEY` from `web/.env.local`.
 *
 * Dry run by default — pass `--broadcast` to actually send. Refuses any chain but Base Sepolia
 * unless `--force-chain` is given: the same call that moves a free testnet ETH moves a real one on
 * mainnet, and the only difference is which RPC answered.
 *
 * Usage:
 *   pnpm fund:test                                  # dry run, 1 ETH each
 *   pnpm fund:test --broadcast                       # send
 *   pnpm fund:test --amount 0.05 --broadcast         # send a smaller top-up
 *   pnpm fund:test 0xabc… --broadcast                # include an extra recipient
 *   pnpm fund:test --from REPORTER_PRIVATE_KEY --recipients 'KOL*-REF*' --broadcast
 */

import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {createWalletClient, createPublicClient, formatEther, http, parseEther, isAddress} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {baseSepolia} from "viem/chains";

/** Keys in the repo-root `.env` whose wallets the fixture drives transactions from. */
const RECIPIENT_KEYS = [
  "PRIVATE_KEY",
  "REPORTER_PRIVATE_KEY",
  "REFERRAL_PRIVATE_KEY",
  "SYGMA_SENDER_KEY",
  "ETHOS_PK",
] as const;

/** Base Sepolia. A `--force-chain` run is the only way to send anywhere else. */
const EXPECTED_CHAIN_ID = 84532;

/**
 * Reads one variable out of a dotenv file without sourcing it.
 *
 * @param file Path to the dotenv file.
 * @param name Variable to read.
 * @returns The value, or undefined when the file or the variable is absent.
 */
function fromEnvFile(file: string, name: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }

  for (const line of text.split("\n")) {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)$/);
    if (!match || match[1] !== name) continue;
    const value = match[2].trim().replace(/^["']|["']$/g, "");
    if (value) return value;
  }

  return undefined;
}

/**
 * Lists the variable names a dotenv file defines, in file order.
 *
 * @param file Path to the dotenv file.
 * @returns The uncommented names, or an empty array when the file is absent.
 */
function namesIn(file: string): string[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }

  const names: string[] = [];
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.+)$/);
    if (match) names.push(match[1]);
  }

  return names;
}

/**
 * Compiles a `KOL*-REF*` style pattern to a matcher over variable names.
 *
 * @param pattern Literal text with `*` standing for any run of characters.
 * @returns A predicate over a variable name.
 */
function nameMatcher(pattern: string): (name: string) => boolean {
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  const re = new RegExp(`^${source}$`);
  return (name) => re.test(name);
}

/**
 * Normalises a dotenv private key to the 0x form viem wants.
 *
 * @param raw The value as it appears in the file.
 * @returns The prefixed key, or undefined when it is not 32 bytes of hex.
 */
function asPrivateKey(raw: string | undefined): `0x${string}` | undefined {
  if (!raw) return undefined;
  const hex = raw.startsWith("0x") ? raw.slice(2) : raw;
  return /^[0-9a-fA-F]{64}$/.test(hex) ? (`0x${hex}` as const) : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const broadcast = argv.includes("--broadcast");
  const forceChain = argv.includes("--force-chain");
  const amountArg = argv[argv.indexOf("--amount") + 1];
  const amount = parseEther(argv.includes("--amount") && amountArg ? amountArg : "1");
  const extras = argv.filter((a) => isAddress(a));
  const fromArg = argv.includes("--from") ? argv[argv.indexOf("--from") + 1] : undefined;
  const recipientsArg = argv.includes("--recipients")
    ? argv[argv.indexOf("--recipients") + 1]
    : undefined;

  const root = resolve(process.cwd(), "..");
  const rootEnv = resolve(root, ".env");
  const localEnv = resolve(process.cwd(), ".env.local");

  const funderVar = fromArg ?? "ATTESTOR_PRIVATE_KEY";
  const funderKey = asPrivateKey(
    fromEnvFile(localEnv, funderVar) ?? fromEnvFile(rootEnv, funderVar),
  );
  if (!funderKey) throw new Error(`${funderVar} missing or malformed in .env.local and .env`);
  const funder = privateKeyToAccount(funderKey);

  const rpc =
    fromEnvFile(localEnv, "NEXT_PUBLIC_BASE_SEPOLIA_RPC") ??
    fromEnvFile(rootEnv, "RPC_URL") ??
    "https://base-sepolia-rpc.publicnode.com";

  const publicClient = createPublicClient({chain: baseSepolia, transport: http(rpc)});
  const chainId = await publicClient.getChainId();
  if (chainId !== EXPECTED_CHAIN_ID && !forceChain) {
    throw new Error(`RPC is chain ${chainId}, not Base Sepolia (${EXPECTED_CHAIN_ID}). Refusing.`);
  }

  // Deduplicated: several of these vars hold the same key on purpose — the reporter must be the
  // project key, and the attestor is ETHOS_PK — so a naive list pays the same wallet three times.
  const sources: {file: string; names: string[]}[] = recipientsArg
    ? [
        {file: localEnv, names: namesIn(localEnv).filter(nameMatcher(recipientsArg))},
        {file: rootEnv, names: namesIn(rootEnv).filter(nameMatcher(recipientsArg))},
      ]
    : [{file: rootEnv, names: [...RECIPIENT_KEYS]}];

  const targets = new Map<string, string[]>();
  for (const {file, names} of sources) {
    for (const name of names) {
      const key = asPrivateKey(fromEnvFile(file, name));
      if (!key) continue;
      const address = privateKeyToAccount(key).address;
      targets.set(address, [...(targets.get(address) ?? []), name]);
    }
  }

  if (recipientsArg && targets.size === 0) {
    throw new Error(`no private keys matched ${recipientsArg} in .env.local or .env`);
  }
  for (const extra of extras) {
    const address = extra as `0x${string}`;
    targets.set(address, [...(targets.get(address) ?? []), "argument"]);
  }
  targets.delete(funder.address);

  const rows = await Promise.all(
    [...targets].map(async ([address, names]) => ({
      address: address as `0x${string}`,
      names,
      balance: await publicClient.getBalance({address: address as `0x${string}`}),
    })),
  );

  const funderBalance = await publicClient.getBalance({address: funder.address});
  const total = amount * BigInt(rows.length);

  console.log(`chain    ${chainId} (Base Sepolia)`);
  console.log(`funder   ${funder.address}  ${formatEther(funderBalance)} ETH  (${funderVar})`);
  console.log(`sending  ${formatEther(amount)} ETH x ${rows.length} = ${formatEther(total)} ETH\n`);
  for (const row of rows) {
    console.log(`  ${row.address}  ${formatEther(row.balance).padStart(12)} ETH  ${row.names.join(", ")}`);
  }
  console.log();

  if (rows.length === 0) return console.log("nothing to fund.");

  // Gas is left out of this comparison deliberately: it is a rounding error against whole ETH, and
  // an exact reserve would have to guess at the fee market. A short balance fails here, not midway.
  if (funderBalance < total) {
    throw new Error(
      `funder holds ${formatEther(funderBalance)} ETH, needs ${formatEther(total)} ETH plus gas.`,
    );
  }

  if (!broadcast) return console.log("dry run — pass --broadcast to send.");

  const wallet = createWalletClient({account: funder, chain: baseSepolia, transport: http(rpc)});
  for (const row of rows) {
    const hash = await wallet.sendTransaction({to: row.address, value: amount});
    const receipt = await publicClient.waitForTransactionReceipt({hash});
    console.log(`  ${row.address}  ${receipt.status}  ${hash}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
