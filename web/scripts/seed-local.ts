/**
 * One-command chain setup: deploy → seed → generate deployments → extract ABIs.
 *
 * Every step here was run by hand at least once, and the hand-run is the problem. `SeedLocal`
 * needs four addresses that only exist after `DeployBoney`, so seeding meant copying them out of
 * forge's log and into an env var — exactly the transcription error `generate-deployments.ts`
 * was written to eliminate one layer up. This reads them from the broadcast receipt instead, so
 * the addresses the seed writes to are the ones that landed on chain, by construction.
 *
 * Usage: pnpm seed [--rpc <url>] [--skip-deploy]
 *
 * Defaults to a local anvil, which must already be running — starting it is deliberately left to
 * you, because a script that spawns a chain it does not own tends to orphan it.
 *
 * Against any other chain (`--rpc https://base-sepolia-rpc.publicnode.com`), `PRIVATE_KEY` from the
 * repo-root `.env` becomes the deployer, attestor, and campaign owner. The chain id is read from the
 * node rather than passed as a flag, so the receipt read back is always the one just written.
 */
import {execFileSync} from "node:child_process";
import {readFileSync, existsSync} from "node:fs";
import {resolve, dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {keccak256, toHex} from "viem";
import {readBroadcast} from "./generate-deployments";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");

/** Anvil's first two deterministic accounts — funded, and the local deployer and project. */
const ANVIL_DEPLOYER_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ANVIL_PROJECT_PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

/**
 * The two seeded promoters need their own keys, because each sends its own `join()` and
 * `Campaign.join()` rejects a repeat address — one wallet cannot be both.
 *
 * On anvil they are deterministic accounts 2 and 3, which `live.test.ts` pins by address. On any
 * public chain those keys are unusable: sweeper bots drain anvil's well-known accounts within
 * seconds, so a gas top-up disappears before the seed can spend it. There the keys are derived
 * from the deployer instead — private, stable across reseeds, and reproducible from the same
 * `.env` without storing another secret on disk.
 */
const ANVIL_PROMOTER_PKS = [
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
];
/** A `join()` is ~200k gas; on an L2 this is orders of magnitude more than enough. */
const PROMOTER_TOPUP_WEI = 2_000_000_000_000_000n; // 0.002 ETH
const PROMOTER_MIN_WEI = 200_000_000_000_000n; // 0.0002 ETH

const ANVIL_CHAIN_ID = 31337;

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

const rpc = arg("--rpc") ?? "http://127.0.0.1:8545";
const skipDeploy = process.argv.includes("--skip-deploy");

function capture(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function run(label: string, cmd: string, args: string[], env: Record<string, string> = {}) {
  process.stdout.write(`\n> ${label}\n`);
  try {
    execFileSync(cmd, args, {
      cwd: REPO_ROOT,
      env: {...process.env, ...env},
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
  } catch (err) {
    const e = err as {stdout?: string; stderr?: string};
    process.stderr.write(`${label} failed\n`);
    if (e.stdout) process.stderr.write(e.stdout);
    if (e.stderr) process.stderr.write(e.stderr);
    process.exit(1);
  }
}

/**
 * `PRIVATE_KEY` out of the repo-root `.env`.
 *
 * Foundry loads that file itself, but this script shells out to `cast` for balance checks and
 * top-ups before forge ever runs, so it has to read the key the same way forge will.
 */
function envPrivateKey(): string | undefined {
  if (process.env.PRIVATE_KEY) return process.env.PRIVATE_KEY;
  const path = resolve(REPO_ROOT, ".env");
  if (!existsSync(path)) return undefined;
  const line = readFileSync(path, "utf8")
    .split("\n")
    .find((l) => /^\s*PRIVATE_KEY\s*=/.test(l));
  return line?.split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, "") || undefined;
}

// A chain that is not up produces a forge error much less legible than this one.
try {
  execFileSync("cast", ["block-number", "--rpc-url", rpc], {stdio: "ignore"});
} catch {
  process.stderr.write(
    `No chain at ${rpc}. Start one first:\n\n  anvil --host 0.0.0.0 --port 8545\n\n`,
  );
  process.exit(1);
}

// Read the chain id rather than trusting a flag: the receipt directory is keyed by it, so a
// wrong value here reads back a different chain's deployment.
const chainId = Number(capture("cast", ["chain-id", "--rpc-url", rpc]));
const isAnvil = chainId === ANVIL_CHAIN_ID;

const deployerPk = isAnvil ? ANVIL_DEPLOYER_PK : envPrivateKey();
if (!deployerPk) {
  process.stderr.write(
    `Chain ${chainId} is not a local anvil, so seeding needs a funded key.\n` +
      `Set PRIVATE_KEY in ${resolve(REPO_ROOT, ".env")} and re-run.\n`,
  );
  process.exit(1);
}
const deployer = capture("cast", ["wallet", "address", "--private-key", deployerPk]);

process.stdout.write(`Chain ${chainId} at ${rpc}\nDeployer ${deployer}\n`);

if (!skipDeploy) {
  run(
    "Deploying protocol",
    "forge",
    [
      "script",
      "script/DeployBoney.s.sol:DeployBoney",
      "--rpc-url",
      rpc,
      "--broadcast",
      // One transaction at a time off anvil: a public chain will not reliably accept a burst of
      // same-sender transactions, and a dropped one leaves a half-wired protocol.
      ...(isAnvil ? [] : ["--slow"]),
    ],
    {PRIVATE_KEY: deployerPk, BONEY_INITIAL_ATTESTOR: deployer},
  );
}

// The receipt is the source of truth — not the log lines, and certainly not a human's clipboard.
const addresses = readBroadcast(chainId);

const required = ["campaignRegistry", "escrowVault", "attributionRegistry", "reputationRegistry"];
const missing = required.filter((k) => !addresses[k]);
if (missing.length > 0) {
  process.stderr.write(
    `Broadcast receipt is missing: ${missing.join(", ")}\n` +
      `Re-run without --skip-deploy to redeploy.\n`,
  );
  process.exit(1);
}

// Anvil pre-funds every deterministic account; no other chain does. The seeded promoters send
// their own join(), so without gas the seed dies partway through on an out-of-funds error,
// after the campaigns have already been created and paid for.
const promoterPks = isAnvil
  ? ANVIL_PROMOTER_PKS
  : ANVIL_PROMOTER_PKS.map((_, i) =>
      // Hashed in-process rather than via `cast keccak`, which reads a leading `0x` as hex bytes
      // and rejects the odd-length string that follows.
      keccak256(toHex(`${deployerPk}:boney-promoter-${i}`)),
    );

if (!isAnvil) {
  for (const pk of promoterPks) {
    const addr = capture("cast", ["wallet", "address", "--private-key", pk]);
    const balance = BigInt(capture("cast", ["balance", addr, "--rpc-url", rpc]));
    if (balance >= PROMOTER_MIN_WEI) {
      process.stdout.write(`\nPromoter ${addr} already funded\n`);
      continue;
    }
    run(`Funding promoter ${addr}`, "cast", [
      "send",
      addr,
      "--value",
      PROMOTER_TOPUP_WEI.toString(),
      "--private-key",
      deployerPk,
      "--rpc-url",
      rpc,
    ]);
  }
}

run(
  "Seeding campaigns",
  "forge",
  [
    "script",
    "script/SeedLocal.s.sol:SeedLocal",
    "--rpc-url",
    rpc,
    "--broadcast",
    ...(isAnvil ? [] : ["--slow"]),
  ],
  {
    PRIVATE_KEY: deployerPk,
    // Off anvil, deployer and project are both the funded wallet — so the seeded campaigns show
    // up under "My Campaigns" for the wallet you connect with. On anvil these are the script's
    // own defaults, so the local fixture is exactly what it has always been.
    SEED_DEPLOYER_PK: deployerPk,
    SEED_PROJECT_PK: isAnvil ? ANVIL_PROJECT_PK : deployerPk,
    // These two keys stay `SEED_KOL*`: they are read by name in `script/SeedLocal.s.sol`, which is
    // outside this rename's scope. Renaming them here alone would silently unset them.
    SEED_KOL_PK: promoterPks[0],
    SEED_KOL2_PK: promoterPks[1],
    REGISTRY_ADDRESS: addresses.campaignRegistry,
    VAULT_ADDRESS: addresses.escrowVault,
    ATTRIBUTION_ADDRESS: addresses.attributionRegistry,
    REPUTATION_ADDRESS: addresses.reputationRegistry,
  },
);

run("Generating deployments.ts", "npx", [
  "tsx",
  "web/scripts/generate-deployments.ts",
  String(chainId),
]);
run("Extracting ABIs", "npx", ["tsx", "web/scripts/extract-abis.ts"]);

process.stdout.write(`\nChain ${chainId} ready.\n`);
for (const key of Object.keys(addresses).sort()) {
  process.stdout.write(`  ${key.padEnd(20)} ${addresses[key]}\n`);
}
process.stdout.write(
  `\nNext:\n  pnpm dev\n` +
    (isAnvil ? `  LIVE_CHAIN=1 pnpm test        # read path against the real chain\n` : ""),
);
