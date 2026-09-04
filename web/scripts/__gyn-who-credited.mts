/** Throwaway: which transactions moved this campaign's progress, and who sent them. */
import {createPublicClient, http, getAddress, type PublicClient} from "viem";
import {baseSepolia} from "viem/chains";
import {CampaignAbi} from "../src/lib/abis";

const client = createPublicClient({chain: baseSepolia, transport: http("https://base-sepolia-rpc.publicnode.com", {retryCount: 5})}) as PublicClient;
const CAMPAIGN = getAddress("0x86B7b22aEd09452232Ca1A072db5BE7a837F06fc");
const head = await client.getBlockNumber();

const events = (CampaignAbi as {type: string; name?: string}[]).filter((x) => x.type === "event").map((e) => e.name);
console.log("campaign events:", events.join(", "));

const logs = await client.getLogs({address: CAMPAIGN, fromBlock: head - 1500n, toBlock: head});
console.log(`\n${logs.length} campaign log(s) in the last 1500 blocks`);

const {decodeEventLog} = await import("viem");
const senders = new Map<string, number>();
for (const l of logs) {
  let name = "?";
  try { name = decodeEventLog({abi: CampaignAbi, data: l.data, topics: l.topics}).eventName; } catch {}
  const tx = await client.getTransaction({hash: l.transactionHash});
  const key = `${name} <- ${tx.from} (to ${tx.to})`;
  senders.set(key, (senders.get(key) ?? 0) + 1);
}
for (const [k, n] of [...senders].sort((a, b) => b[1] - a[1])) console.log(`  ${n.toString().padStart(3)}x ${k}`);
