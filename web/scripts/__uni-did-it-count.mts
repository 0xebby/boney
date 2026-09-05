/** Throwaway: did the swap just made land on the watched pool, and has it credited yet. */
import {createPublicClient, http, getAddress, type Hex, type PublicClient} from "viem";
import {baseSepolia} from "viem/chains";
import {CampaignAbi, EventMetricKpiVerifierAbi, AttributionRegistryAbi} from "../src/lib/abis";
import {GENERATED_DEPLOYMENTS} from "../src/lib/deployments";

const D = GENERATED_DEPLOYMENTS[baseSepolia.id]!;
const CAMPAIGN = getAddress("0x101431E3Cc9d8fec1221c0ED888c210f5E362b8b");
const POOL = getAddress("0x46880b404CD35c165EDdefF7421019F8dD25F4Ad");
const USDC = getAddress("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
const SWAP = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const XFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const FLOOR = 46363409n;

const client = createPublicClient({
  chain: baseSepolia,
  transport: http("https://base-sepolia-rpc.publicnode.com", {retryCount: 6, retryDelay: 800}),
}) as PublicClient;

const head = await client.getBlockNumber();
console.log(`head ${head}   window floor ${FLOOR}`);

const logs = (await client.request({
  method: "eth_getLogs",
  params: [{address: POOL, topics: [SWAP], fromBlock: `0x${FLOOR.toString(16)}`, toBlock: `0x${head.toString(16)}`}],
} as never)) as {blockNumber: Hex; transactionHash: Hex; topics: Hex[]}[];

console.log(`\n${logs.length} Swap log(s) on the watched pool since the campaign opened`);
for (const l of logs) {
  const blk = BigInt(l.blockNumber);
  const {timestamp} = await client.getBlock({blockNumber: blk});
  console.log(`  block ${blk}  ${new Date(Number(timestamp) * 1000).toISOString().slice(11, 19)}Z`);
  console.log(`    sender    0x${l.topics[1]!.slice(26)}`);
  console.log(`    recipient 0x${l.topics[2]!.slice(26)}   <- what KPI 0 credits`);
  console.log(`    tx ${l.transactionHash}`);
}

const out = (await client.request({
  method: "eth_getLogs",
  params: [{address: USDC, topics: [XFER, `0x${"0".repeat(24)}${POOL.slice(2).toLowerCase()}`], fromBlock: `0x${FLOOR.toString(16)}`, toBlock: `0x${head.toString(16)}`}],
} as never)) as {blockNumber: Hex; topics: Hex[]; data: Hex}[];
console.log(`\n${out.length} USDC transfer(s) out of the pool since the campaign opened  <- KPI 1`);
for (const l of out) {
  console.log(`  block ${BigInt(l.blockNumber)}  to 0x${l.topics[2]!.slice(26)}  ${BigInt(l.data)} units (${Number(BigInt(l.data)) / 1e6} USDC)`);
}

const touches = await client.getContractEvents({
  address: D.attributionRegistry,
  abi: AttributionRegistryAbi,
  eventName: "TouchStored",
  args: {campaign: CAMPAIGN},
  fromBlock: FLOOR - 200n,
  toBlock: head,
});
console.log(`\n${touches.length} touch(es) on this campaign:`);
const users: Hex[] = [];
for (const t of touches) {
  const a = t.args as Record<string, unknown>;
  const user = getAddress(String(a.user ?? a.wallet));
  users.push(user);
  console.log(`  block ${t.blockNumber}  user ${user}  promoter ${String(a.kol ?? a.kolId ?? a.promoter)}`);
}

console.log(`\nceiling (relay's observation) / credited (indexer's claim):`);
for (const kpi of [0n, 1n, 2n]) {
  const total = (await client.readContract({address: CAMPAIGN, abi: CampaignAbi, functionName: "totalProgress", args: [kpi]})) as bigint;
  const parts: string[] = [];
  for (const u of users) {
    const seen = (await client.readContract({
      address: D.eventMetricKpiVerifier, abi: EventMetricKpiVerifierAbi,
      functionName: "verifiedTotalOf", args: [CAMPAIGN, kpi, u],
    })) as bigint;
    parts.push(`${u.slice(0, 8)}…=${seen}`);
  }
  console.log(`  KPI ${kpi}  totalProgress=${total}  ceiling: ${parts.join("  ") || "no touched wallet"}`);
}
