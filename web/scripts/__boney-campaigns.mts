/**
 * Enumerates every campaign the Base Sepolia registry has created and scans the per-campaign
 * events, so the clone-address problem and each event's topic layout are read off real logs.
 */
import {createPublicClient, http, getAddress, decodeAbiParameters, type Hex} from "viem";
import {baseSepolia} from "viem/chains";
import {eventTopic} from "../src/lib/kpiSource";

const client = createPublicClient({
  chain: baseSepolia,
  transport: http(process.env.BASE_SEPOLIA_RPC ?? "https://base-sepolia-rpc.publicnode.com"),
});

const REGISTRY = getAddress("0x3e0a2fc423dE77bEE9147879308BFfFC6129c4EE");
const START = 46110182n;
const CHUNK = 9000n;
const head = await client.getBlockNumber();

async function scan(address: `0x${string}` | `0x${string}`[], topic0: Hex) {
  const out: {topics: readonly Hex[]; data: Hex; blockNumber: bigint | null; address: string}[] = [];
  let from = START;
  while (from <= head) {
    const to = from + CHUNK - 1n > head ? head : from + CHUNK - 1n;
    try {
      const got = await client.getLogs({address, fromBlock: from, toBlock: to} as never);
      for (const l of got as never as typeof out) {
        if (l.topics[0]?.toLowerCase() === topic0.toLowerCase()) out.push(l);
      }
    } catch { /* chunk skipped */ }
    from = to + 1n;
  }
  return out;
}

const created = await scan(REGISTRY, eventTopic("CampaignCreated(uint256,address,address,address,string)"));
console.log(`head=${head}\n### CampaignCreated — ${created.length} logs, topic0=${eventTopic("CampaignCreated(uint256,address,address,address,string)")}`);
const campaigns: `0x${string}`[] = [];
for (const l of created) {
  const id = BigInt(l.topics[1]!);
  const campaign = getAddress(`0x${l.topics[2]!.slice(26)}`);
  const project = getAddress(`0x${l.topics[3]!.slice(26)}`);
  const [token, name] = decodeAbiParameters([{type: "address"}, {type: "string"}], l.data);
  campaigns.push(campaign);
  console.log(`  id=${id} campaign=${campaign} project=${project} token=${token} name="${name}" block=${l.blockNumber}`);
}
const projects = new Set(created.map((l) => l.topics[3]!.toLowerCase()));
console.log(`  T1 campaignId values: ${created.map((l) => BigInt(l.topics[1]!)).join(", ")}  (all pass an address-shape test)`);
console.log(`  T3 project: ${projects.size} distinct wallet(s)`);

const CLONE_EVENTS = [
  "PromoterJoined(address,bytes32,uint256)",
  "ProgressCredited(uint256,bytes32,address,uint256)",
  "AggregateProgress(uint256,uint256)",
  "TierSettled(bytes32,address,uint256,uint256,uint256)",
  "Activated(uint64,uint64)",
  "StatusChanged(uint8,uint8)",
  "PoolExhausted(uint256)",
  "Reclaimed(address,uint256)",
];

const isAddrWord = (w: Hex) => /^0x0{24}[0-9a-f]{40}$/i.test(w);

for (const sig of CLONE_EVENTS) {
  const topic0 = eventTopic(sig);
  const logs = await scan(campaigns, topic0);
  console.log(`\n### ${sig}`);
  console.log(`    topic0=${topic0} logs=${logs.length} across ${new Set(logs.map((l) => l.address.toLowerCase())).size} campaign address(es)`);
  if (logs.length === 0) continue;
  const topicCount = logs[0].topics.length - 1;
  console.log(`    indexed=${topicCount} dataWords=${(logs[0].data.length - 2) / 64}`);
  for (let t = 1; t <= topicCount; t++) {
    const vals = logs.map((l) => l.topics[t]!);
    console.log(`      T${t}: address-shaped ${vals.filter(isAddrWord).length}/${vals.length} distinct=${new Set(vals.map((v) => v.toLowerCase())).size} e.g. ${vals[0]}`);
  }
  if (logs[0].data.length > 2) {
    const w0 = logs.map((l) => BigInt(l.data.slice(0, 66)));
    console.log(`      dataWord0: min=${w0.reduce((m, v) => (v < m ? v : m))} max=${w0.reduce((m, v) => (v > m ? v : m))}`);
  }
  const per = new Map<string, number>();
  for (const l of logs) per.set(l.address.toLowerCase(), (per.get(l.address.toLowerCase()) ?? 0) + 1);
  console.log(`      per source: ${[...per].map(([a, n]) => `${a.slice(0, 10)}…=${n}`).join(" ")}`);
}
