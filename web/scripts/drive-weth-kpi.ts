/**
 * Drives a campaign's WETH KPIs by wrapping or unwrapping small random amounts.
 *
 * Senders are the wallets behind the `KOL*-REF*` keys in `web/.env.local` — the referrals that have
 * already signed a touch on the campaign. `--count` is **per wallet**, not a total: every eligible
 * wallet makes its own run of deposits, so every promoter holding one moves by the same amount. The
 * WETH address is not hardcoded: it is read out of the campaign's own KPI params, so a fixture
 * pointing at a different token is followed rather than silently missed.
 *
 * Nothing here credits anybody. `WETH.deposit()` only emits the log; `pnpm index` is what reads it,
 * checks attribution and reports the total to the campaign.
 *
 * `--action deposit` wraps ETH and feeds the `Deposit`-sourced KPIs; `--action withdraw` unwraps WETH
 * and feeds the `Withdrawal`-sourced ones. Both are counted per event, so on a count-mode KPI the
 * amount only has to be affordable.
 *
 * Calls inside one wallet's run are spaced by a random 30-60s so the activity spreads over blocks
 * rather than arriving as one burst; `--delay-min 0 --delay-max 0` sends them back to back.
 *
 * Dry run by default — pass `--broadcast` to send. Refuses any chain but Base Sepolia unless
 * `--force-chain` is given.
 *
 * Usage:
 *   pnpm weth:deposit                                    # dry run against campaign 2
 *   pnpm weth:deposit --broadcast                        # 25 deposits per wallet, 0.01-0.05 ETH each
 *   pnpm weth:withdraw --count 10 --broadcast            # 10 unwraps per wallet
 *   pnpm weth:deposit --campaign 0x0a01… --seed 42       # replay an earlier plan exactly
 *   pnpm weth:deposit --delay-min 0 --delay-max 0        # no pacing, as fast as the RPC allows
 */

import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  getAddress,
  http,
  isAddress,
  parseEther,
  type Address,
  type Hex,
} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {baseSepolia} from "viem/chains";
import {CampaignAbi} from "../src/lib/abis/Campaign";
import {CampaignRegistryAbi} from "../src/lib/abis/CampaignRegistry";
import {AttributionRegistryAbi} from "../src/lib/abis/AttributionRegistry";
import {GENERATED_DEPLOYMENTS} from "../src/lib/deployments";
import {AMOUNT_MODE, decodeEventSource, effectiveScale, eventTopic} from "../src/lib/kpiSource";

/** Base Sepolia. A `--force-chain` run is the only way to send anywhere else. */
const EXPECTED_CHAIN_ID = 84532;

/**
 * The two sides of WETH, each with the event a KPI sources from it.
 *
 * `topics[1]` carries the actor either way, which is what lets one KPI encoding serve both.
 */
const ACTIONS = {
  deposit: {
    topic: eventTopic("Deposit(address,uint256)"),
    /** ETH is spent, so the wallet's own balance is the ceiling. */
    funds: "eth",
    noun: "deposit",
    past: "deposited",
  },
  withdraw: {
    topic: eventTopic("Withdrawal(address,uint256)"),
    /** WETH is burned back to ETH; the wallet only needs gas in ETH. */
    funds: "weth",
    noun: "withdrawal",
    past: "withdrawn",
  },
} as const;

type ActionName = keyof typeof ACTIONS;

/** Left unspent per sender so the last deposit in its run still has gas behind it. */
const GAS_RESERVE = parseEther("0.002");

/** Enough of WETH9 to wrap ETH, unwrap it, and read the result back. */
const WETH_ABI = [
  {type: "function", name: "deposit", inputs: [], outputs: [], stateMutability: "payable"},
  {
    type: "function",
    name: "withdraw",
    inputs: [{name: "wad", type: "uint256"}],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "balanceOf",
    inputs: [{name: "", type: "address"}],
    outputs: [{name: "", type: "uint256"}],
    stateMutability: "view",
  },
] as const;

const ZERO_ID = `0x${"0".repeat(64)}`;

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
function asPrivateKey(raw: string | undefined): Hex | undefined {
  if (!raw) return undefined;
  const hex = raw.startsWith("0x") ? raw.slice(2) : raw;
  return /^[0-9a-fA-F]{64}$/.test(hex) ? (`0x${hex}` as Hex) : undefined;
}

