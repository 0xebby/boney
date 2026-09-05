/** Throwaway: has the watched pool seen any `Swap` at all lately, and from whom? */
import {createPublicClient, http, getAddress, type Hex} from "viem";
import {baseSepolia} from "viem/chains";
import {knownContractName} from "../src/lib/knownContracts";

const POOL = getAddress("0x46880b404CD35c165EDdefF7421019F8dD25F4Ad");
const SWAP = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67" as const;

const client = createPublicClient({
  chain: baseSepolia,
  transport: http("https://base-sepolia-rpc.publicnode.com", {retryCount: 6, retryDelay: 800}),
});

const head = await client.getBlockNumber();
const spans: Array<[bigint, bigint]> = [];
for (let to = head; to > head - 200_000n; to -= 49_000n) spans.push([to - 49_000n + 1n, to]);

let total = 0;
const senders = new Map<string, number>();
const recipients = new Map<string, number>();
let newest = 0n;

for (const [from, to] of spans) {
  const logs = (await client.request({
    method: "eth_getLogs",
    params: [
      {
        address: POOL,
        topics: [SWAP],
        fromBlock: `0x${from.toString(16)}`,
        toBlock: `0x${to.toString(16)}`,
      } as never,
    ],
  })) as Array<{topics: Hex[]; blockNumber: Hex}>;
  console.log(`  ${from}..${to}  ${logs.length} Swap log(s)`);
  total += logs.length;
  for (const log of logs) {
    const block = BigInt(log.blockNumber);
    if (block > newest) newest = block;
    const s = `0x${log.topics[1]!.slice(26)}`;
    const r = `0x${log.topics[2]!.slice(26)}`;
    senders.set(s, (senders.get(s) ?? 0) + 1);
    recipients.set(r, (recipients.get(r) ?? 0) + 1);
  }
}

console.log(`\n${total} Swap log(s) in the last 200k blocks (head ${head}), newest at ${newest}`);
const name = (a: string) => knownContractName(getAddress(a)) ?? a;
console.log("\nsender (topics[1]):");
for (const [a, n] of [...senders].sort((x, y) => y[1] - x[1])) console.log(`  ${n}x  ${name(a)}`);
console.log("\nrecipient (topics[2]) — what KPI 0 credits:");
for (const [a, n] of [...recipients].sort((x, y) => y[1] - x[1])) console.log(`  ${n}x  ${name(a)}`);
