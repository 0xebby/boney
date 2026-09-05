import {createPublicClient, http, getAddress, type Hex} from "viem";
import {baseSepolia} from "viem/chains";
import {eventTopic} from "../src/lib/kpiSource";
const client = createPublicClient({chain: baseSepolia, transport: http("https://base-sepolia-rpc.publicnode.com")});
const REG = getAddress("0xe04C5185eDd4C9b1c91e31c790843c335766258e");
const T0 = eventTopic("TouchStored(address,address,bytes32,uint64,uint64,address)");
const head = await client.getBlockNumber();
let from = 46110182n; const logs: {topics: readonly Hex[]; data: Hex; blockNumber: bigint}[] = [];
while (from <= head) {
  const to = from + 8999n > head ? head : from + 8999n;
  try { const g = await client.getLogs({address: REG, fromBlock: from, toBlock: to} as never);
    for (const l of g as never as typeof logs) if (l.topics[0]?.toLowerCase() === T0.toLowerCase()) logs.push(l);
  } catch {}
  from = to + 1n;
}
const pairs = new Map<string, number>();
const users = new Map<string, Set<string>>();
for (const l of logs) {
  const c = l.topics[1]!.slice(26).toLowerCase(), u = l.topics[2]!.slice(26).toLowerCase();
  pairs.set(`${c}:${u}`, (pairs.get(`${c}:${u}`) ?? 0) + 1);
  if (!users.has(u)) users.set(u, new Set());
  users.get(u)!.add(c);
}
const repeats = [...pairs].filter(([, n]) => n > 1);
console.log(`TouchStored=${logs.length} distinct (campaign,user) pairs=${pairs.size} distinct users=${users.size}`);
console.log(`pairs signed more than once: ${repeats.length}  max repeats=${Math.max(...pairs.values())}`);
console.log(`  e.g. ${repeats.slice(0, 4).map(([k, n]) => `${k.slice(0, 12)}…/${k.slice(43, 51)}…=${n}`).join("  ")}`);
console.log(`users on >1 campaign: ${[...users.values()].filter((s) => s.size > 1).length}`);
const relayers = new Set(logs.map((l) => l.data.slice(130).toLowerCase()));
console.log(`distinct relayers (dataWord2): ${relayers.size}`);
