/** Lists campaigns available from the subgraph. */
import {readFileSync} from "node:fs";
const txt = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const url = txt.split("\n").find((l) => /^\s*NEXT_PUBLIC_SUBGRAPH_URL\s*=/.test(l))!
  .split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, "");
const q = `{ campaigns(first: 100, orderBy: createdAt) {
  id campaignId name project token status createdAt
  kpis { index kind target aggregate }
  promoters { id }
  touches(first: 1000) { id }
} }`;
const r = await fetch(url, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({query: q})});
type CampaignRow = {
  campaignId: string; name: string; id: string; status: number; createdAt: string;
  kpis: {index: number; kind: number; aggregate: boolean}[];
  promoters: {id: string}[]; touches: {id: string}[];
};
const {data, errors} = await r.json() as {data: {campaigns: CampaignRow[]}; errors?: unknown};
if (errors) { console.log("ERRORS", JSON.stringify(errors).slice(0, 400)); process.exit(1); }
const STATUS = ["Pending", "Active", "Paused", "Ended", "Cancelled"];
for (const c of data.campaigns) {
  console.log(`#${c.campaignId}  ${c.name}`);
  console.log(`   ${c.id}  ${STATUS[c.status] ?? c.status}  created ${new Date(Number(c.createdAt)*1000).toISOString().slice(0,10)}`);
  console.log(`   kpis=${c.kpis.length} [${c.kpis.map((k)=>`#${k.index} kind${k.kind}${k.aggregate?" agg":""}`).join(", ")}]  promoters=${c.promoters.length}  touches=${c.touches.length}`);
}
