/**
 * Throwaway: the floor-free overcredit test. Compares credited against the whole of history for the
 * KPI's own source, unfiltered by attribution — a ceiling no honest report can exceed, so a breach
 * needs no attribution logic to be conclusive.
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

const TARGETS: [string, number][] = [
  ["0x16FE7197F7Df62D86CD7606FA6F72dBF30A23491", 0], ["0x16FE7197F7Df62D86CD7606FA6F72dBF30A23491", 1],
  ["0x0a01B03EBaCBb553AD5b269297921F32D261C45F", 0], ["0x0a01B03EBaCBb553AD5b269297921F32D261C45F", 2],
  ["0x101431E3Cc9d8fec1221c0ED888c210f5E362b8b", 2],
];

let breaches = 0, pairs = 0;
for (const [addr, k] of TARGETS) {
  const campaign = getAddress(addr);
  const spec = await client.readContract({address: campaign, abi: CampaignAbi, functionName: "kpi", args: [BigInt(k)]}) as Record<string, unknown>;
  const src = decodeEventSource(spec.params as Hex)!;
  const scale = effectiveScale(src);
  const {campaign: sg} = await gql<{campaign: {name: string; touches: {user: Hex}[]}}>(`{
    campaign(id: "${campaign.toLowerCase()}") { name touches(first: 1000) { user } } }`);
  const users = sg.touches.map((t) => t.user.toLowerCase());

  const rows: {user: Hex; value: string}[] = [];
  for (let skip = 0; skip < 20000; skip += 1000) {
    const p = await gql<{kpiActions: typeof rows}>(`{
      kpiActions(first: 1000, skip: ${skip}, where: {source: "${src.source.toLowerCase()}",
        topic0: "${(src.topic0 as string).toLowerCase()}", user_in: [${users.map((u) => `"${u}"`).join(",")}]})
      { user value } }`);
    rows.push(...p.kpiActions); if (p.kpiActions.length < 1000) break;
  }
  const allTime = new Map<string, bigint>();
  for (const r of rows) {
    const u = r.user.toLowerCase();
    allTime.set(u, (allTime.get(u) ?? 0n) + (src.amountMode === AMOUNT_MODE.count ? 1n : BigInt(r.value)));
  }
  for (const [u, v] of allTime) allTime.set(u, v / scale);

  console.log(`\n=== ${sg.name} KPI ${k}  — credited vs ALL of history, no attribution floor`);
  for (const u of users) {
    const credited = await client.readContract({address: campaign, abi: CampaignAbi,
      functionName: "userCreditedOf", args: [u as Hex, BigInt(k)]}) as bigint;
    const cap = allTime.get(u) ?? 0n;
    if (credited === 0n && cap === 0n) continue;
    pairs++;
    const breach = credited > cap;
    if (breach) breaches++;
    console.log(`  ${u.slice(0, 12)}…  credited=${String(credited).padStart(6)}  all-time=${String(cap).padStart(6)}` +
      `  ${breach ? `IMPOSSIBLE: credited exceeds every matching log ever, by ${credited - cap}` : "within history"}`);
  }
}
console.log(`\n${breaches} of ${pairs} referral-KPI pairs credit more than the source has ever emitted for that wallet`);
