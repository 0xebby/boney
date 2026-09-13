/** Folds Gyndore state into card rows. */
import {readFileSync} from "node:fs";

const txt = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const url = txt.split("\n").find((l) => /^\s*NEXT_PUBLIC_SUBGRAPH_URL\s*=/.test(l))!
  .split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, "");
const CAMPAIGN = "0x86b7b22aed09452232ca1a072db5be7a837f06fc";

const q = `{
  campaign(id:"${CAMPAIGN}") {
    name campaignId project token status createdAt createdAtBlock
    kpis { index kind verifier source topic0 actorTopic amountMode scale target aggregate }
    promoters { promoterId wallet reputation joinedAtBlock }
    touches(first: 1000, orderBy: signedAt) { user promoterId signedAt expiresAt blockNumber }
  }
  credits(first: 1000, where: {campaign: "${CAMPAIGN}"}, orderBy: timestamp) {
    kpiIndex promoterId user amount blockNumber timestamp
  }
  _meta { block { number timestamp } hasIndexingErrors }
}`;
const r = await fetch(url, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({query: q})});
type Kpi = {index: number; kind: number; verifier: string; source: string; topic0: string | null; actorTopic: number; amountMode: number; scale: string; target: string; aggregate: boolean};
type Promoter = {promoterId: string; wallet: string; reputation: string; joinedAtBlock: string};
type Touch = {user: string; promoterId: string; signedAt: string; expiresAt: string; blockNumber: string};
type Credit = {kpiIndex: number; promoterId: string; user: string; amount: string; blockNumber: string; timestamp: string};
type Data = {
  campaign: {name: string; campaignId: string; project: string; token: string; status: number; createdAt: string; createdAtBlock: string; kpis: Kpi[]; promoters: Promoter[]; touches: Touch[]};
  credits: Credit[]; _meta: {block: {number: number; timestamp: string}; hasIndexingErrors: boolean};
};
const {data} = await r.json() as {data: Data};
const c = data.campaign, credits = data.credits;

const iso = (s: string) => new Date(Number(s) * 1000).toISOString().replace(".000Z", "Z");
console.log(`CAMPAIGN  ${c.name}  id=${c.campaignId}  status=${c.status}`);
console.log(`  project=${c.project}  token=${c.token}`);
console.log(`  created ${iso(c.createdAt)} @ block ${c.createdAtBlock}`);
console.log(`  indexed to block ${data._meta.block.number} (${iso(String(data._meta.block.timestamp))}) errors=${data._meta.hasIndexingErrors}`);

console.log(`\nKPIS (${c.kpis.length})`);
for (const k of c.kpis) {
  console.log(`  #${k.index} kind=${k.kind} actorTopic=${k.actorTopic} amountMode=${k.amountMode} scale=${k.scale} target=${k.target} aggregate=${k.aggregate}`);
  console.log(`      source=${k.source}  topic0=${k.topic0 ?? "null"}  verifier=${k.verifier}`);
}

console.log(`\nTOUCHES ${c.touches.length}   PROMOTERS ${c.promoters.length}   CREDITS ${credits.length}`);
const now = Math.floor(Date.now() / 1000);
for (const p of c.promoters) {
  const t = c.touches.filter((x) => x.promoterId === p.promoterId);
  const live = t.filter((x) => Number(x.expiresAt) > now).length;
  const cr = credits.filter((x) => x.promoterId === p.promoterId);
  const byKpi = new Map<number, {n: number; sum: bigint; users: Set<string>}>();
  for (const x of cr) {
    const e = byKpi.get(x.kpiIndex) ?? {n: 0, sum: 0n, users: new Set<string>()};
    e.n++; e.sum += BigInt(x.amount); e.users.add(x.user); byKpi.set(x.kpiIndex, e);
  }
  console.log(`\n  ${p.wallet}  rep=${p.reputation}  joined@${p.joinedAtBlock}`);
  console.log(`    id=${p.promoterId.slice(0, 18)}…`);
  console.log(`    refs=${t.length} (live ${live})  distinct=${new Set(t.map((x) => x.user)).size}`);
  for (const [k, e] of [...byKpi].sort((a, b) => a[0] - b[0])) {
    console.log(`    kpi#${k}: ${e.n} credit(s)  sum=${e.sum}  wallets=${e.users.size}`);
  }
  if (byKpi.size === 0) console.log(`    no credits`);
}

const orphan = credits.filter((x) => !c.promoters.some((p) => p.promoterId === x.promoterId));
console.log(`\norphan credits (no promoter row): ${orphan.length}`);
const totals = new Map<number, {n: number; sum: bigint; users: Set<string>}>();
for (const x of credits) {
  const e = totals.get(x.kpiIndex) ?? {n: 0, sum: 0n, users: new Set<string>()};
  e.n++; e.sum += BigInt(x.amount); e.users.add(x.user); totals.set(x.kpiIndex, e);
}
console.log(`TOTALS per kpi:`);
for (const [k, e] of [...totals].sort((a, b) => a[0] - b[0])) {
  console.log(`  kpi#${k}: ${e.n} credits  sum=${e.sum}  distinct wallets=${e.users.size}`);
}
console.log(`distinct credited wallets overall: ${new Set(credits.map((x) => x.user)).size}`);
console.log(`first credit ${iso(credits[0].timestamp)}  last ${iso(credits.at(-1).timestamp)}`);
