/**
 * Throwaway: the reconciler seat, run for real. For every KPI the subgraph can observe, folds
 * `KpiAction` under the campaign's own attribution floor and scale and compares it to what the
 * campaign credited, per referral.
 */
import {readFileSync} from "node:fs";
import {createPublicClient, http, getAddress, type Hex} from "viem";
import {baseSepolia} from "viem/chains";
import {CampaignAbi} from "../src/lib/abis/Campaign";
import {decodeEventSource, AMOUNT_MODE, effectiveScale} from "../src/lib/kpiSource";

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
const ms = () => Number(process.hrtime.bigint() / 1_000_000n);

/** The five (campaign, kpi) pairs the coverage pass found observable. */
const TARGETS: [string, number][] = [
  ["0x16FE7197F7Df62D86CD7606FA6F72dBF30A23491", 0],  // Venus       Deposit sum  1e15
  ["0x16FE7197F7Df62D86CD7606FA6F72dBF30A23491", 1],  // Venus       Deposit count
  ["0x0a01B03EBaCBb553AD5b269297921F32D261C45F", 0],  // SuperBridge Deposit count
  ["0x0a01B03EBaCBb553AD5b269297921F32D261C45F", 2],  // SuperBridge Deposit sum  1e16
  ["0x101431E3Cc9d8fec1221c0ED888c210f5E362b8b", 2],  // Uniswap     Deposit count
];

const t0 = ms();
let flagged = 0, checked = 0;
for (const [addr, k] of TARGETS) {
  const campaign = getAddress(addr);
  const spec = await client.readContract({address: campaign, abi: CampaignAbi, functionName: "kpi", args: [BigInt(k)]}) as Record<string, unknown>;
  const src = decodeEventSource(spec.params as Hex)!;
  const scale = effectiveScale(src);
  const total = await client.readContract({address: campaign, abi: CampaignAbi, functionName: "totalProgress", args: [BigInt(k)]}) as bigint;

  const {campaign: sg} = await gql<{campaign: {name: string; touches: {user: Hex; signedAt: string}[]}}>(`{
    campaign(id: "${campaign.toLowerCase()}") { name touches(first: 1000) { user signedAt } } }`);
  const signedAt = new Map(sg.touches.map((t) => [t.user.toLowerCase(), BigInt(t.signedAt)]));
  const users = [...signedAt.keys()];

  const rows: {user: Hex; value: string; timestamp: string}[] = [];
  for (let skip = 0; skip < 20000; skip += 1000) {
    const p = await gql<{kpiActions: typeof rows}>(`{
      kpiActions(first: 1000, skip: ${skip}, where: {source: "${src.source.toLowerCase()}",
        topic0: "${(src.topic0 as string).toLowerCase()}", user_in: [${users.map((u) => `"${u}"`).join(",")}]})
      { user value timestamp } }`);
    rows.push(...p.kpiActions);
    if (p.kpiActions.length < 1000) break;
  }

  const observed = new Map<string, bigint>();
  for (const r of rows) {
    const u = r.user.toLowerCase();
    if (BigInt(r.timestamp) < (signedAt.get(u) ?? 0n)) continue;   // aggregateDeltas' floor
    const raw = src.amountMode === AMOUNT_MODE.count ? 1n : BigInt(r.value);
    observed.set(u, (observed.get(u) ?? 0n) + raw);
  }
  for (const [u, v] of observed) observed.set(u, v / scale);

  console.log(`\n=== ${sg.name} KPI ${k}  ${src.amountMode === AMOUNT_MODE.count ? "count" : "sum"} scale=${scale}` +
    `  totalProgress=${total}  (${rows.length} subgraph rows over ${users.length} referrals)`);
  let sumObs = 0n, sumCred = 0n;
  for (const u of users) {
    const credited = await client.readContract({address: campaign, abi: CampaignAbi,
      functionName: "userCreditedOf", args: [u as Hex, BigInt(k)]}) as bigint;
    const obs = observed.get(u) ?? 0n;
    sumObs += obs; sumCred += credited;
    if (credited === 0n && obs === 0n) continue;
    checked++;
    const delta = credited - obs;
    if (delta > 0n) flagged++;
    console.log(`  ${u}  credited=${String(credited).padStart(6)}  observed=${String(obs).padStart(6)}` +
      `  ${delta === 0n ? "ok" : delta > 0n ? `OVER by ${delta} (${(Number(credited) / Math.max(Number(obs), 1)).toFixed(2)}x)` : `under by ${-delta}`}`);
  }
  console.log(`  --- credited ${sumCred}  observed ${sumObs}` +
    `  ${sumCred === sumObs ? "reconciles" : `RATIO ${(Number(sumCred) / Math.max(Number(sumObs), 1)).toFixed(3)}x`}`);
}
console.log(`\nreconciler pass: ${ms() - t0}ms, ${checked} referral-KPI pairs checked, ${flagged} over-credited`);
