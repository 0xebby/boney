/** Verifies positional topic filtering against a wallet with matching activity. */
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

  // Find an active wallet in the unfiltered window.
  const all = (await client.request({
    method: "eth_getLogs",
    params: [{address: WETH_BASE, topics: [deposit.topic0], fromBlock: toHex(from), toBlock: toHex(head)}],
  })) as {topics: readonly Hex[]; data: Hex; blockNumber: Hex}[];
  console.log(`unfiltered: ${all.length} Deposit logs in blocks ${from}..${head}`);
  if (all.length === 0) return console.log("window is idle — rerun");

  const actor = `0x${all[0]!.topics[1]!.slice(26)}` as `0x${string}`;
  console.log(`picked actor ${actor}`);

  // Apply the production positional filter.
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
  // Null floors test topic matching without creditability filtering.
  const totals = aggregateByActor(logs, deposit, null);
  for (const [addr, t] of totals) console.log(`  observed ${addr} = ${t.amount} units (scale 1e15)`);
  if (totals.size === 0) console.log("  folded to zero (sub-scale deposits)");
}

void main().catch((e) => { console.error(e); process.exit(1); });
