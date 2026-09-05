/**
 * Throwaway: does the reconciler's Venus flag survive the two ways it could be a false positive —
 * subgraph rows missing before the template's spawn block, and a re-signed referral whose windows
 * a single `signedAt` floor understates?
 */
import {readFileSync} from "node:fs";
import {createPublicClient, http, getAddress, type Hex} from "viem";
import {baseSepolia} from "viem/chains";
import {CampaignAbi} from "../src/lib/abis/Campaign";

const WETH = "0x4200000000000000000000000000000000000006";
const DEPOSIT = "0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c";
const VENUS = getAddress("0x16FE7197F7Df62D86CD7606FA6F72dBF30A23491");
const SUSPECT = "0x98bef22956549f6ab41db8828db539c185ea3f1b";

const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const URL_ = env.split("\n").find((l) => /^\s*NEXT_PUBLIC_SUBGRAPH_URL\s*=/.test(l))!
  .split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, "");
const client = createPublicClient({chain: baseSepolia,
  transport: http(process.env.BASE_SEPOLIA_RPC ?? "https://base-sepolia-rpc.publicnode.com")});
async function gql<T>(q: string): Promise<T> {
  for (let a = 0; a < 6; a++) {
    try {
      const r = await fetch(URL_, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({query: q})});
      const b = await r.json() as {data?: T; errors?: unknown};
      if (b.errors) throw new Error(JSON.stringify(b.errors).slice(0, 300));
      return b.data!;
    } catch (e) { if (a === 5) throw e; }
  }
  throw new Error("unreachable");
}

const head = await client.getBlockNumber();
const {campaign, spawnedSources} = await gql<{
  campaign: {createdAtBlock: string; touches: {user: Hex; signedAt: string; blockNumber: string}[]};
  spawnedSources: {template: string; spawnedAtBlock: string}[];
}>(`{
  campaign(id: "${VENUS.toLowerCase()}") { createdAtBlock touches(first: 1000) { user signedAt blockNumber } }
  spawnedSources(first: 10, where: {template: "WethDeposit"}) { template spawnedAtBlock } }`);

console.log(`Venus createdAtBlock ${campaign.createdAtBlock}   WethDeposit spawnedAtBlock ${spawnedSources[0]!.spawnedAtBlock}`);
console.log(`touches (${campaign.touches.length}) — one row per referral, superseded not retained:`);
for (const t of campaign.touches) console.log(`  ${t.user} signedAt=${t.signedAt} block=${t.blockNumber}`);

const users = campaign.touches.map((t) => t.user.toLowerCase());
console.log(`\ndistinct referrals: ${new Set(users).size} of ${users.length} touch rows` +
  ` → ${new Set(users).size === users.length ? "no duplicate users; re-signing invisible here by design" : "duplicates"}`);

// Full-history chain scan for the flagged referral, from well before the template spawned.
const from = 46_100_000n;
let logs = 0;
const blocks: bigint[] = [];
for (let b = from; b <= head; b += 2000n) {
  const to = b + 1999n > head ? head : b + 1999n;
  try {
    const res = await client.request({method: "eth_getLogs", params: [{address: WETH,
      topics: [DEPOSIT, `0x${"0".repeat(24)}${SUSPECT.slice(2)}`],
      fromBlock: `0x${b.toString(16)}`, toBlock: `0x${to.toString(16)}`}]} as never) as {blockNumber: Hex; data: Hex}[];
    logs += res.length;
    for (const l of res) blocks.push(BigInt(l.blockNumber));
  } catch { console.log(`  (chunk ${b} failed)`); }
}
const sgRows = await gql<{kpiActions: {blockNumber: string}[]}>(`{
  kpiActions(first: 1000, where: {source: "${WETH}", topic0: "${DEPOSIT}", user: "${SUSPECT}"}) { blockNumber } }`);
console.log(`\n${SUSPECT}:`);
console.log(`  chain full scan from ${from}: ${logs} Deposit logs, first at ${blocks.length ? blocks[0] : "-"}`);
console.log(`  subgraph KpiAction rows: ${sgRows.kpiActions.length}, first at ${sgRows.kpiActions[0]?.blockNumber ?? "-"}`);
console.log(`  ${logs === sgRows.kpiActions.length ? "subgraph is complete for this actor — no pre-spawn gap" : "GAP: subgraph missing rows"}`);

const touch = campaign.touches.find((t) => t.user.toLowerCase() === SUSPECT)!;
const before = blocks.filter((b) => b < BigInt(touch.blockNumber)).length;
console.log(`  its touch landed at block ${touch.blockNumber}; ${before} of those ${logs} logs predate it`);
for (const k of [0n, 1n]) {
  const credited = await client.readContract({address: VENUS, abi: CampaignAbi,
    functionName: "userCreditedOf", args: [SUSPECT as Hex, k]}) as bigint;
  console.log(`  KPI ${k} credited=${credited}`);
}
