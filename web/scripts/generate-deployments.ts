/**
 * Generates `src/lib/deployments.ts` from Foundry's broadcast receipt.
 *
 * Hand-transcribing addresses is exactly the class of error that shipped a bricked vault in the
 * contract phase — one wrong character is silent until a call reverts. The broadcast receipt is
 * the source of truth for what actually landed on chain.
 *
 * Usage: pnpm deployments [chainId]   (default 31337)
 */
import {readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync} from "node:fs";
import {resolve, dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {getAddress} from "viem";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");

type BroadcastTx = {
  transactionType?: string;
  contractName?: string | null;
  contractAddress?: string | null;
};

/** Maps Solidity contract names to the keys the app's `Deployment` type uses. */
const KEY_BY_CONTRACT: Record<string, string> = {
  Boney: "boney",
  CampaignRegistry: "campaignRegistry",
  EscrowVault: "escrowVault",
  AttributionRegistry: "attributionRegistry",
  ReputationRegistry: "reputationRegistry",
  AttestationVerifier: "attestationVerifier",
  OracleCoordinator: "oracleCoordinator",
  EventMetricKpiVerifier: "eventMetricKpiVerifier",
  GuardedKpiVerifier: "guardedKpiVerifier",
  TouchWindowVerifier: "touchWindowVerifier",
};

/**
 * Keys that may be absent from a receipt without failing the run.
 *
 * The KPI verification layer was added after the live deployments were made, so a receipt from
 * before that lands without these three. Requiring them would make `pnpm deployments`
 * unrunnable against an existing receipt until a full redeploy — which is a bigger hammer than
 * regenerating addresses warrants. They are optional on the `Deployment` type for the same reason,
 * and get filled in automatically by the next deploy.
 */
const OPTIONAL_KEYS = new Set([
  "eventMetricKpiVerifier",
  "guardedKpiVerifier",
  "touchWindowVerifier",
]);

export function readBroadcast(chainId: number): Record<string, string> {
  const path = resolve(
    REPO_ROOT,
    `broadcast/DeployBoney.s.sol/${chainId}/run-latest.json`,
  );
  if (!existsSync(path)) {
    throw new Error(
      `No broadcast receipt at ${path}\n` +
        `Deploy first:\n` +
        `  PRIVATE_KEY=0x… BONEY_INITIAL_ATTESTOR=0x… forge script ` +
        `script/DeployBoney.s.sol:DeployBoney --rpc-url http://127.0.0.1:8545 --broadcast`,
    );
  }

  const parsed = JSON.parse(readFileSync(path, "utf8")) as {transactions?: BroadcastTx[]};
  const out: Record<string, string> = {};

  for (const tx of parsed.transactions ?? []) {
    if (tx.transactionType !== "CREATE") continue;
    const name = tx.contractName;
    if (!name || !tx.contractAddress) continue;
    const key = KEY_BY_CONTRACT[name];
    if (!key) continue;
    // Checksum the address: viem rejects malformed ones, so a typo cannot survive this step.
    out[key] = getAddress(tx.contractAddress);
  }

  const missing = Object.values(KEY_BY_CONTRACT).filter(
    (k) => !(k in out) && !OPTIONAL_KEYS.has(k),
  );
  if (missing.length > 0) {
    throw new Error(`Broadcast receipt is missing: ${missing.join(", ")}`);
  }

  return out;
}

/**
 * The block the protocol was deployed in — the earliest receipt in the run.
 *
 * This exists so log scans have a floor. Promoters are not enumerable on chain (a campaign emits
 * `PromoterJoined` and stores no list), so listing them means `getLogs`, and public RPCs cap a
 * single query at ~2000 blocks. Without a floor the only honest `fromBlock` is genesis, which on
 * a live L2 is tens of thousands of requests. With it, the scan spans deploy→head.
 *
 * Returns 0 when the receipt carries no block — a scan from genesis is correct on a local chain
 * and merely slow, which is better than guessing a floor that silently hides older events.
 */
export function readStartBlock(chainId: number): number {
  const path = resolve(REPO_ROOT, `broadcast/DeployBoney.s.sol/${chainId}/run-latest.json`);
  if (!existsSync(path)) return 0;

  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    receipts?: {blockNumber?: string | number}[];
  };

  const blocks = (parsed.receipts ?? [])
    .map((r) => (typeof r.blockNumber === "string" ? Number(r.blockNumber) : r.blockNumber))
    .filter((n): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0);

  return blocks.length > 0 ? Math.min(...blocks) : 0;
}

