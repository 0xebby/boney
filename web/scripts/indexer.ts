/**
 * Event-sourced KPI indexer for attributed campaign progress.
 *
 * Usage: pnpm index [--rpc <url>] [--campaign <address>] [--from-block N] [--dry-run]
 *
 * Reports are cumulative and idempotent. The default scan starts at the campaign's earliest
 * attributable block; `--from-block` overrides that bound.
 */
import {readFileSync, existsSync} from "node:fs";
import {resolve, dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {
  createPublicClient,
  createWalletClient,
  http,
  getAddress,
  type Hex,
  type PublicClient,
} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {CampaignAbi, BoneyAbi, AttributionRegistryAbi} from "../src/lib/abis";
import {decodeEventSource, type EventSource} from "../src/lib/kpiSource";
import {catalogSignature} from "../src/lib/eventNames";
import {
  actorFromTopic,
  aggregateByActor,
  blockChunks,
  decideReport,
  encodeActions,
  foldToLimit,
  logRequest,
  logScanKey,
  type IndexedLog,
  type RawLog,
} from "../src/lib/indexerCore";
import {
  attributionLookup,
  buildAttributionWindows,
  earliestAttributedBlock,
  type AttributionLookup,
  type TouchLog,
} from "../src/lib/attributionWindows";
import {blockAtTimestamp, earliestCoveringTouch} from "../src/lib/blockSearch";
import {
  harvestLogTimestamps,
  missingTimestamps,
  timestampBatches,
  type BlockTimestamps,
} from "../src/lib/blockTimestamps";
import {TOUCH_STORED} from "../src/lib/events";
import {campaignReportBatches, type CampaignReportPayload} from "../src/lib/reporting";
import {progress, progressDone} from "./progress";
import {loadTimestampCache, saveTimestampCache} from "./timestampCache";
import {readBroadcast, readStartBlock} from "./generate-deployments";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");

/**
 * Base's public endpoint rejects wider `eth_getLogs` ranges.
 */
const MAX_LOG_RANGE = BigInt(2_000);

/** Mirrors `Campaign.MAX_EVIDENCE_ACTIONS`; longer evidence reverts `TooManyActions`. */
const MAX_EVIDENCE_ACTIONS = 256;

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

const rpcUrl = arg("--rpc") ?? "http://127.0.0.1:8545";
const onlyCampaign = arg("--campaign")?.toLowerCase();
const fromBlockFlag = arg("--from-block");
const dryRun = process.argv.includes("--dry-run");


function envPrivateKey(): Hex | undefined {
  if (process.env.PRIVATE_KEY) return process.env.PRIVATE_KEY as Hex;
  const path = resolve(REPO_ROOT, ".env");
  if (!existsSync(path)) return undefined;
  const line = readFileSync(path, "utf8")
    .split("\n")
    .find((l) => /^\s*PRIVATE_KEY\s*=/.test(l));
  const value = line?.split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, "");
  return (value || undefined) as Hex | undefined;
}

/**
 * Calls packed into one JSON-RPC request. Public endpoints rate-limit by request.
 */
const RPC_BATCH_SIZE = 100;

/** Concurrent reads handed to the batched transport. */
const READ_CONCURRENCY = 300;

/** Per-request timeout. */
const RPC_TIMEOUT = 60_000;

/**
 * Retries per request. A public endpoint rate-limits partway through a long pass rather than at its
 * start, and the pass has no checkpoint of its own to resume from, so every request has to outlast
 * the limiter's window.
 */
const RPC_RETRY_COUNT = 6;

/** Initial exponential-backoff delay. */
const RPC_RETRY_DELAY = 1_000;

/**
 * Fetches logs across a range the RPC will actually accept.
 *
 * @param client Chain to read from.
 * @param source Event source the KPI names.
 * @param fromBlock First block to scan.
 * @param toBlock Last block to scan.
 * @param timestamps Cache the logs' own `blockTimestamp` fields are collected into, and read back from.
 * @returns Every matching log in the range, each carrying its block timestamp.
 */
