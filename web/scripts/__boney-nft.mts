/**
 * Re-reads the open-mint NFT at the current head: how many `Transfer` logs are mints, how many
 * wallets minted, and what `Minted.paid` reads.
 */
import {createPublicClient, http, getAddress, type Hex} from "viem";
import {baseSepolia} from "viem/chains";
import {eventTopic} from "../src/lib/kpiSource";

const client = createPublicClient({
  chain: baseSepolia,
  transport: http(process.env.BASE_SEPOLIA_RPC ?? "https://base-sepolia-rpc.publicnode.com"),
});

const NFT = getAddress("0x3bdD104560Ae0F0cC4360E691Cdcd972F4CD1193");
const TRANSFER = eventTopic("Transfer(address,address,uint256)");
const MINTED = eventTopic("Minted(address,uint256,uint256)");
const START = 46110182n;
const CHUNK = 9000n;
const head = await client.getBlockNumber();

const logs: {topics: readonly Hex[]; data: Hex}[] = [];
let from = START;
while (from <= head) {
  const to = from + CHUNK - 1n > head ? head : from + CHUNK - 1n;
  try {
    logs.push(...((await client.getLogs({address: NFT, fromBlock: from, toBlock: to} as never)) as never as typeof logs));
  } catch { /* chunk skipped */ }
  from = to + 1n;
}

const transfers = logs.filter((l) => l.topics[0]?.toLowerCase() === TRANSFER.toLowerCase());
const mints = transfers.filter((l) => BigInt(l.topics[1]!) === 0n);
const minted = logs.filter((l) => l.topics[0]?.toLowerCase() === MINTED.toLowerCase());

console.log(`head=${head}`);
console.log(`Transfer     ${transfers.length}  from==0x0: ${mints.length}  secondary: ${transfers.length - mints.length}`);
console.log(`  distinct recipients (topic 2): ${new Set(transfers.map((l) => l.topics[2])).size}`);
console.log(`  mint recipients:               ${new Set(mints.map((l) => l.topics[2])).size}`);
console.log(`Minted       ${minted.length}  distinct minters: ${new Set(minted.map((l) => l.topics[1])).size}`);
const paid = minted.map((l) => BigInt(l.data.slice(0, 66)));
const qty = minted.map((l) => BigInt(`0x${l.data.slice(66, 130)}`));
console.log(`  paid  min=${paid.reduce((a, b) => (b < a ? b : a))}  max=${paid.reduce((a, b) => (b > a ? b : a))}`);
console.log(`  qty   ${[...new Set(qty.map(String))].join(", ")}  sum=${qty.reduce((a, b) => a + b, 0n)}`);
