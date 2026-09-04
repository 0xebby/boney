import {createPublicClient, http, getAddress, decodeEventLog, type PublicClient} from "viem";
import {baseSepolia} from "viem/chains";
import {CampaignAbi} from "../src/lib/abis";
const client = createPublicClient({chain: baseSepolia, transport: http("https://base-sepolia-rpc.publicnode.com", {retryCount: 5})}) as PublicClient;
const CAMPAIGN = getAddress("0x86B7b22aEd09452232Ca1A072db5BE7a837F06fc");
const head = await client.getBlockNumber();
const logs = await client.getLogs({address: CAMPAIGN, fromBlock: head - 1500n, toBlock: head});
for (const l of logs) {
  const d = decodeEventLog({abi: CampaignAbi, data: l.data, topics: l.topics}) as {eventName: string; args: Record<string, unknown>};
  if (d.eventName !== "ProgressCredited") continue;
  const blk = await client.getBlock({blockNumber: l.blockNumber});
  const t = new Date(Number(blk.timestamp) * 1000).toISOString().slice(11, 19);
  const a = d.args as Record<string, unknown>;
  console.log(`${t}  blk ${l.blockNumber}  kpi ${a.kpiIndex}  user ${a.user}  amount ${a.amount ?? a.delta ?? ""}  tx ${l.transactionHash.slice(0, 12)}`);
}