async function fetchLogs(
  client: PublicClient,
  source: EventSource,
  fromBlock: bigint,
  toBlock: bigint,
  timestamps: BlockTimestamps,
): Promise<IndexedLog[]> {
  const chunks = blockChunks(fromBlock, toBlock, MAX_LOG_RANGE);
  const matched: Omit<IndexedLog, "timestamp">[] = [];

  for (const [i, chunk] of chunks.entries()) {
    progress(`scanning ${i + 1}/${chunks.length} chunks`);

    // Filtered by the node, and sent raw to make sure of it: these sources are busy contracts, and
    // every non-matching log downloaded is payload the run pays for and then discards.
    // `aggregateByActor` applies both the signature and the filter again over whatever comes back.
    const logs = (await client.request({
      method: "eth_getLogs",
      params: [logRequest(source.source, source.topic0, source, chunk.from, chunk.to)],
    })) as RawLog[];

    harvestLogTimestamps(logs, timestamps);

    for (const log of logs) {
      matched.push({
        topics: log.topics,
        data: log.data,
        blockNumber: BigInt(log.blockNumber),
      });
    }
  }
  if (chunks.length > 0) progressDone();

  // Fill only timestamps absent from log payloads and the cache.
  const blocks = [...new Set(matched.map((log) => log.blockNumber))];
  const missing = missingTimestamps(blocks, timestamps);
  let readSoFar = 0;

  for (const batch of timestampBatches(missing, READ_CONCURRENCY)) {
    readSoFar += batch.length;
    progress(`reading ${readSoFar}/${missing.length} block timestamps`);
    const read = await Promise.all(batch.map((blockNumber) => client.getBlock({blockNumber})));
    read.forEach((block, j) => timestamps.set(batch[j], block.timestamp));
  }
  if (missing.length > 0) progressDone();

  console.log(`  ${blocks.length} distinct block(s), ${missing.length} timestamp read(s) needed`);
  return matched.map((log) => ({...log, timestamp: timestamps.get(log.blockNumber)!}));
}

/**
 * Builds campaign attribution windows and their earliest attributable block.
 *
 * @param client Public client used for the log scan.
 * @param registry Attribution registry address.
 * @param campaign Campaign the touches belong to.
 * @param startTime Campaign start; actions before it are creditable to nobody.
 * @param fromBlock Lowest block to scan touches from.
 * @param head Highest block to scan touches to.
 * @returns Attribution lookup and earliest attributable block.
 */
async function campaignAttribution(
  client: PublicClient,
  registry: `0x${string}`,
  campaign: `0x${string}`,
  startTime: bigint,
  fromBlock: bigint,
  head: bigint,
): Promise<{attribution: AttributionLookup; attributedFrom: bigint | null}> {
  const touches: TouchLog[] = [];
  for (const chunk of blockChunks(fromBlock, head, MAX_LOG_RANGE)) {
    const touchLogs = await client.getLogs({
      address: registry,
      event: TOUCH_STORED,
      args: {campaign},
      fromBlock: chunk.from,
      toBlock: chunk.to,
    });
    for (const log of touchLogs) {
      if (!log.args.user || !log.args.promoterId) continue;
      touches.push({
        user: getAddress(log.args.user),
        promoterId: log.args.promoterId,
        signedAt: log.args.signedAt ?? BigInt(0),
        expiresAt: log.args.expiresAt ?? BigInt(0),
        blockNumber: log.blockNumber ?? BigInt(0),
      });
    }
  }

  const windows = buildAttributionWindows(touches);

  return {
    attribution: attributionLookup(windows, startTime),
    attributedFrom: earliestAttributedBlock(windows),
  };
}

/**
 * Referrals a KPI's logs show acting who were never attributed on the campaign.
 *
 * @param logs Matched activity logs.
 * @param source Event source describing how to read an actor out of a log.
 * @param attribution Attribution lookup for the campaign.
 * @returns Their addresses, checksummed.
 */
function unattributedActors(
  logs: readonly IndexedLog[],
  source: EventSource,
  attribution: AttributionLookup,
): string[] {
  const actors = new Set<string>();
  for (const log of logs) {
    const actor = actorFromTopic(log, source.actorTopic);
    if (actor) actors.add(getAddress(actor));
  }

  const out: string[] = [];
  for (const actor of actors) {
    if (!attribution.known(actor as `0x${string}`)) out.push(actor);
  }
  return out;
}

