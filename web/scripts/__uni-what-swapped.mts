/** Throwaway: who is attributed on the Uniswap campaign, and what their recent logs actually are. */
import {createPublicClient, http, getAddress, pad, type Hex} from "viem";
import {baseSepolia} from "viem/chains";
import {AttributionRegistryAbi} from "../src/lib/abis/AttributionRegistry";
import {catalogSignature, shortTopic} from "../src/lib/eventNames";
import {knownContractName} from "../src/lib/knownContracts";

const CAMPAIGN = getAddress("0x101431E3Cc9d8fec1221c0ED888c210f5E362b8b");
const ATTRIBUTION = getAddress("0xe04C5185eDd4C9b1c91e31c790843c335766258e");
const START = 46_363_409n; // The campaign's window floor.

const client = createPublicClient({
  chain: baseSepolia,
  transport: http("https://base-sepolia-rpc.publicnode.com", {retryCount: 6, retryDelay: 800}),
});

const head = await client.getBlockNumber();
console.log(`head=${head}  campaign window from ${START}  (${head - START} blocks)`);

const touches = await client.getContractEvents({
  address: ATTRIBUTION,
  abi: AttributionRegistryAbi,
  eventName: "TouchStored",
  args: {campaign: CAMPAIGN},
  fromBlock: START - 2_000n,
  toBlock: head,
});
console.log(`\n${touches.length} TouchStored on this campaign`);
const users = new Set<string>();
for (const t of touches) {
  const a = t.args as {user?: string; promoterId?: string; signedAt?: bigint; expiresAt?: bigint};
  users.add(a.user!.toLowerCase());
  console.log(
    `  block ${t.blockNumber}  user ${a.user}  promoter ${a.promoterId?.slice(0, 12)}…  ` +
      `expires ${new Date(Number(a.expiresAt) * 1000).toISOString().slice(0, 16)}`,
  );
}

/** Every log carrying `who` in an indexed slot, grouped by emitter and signature. */
async function profile(who: string, from: bigint, to: bigint) {
  const padded = pad(who.toLowerCase() as Hex, {size: 32});
  const seen = new Map<string, {count: number; first: bigint; last: bigint}>();
  for (const slot of [1, 2, 3]) {
    const topics: (Hex | null)[] = [null, null, null, null];
    topics[slot] = padded;
    const logs = (await client.request({
      method: "eth_getLogs",
      params: [
        {
          fromBlock: `0x${from.toString(16)}`,
          toBlock: `0x${to.toString(16)}`,
          topics: topics.slice(0, slot + 1) as never,
        },
      ],
    })) as Array<{address: Hex; topics: Hex[]; blockNumber: Hex}>;
    for (const log of logs) {
      const key = `${log.address.toLowerCase()}|${log.topics[0]}|slot${slot}`;
      const block = BigInt(log.blockNumber);
      const row = seen.get(key);
      if (row) {
        row.count++;
        if (block < row.first) row.first = block;
        if (block > row.last) row.last = block;
      } else seen.set(key, {count: 1, first: block, last: block});
    }
  }
  console.log(`\n${who} — ${seen.size} (contract, event, slot) combinations in ${from}..${to}`);
  for (const [key, row] of [...seen].sort((a, b) => b[1].count - a[1].count)) {
    const [address, topic0, slot] = key.split("|");
    const sig = catalogSignature(topic0 as Hex) ?? shortTopic(topic0 as Hex);
    const name = knownContractName(getAddress(address!)) ?? address;
    console.log(
      `  ${String(row.count).padStart(4)}x  ${sig.padEnd(34)} ${slot}  ${name}  ` +
        `blocks ${row.first}..${row.last}`,
    );
  }
}

for (const user of users) await profile(user, START, head);
