/**
 * Measures whether `ICampaign.PromoterJoined` can back a KPI: each clone's reputation gate and
 * status, the joins on it, and whether each joining wallet held an attribution before it joined.
 */
import {createPublicClient, http, getAddress, type Hex} from "viem";
import {baseSepolia} from "viem/chains";
import {eventTopic} from "../src/lib/kpiSource";

const client = createPublicClient({
  chain: baseSepolia,
  transport: http(process.env.BASE_SEPOLIA_RPC ?? "https://base-sepolia-rpc.publicnode.com"),
});

const ATTRIBUTION = getAddress("0xe04C5185eDd4C9b1c91e31c790843c335766258e");
const START = 46110182n;
const CHUNK = 9000n;
const head = await client.getBlockNumber();

const CLONES: Array<[string, `0x${string}`]> = [
  ["Venus", getAddress("0x16FE7197F7Df62D86CD7606FA6F72dBF30A23491")],
  ["Sdy Labs", getAddress("0xF6f786589391410B41dEfBd02a4B6303Ca372542")],
  ["SuperBridge", getAddress("0x0a01B03EBaCBb553AD5b269297921F32D261C45F")],
  ["Gyndore Testnet", getAddress("0x86B7b22aEd09452232Ca1A072db5BE7a837F06fc")],
];

const JOINED = eventTopic("PromoterJoined(address,bytes32,uint256)");
const TOUCH = eventTopic("TouchStored(address,address,bytes32,uint64,uint64,address)");

async function scan(address: `0x${string}` | `0x${string}`[], topic0: Hex) {
  const out: {topics: readonly Hex[]; data: Hex; blockNumber: bigint; address: string}[] = [];
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

const VIEWS = [
  {name: "minReputation", outputs: [{type: "uint256"}]},
  {name: "status", outputs: [{type: "uint8"}]},
  {name: "startTime", outputs: [{type: "uint64"}]},
  {name: "endTime", outputs: [{type: "uint64"}]},
  {name: "maxAttributionDuration", outputs: [{type: "uint64"}]},
].map((v) => ({type: "function", name: v.name, inputs: [], outputs: v.outputs, stateMutability: "view"}) as const);

const STATUS = ["Pending", "Active", "Paused", "Ended", "Cancelled"];

console.log(`head=${head}`);
console.log("### clones — gate and status");
for (const [name, address] of CLONES) {
  const read = async (fn: string) => {
    try {
      return await client.readContract({address, abi: VIEWS, functionName: fn as never});
    } catch (e) {
      return `err:${(e as Error).message.split("\n")[0]}`;
    }
  };
  const [gate, status, start, end, maxDur] = await Promise.all(
    ["minReputation", "status", "startTime", "endTime", "maxAttributionDuration"].map(read),
  );
  const endTs = typeof end === "bigint" ? Number(end) : 0;
  console.log(
    `${name.padEnd(16)} ${address} gate=${String(gate).padEnd(6)} status=${STATUS[Number(status)] ?? status}` +
      ` end=${endTs ? new Date(endTs * 1000).toISOString().slice(0, 10) : "?"}` +
      ` maxAttrib=${typeof maxDur === "bigint" ? `${Number(maxDur) / 86400}d` : maxDur}`,
  );
}

const joins = await scan(CLONES.map(([, a]) => a), JOINED);
const touches = await scan(ATTRIBUTION, TOUCH);

console.log(`\n### PromoterJoined — ${joins.length} logs`);
const byClone = new Map<string, typeof joins>();
for (const l of joins) {
  const key = getAddress(l.address as `0x${string}`);
  byClone.set(key, [...(byClone.get(key) ?? []), l]);
}
for (const [name, address] of CLONES) {
  const list = byClone.get(address) ?? [];
  const wallets = new Set(list.map((l) => `0x${l.topics[1]!.slice(26)}`));
  console.log(`${name.padEnd(16)} joins=${String(list.length).padEnd(3)} distinct wallets=${wallets.size}`);
}

/** Touch history keyed by user, each entry the campaign it names and the block it landed in. */
const touchesByUser = new Map<string, Array<{campaign: string; block: bigint; promoterId: string}>>();
for (const l of touches) {
  const user = `0x${l.topics[2]!.slice(26)}`.toLowerCase();
  touchesByUser.set(user, [
    ...(touchesByUser.get(user) ?? []),
    {campaign: `0x${l.topics[1]!.slice(26)}`.toLowerCase(), block: l.blockNumber, promoterId: l.topics[3]!},
  ]);
}

console.log("\n### would each join have credited a promoter?");
console.log("(a join credits only if the wallet held a touch on the REPORTING campaign at an earlier block)");
let creditable = 0;
let anyTouch = 0;
for (const l of joins) {
  const wallet = `0x${l.topics[1]!.slice(26)}`.toLowerCase();
  const clone = getAddress(l.address as `0x${string}`);
  const cloneName = CLONES.find(([, a]) => a === clone)?.[0] ?? clone;
  const history = touchesByUser.get(wallet) ?? [];
  const earlier = history.filter((t) => t.block < l.blockNumber);
  if (history.length > 0) anyTouch++;
  if (earlier.length > 0) creditable++;
  const on = [...new Set(earlier.map((t) => t.campaign.slice(0, 10)))].join(",") || "—";
  console.log(
    `${wallet.slice(0, 12)}… joined ${String(cloneName).padEnd(16)} @${l.blockNumber}` +
      ` touches=${history.length} earlier=${earlier.length} on=${on}`,
  );
}
console.log(`\njoins by a wallet that ever signed a touch: ${anyTouch}/${joins.length}`);
console.log(`joins preceded by a touch (any campaign):     ${creditable}/${joins.length}`);

console.log("\n### repeat touches — the promoterId on each");
const pairs = new Map<string, Array<{promoterId: string; block: bigint}>>();
for (const l of touches) {
  const key = `${`0x${l.topics[1]!.slice(26)}`.toLowerCase()}/${`0x${l.topics[2]!.slice(26)}`.toLowerCase()}`;
  pairs.set(key, [...(pairs.get(key) ?? []), {promoterId: l.topics[3]!, block: l.blockNumber}]);
}
for (const [key, list] of pairs) {
  if (list.length < 2) continue;
  const ids = [...new Set(list.map((t) => t.promoterId))];
  console.log(`${key}  touches=${list.length} distinct promoterIds=${ids.length}`);
  for (const t of list) console.log(`    @${t.block} ${t.promoterId.slice(0, 18)}…`);
}
