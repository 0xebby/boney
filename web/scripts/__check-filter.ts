/** Control test: does the positional topic filter actually match a wallet that DID act? */
import {createPublicClient, http, pad, toHex, type Hex, type PublicClient} from "viem";
import {EVENT_PRESETS, WETH_BASE} from "../src/lib/kpiSource";
import {aggregateByActor, type IndexedLog} from "../src/lib/indexerCore";

const client = createPublicClient({
  transport: http("https://base-sepolia-rpc.publicnode.com"),
}) as PublicClient;
const deposit = EVENT_PRESETS[0].source; // WETH Deposit, actorTopic 1, dataWord0, scale 1e15

async function main() {
  const head = await client.getBlockNumber();
  const from = head - 1899n;

  // Unfiltered: find someone who actually deposited in this window.
  const all = (await client.request({
    method: "eth_getLogs",
    params: [{address: WETH_BASE, topics: [deposit.topic0], fromBlock: toHex(from), toBlock: toHex(head)}],
  })) as {topics: readonly Hex[]; data: Hex; blockNumber: Hex}[];
  console.log(`unfiltered: ${all.length} Deposit logs in blocks ${from}..${head}`);
  if (all.length === 0) return console.log("window is idle — rerun");

  const actor = `0x${all[0]!.topics[1]!.slice(26)}` as `0x${string}`;
  console.log(`picked actor ${actor}`);

  // Filtered exactly as useObservedActions does.
  const filtered = (await client.request({
    method: "eth_getLogs",
    params: [
      {
        address: WETH_BASE,
        topics: [deposit.topic0, [pad(actor.toLowerCase() as Hex, {size: 32})]],
        fromBlock: toHex(from),
        toBlock: toHex(head),
      },
    ],
  })) as {topics: readonly Hex[]; data: Hex; blockNumber: Hex}[];
  console.log(`filtered to that actor: ${filtered.length} logs`);

  const logs: IndexedLog[] = filtered.map((l) => ({
    topics: l.topics, data: l.data, blockNumber: BigInt(l.blockNumber), timestamp: 0n,
  }));
  // `null` floors: this asks "does the topic filter match at all", not "is it creditable". These
  // logs carry timestamp 0 anyway, which a real floor would drop every one of.
  const totals = aggregateByActor(logs, deposit, null);
  for (const [addr, t] of totals) console.log(`  observed ${addr} = ${t.amount} units (scale 1e15)`);
  if (totals.size === 0) console.log("  folded to zero (sub-scale deposits)");
}

void main().catch((e) => { console.error(e); process.exit(1); });
