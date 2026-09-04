/** Throwaway: which local ref keys are attributed to which promoter on one campaign. */
import {readFileSync} from "node:fs";
import {getAddress, type Hex} from "viem";
import {privateKeyToAccount} from "viem/accounts";

const campaign = getAddress(process.argv[2]!).toLowerCase();

const keys: {name: string; address: Hex}[] = [];
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^\s*(KOL[\w]*)\s*=\s*(.+)$/);
  if (!m) continue;
  const raw = m[2]!.trim().replace(/^["']|["']$/g, "");
  const hex = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) continue;
  keys.push({name: m[1]!, address: privateKeyToAccount(hex as Hex).address});
}

const q = `{ campaign(id:"${campaign}"){ name
  promoters{ promoterId wallet }
  touches{ user promoterId signedAt expiresAt blockNumber } } }`;
const r = await fetch(process.env.NEXT_PUBLIC_SUBGRAPH_URL!, {
  method: "POST",
  headers: {"content-type": "application/json"},
  body: JSON.stringify({query: q}),
});
const c = (await r.json()).data.campaign;

const nameOf = new Map(keys.map((k) => [k.address.toLowerCase(), k.name]));
console.log(`campaign ${c.name}`);
for (const p of c.promoters) {
  const mine = c.touches.filter((t: {promoterId: string}) => t.promoterId.toLowerCase() === p.promoterId.toLowerCase());
  console.log(`\npromoter ${getAddress(p.wallet)}  touches ${mine.length}`);
  for (const t of mine) {
    const key = nameOf.get(t.user.toLowerCase());
    const exp = Number(t.expiresAt) * 1000;
    console.log(
      `  ${getAddress(t.user)}  ${(key ?? "-- no local key --").padEnd(16)}` +
        `expires ${new Date(exp).toISOString().slice(0, 16)} ${exp > Date.now() ? "live" : "LAPSED"}`,
    );
  }
}
