/** Throwaway: every Gyndore credit, one line each. */
import {readFileSync} from "node:fs";
const txt = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const url = txt.split("\n").find((l) => /^\s*NEXT_PUBLIC_SUBGRAPH_URL\s*=/.test(l))!
  .split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, "");
const C = "0x86b7b22aed09452232ca1a072db5be7a837f06fc";
const q = `{ credits(first:1000, where:{campaign:"${C}"}, orderBy: blockNumber) {
  kpiIndex promoterId user amount blockNumber timestamp } 
  campaign(id:"${C}"){ promoters { promoterId wallet } touches(first:1000, orderBy:signedAt){ user promoterId signedAt expiresAt blockNumber } } }`;
const r = await fetch(url, {method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({query:q})});
const {data} = await r.json();
const short = (a: string) => `${a.slice(0,6)}…${a.slice(-4)}`;
const pw = new Map<string,string>(data.campaign.promoters.map((p:any)=>[p.promoterId, short(p.wallet)]));
console.log("KIND: 1=Mint 2=Swap 5=Stake   #0=Swap #1=Stake #2=Mint");
console.log("\nkpi  promoter        user            amount  block      when");
for (const c of data.credits) {
  console.log(`  ${c.kpiIndex}  ${pw.get(c.promoterId)}  ${short(c.user)}  ${String(c.amount).padStart(6)}  ${c.blockNumber}  ${new Date(Number(c.timestamp)*1000).toISOString().slice(0,16)}`);
}
console.log("\nTOUCHES");
for (const t of data.campaign.touches) {
  console.log(`  ${pw.get(t.promoterId) ?? "?"}  ${short(t.user)}  block ${t.blockNumber}  signed ${new Date(Number(t.signedAt)*1000).toISOString().slice(0,16)}  expires ${new Date(Number(t.expiresAt)*1000).toISOString().slice(0,16)}`);
}
