/**
 * Throwaway: for each KPI, scans the whole report window for logs whose actor topic is one of the
 * campaign's referrals, then splits them by whether the KPI's own topic filter matches.
 *
 * Answers one question the on-chain totals cannot: is the gap between Boney's ceiling and the
 * project's claim the unfiltered/filtered asymmetry, or the indexer being behind?
 *
 * Run: pnpm tsx scripts/__gyn-gap.mts <campaign>
 */
import {createPublicClient, http, getAddress, pad, toHex, type Hex, type PublicClient} from "viem";
import {CampaignAbi} from "../src/lib/abis";
import {GENERATED_DEPLOYMENTS} from "../src/lib/deployments";
import {decodeEventSource} from "../src/lib/kpiSource";
import {blockChunks} from "../src/lib/indexerCore";

const RPC = "https://base-sepolia-rpc.publicnode.com";
const D = GENERATED_DEPLOYMENTS[84532]!;
const campaign = getAddress(process.argv[2]!);
const FROM = 46215147n; // windowStartBlock, identical on all three KPIs
const RANGE = 1900n;

const client = createPublicClient({transport: http(RPC, {retryCount: 6})}) as PublicClient;

type Raw = {topics: readonly Hex[]; data: Hex; blockNumber: Hex; transactionHash: Hex};

async function main() {
  const g = await fetch(process.env.SUBGRAPH!, {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({
      query: `{campaign(id:"${campaign.toLowerCase()}"){touches{user promoterId signedAt blockNumber}}}`,
    }),
  }).then((r) => r.json());
  const touches = g.data.campaign.touches as {
    user: Hex;
    promoterId: Hex;
    signedAt: string;
    blockNumber: string;
  }[];
  const byUser = new Map(touches.map((t) => [t.user.toLowerCase(), t]));
  const actorWords = touches.map((t) => pad(t.user, {size: 32}).toLowerCase() as Hex);

  const head = await client.getBlockNumber();
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
    })) as {params: Hex};
    const src = decodeEventSource(spec.params);
    if (!src) continue;

    // Actor slot ORs the referrals; the KPI's own filter slot is left open so both sides are visible
    // in one scan.
    const topics: (Hex | Hex[] | null)[] = [src.topic0];
    for (let slot = 1; slot <= Math.max(src.actorTopic, src.filterTopic ?? 0); slot++) {
      topics.push(slot === src.actorTopic ? actorWords : null);
    }

    const logs: Raw[] = [];
    let failed = 0;
    for (const c of blockChunks(FROM, head, RANGE)) {
      try {
        const raw = (await client.request({
          method: "eth_getLogs",
          params: [
            {
              address: src.source,
              topics: topics as never,
              fromBlock: toHex(c.from),
              toBlock: toHex(c.to),
            },
          ],
        })) as Raw[];
        logs.push(...raw);
      } catch {
        failed++;
      }
    }

    const filterWord = src.filterValue?.toLowerCase();
    const rows = new Map<string, {all: number; matched: number; preAttribution: number}>();
    for (const l of logs) {
      const actor = l.topics[src.actorTopic]!.toLowerCase();
      const user = `0x${actor.slice(26)}`;
      const row = rows.get(user) ?? {all: 0, matched: 0, preAttribution: 0};
      row.all++;
      const passes =
        !filterWord || l.topics[src.filterTopic!]?.toLowerCase() === filterWord;
      if (passes) {
        row.matched++;
        const touch = byUser.get(user);
        if (touch && BigInt(l.blockNumber) < BigInt(touch.blockNumber)) row.preAttribution++;
      }
      rows.set(user, row);
    }

    console.log(
      `\nKPI ${i}: ${logs.length} log(s) with a referral in topic ${src.actorTopic}` +
        `, filter topic ${src.filterTopic} == ${filterWord ?? "(none)"}, ${failed} failed chunk(s)`,
    );
    if (rows.size === 0) console.log("  no referral appears in the actor slot at all");
    for (const [user, r] of rows) {
      console.log(
        `  ${user}  unfiltered=${r.all}  filter-matched=${r.matched}  ` +
          `(of matched, ${r.preAttribution} predate that referral's touch block)`,
      );
    }
  }
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
