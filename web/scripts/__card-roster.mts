/**
 * Throwaway: the referral roster for a campaign card — who signed with whom, and what they did.
 *
 * @param argv[2] campaign address
 */
import {readFileSync} from "node:fs";
import {getAddress} from "viem";

const CAMPAIGN = process.argv[2]!.toLowerCase();
const txt = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const url = txt.split("\n").find((l) => /^\s*NEXT_PUBLIC_SUBGRAPH_URL\s*=/.test(l))!
  .split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, "");

const r = await fetch(url, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({query: `{
  campaign(id: "${CAMPAIGN}") {
    promoters { promoterId wallet reputation joinedAtBlock }
    touches(first: 1000, orderBy: blockNumber) { user promoterId signedAt blockNumber }
  }
  credits(first: 1000, where: {campaign: "${CAMPAIGN}"}, orderBy: blockNumber) {
    kpiIndex promoterId user amount blockNumber
  }
}`})});
const {data, errors} = await r.json();
if (errors) throw new Error(JSON.stringify(errors).slice(0, 400));

const promoters = data.campaign.promoters as Array<{promoterId: string; wallet: string; reputation: string; joinedAtBlock: string}>;
const byId = new Map(promoters.map((p) => [p.promoterId.toLowerCase(), getAddress(p.wallet)]));
const touches = data.campaign.touches as Array<{user: string; promoterId: string; signedAt: string; blockNumber: string}>;
const credits = data.credits as Array<{kpiIndex: number; promoterId: string; user: string; amount: string}>;

console.log("PROMOTERS (reputation is the score at join)");
for (const p of [...promoters].sort((a, b) => Number(a.joinedAtBlock) - Number(b.joinedAtBlock))) {
  const refs = touches.filter((t) => t.promoterId.toLowerCase() === p.promoterId.toLowerCase()).length;
  console.log(`  ${getAddress(p.wallet)}  rep=${Number(p.reputation).toLocaleString("en-US")}  joinedAtBlock=${p.joinedAtBlock}  touches=${refs}`);
}

/** user → {promoter, per-KPI totals} */
const rows = new Map<string, {promoter: string; signedAt: number; k: Record<number, bigint>}>();
for (const t of touches) {
  rows.set(t.user.toLowerCase(), {
    promoter: byId.get(t.promoterId.toLowerCase()) ?? t.promoterId,
    signedAt: Number(t.signedAt), k: {},
  });
}
for (const cr of credits) {
  const row = rows.get(cr.user.toLowerCase());
  if (!row) { console.log(`  ** credit for un-touched user ${cr.user} **`); continue; }
  row.k[Number(cr.kpiIndex)] = (row.k[Number(cr.kpiIndex)] ?? 0n) + BigInt(cr.amount);
}

console.log(`\nROSTER  ${rows.size} referral wallet(s)   [kpi0 deposits · kpi1 withdrawals · kpi2 volume units]`);
const sums: Record<number, bigint> = {0: 0n, 1: 0n, 2: 0n};
const ordered = [...rows.entries()].sort((a, b) => Number((b[1].k[0] ?? 0n) - (a[1].k[0] ?? 0n)));
for (const [user, row] of ordered) {
  for (const i of [0, 1, 2]) sums[i] += row.k[i] ?? 0n;
  const self = row.promoter.toLowerCase() === user ? "  SELF" : "";
  console.log(`  ${user}  via ${row.promoter.slice(0,6)}…${row.promoter.slice(-4)}  ` +
    `${String(row.k[0] ?? 0n).padStart(4)} dep  ${String(row.k[1] ?? 0n).padStart(4)} wd  ${String(row.k[2] ?? 0n).padStart(5)} vol` +
    `  signed ${new Date(row.signedAt * 1000).toISOString().slice(0, 16)}Z${self}`);
}
console.log(`  SUMS  ${sums[0]} dep  ${sums[1]} wd  ${sums[2]} vol`);
