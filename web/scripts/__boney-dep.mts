import {createPublicClient, http, getAddress, type Hex} from "viem";
import {baseSepolia} from "viem/chains";
import {eventTopic} from "../src/lib/kpiSource";
const client = createPublicClient({chain: baseSepolia, transport: http("https://base-sepolia-rpc.publicnode.com")});
const V = getAddress("0x880fd3271f83b8B68E2E2Ff9888706fEF1b70D7b");
const D = eventTopic("Deposited(address,address,uint256)");
const R = eventTopic("Released(address,address,uint256)");
const head = await client.getBlockNumber();
let from = 46110182n; const logs: {topics: readonly Hex[]; data: Hex; blockNumber: bigint}[] = [];
while (from <= head) {
  const to = from + 8999n > head ? head : from + 8999n;
  try { const g = await client.getLogs({address: V, fromBlock: from, toBlock: to} as never);
    for (const l of g as never as typeof logs) if ([D, R].includes(l.topics[0]!.toLowerCase() as never) || l.topics[0]?.toLowerCase() === D.toLowerCase() || l.topics[0]?.toLowerCase() === R.toLowerCase()) logs.push(l);
  } catch {}
  from = to + 1n;
}
for (const [name, t0] of [["Deposited", D], ["Released", R]] as const) {
  const ls = logs.filter((l) => l.topics[0]!.toLowerCase() === t0.toLowerCase());
  const froms = new Map<string, {n: number; total: bigint}>();
  for (const l of ls) {
    const a = `0x${l.topics[2]!.slice(26)}`.toLowerCase();
    const v = BigInt(l.data.slice(0, 66));
    const cur = froms.get(a) ?? {n: 0, total: 0n};
    froms.set(a, {n: cur.n + 1, total: cur.total + v});
  }
  console.log(`\n${name}: ${ls.length} logs, ${froms.size} distinct T2`);
  for (const [a, {n, total}] of [...froms].sort((x, y) => y[1].n - x[1].n)) {
    const code = await client.getCode({address: a as `0x${string}`});
    console.log(`  ${a}  n=${n}  sum=${total / BigInt("1000000000000000000")}  ${code && code !== "0x" ? "CONTRACT" : "EOA"}`);
  }
}
