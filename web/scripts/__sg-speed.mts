/**
 * Throwaway: times the two questions the verification pipeline asks, each answered twice — once off
 * chain reads/logs the way the indexer and relayer do it, once off the subgraph.
 */
import {readFileSync} from "node:fs";
import {createPublicClient, http, getAddress, type Hex} from "viem";
import {baseSepolia} from "viem/chains";
import {CampaignAbi} from "../src/lib/abis/Campaign";
import {CampaignRegistryAbi} from "../src/lib/abis/CampaignRegistry";

const REGISTRY = getAddress("0x3e0a2fc423dE77bEE9147879308BFfFC6129c4EE");
const MAX_LOG_RANGE = 2_000n;  // scripts/indexer.ts:83
const WETH = "0x4200000000000000000000000000000000000006";
const DEPOSIT = "0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c";

const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const URL_ = env.split("\n").find((l) => /^\s*NEXT_PUBLIC_SUBGRAPH_URL\s*=/.test(l))!
  .split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, "");

let rpcCalls = 0, gqlCalls = 0;
const client = createPublicClient({
  chain: baseSepolia,
  transport: http(process.env.BASE_SEPOLIA_RPC ?? "https://base-sepolia-rpc.publicnode.com", {
    onFetchRequest: () => { rpcCalls++; },
  }),
});

async function gql<T>(query: string): Promise<T> {
  for (let a = 0; a < 5; a++) {
    gqlCalls++;
    try {
      const res = await fetch(URL_, {
        method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({query}),
      });
      const body = await res.json() as {data?: T; errors?: unknown};
      if (body.errors) throw new Error(JSON.stringify(body.errors).slice(0, 300));
      return body.data!;
    } catch (e) { if (a === 4) throw e; }
  }
  throw new Error("unreachable");
}

const ms = () => Number(process.hrtime.bigint() / 1_000_000n);
const head = await client.getBlockNumber();

{
  const t = ms();
  for (let i = 0; i < 5; i++) await client.getBlockNumber();
  const rpc = (ms() - t) / 5;
  const t2 = ms();
  for (let i = 0; i < 5; i++) await gql(`{ _meta { block { number } } }`);
  console.log(`baseline round trip: rpc ${rpc.toFixed(0)}ms  subgraph ${((ms() - t2) / 5).toFixed(0)}ms\n`);
}

console.log(`### Q1 — every promoter's progress on every KPI, plus settlement, all campaigns`);

const roster: {address: Hex; name: string; wallets: Hex[]}[] = [];
{
  const {campaigns} = await gql<{campaigns: {id: Hex; name: string;
    promoters: {wallet: Hex | null}[]}[]}>(`{
    campaigns(first: 100) { id name promoters(first: 100) { wallet } } }`);
  for (const c of campaigns) {
    roster.push({address: getAddress(c.id), name: c.name,
      wallets: c.promoters.filter((p) => p.wallet).map((p) => getAddress(p.wallet!))});
  }
}

rpcCalls = 0;
const tChain = ms();
let figures = 0;
const count = await client.readContract({
  address: REGISTRY, abi: CampaignRegistryAbi, functionName: "campaignCount"}) as bigint;
for (let id = 0n; id < count; id++) {
  const address = await client.readContract({
    address: REGISTRY, abi: CampaignRegistryAbi, functionName: "campaignAt", args: [id]}) as Hex;
  const entry = roster.find((r) => r.address === getAddress(address))!;
  const kpiCount = await client.readContract({address, abi: CampaignAbi, functionName: "kpiCount"}) as bigint;
  await client.readContract({address, abi: CampaignAbi, functionName: "remainingPool"});
  for (let k = 0n; k < kpiCount; k++) {
    await client.readContract({address, abi: CampaignAbi, functionName: "totalProgress", args: [k]});
    figures++;
    for (const w of entry.wallets) {
      await Promise.all([
        client.readContract({address, abi: CampaignAbi, functionName: "progressOf", args: [w, k]}),
        client.readContract({address, abi: CampaignAbi, functionName: "settledTiersOf", args: [w, k]}),
      ]);
      figures += 2;
    }
  }
}
const chainMs = ms() - tChain, chainCalls = rpcCalls;

gqlCalls = 0;
const tSg = ms();
const credits: unknown[] = [], payouts: unknown[] = [];
for (let skip = 0; ; skip += 1000) {
  const p = await gql<{credits: unknown[]}>(`{ credits(first: 1000, skip: ${skip}) { campaign { id } kpiIndex promoterId user amount } }`);
  credits.push(...p.credits); if (p.credits.length < 1000) break;
}
for (let skip = 0; ; skip += 1000) {
  const p = await gql<{tierPayouts: unknown[]}>(`{ tierPayouts(first: 1000, skip: ${skip}) { campaign { id } promoter kpiIndex tier paid } }`);
  payouts.push(...p.tierPayouts); if (p.tierPayouts.length < 1000) break;
}
const sgMs = ms() - tSg, sgCalls = gqlCalls;

