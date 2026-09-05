/**
 * Throwaway: for every campaign on the registry, compare what the subgraph can serve against what
 * the chain says — observability per KPI, the `Credit` fold against `totalProgress`/`progressOf`,
 * and the `TierPayout` fold against escrow drain.
 */
import {readFileSync} from "node:fs";
import {createPublicClient, http, getAddress, type Hex} from "viem";
import {baseSepolia} from "viem/chains";
import {CampaignAbi} from "../src/lib/abis/Campaign";
import {CampaignRegistryAbi} from "../src/lib/abis/CampaignRegistry";
import {decodeEventSource} from "../src/lib/kpiSource";

const REGISTRY = getAddress("0x3e0a2fc423dE77bEE9147879308BFfFC6129c4EE");
const client = createPublicClient({
  chain: baseSepolia,
  transport: http(process.env.BASE_SEPOLIA_RPC ?? "https://base-sepolia-rpc.publicnode.com"),
});

const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const URL_ = env.split("\n").find((l) => /^\s*NEXT_PUBLIC_SUBGRAPH_URL\s*=/.test(l))!
  .split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, "");

async function gql<T>(query: string): Promise<T> {
  for (let a = 0; a < 5; a++) {
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

type SgKpi = {index: number; source: Hex | null; topic0: Hex | null; actorTopic: number | null; amountMode: number | null; scale: string | null};
type SgCampaign = {
  id: Hex; name: string; campaignId: string; createdAtBlock: string;
  kpis: SgKpi[];
  promoters: {promoterId: Hex; wallet: Hex | null}[];
  touches: {user: Hex}[];
};

const meta = await gql<{_meta: {block: {number: number}; hasIndexingErrors: boolean}}>(
  `{ _meta { block { number } hasIndexingErrors } }`);
const head = await client.getBlockNumber();
console.log(`subgraph head ${meta._meta.block.number}  chain head ${head}  lag ${Number(head) - meta._meta.block.number} blocks` +
  `  indexingErrors=${meta._meta.hasIndexingErrors}`);

const {campaigns} = await gql<{campaigns: SgCampaign[]}>(`{
  campaigns(first: 100, orderBy: campaignId) {
    id name campaignId createdAtBlock
    kpis(first: 20, orderBy: index) { index source topic0 actorTopic amountMode scale }
    promoters(first: 100) { promoterId wallet }
    touches(first: 1000) { user }
  }
}`);

const {spawnedSources, unsupportedSources} = await gql<{
  spawnedSources: {template: string; address: Hex; spawnedAtBlock: string}[];
  unsupportedSources: {source: Hex; topic0: Hex; actorTopic: number; amountMode: number; kpiCount: number}[];
}>(`{
  spawnedSources(first: 100) { template address spawnedAtBlock }
  unsupportedSources(first: 100) { source topic0 actorTopic amountMode kpiCount }
}`);

console.log(`\nspawnedSources (${spawnedSources.length}):`);
for (const s of spawnedSources) console.log(`  ${s.template.padEnd(24)} ${s.address} @${s.spawnedAtBlock}`);
console.log(`unsupportedSources (${unsupportedSources.length}):`);
for (const u of unsupportedSources) {
  console.log(`  ${u.source} topic0=${u.topic0.slice(0, 12)}… T${u.actorTopic} ` +
    `${u.amountMode === 0 ? "count" : "sum"} kpiCount=${u.kpiCount}`);
}
const spawnedAddrs = new Set(spawnedSources.map((s) => s.address.toLowerCase()));

const count = await client.readContract({
  address: REGISTRY, abi: CampaignRegistryAbi, functionName: "campaignCount"}) as bigint;

type Row = {campaign: string; kpi: number; bytes: number; filtered: boolean; sgSource: string;
  template: string; actions: number; verdict: string};
const coverage: Row[] = [];
const fidelity: {campaign: string; kpi: number; sg: bigint; chain: bigint}[] = [];
const perPromoter: {campaign: string; wallet: string; kpi: number; sg: bigint; chain: bigint}[] = [];
const settlement: {campaign: string; sgPaid: bigint; drain: bigint; rows: number}[] = [];

for (let id = 0n; id < count; id++) {
  const address = await client.readContract({
    address: REGISTRY, abi: CampaignRegistryAbi, functionName: "campaignAt", args: [id]}) as Hex;
  const sg = campaigns.find((c) => c.id.toLowerCase() === address.toLowerCase());
  const [cfg, kpiCount, remaining] = await Promise.all([
    client.readContract({address, abi: CampaignAbi, functionName: "config"}),
    client.readContract({address, abi: CampaignAbi, functionName: "kpiCount"}),
    client.readContract({address, abi: CampaignAbi, functionName: "remainingPool"}),
  ]) as [Record<string, unknown>, bigint, bigint];
  const name = cfg.name as string;
  if (!sg) { console.log(`\n!! ${name} ${address} absent from subgraph`); continue; }

  // --- Credit fold, whole campaign, paginated.
  const credits: {kpiIndex: number; promoterId: Hex; user: Hex; amount: string}[] = [];
  for (let skip = 0; ; skip += 1000) {
    const page = await gql<{credits: typeof credits}>(`{
      credits(first: 1000, skip: ${skip}, where: {campaign: "${address.toLowerCase()}"}) {
        kpiIndex promoterId user amount } }`);
    credits.push(...page.credits);
    if (page.credits.length < 1000) break;
  }
  const payouts: {promoter: Hex; paid: string}[] = [];
  for (let skip = 0; ; skip += 1000) {
    const page = await gql<{tierPayouts: typeof payouts}>(`{
      tierPayouts(first: 1000, skip: ${skip}, where: {campaign: "${address.toLowerCase()}"}) {
        promoter paid } }`);
    payouts.push(...page.tierPayouts);
    if (page.tierPayouts.length < 1000) break;
  }

  console.log(`\n=== id ${id} ${name} ${address}  kpis=${kpiCount}` +
    ` sgPromoters=${sg.promoters.length} sgTouches=${sg.touches.length}` +
    ` credits=${credits.length} payouts=${payouts.length}`);

  const sgPaid = payouts.reduce((a, p) => a + BigInt(p.paid), 0n);
  settlement.push({campaign: name, sgPaid, drain: (cfg.rewardPool as bigint) - remaining, rows: payouts.length});

  for (let k = 0n; k < kpiCount; k++) {
    const spec = await client.readContract({
      address, abi: CampaignAbi, functionName: "kpi", args: [k]}) as Record<string, unknown>;
    const params = spec.params as Hex;
    const src = decodeEventSource(params);
    const bytes = (params.length - 2) / 2;
    const sgk = sg.kpis.find((x) => x.index === Number(k));
    const template = src && spawnedAddrs.has(src.source.toLowerCase())
      ? spawnedSources.find((s) => s.address.toLowerCase() === src.source.toLowerCase())!.template
      : unsupportedSources.some((u) => u.source.toLowerCase() === src?.source.toLowerCase() &&
          u.topic0.toLowerCase() === (src.topic0 as string).toLowerCase()) ? "UNSUPPORTED" : "none";

    let actions = 0;
    if (src) {
      const q = await gql<{kpiActions: {id: string}[]}>(`{
        kpiActions(first: 1000, where: {source: "${src.source.toLowerCase()}", topic0: "${(src.topic0 as string).toLowerCase()}"}) { id } }`);
      actions = q.kpiActions.length;
    }
    const verdict = !src ? "no event source"
      : !sgk?.source ? "params UNDECODED by deployed mapping"
      : template === "UNSUPPORTED" ? "decoded, no template"
      : template === "none" ? "decoded, nothing spawned"
      : actions === 0 ? `template ${template}, ZERO rows`
      : "observable";
    coverage.push({campaign: name, kpi: Number(k), bytes, filtered: bytes === 224,
      sgSource: sgk?.source ? "decoded" : "NULL", template, actions, verdict});

    const chainTotal = await client.readContract({
      address, abi: CampaignAbi, functionName: "totalProgress", args: [k]}) as bigint;
    const sgTotal = credits.filter((c) => c.kpiIndex === Number(k))
      .reduce((a, c) => a + BigInt(c.amount), 0n);
    fidelity.push({campaign: name, kpi: Number(k), sg: sgTotal, chain: chainTotal});
  }

  for (const p of sg.promoters) {
    if (!p.wallet) continue;
    for (let k = 0n; k < kpiCount; k++) {
      const chain = await client.readContract({
        address, abi: CampaignAbi, functionName: "progressOf", args: [getAddress(p.wallet), k]}) as bigint;
      const sgv = credits.filter((c) => c.kpiIndex === Number(k) &&
        c.promoterId.toLowerCase() === p.promoterId.toLowerCase())
        .reduce((a, c) => a + BigInt(c.amount), 0n);
      if (chain > 0n || sgv > 0n) {
        perPromoter.push({campaign: name, wallet: getAddress(p.wallet), kpi: Number(k), sg: sgv, chain});
      }
    }
  }
}

const ok = (a: bigint, b: bigint) => (a === b ? "OK" : `MISMATCH (${a - b > 0n ? "+" : ""}${a - b})`);

console.log(`\n\n######## COVERAGE — can the subgraph observe this KPI?`);
console.log(`campaign                   kpi params sgSource template                 rows  verdict`);
for (const r of coverage) {
  console.log(`${r.campaign.padEnd(26)} ${String(r.kpi).padEnd(3)} ` +
    `${(r.filtered ? "224F" : r.bytes ? `${r.bytes}` : "0").padEnd(6)} ` +
    `${r.sgSource.padEnd(8)} ${r.template.padEnd(24)} ${String(r.actions).padStart(4)}  ${r.verdict}`);
}

console.log(`\n######## FIDELITY — Credit fold vs totalProgress`);
for (const f of fidelity) {
  console.log(`${f.campaign.padEnd(26)} kpi ${f.kpi}  subgraph=${String(f.sg).padStart(6)}  chain=${String(f.chain).padStart(6)}  ${ok(f.sg, f.chain)}`);
}

console.log(`\n######## FIDELITY — Credit fold vs progressOf, per promoter`);
for (const p of perPromoter) {
  console.log(`${p.campaign.padEnd(26)} ${p.wallet.slice(0, 10)}… kpi ${p.kpi}  subgraph=${String(p.sg).padStart(6)}  chain=${String(p.chain).padStart(6)}  ${ok(p.sg, p.chain)}`);
}

console.log(`\n######## SETTLEMENT — TierPayout fold vs escrow drain`);
for (const s of settlement) {
  console.log(`${s.campaign.padEnd(26)} rows=${String(s.rows).padStart(3)}  subgraph=${s.sgPaid / 10n ** 18n}  drain=${s.drain / 10n ** 18n}  ${ok(s.sgPaid, s.drain)}`);
}

const total = coverage.length;
const observable = coverage.filter((r) => r.verdict === "observable").length;
console.log(`\nobservable KPIs: ${observable}/${total}`);
console.log(`fidelity: ${fidelity.filter((f) => f.sg === f.chain).length}/${fidelity.length} totals match, ` +
  `${perPromoter.filter((p) => p.sg === p.chain).length}/${perPromoter.length} promoter rows match, ` +
  `${settlement.filter((s) => s.sgPaid === s.drain).length}/${settlement.length} escrows reconcile`);
