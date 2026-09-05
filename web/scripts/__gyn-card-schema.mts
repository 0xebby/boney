/** Throwaway: what the subgraph actually exposes on the entities the Gyndore card needs. */
import {readFileSync} from "node:fs";

const txt = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const url = txt.split("\n").find((l) => /^\s*NEXT_PUBLIC_SUBGRAPH_URL\s*=/.test(l))!
  .split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, "");

const q = `{
  Campaign: __type(name:"Campaign"){ fields{ name type{ name kind ofType{ name kind } } } }
  Kpi: __type(name:"Kpi"){ fields{ name type{ name kind ofType{ name kind } } } }
  Credit: __type(name:"Credit"){ fields{ name type{ name kind ofType{ name kind } } } }
  Touch: __type(name:"Touch"){ fields{ name type{ name kind ofType{ name kind } } } }
  Promoter: __type(name:"Promoter"){ fields{ name type{ name kind ofType{ name kind } } } }
}`;

const r = await fetch(url, {
  method: "POST",
  headers: {"content-type": "application/json"},
  body: JSON.stringify({query: q}),
});
const j = await r.json();
if (j.errors) { console.log("ERRORS", JSON.stringify(j.errors).slice(0, 500)); process.exit(1); }
for (const [type, def] of Object.entries(j.data as Record<string, {fields: {name: string; type: {name?: string; kind: string; ofType?: {name?: string}}}[]} | null>)) {
  if (!def) { console.log(`${type}: NOT IN SCHEMA`); continue; }
  const names = def.fields.map((f) => `${f.name}:${f.type.name ?? f.type.ofType?.name ?? f.type.kind}`);
  console.log(`\n${type} (${names.length})\n  ${names.join("  ")}`);
}