console.log(`  chain    ${String(chainMs).padStart(6)}ms  ${chainCalls} JSON-RPC requests  (${figures} figures)`);
console.log(`  subgraph ${String(sgMs).padStart(6)}ms  ${sgCalls} POST  (${credits.length} Credit + ${payouts.length} TierPayout rows → every figure above)`);
console.log(`  ${(chainMs / sgMs).toFixed(1)}x faster, ${(chainCalls / sgCalls).toFixed(0)}x fewer requests\n`);

// ================= Q2: the observation fold for one KPI — SuperBridge 0, WETH Deposit =================
const SB = getAddress("0x0a01B03EBaCBb553AD5b269297921F32D261C45F");
const {campaign} = await gql<{campaign: {touches: {user: Hex; blockNumber: string}[]}}>(`{
  campaign(id: "${SB.toLowerCase()}") { touches(first: 1000) { user blockNumber } } }`);
const referrals = campaign.touches.map((t) => t.user.toLowerCase());
const from = campaign.touches.reduce((m, t) => (BigInt(t.blockNumber) < m ? BigInt(t.blockNumber) : m), 2n ** 60n);

console.log(`### Q2 — observed action fold, SuperBridge KPI 0 (WETH Deposit, count, T1)`);
console.log(`    ${referrals.length} referrals, blocks ${from}..${head} (${head - from} blocks)`);

rpcCalls = 0;
const tLogs = ms();
const byActorChain = new Map<string, number>();
let chunks = 0;
const topics = [DEPOSIT, referrals.map((a) => `0x${"0".repeat(24)}${a.slice(2)}`)];
for (let b = from; b <= head; b += MAX_LOG_RANGE) {
  const to = b + MAX_LOG_RANGE - 1n > head ? head : b + MAX_LOG_RANGE - 1n;
  chunks++;
  let logs: {topics: Hex[]}[] = [];
  try {
    logs = await client.request({method: "eth_getLogs", params: [{
      address: WETH, topics, fromBlock: `0x${b.toString(16)}`, toBlock: `0x${to.toString(16)}`,
    }]} as never) as never;
  } catch { continue; }
  for (const l of logs) {
    const actor = `0x${l.topics[1]!.slice(26)}`.toLowerCase();
    byActorChain.set(actor, (byActorChain.get(actor) ?? 0) + 1);
  }
}
const logsMs = ms() - tLogs, logsCalls = rpcCalls;

gqlCalls = 0;
const tActions = ms();
const byActorSg = new Map<string, number>();
let rows = 0;
for (let skip = 0; skip < 6000; skip += 1000) {
  const p = await gql<{kpiActions: {user: Hex}[]}>(`{
    kpiActions(first: 1000, skip: ${skip}, where: {source: "${WETH}", topic0: "${DEPOSIT}",
      user_in: [${referrals.map((r) => `"${r}"`).join(",")}]}) { user } }`);
  rows += p.kpiActions.length;
  for (const a of p.kpiActions) {
    const u = a.user.toLowerCase();
    byActorSg.set(u, (byActorSg.get(u) ?? 0) + 1);
  }
  if (p.kpiActions.length < 1000) break;
}
const actionsMs = ms() - tActions, actionsCalls = gqlCalls;

const chainRows = [...byActorChain.values()].reduce((a, b) => a + b, 0);
console.log(`  chain    ${String(logsMs).padStart(6)}ms  ${logsCalls} eth_getLogs (${chunks} chunks of ${MAX_LOG_RANGE})  ${chainRows} logs, ${byActorChain.size} actors`);
console.log(`  subgraph ${String(actionsMs).padStart(6)}ms  ${actionsCalls} POST  ${rows} rows, ${byActorSg.size} actors`);
console.log(`  ${(logsMs / actionsMs).toFixed(1)}x faster, ${(logsCalls / actionsCalls).toFixed(0)}x fewer requests`);

const agree = [...byActorChain.keys()].every((a) => byActorChain.get(a) === byActorSg.get(a)) &&
  byActorChain.size === byActorSg.size;
console.log(`  folds agree per actor: ${agree ? "yes" : "NO"}`);
if (!agree) {
  for (const a of new Set([...byActorChain.keys(), ...byActorSg.keys()])) {
    if (byActorChain.get(a) !== byActorSg.get(a)) console.log(`    ${a} chain=${byActorChain.get(a) ?? 0} subgraph=${byActorSg.get(a) ?? 0}`);
  }
}