async function main(): Promise<void> {
  const publicClient = createPublicClient({
    transport: http(rpcUrl, {
      timeout: RPC_TIMEOUT,
      batch: {batchSize: RPC_BATCH_SIZE, wait: 8},
      retryCount: RPC_RETRY_COUNT,
      retryDelay: RPC_RETRY_DELAY,
    }),
  }) as PublicClient;

  const chainId = await publicClient.getChainId();
  const addresses = readBroadcast(chainId);
  const boney = getAddress(addresses.boney!);
  const attributionRegistry = getAddress(addresses.attributionRegistry!);

  const pk = envPrivateKey();
  if (!pk && !dryRun) {
    console.error(
      `Reporting needs the project's key. Set PRIVATE_KEY in ${resolve(REPO_ROOT, ".env")},\n` +
        `or pass --dry-run to see what would be reported without sending anything.`,
    );
    process.exit(1);
  }

  const account = pk ? privateKeyToAccount(pk) : undefined;
  const wallet = account
    ? createWalletClient({
        account,
        transport: http(rpcUrl, {retryCount: RPC_RETRY_COUNT, retryDelay: RPC_RETRY_DELAY}),
        chain: publicClient.chain,
      })
    : undefined;

  console.log(`Chain ${chainId} at ${rpcUrl}`);
  console.log(`Reporter ${account?.address ?? "(dry run — no key)"}`);

  const head = await publicClient.getBlockNumber();

  // The Boney facade only exposes summary rows; KPI specs live on the Campaign itself.
  const views = (await publicClient.readContract({
    address: boney,
    abi: BoneyAbi,
    functionName: "browseCampaigns",
    args: [BigInt(0), BigInt(1_000)],
  })) as readonly {campaign: `0x${string}`; campaignId: bigint; kpiCount: bigint}[];

  let reported = 0;
  let skipped = 0;

  // Share timestamp lookups across campaigns and retain them across passes.
  const blockTimestamps = loadTimestampCache(chainId);
  if (blockTimestamps.size > 0) {
    console.log(`${blockTimestamps.size} block timestamp(s) cached from earlier passes`);
  }
  // Use the broadcast start block so attribution touches cannot precede the scan floor.
  const deployedAt = BigInt(readStartBlock(chainId));

  for (const view of views) {
    if (onlyCampaign && view.campaign.toLowerCase() !== onlyCampaign) continue;

    const [status, startTime, endTime, project, kpiCount] = await Promise.all([
      publicClient.readContract({address: view.campaign, abi: CampaignAbi, functionName: "status"}),
      publicClient.readContract({address: view.campaign, abi: CampaignAbi, functionName: "startTime"}),
      publicClient.readContract({address: view.campaign, abi: CampaignAbi, functionName: "endTime"}),
      publicClient.readContract({address: view.campaign, abi: CampaignAbi, functionName: "project"}),
      publicClient.readContract({address: view.campaign, abi: CampaignAbi, functionName: "kpiCount"}),
    ]);

    // Cache scans within the current campaign.
    const logScans = new Map<string, IndexedLog[]>();

    // Plan every KPI report before sending stable Campaign batches.
    const campaignReports: CampaignReportPayload[] = [];

    // Resolve attribution once for campaigns with event-sourced KPIs.
    let attributionOnce:
      | Promise<{attribution: AttributionLookup; attributedFrom: bigint | null}>
      | undefined;
    const attributionFor = async () => {
      if (!attributionOnce) {
        const maxDuration = (await publicClient.readContract({
          address: attributionRegistry,
          abi: AttributionRegistryAbi,
          functionName: "effectiveMaxDuration",
          args: [view.campaign],
        })) as bigint;

        const touchFloor = await blockAtTimestamp(
          async (blockNumber) => (await publicClient.getBlock({blockNumber})).timestamp,
          earliestCoveringTouch(startTime as bigint, BigInt(maxDuration)),
          deployedAt,
          head,
          blockTimestamps,
        );

        attributionOnce = campaignAttribution(
          publicClient,
          attributionRegistry,
          view.campaign,
          startTime as bigint,
          touchFloor,
          head,
        );
      }
      return attributionOnce;
    };

    for (let kpiIndex = 0; kpiIndex < Number(kpiCount); kpiIndex++) {
      const spec = (await publicClient.readContract({
        address: view.campaign,
        abi: CampaignAbi,
        functionName: "kpi",
        args: [BigInt(kpiIndex)],
      })) as {kind: number; verifier: `0x${string}`; aggregate: boolean; params: Hex};

      const source = decodeEventSource(spec.params);
      // Ignore KPIs without an event source.
      if (!source) continue;

      const label = `campaign ${view.campaignId} kpi ${kpiIndex}`;
      const signature = catalogSignature(source.topic0) ?? source.topic0;
      console.log(`\n${label} — ${signature} on ${source.source}`);

      // Mirror the contract's report guards before scanning.
      const now = BigInt(Math.floor(Date.now() / 1000));
      if (Number(status) !== 1) {
        console.log(`  skipped: campaign is not Active — onlyActive would revert`);
        skipped++;
        continue;
      }
      if (now < (startTime as bigint) || now > (endTime as bigint)) {
        console.log(`  skipped: outside the campaign window — OutsideWindow would revert`);
        skipped++;
        continue;
      }
      if (spec.aggregate) {
        console.log(`  skipped: aggregate KPI — AggregateKpi would revert`);
        skipped++;
        continue;
      }
      if (account && getAddress(project as `0x${string}`) !== account.address) {
        console.log(
          `  skipped: reporter is not the project (${project}) — NotReporter would revert`,
        );
        skipped++;
        continue;
      }

      // Scan the full attributable history unless `--from-block` overrides it.
      const {attribution, attributedFrom} = await attributionFor();
      if (attributedFrom === null && !fromBlockFlag) {
        console.log(`  skipped: no touch was ever stored on this campaign — nobody to credit`);
        skipped++;
        continue;
      }
      const fromBlock = fromBlockFlag ? BigInt(fromBlockFlag) : attributedFrom!;

      console.log(`  blocks ${fromBlock}..${head}`);
      const scanKey = logScanKey(source, fromBlock, head);
      let logs = logScans.get(scanKey);
      if (logs) {
        console.log(`  reusing the scan an earlier KPI on this source already paid for`);
      } else {
        logs = await fetchLogs(publicClient, source, fromBlock, head, blockTimestamps);
        logScans.set(scanKey, logs);

        // Persist timestamp reads before contract reads and writes.
        saveTimestampCache(chainId, blockTimestamps);
      }
      console.log(`  ${logs.length} matching log(s)`);

      for (const actor of unattributedActors(logs, source, attribution)) {
        console.log(`  · ${actor}: never attributed on this campaign — nobody to credit`);
        skipped++;
      }
      const totals = aggregateByActor(logs, source, attribution);

      for (const total of totals.values()) {
        const alreadyCredited = (await publicClient.readContract({
          address: view.campaign,
          abi: CampaignAbi,
          functionName: "userCreditedOf",
          args: [total.referral, BigInt(kpiIndex)],
        })) as bigint;

        const decision = decideReport(total, alreadyCredited);
        if (!decision.send) {
          console.log(`  · ${total.referral}: ${decision.reason}`);
          skipped++;
          continue;
        }

        // Evidence preserves per-action attribution for every KPI.
        const evidence = encodeActions(foldToLimit(decision.actions, MAX_EVIDENCE_ACTIONS));

        if (dryRun) {
          console.log(`  · ${total.referral}: would report ${decision.newTotal} (dry run)`);
          continue;
        }
        campaignReports.push({
          kpiIndex: BigInt(kpiIndex),
          user: total.referral,
          newTotal: decision.newTotal,
          evidence,
        });
      }
    }

    if (!wallet || !account) continue;
    const batches = campaignReportBatches(campaignReports);
    for (const [batchIndex, batch] of batches.entries()) {
      const {request} = await publicClient.simulateContract({
        account,
        address: view.campaign,
        abi: CampaignAbi,
        functionName: "reportUserActionsBatch",
        args: [batch],
      });
      const hash = await wallet.writeContract(request);
      const receipt = await publicClient.waitForTransactionReceipt({hash});
      if (receipt.status !== "success") {
        throw new Error(
          `campaign ${view.campaignId} batch ${batchIndex + 1}/${batches.length} reverted: ${hash}`,
        );
      }
      console.log(
        `  batch ${batchIndex + 1}/${batches.length}: reported ${batch.length} item(s) — ${hash}`,
      );
      reported += batch.length;
    }
  }

  // Persist timestamp reads from scans and attribution searches.
  saveTimestampCache(chainId, blockTimestamps);

  console.log(`\n${reported} report(s) sent, ${skipped} skipped.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
