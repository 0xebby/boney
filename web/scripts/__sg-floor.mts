/**
 * Throwaway: the Q2 fold disagreement — whether the subgraph's `KpiAction` superset reconciles with
 * a chain scan once the campaign's own attribution floor is applied to both sides.
 */
import {readFileSync} from "node:fs";
import {createPublicClient, http, getAddress, type Hex} from "viem";
import {baseSepolia} from "viem/chains";

const WETH = "0x4200000000000000000000000000000000000006";
const DEPOSIT = "0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c";
const SB = getAddress("0x0a01B03EBaCBb553AD5b269297921F32D261C45F");
const MAX_LOG_RANGE = 2_000n;

const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const URL_ = env.split("\n").find((l) => /^\s*NEXT_PUBLIC_SUBGRAPH_URL\s*=/.test(l))!
  .split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, "");
const client = createPublicClient({chain: baseSepolia,
  transport: http(process.env.BASE_SEPOLIA_RPC ?? "https://base-sepolia-rpc.publicnode.com")});

async function gql<T>(q: string): Promise<T> {
  for (let a = 0; a < 5; a++) {
    try {
      const r = await fetch(URL_, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({query: q})});
      const b = await r.json() as {data?: T; errors?: unknown};
      if (b.errors) throw new Error(JSON.stringify(b.errors).slice(0, 300));
      return b.data!;
    } catch (e) { if (a === 4) throw e; }
  }
  throw new Error("unreachable");
}
const ms = () => Number(process.hrtime.bigint() / 1_000_000n);

// Honest RPC round trip: readContract, not the cached getBlockNumber action.
{
  const t = ms();
  for (let i = 0; i < 5; i++) await client.request({method: "eth_getBlockByNumber", params: ["latest", false]} as never);
  console.log(`rpc round trip (uncached) ${((ms() - t) / 5).toFixed(0)}ms\n`);
}

const head = await client.getBlockNumber();
const {campaign} = await gql<{campaign: {touches: {user: Hex; signedAt: string; blockNumber: string}[]}}>(`{
  campaign(id: "${SB.toLowerCase()}") { touches(first: 1000) { user signedAt blockNumber } } }`);
const referrals = campaign.touches.map((t) => t.user.toLowerCase());
const floorBlock = campaign.touches.reduce((m, t) => (BigInt(t.blockNumber) < m ? BigInt(t.blockNumber) : m), 2n ** 60n);
const perUserFloor = new Map(campaign.touches.map((t) => [t.user.toLowerCase(), BigInt(t.blockNumber)]));

/** Subgraph fold at three floors: none, campaign-wide, per referral's own touch block. */
const rowsAll: {user: Hex; blockNumber: string}[] = [];
for (let skip = 0; skip < 10000; skip += 1000) {
  const p = await gql<{kpiActions: typeof rowsAll}>(`{
    kpiActions(first: 1000, skip: ${skip}, where: {source: "${WETH}", topic0: "${DEPOSIT}",
      user_in: [${referrals.map((r) => `"${r}"`).join(",")}]}) { user blockNumber } }`);
  rowsAll.push(...p.kpiActions);
  if (p.kpiActions.length < 1000) break;
}
const fold = (rows: typeof rowsAll, keep: (r: typeof rowsAll[number]) => boolean) => {
  const m = new Map<string, number>();
  for (const r of rows) if (keep(r)) m.set(r.user.toLowerCase(), (m.get(r.user.toLowerCase()) ?? 0) + 1);
  return m;
};
const sgNoFloor = fold(rowsAll, () => true);
const sgCampaignFloor = fold(rowsAll, (r) => BigInt(r.blockNumber) >= floorBlock);
const sgUserFloor = fold(rowsAll, (r) => BigInt(r.blockNumber) >= (perUserFloor.get(r.user.toLowerCase()) ?? 0n));

// Chain scan from the campaign-wide floor, same narrowing.
const chainAll = new Map<string, number>();
const chainBlocks = new Map<string, bigint[]>();
const topics = [DEPOSIT, referrals.map((a) => `0x${"0".repeat(24)}${a.slice(2)}`)];
const earliest = rowsAll.reduce((m, r) => (BigInt(r.blockNumber) < m ? BigInt(r.blockNumber) : m), 2n ** 60n);
for (let b = earliest; b <= head; b += MAX_LOG_RANGE) {
  const to = b + MAX_LOG_RANGE - 1n > head ? head : b + MAX_LOG_RANGE - 1n;
  let logs: {topics: Hex[]; blockNumber: Hex}[] = [];
  try {
    logs = await client.request({method: "eth_getLogs", params: [{address: WETH, topics,
      fromBlock: `0x${b.toString(16)}`, toBlock: `0x${to.toString(16)}`}]} as never) as never;
  } catch { console.log(`  (chunk ${b} failed)`); continue; }
  for (const l of logs) {
    const a = `0x${l.topics[1]!.slice(26)}`.toLowerCase();
    chainAll.set(a, (chainAll.get(a) ?? 0) + 1);
    chainBlocks.set(a, [...(chainBlocks.get(a) ?? []), BigInt(l.blockNumber)]);
  }
}
const chainCampaignFloor = new Map<string, number>();
const chainUserFloor = new Map<string, number>();
for (const [a, blocks] of chainBlocks) {
  chainCampaignFloor.set(a, blocks.filter((b) => b >= floorBlock).length);
  chainUserFloor.set(a, blocks.filter((b) => b >= (perUserFloor.get(a) ?? 0n)).length);
}

console.log(`subgraph earliest Deposit row: block ${earliest}   campaign first touch: block ${floorBlock}` +
  `   gap ${floorBlock - earliest} blocks\n`);
console.log(`referral                                     chainRaw sgRaw | chainFloor sgFloor | chainUser sgUser`);
const all = [...new Set([...chainAll.keys(), ...sgNoFloor.keys()])].sort();
for (const a of all) {
  const cols = [chainAll.get(a) ?? 0, sgNoFloor.get(a) ?? 0, chainCampaignFloor.get(a) ?? 0,
    sgCampaignFloor.get(a) ?? 0, chainUserFloor.get(a) ?? 0, sgUserFloor.get(a) ?? 0];
  const bad = cols[0] !== cols[1] || cols[2] !== cols[3] || cols[4] !== cols[5];
  console.log(`${a}  ${cols.map((c) => String(c).padStart(8)).join(" ")}  ${bad ? "<-- differs" : ""}`);
}
const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
console.log(`\ntotals   raw: chain ${sum(chainAll)} / sg ${sum(sgNoFloor)}` +
  `   campaign-floored: chain ${sum(chainCampaignFloor)} / sg ${sum(sgCampaignFloor)}` +
  `   per-referral-floored: chain ${sum(chainUserFloor)} / sg ${sum(sgUserFloor)}`);
console.log(`on-chain credited totalProgress for this KPI: 550`);
