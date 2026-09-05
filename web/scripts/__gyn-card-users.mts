/** Throwaway: full addresses, credited per kpi, for the Gyndore card. */
import {readFileSync} from "node:fs";
const txt = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const url = txt.split("\n").find((l) => /^\s*NEXT_PUBLIC_SUBGRAPH_URL\s*=/.test(l))!
  .split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, "");
const C = "0x86b7b22aed09452232ca1a072db5be7a837f06fc";
const q = `{ credits(first:1000, where:{campaign:"${C}"}) { kpiIndex promoterId user amount }
  campaign(id:"${C}"){ promoters{promoterId wallet} touches(first:1000){user promoterId signedAt} } }`;
const r = await fetch(url, {method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({query:q})});
const {data} = await r.json();
const per = new Map<string, {swaps: bigint; stakes: bigint; promoter: string}>();
const pw = new Map<string,string>(data.campaign.promoters.map((p:any)=>[p.promoterId, p.wallet]));
for (const t of data.campaign.touches) {
  if (!per.has(t.user)) per.set(t.user, {swaps: 0n, stakes: 0n, promoter: pw.get(t.promoterId) ?? "?"});
}
for (const c of data.credits) {
  const e = per.get(c.user) ?? {swaps: 0n, stakes: 0n, promoter: pw.get(c.promoterId) ?? "?"};
  if (c.kpiIndex === 0) e.swaps += BigInt(c.amount);
  if (c.kpiIndex === 1) e.stakes += BigInt(c.amount);
  per.set(c.user, e);
}
console.log("user                                        swaps  stakes  via promoter");
for (const [u, e] of [...per].sort((a,b)=>Number(b[1].swaps + b[1].stakes - a[1].swaps - a[1].stakes))) {
  console.log(`${u}  ${String(e.swaps).padStart(5)}  ${String(e.stakes).padStart(6)}  ${e.promoter}`);
}
