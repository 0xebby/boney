/**
 * Throwaway check for the report panel's KOL dropdown: after enough blocks, does the log-only touch
 * scan lose every attribution and disable every promoter the chain still holds?
 *
 * Replicates both paths of `useCampaignTouches` — the `planWindows` log scan and the subgraph read —
 * and runs `buildKolTargets` over each, so the comparison is the one the panel makes.
 *
 * Run: pnpm tsx scripts/__check-report-panel.ts <rpc> <subgraphUrl>
 */
import {createPublicClient, http, type PublicClient} from "viem";
import {CampaignRegistryAbi} from "../src/lib/abis";
import {TOUCH_STORED} from "../src/lib/events";
import {planWindows} from "../src/lib/promoters";
import {fetchPromotersFromGraph, promoterEntries} from "../src/lib/promoterGraph";
import {fetchTouchesFromGraph, touchEntries} from "../src/lib/attributionGraph";
import {buildKolTargets, latestTouches, type TouchEntry} from "../src/lib/reporting";
import {
  attributionLookup,
  buildAttributionWindows,
  mergeAttributionWindows,
} from "../src/lib/attributionWindows";
import {GENERATED_DEPLOYMENTS} from "../src/lib/deployments";

const rpc = process.argv[2];
const graphUrl = process.argv[3];
const deployment = GENERATED_DEPLOYMENTS[84532]!;

const client = createPublicClient({transport: http(rpc)}) as PublicClient;

/** One touch, in the shape `buildAttributionWindows` reads. */
const toLog = (e: TouchEntry) => ({
  user: e.referral,
  promoterId: e.promoterId,
  signedAt: e.signedAt,
  expiresAt: e.expiresAt,
  blockNumber: e.blockNumber,
});

async function main() {
  const head = await client.getBlockNumber({cacheTime: 0});
  const {windows: spans, skippedBefore} = planWindows(deployment.startBlock, head);
  const now = Math.floor(Date.now() / 1000);

  console.log(`head       ${head}`);
  console.log(`floor      ${skippedBefore ?? "none — full history scanned"}`);
  console.log(`spans      ${spans.length}\n`);

  const count = (await client.readContract({
    address: deployment.campaignRegistry,
    abi: CampaignRegistryAbi,
    functionName: "campaignCount",
  })) as bigint;

  const campaigns: `0x${string}`[] = [];
  for (let i = 0n; i < count; i++) {
    campaigns.push(
      (await client.readContract({
        address: deployment.campaignRegistry,
        abi: CampaignRegistryAbi,
        functionName: "campaignAt",
        args: [i],
      })) as `0x${string}`,
    );
  }

  const joins = await fetchPromotersFromGraph({url: graphUrl, campaigns});
  if (joins.kind !== "ok") throw new Error(`promoter graph unavailable: ${joins.reason}`);
  const promotersOf = new Map<string, {promoter: `0x${string}`; promoterId: `0x${string}`}[]>();
  for (const entry of promoterEntries(joins.data)) {
    const key = entry.campaign.toLowerCase();
    const list = promotersOf.get(key) ?? [];
    list.push({promoter: entry.promoter, promoterId: entry.promoterId});
    promotersOf.set(key, list);
  }

  for (const campaign of campaigns) {
    const logs: TouchEntry[] = [];
    for (const span of spans) {
      try {
        const found = await client.getLogs({
          address: deployment.attributionRegistry,
          event: TOUCH_STORED,
          args: {campaign},
          fromBlock: span.from,
          toBlock: span.to,
        });
        for (const log of found) {
          if (!log.args.user || !log.args.promoterId) continue;
          logs.push({
            referral: log.args.user,
            promoterId: log.args.promoterId,
            signedAt: log.args.signedAt ?? 0n,
            expiresAt: log.args.expiresAt ?? 0n,
            blockNumber: log.blockNumber ?? 0n,
          });
        }
      } catch {
        continue;
      }
    }

    const graph = await fetchTouchesFromGraph({url: graphUrl, campaigns: [campaign]});
    if (graph.kind !== "ok") throw new Error(`touch graph unavailable: ${graph.reason}`);
    const rows: TouchEntry[] = touchEntries(graph.data).map((e) => ({
      referral: e.referral,
      promoterId: e.promoterId,
      signedAt: e.signedAt,
      expiresAt: e.expiresAt,
      blockNumber: e.blockNumber,
    }));

    const promoters = promotersOf.get(campaign.toLowerCase()) ?? [];
    const before = buildKolTargets(promoters, latestTouches(logs), now);
    const after = buildKolTargets(promoters, latestTouches(rows), now);

    const logWindows = buildAttributionWindows(logs.map(toLog));
    const merged = mergeAttributionWindows(logWindows, buildAttributionWindows(rows.map(toLog)));
    const resolves = (w: typeof merged) => {
      const at = attributionLookup(w, 0n).at;
      return rows.filter((r) => at(r.referral, head, BigInt(now)) !== null).length;
    };

    console.log(`${campaign}`);
    console.log(`  promoters joined     ${promoters.length}`);
    console.log(`  touches  logs ${logs.length}  graph ${rows.length}`);
    console.log(
      `  reportable  logs ${before.filter((k) => !k.blocked).length}/${before.length}` +
        `  graph ${after.filter((k) => !k.blocked).length}/${after.length}`,
    );
    console.log(
      `  referrals resolving  logs ${resolves(logWindows)}/${rows.length}` +
        `  merged ${resolves(merged)}/${rows.length}\n`,
    );
  }
}

void main();
