/**
 * Throwaway check for `useObservedActions`' scan: does the positional topic filter actually return
 * the referral's logs, and does the fold match what the indexer would credit?
 *
 * Run: pnpm tsx scripts/__check-observed.ts <campaign>
 */
import {createPublicClient, http, pad, toHex, type Hex, type PublicClient} from "viem";
import {CampaignAbi} from "../src/lib/abis";
import {decodeEventSource, knownSignature} from "../src/lib/kpiSource";
import {aggregateByActor, type IndexedLog} from "../src/lib/indexerCore";
import {planWindows} from "../src/lib/promoters";

const RPC = "https://sepolia.base.org";
const REGISTRY = "0x92a86e0Ce5f32328CE7bB208431B4904Ef7760D5" as const;
const START_BLOCK = 45295535n;
const campaign = process.argv[2] as `0x${string}`;

const client = createPublicClient({transport: http(RPC)}) as PublicClient;

async function main() {

  const head = await client.getBlockNumber();
  const {windows, skippedBefore} = planWindows(START_BLOCK, head);
  console.log(`head ${head}, ${windows.length} windows, floor ${skippedBefore ?? START_BLOCK}`);

  // Referrals attributed on this campaign, from TouchStored.
  const touchLogs: {user: `0x${string}`}[] = [];
  for (const w of windows) {
    try {
      const logs = await client.getLogs({
        address: REGISTRY,
        event: {
          type: "event",
          name: "TouchStored",
          inputs: [
            {name: "campaign", type: "address", indexed: true},
            {name: "user", type: "address", indexed: true},
            {name: "promoterId", type: "bytes32", indexed: true},
            {name: "signedAt", type: "uint64"},
            {name: "expiresAt", type: "uint64"},
            {name: "relayer", type: "address"},
          ],
        },
        args: {campaign},
        fromBlock: w.from,
        toBlock: w.to,
      });
      for (const l of logs) if (l.args.user) touchLogs.push({user: l.args.user});
    } catch {
      /* ignore */
    }
  }
  const referrals = [...new Set(touchLogs.map((t) => t.user.toLowerCase()))] as `0x${string}`[];
  console.log(`referrals: ${referrals.length ? referrals.join(", ") : "(none)"}`);
  if (referrals.length === 0) process.exit(0);

  const kpiCount = (await client.readContract({
    address: campaign,
    abi: CampaignAbi,
    functionName: "kpiCount",
  })) as bigint;

  for (let i = 0n; i < kpiCount; i++) {
    const spec = (await client.readContract({
      address: campaign,
      abi: CampaignAbi,
      functionName: "kpi",
      args: [i],
    })) as {params: Hex; aggregate: boolean};

    const source = decodeEventSource(spec.params);
    console.log(`\nkpi ${i}: ${source ? knownSignature(source.topic0) ?? source.topic0 : "no source"}`);
    if (!source) continue;

    const topics: (Hex | Hex[] | null)[] = [source.topic0];
    for (let t = 1; t < source.actorTopic; t++) topics.push(null);
    topics.push(referrals.map((r) => pad(r, {size: 32})));

    const logs: IndexedLog[] = [];
    let failed = 0;
    for (const w of windows) {
      try {
        const raw = (await client.request({
          method: "eth_getLogs",
          params: [
            {
              address: source.source,
              topics: topics as never,
              fromBlock: toHex(w.from),
              toBlock: toHex(w.to),
            },
          ],
        })) as {topics: readonly Hex[]; data: Hex; blockNumber: Hex}[];
        for (const l of raw)
          logs.push({topics: l.topics, data: l.data, blockNumber: BigInt(l.blockNumber), timestamp: 0n});
      } catch (err) {
        failed++;
        if (failed === 1) console.log(`  first window error: ${(err as Error).message.slice(0, 120)}`);
      }
    }

    console.log(`  ${logs.length} matched logs, ${failed} failed windows`);
    const totals = aggregateByActor(logs, source);
    if (totals.size === 0) console.log("  observed: nothing — panel refuses, no payout");
    for (const [addr, t] of totals) {
      const credited = (await client.readContract({
        address: campaign,
        abi: CampaignAbi,
        functionName: "userCreditedOf",
        args: [t.referral, i],
      })) as bigint;
      console.log(`  observed ${addr} = ${t.amount} (already credited ${credited})`);
    }
  }

}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