/**
 * Seeded PRNG, so a dry run and the `--broadcast` that follows it plan the same amounts.
 *
 * @param seed Any 32-bit integer.
 * @returns A function yielding the next value in [0, 1).
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Waits, so a wallet's deposits land in different blocks.
 *
 * @param ms Milliseconds to wait.
 * @returns A promise resolving once the wait is over.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * Reads a flag's value out of argv.
 *
 * @param argv Arguments after the script name.
 * @param flag Flag to look for, including its leading dashes.
 * @returns The following argument, or undefined when the flag is absent or last.
 */
function flag(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const broadcast = argv.includes("--broadcast");
  const forceChain = argv.includes("--force-chain");
  const includeUnattributed = argv.includes("--include-unattributed");
  const actionName = (flag(argv, "--action") ?? "deposit") as ActionName;
  if (!(actionName in ACTIONS)) throw new Error(`--action must be deposit or withdraw`);
  const action = ACTIONS[actionName];
  const count = Number(flag(argv, "--count") ?? 25);
  const min = parseEther(flag(argv, "--min") ?? "0.01");
  const max = parseEther(flag(argv, "--max") ?? "0.05");
  const step = parseEther(flag(argv, "--step") ?? "0.001");
  const seed = Number(flag(argv, "--seed") ?? Math.floor(Math.random() * 2 ** 31));
  const delayMin = Number(flag(argv, "--delay-min") ?? 30);
  const delayMax = Number(flag(argv, "--delay-max") ?? 60);
  const sendersArg = flag(argv, "--senders") ?? "KOL*-REF*";
  const campaignArg = flag(argv, "--campaign") ?? "2";

  if (!Number.isInteger(count) || count < 1) throw new Error(`--count must be a positive integer`);
  if (max < min) throw new Error(`--max must be at least --min`);
  if (step <= 0n) throw new Error(`--step must be positive`);
  if (!(delayMin >= 0) || !(delayMax >= delayMin)) {
    throw new Error(`--delay-min must be >= 0 and --delay-max at least --delay-min`);
  }

  const root = resolve(process.cwd(), "..");
  const rootEnv = resolve(root, ".env");
  const localEnv = resolve(process.cwd(), ".env.local");

  const rpc =
    fromEnvFile(localEnv, "NEXT_PUBLIC_BASE_SEPOLIA_RPC") ??
    fromEnvFile(rootEnv, "RPC_URL") ??
    "https://base-sepolia-rpc.publicnode.com";

  const publicClient = createPublicClient({chain: baseSepolia, transport: http(rpc)});
  const chainId = await publicClient.getChainId();
  if (chainId !== EXPECTED_CHAIN_ID && !forceChain) {
    throw new Error(`RPC is chain ${chainId}, not Base Sepolia (${EXPECTED_CHAIN_ID}). Refusing.`);
  }

  const deployment = GENERATED_DEPLOYMENTS[EXPECTED_CHAIN_ID];
  const campaign = isAddress(campaignArg)
    ? getAddress(campaignArg)
    : ((await publicClient.readContract({
        address: deployment.campaignRegistry as Address,
        abi: CampaignRegistryAbi,
        functionName: "campaignAt",
        args: [BigInt(campaignArg)],
      })) as Address);

  const read = (functionName: string, args: readonly unknown[] = []) =>
    publicClient.readContract({address: campaign, abi: CampaignAbi, functionName, args});

  const config = (await read("config")) as {name: string; endTime: bigint};
  const status = Number(await read("status"));
  const now = BigInt(Math.floor(Date.now() / 1000));

  console.log(`chain     ${chainId} (Base Sepolia)`);
  console.log(`campaign  ${campaign}  ${config.name}  status=${status}`);
  if (config.endTime <= now) console.log(`  ! ended at ${config.endTime} — deposits will not credit.`);

  // The WETH address comes from the campaign rather than a constant: two mock tokens exist on this
  // chain, and acting on the wrong one leaves no log any KPI is watching.
  const kpiCount = Number(await read("kpiCount"));
  const watched: {index: number; countMode: boolean; scale: bigint; source: Address}[] = [];
  for (let i = 0; i < kpiCount; i++) {
    const spec = (await read("kpi", [BigInt(i)])) as {params: Hex};
    const source = decodeEventSource(spec.params);
    if (!source || source.topic0 !== action.topic) continue;
    watched.push({
      index: i,
      countMode: source.amountMode === AMOUNT_MODE.count,
      scale: effectiveScale(source),
      source: getAddress(source.source),
    });
  }

  if (watched.length === 0) {
    throw new Error(`no KPI on ${config.name} is sourced from a WETH ${action.noun} event`);
  }
  const tokens = new Set(watched.map((k) => k.source));
  if (tokens.size > 1) {
    throw new Error(`${actionName} KPIs disagree on the source token: ${[...tokens].join(", ")}`);
  }
  const weth = watched[0].source;
  console.log(`weth      ${weth}`);
  console.log(`action    ${actionName}`);
  for (const k of watched) {
    console.log(
      `  KPI ${k.index}  ${k.countMode ? `one unit per ${action.noun}` : `one unit per ${formatEther(k.scale)} ETH`}`,
    );
  }

  // Deduplicated by address: two vars holding one key would otherwise take two turns in the deal.
  const keyed = new Map<Address, {key: Hex; names: string[]}>();
  for (const name of namesIn(localEnv).filter(nameMatcher(sendersArg))) {
    const key = asPrivateKey(fromEnvFile(localEnv, name));
    if (!key) continue;
    const address = privateKeyToAccount(key).address;
    keyed.set(address, {key, names: [...(keyed.get(address)?.names ?? []), name]});
  }
  if (keyed.size === 0) throw new Error(`no private keys matched ${sendersArg} in .env.local`);

  const unit = action.funds === "eth" ? "ETH" : "WETH";
  const senders = await Promise.all(
    [...keyed].map(async ([address, {key, names}]) => {
      const eth = await publicClient.getBalance({address});
      const weth9 = (await publicClient.readContract({
        address: weth,
        abi: WETH_ABI,
        functionName: "balanceOf",
        args: [address],
      })) as bigint;
      return {
        address,
        key,
        names,
        eth,
        // What this action actually spends. Gas is checked against `eth` either way.
        balance: action.funds === "eth" ? eth : weth9,
        promoterId: (await publicClient.readContract({
          address: deployment.attributionRegistry as Address,
          abi: AttributionRegistryAbi,
          functionName: "activePromoter",
          args: [campaign, address],
        })) as Hex,
      };
    }),
  );

  // An unattributed wallet's deposit is real and credits nobody — the indexer has no promoter to
  // report it under. Dealing to one would quietly spend the ETH for nothing.
  const eligible = senders.filter((s) => includeUnattributed || s.promoterId !== ZERO_ID);
  console.log(`\nsenders   ${eligible.length} of ${senders.length} matching ${sendersArg}`);
  for (const s of senders) {
    const held = s.promoterId === ZERO_ID ? "no live touch — skipped" : `promoter ${s.promoterId.slice(0, 12)}…`;
    console.log(
      `  ${s.address}  ${formatEther(s.balance).padStart(10)} ${unit.padEnd(4)}  ${s.names.join(", ").padEnd(10)}  ${held}`,
    );
  }
  if (eligible.length === 0) {
    throw new Error(`none of the matched wallets holds a live touch on ${config.name}`);
  }

  // A run per wallet, drawn wallet by wallet so one sender's amounts stay contiguous in the seeded
  // stream — a different `--count` then still reproduces the earlier run's opening deposits.
  const rand = mulberry32(seed);
  const steps = (max - min) / step;
  const runs = eligible.map((sender) => ({
    sender,
    amounts: Array.from(
      {length: count},
      () => min + step * BigInt(Math.floor(rand() * Number(steps + 1n))),
    ),
  }));

  const perSender = new Map<Address, bigint>(
    runs.map(({sender, amounts}) => [sender.address, amounts.reduce((sum, a) => sum + a, 0n)]),
  );
  const total = [...perSender.values()].reduce((sum, a) => sum + a, 0n);

  console.log(
    `\nplan      ${count} ${action.noun}s per wallet x ${eligible.length} = ${count * eligible.length}, ${formatEther(min)}-${formatEther(max)} ${unit} each, seed ${seed}`,
  );
  console.log(`total     ${formatEther(total)} ETH`);
  const midDelay = (delayMin + delayMax) / 2;
  console.log(
    delayMax === 0
      ? `paced     back to back\n`
      : `paced     ${delayMin}-${delayMax}s between a wallet's calls — about ${Math.round((midDelay * (count - 1)) / 60)} min per wallet, run concurrently\n`,
  );

  const short: string[] = [];
  for (const {sender, amounts} of runs) {
    const spend = perSender.get(sender.address)!;
    console.log(
      `  ${sender.names.join(",").padEnd(10)} ${sender.address}  ${amounts.length} x  = ${formatEther(spend)} ${unit}  (of ${formatEther(sender.balance)})`,
    );

    // Gas always comes out of ETH, whichever balance the action itself spends.
    const needed = action.funds === "eth" ? spend + GAS_RESERVE : spend;
    if (sender.balance < needed) {
      short.push(
        `${sender.names.join(",")} ${sender.address} holds ${formatEther(sender.balance)} ${unit}, needs ${formatEther(needed)} — lower --max or --count, or re-seed`,
      );
    }
    if (sender.eth < GAS_RESERVE) {
      short.push(
        `${sender.names.join(",")} ${sender.address} holds ${formatEther(sender.eth)} ETH, short of the ${formatEther(GAS_RESERVE)} ETH gas reserve`,
      );
    }
  }
  if (short.length > 0) throw new Error(`short balances:\n  ${short.join("\n  ")}`);

  // Grouped by promoter, because that is the level a tier pays at. Scaled KPIs are approximate here:
  // the indexer divides each referral's *lifetime* raw total, so its floor can land a unit either way.
  const byPromoter = new Map<Hex, typeof eligible>();
  for (const sender of eligible) {
    byPromoter.set(sender.promoterId, [...(byPromoter.get(sender.promoterId) ?? []), sender]);
  }

  console.log();
  for (const [promoterId, group] of byPromoter) {
    const names = group.map((s) => s.names.join(",")).join(" ");
    // `progressOf` is keyed by the promoter's wallet, not the id the attribution registry returns.
    const promoter = (await read("promoterOf", [promoterId])) as Address;
    console.log(`  promoter ${promoter}  ${names}`);
    for (const kpi of watched) {
      const current = (await read("progressOf", [promoter, BigInt(kpi.index)])) as bigint;
      const raw = group.reduce((sum, s) => sum + (perSender.get(s.address) ?? 0n), 0n);
      const added = kpi.countMode ? BigInt(count * group.length) : raw / kpi.scale;
      const tiers = (await read("tiers", [BigInt(kpi.index)])) as {threshold: bigint}[];
      const reached = tiers.filter((t) => t.threshold <= current + added).length;
      console.log(
        `    KPI ${kpi.index}: ${current} + ~${added} = ~${current + added}  (tier ${reached}/${tiers.length})`,
      );
    }
  }

  if (!broadcast) return console.log(`\ndry run — pass --broadcast --seed ${seed} to send this exact plan.`);

  console.log();

  // One stream per wallet, run concurrently: nonces are per account, so nine wallets can deposit at
  // once, while each wallet's own run stays sequential because its nonces must not race.
  const results = await Promise.all(
    runs.map(async ({sender, amounts}) => {
      const wallet = createWalletClient({
        account: privateKeyToAccount(sender.key),
        chain: baseSepolia,
        transport: http(rpc),
      });
      const label = sender.names.join(",").padEnd(10);
      const pace = mulberry32(seed + 1);
      let sent = 0;

      for (const [i, amount] of amounts.entries()) {
        // Between deposits only: a leading pause would just delay the whole run, and a trailing one
        // would hold the process open after the last receipt.
        if (i > 0 && delayMax > 0) {
          const wait = delayMin + pace() * (delayMax - delayMin);
          console.log(`  ${label} waiting ${wait.toFixed(1)}s`);
          await sleep(wait * 1000);
        }

        const at = `${label} ${String(i + 1).padStart(3)}/${amounts.length}  ${formatEther(amount).padStart(6)} ${unit}`;
        try {
          const hash = await wallet.writeContract(
            actionName === "deposit"
              ? {address: weth, abi: WETH_ABI, functionName: "deposit", value: amount}
              : {address: weth, abi: WETH_ABI, functionName: "withdraw", args: [amount]},
          );
          const receipt = await publicClient.waitForTransactionReceipt({hash});
          sent += receipt.status === "success" ? 1 : 0;
          console.log(`  ${at}  ${receipt.status}  ${hash}`);
        } catch (error) {
          const message = String(error instanceof Error ? error.message : error).split("\n")[0];
          console.log(`  ${at}  failed: ${message}`);
        }
      }

      return sent;
    }),
  );

  const sent = results.reduce((a, b) => a + b, 0);
  console.log(
    `\n${sent}/${count * eligible.length} ${action.past}. Run \`pnpm index\` to credit the promoters.`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