function emit(byChain: Record<number, Record<string, string>>): string {
  const blocks = Object.keys(byChain)
    .map(Number)
    .sort((a, b) => a - b)
    .map((chainId) => {
      const entries = Object.entries(byChain[chainId])
        .map(([k, v]) => `    ${k}: "${v}",`)
        .join("\n");
      // BigInt literal: every consumer compares it against a viem block number, which is bigint.
      const start = `    startBlock: ${readStartBlock(chainId)}n,`;
      return [`  ${chainId}: {`, entries, start, "  },"].join("\n");
    });

  return [
    "// Generated by scripts/generate-deployments.ts — do not edit by hand.",
    "// Regenerate with `pnpm deployments` after redeploying.",
    "",
    "import type {Deployment} from './chains';",
    "",
    "/** Addresses that actually landed on chain, read from Foundry's broadcast receipt. */",
    "export const GENERATED_DEPLOYMENTS: Record<number, Deployment> = {",
    ...blocks,
    "};",
    "",
  ].join("\n");
}

/**
 * Every chain id with a broadcast receipt on disk.
 *
 * The receipt directory is the source of truth for what has been deployed, so emitting all of
 * them keeps a local anvil deployment and a testnet deployment side by side. Emitting only the
 * chain named on the command line would silently drop the other — deploy to Base Sepolia and
 * your anvil addresses vanish from the app.
 */
function deployedChainIds(): number[] {
  const root = resolve(REPO_ROOT, "broadcast/DeployBoney.s.sol");
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map(Number)
    .filter((id) => Number.isInteger(id) && id > 0)
    .filter((id) => existsSync(resolve(root, `${id}/run-latest.json`)));
}

function main(): void {
  // An explicit chain id is a hard requirement — if it was just deployed and its receipt is
  // unreadable, that is an error, not something to skip past.
  const requested = process.argv[2] ? Number(process.argv[2]) : undefined;
  const chainIds = [...new Set([...deployedChainIds(), ...(requested ? [requested] : [])])];

  const byChain: Record<number, Record<string, string>> = {};
  for (const chainId of chainIds) {
    try {
      byChain[chainId] = readBroadcast(chainId);
    } catch (err) {
      if (chainId === requested) throw err;
      // A partial receipt from an aborted deploy should not block regenerating the others.
      console.warn(`  skipped chain ${chainId}: ${(err as Error).message.split("\n")[0]}`);
    }
  }

  if (Object.keys(byChain).length === 0) {
    throw new Error(
      "No usable broadcast receipts found under broadcast/DeployBoney.s.sol/.\n" +
        "Deploy first:\n" +
        "  PRIVATE_KEY=0x… BONEY_INITIAL_ATTESTOR=0x… forge script " +
        "script/DeployBoney.s.sol:DeployBoney --rpc-url <url> --broadcast",
    );
  }

  const outDir = resolve(here, "../src/lib");
  mkdirSync(outDir, {recursive: true});
  writeFileSync(resolve(outDir, "deployments.ts"), emit(byChain));

  for (const chainId of Object.keys(byChain).map(Number).sort((a, b) => a - b)) {
    console.log(`Chain ${chainId}:`);
    for (const [k, v] of Object.entries(byChain[chainId])) {
      console.log(`  ${k.padEnd(20)} ${v}`);
    }
  }
  console.log(`\nWrote src/lib/deployments.ts`);
}

if (process.argv[1]?.endsWith("generate-deployments.ts")) {
  main();
}
