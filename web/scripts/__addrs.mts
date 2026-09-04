import {readFileSync} from "node:fs";
import {privateKeyToAccount} from "viem/accounts";
const txt = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
for (const line of txt.split("\n")) {
  const m = line.match(/^\s*(KOL[\w]*)\s*=\s*(.+)$/);
  if (!m) continue;
  const raw = m[2].trim().replace(/^["']|["']$/g, "");
  const hex = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) continue;
  console.log(`${m[1].padEnd(12)} ${privateKeyToAccount(hex as `0x${string}`).address}`);
}
