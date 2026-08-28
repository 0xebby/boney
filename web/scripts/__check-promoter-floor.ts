/**
 * Throwaway check for the promoter directory's block floor: after enough blocks, does the log scan
 * lose a promoter the chain still knows about, and does the subgraph path still find them?
 *
 * Replicates `useCampaignPromoters`' log path exactly — same `planWindows`, same `getLogs` — so the
 * scan under test is the one the app runs.
 *
 * Run: pnpm tsx scripts/__check-promoter-floor.ts <rpc> <startBlock> <campaign[,campaign…]> [promoter]
 */
import {createPublicClient, http, type PublicClient} from "viem";
import {CampaignAbi} from "../src/lib/abis";
import {PROMOTER_JOINED} from "../src/lib/events";
import {planWindows, dedupePromoters, type PromoterEntry} from "../src/lib/promoters";
import {fetchPromotersFromGraph, promoterEntries} from "../src/lib/promoterGraph";

const rpc = process.argv[2];
const startBlock = BigInt(process.argv[3]);
const campaigns = process.argv[4].split(",") as `0x${string}`[];
const promoter = process.argv[5] as `0x${string}` | undefined;

const client = createPublicClient({transport: http(rpc)}) as PublicClient;

async function main() {
  const head = await client.getBlockNumber({cacheTime: 0});
  const {windows, skippedBefore} = planWindows(startBlock, head);

  console.log(`head        ${head}`);
  console.log(`startBlock  ${startBlock}`);
  console.log(`windows     ${windows.length}`);
  console.log(`floor       ${skippedBefore === undefined ? "none — full history scanned" : skippedBefore}`);

  const entries: PromoterEntry[] = [];
  for (const w of windows) {
    try {
      const logs = await client.getLogs({
        address: campaigns,
        event: PROMOTER_JOINED,
        fromBlock: w.from,
        toBlock: w.to,
      });
      for (const log of logs) {
        if (!log.args.promoter || !log.args.promoterId || !log.address) continue;
        entries.push({
          campaign: log.address,
          promoter: log.args.promoter,
          promoterId: log.args.promoterId,
          reputation: log.args.reputation ?? BigInt(0),
          blockNumber: log.blockNumber ?? BigInt(0),
        });
      }
    } catch (error) {
      console.log(`  window ${w.from}-${w.to} failed: ${(error as Error).message.slice(0, 60)}`);
    }
  }

  const found = dedupePromoters(entries);
  console.log(`\nLOG SCAN    ${found.length} promoter(s)`);
  for (const e of found) console.log(`  ${e.promoter} joined at block ${e.blockNumber}`);

  // The point lookup the rest of the app uses. It reads state, not logs, so it has no block floor —
  // a promoter missing above but present here is the directory losing a member the chain still has.
  if (promoter) {
    const id = await client.readContract({
      address: campaigns[0],
      abi: CampaignAbi,
      functionName: "promoterIdOf",
      args: [promoter],
    });
    const isMember = id !== `0x${"0".repeat(64)}`;
    console.log(`\nPOINT LOOKUP promoterIdOf(${promoter})`);
    console.log(`  ${isMember ? `member, id ${id}` : "NOT a member"}`);
    console.log(
      `  in log scan: ${found.some((e) => e.promoter.toLowerCase() === promoter.toLowerCase()) ? "yes" : "NO"}`,
    );
  }

  const url = process.env.NEXT_PUBLIC_SUBGRAPH_URL?.trim();
  if (url) {
    const result = await fetchPromotersFromGraph({url, campaigns});
    if (result.kind !== "ok") {
      console.log(`\nSUBGRAPH    unavailable (${result.reason}): ${result.message}`);
    } else {
      const rows = promoterEntries(result.data);
      console.log(`\nSUBGRAPH    ${rows.length} promoter(s), truncated=${result.data.truncated}`);
      for (const e of rows) console.log(`  ${e.promoter} joined at block ${e.blockNumber}`);
    }
  } else {
    console.log(`\nSUBGRAPH    no NEXT_PUBLIC_SUBGRAPH_URL — log scan is the only source`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
