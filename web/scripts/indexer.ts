/**
 * Event-sourced KPI indexer: real on-chain logs → attributed campaign progress.
 *
 * Usage: pnpm index [--rpc <url>] [--campaign <address>] [--from-block N] [--dry-run]
 *
 * This is the piece `BoneyDocs.md:118` assumes when it calls `KpiKind` "a hint for indexers and
 * UIs" — the thing that reads it. A campaign declares what it measures in `KpiSpec.params` (see
 * `lib/kpiSource.ts`); this reads those logs, works out who did what, and reports it.
 *
 * Deliberately thin. Everything that can be *wrong* — actor extraction, scaling, cumulative
 * totals, what is worth sending — lives in `lib/indexerCore.ts` where fixture logs prove it. This
 * file is RPC pagination, key handling, and transaction sending.
 *
 * Two properties worth stating plainly:
 *
 *  - **It cannot credit strangers.** Only a wallet that signed an EIP-712 touch can be credited, and
 *    every action is resolved against who held that wallet at the action's own block. Indexing all
 *    traffic on a contract and crediting it is not a thing this can do, by construction.
 *  - **Reports are cumulative and idempotent.** `newTotal` is a running total over the referral's whole
 *    attributed history, not a delta, and a re-run over the same range decides to send nothing. There
 *    is deliberately no cursor: a range shallower than that history would produce a window-scoped total
 *    that `Campaign` compares against a lifetime watermark and silently ignores. The range is instead
 *    bounded by attribution — it starts just after the campaign's first touch, since nothing earlier is
 *    creditable to anybody.
 *
 * Trust model: with `verifier == address(0)` the campaign credits the reported number as-is. This
 * indexer is honest but unverified on chain — a state-reading `IKpiVerifier` would bound it, and
 * is the natural next step.
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
  type IndexedLog,
} from "../src/lib/indexerCore";
import {
  attributionLookup,
  buildAttributionWindows,
  earliestAttributedBlock,
  type AttributionLookup,
  type TouchLog,
} from "../src/lib/attributionWindows";
import {blockAtTimestamp, earliestCoveringTouch} from "../src/lib/blockSearch";
import {TOUCH_STORED} from "../src/lib/events";
import {readBroadcast, readStartBlock} from "./generate-deployments";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");

/**
 * Base's public endpoint rejects wider `eth_getLogs` ranges outright:
 * `-32602: query exceeds max block range 2000`. Observed against sepolia.base.org, not guessed.
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

/**
 * `PRIVATE_KEY` from the repo-root `.env`, read the same way `seed-local.ts:93` does.
 *
 * Foundry loads that file itself, but this is a plain node script, so it has to read it too.
 */
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
 * How many block-timestamp reads are in flight at once. Public endpoints throttle a wider fan-out,
 * and a throttled batch costs more than a narrower one.
 */
const TIMESTAMP_CONCURRENCY = 12;

/**
 * Fetches logs across a range the RPC will actually accept.
 *
 * @param client Chain to read from.
 * @param source Event source the KPI names.
 * @param fromBlock First block to scan.
 * @param toBlock Last block to scan.
 * @returns Every matching log in the range, each carrying its block timestamp.
 */
async function fetchLogs(
  client: PublicClient,
  source: EventSource,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<IndexedLog[]> {
  const chunks = blockChunks(fromBlock, toBlock, MAX_LOG_RANGE);
  const matched: Omit<IndexedLog, "timestamp">[] = [];

  for (const [i, chunk] of chunks.entries()) {
    process.stdout.write(`\r    scanning ${i + 1}/${chunks.length} chunks…`);

    const logs = await client.getLogs({
      address: source.source,
      fromBlock: chunk.from,
      toBlock: chunk.to,
      // Filtered by the node, not here. These sources are busy contracts, and every non-matching
      // log downloaded is payload the run pays for and then discards.
      topics: [source.topic0.toLowerCase() as Hex],
    });

    for (const log of logs) {
      matched.push({
        topics: log.topics as readonly Hex[],
        data: log.data,
        blockNumber: log.blockNumber!,
      });
    }
  }

  // Verifier evidence carries each action's timestamp, so every block holding a matching log needs
  // one read. Batched and deduplicated: one block carries many logs, and serially is unusably slow
  // over thousands of them.
  const blocks = [...new Set(matched.map((log) => log.blockNumber))];
  const timestamps = new Map<bigint, bigint>();

  for (let i = 0; i < blocks.length; i += TIMESTAMP_CONCURRENCY) {
    const batch = blocks.slice(i, i + TIMESTAMP_CONCURRENCY);
    process.stdout.write(
      `\r    reading ${i + batch.length}/${blocks.length} block timestamps…`,
    );
    const read = await Promise.all(
      batch.map((blockNumber) => client.getBlock({blockNumber})),
    );
    read.forEach((block, j) => timestamps.set(batch[j], block.timestamp));
  }

  if (chunks.length > 0) process.stdout.write("\r");
  return matched.map((log) => ({...log, timestamp: timestamps.get(log.blockNumber)!}));
}

/**
 * Who held each of a campaign's referrals, at every block they ever acted in.
 *
 * This is the correctness boundary the block range is not. `reportUserAction` receives a total, never
 * the blocks behind it, so the contract cannot tell that a figure includes activity from before the
 * campaign existed or from a spell nobody was attributed for — with `verifier == address(0)` it credits
 * the number as-is. Only this filter stands between a wide scan and a wrong credit.
 *
 * Scanned from the oldest touch that could still cover creditable work rather than from the protocol's
 * deployment: a touch expires at most `effectiveMaxDuration` after it is stored, and activity before
 * the campaign's start credits nobody, so anything older covers nothing this campaign will pay for.
 *
 * One log scan for the whole campaign rather than a read per referral, and it also answers "was this
 * referral ever attributed at all" — absent from the history means dropped, which matches `Campaign`
 * skipping actions no promoter held.
 *
 * @param client Public client used for the log scan.
 * @param registry Attribution registry address.
 * @param campaign Campaign the touches belong to.
 * @param startTime Campaign start; actions before it are creditable to nobody.
 * @param fromBlock Lowest block to scan touches from.
 * @param head Highest block to scan touches to.
 * @returns The attribution lookup, and the lowest block any action of this campaign can be credited at.
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
    // Reported rather than dropped in silence: losing this line would make a busy source look quiet.
    if (!attribution.known(actor as `0x${string}`)) out.push(actor);
  }
  return out;
}

async function main(): Promise<void> {
  const publicClient = createPublicClient({transport: http(rpcUrl)}) as PublicClient;

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
    ? createWalletClient({account, transport: http(rpcUrl), chain: publicClient.chain})
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

  // Shared across every timestamp→block search this run. The searches start from the same bounds, so
  // they probe the same midpoints and the second campaign onward costs almost nothing.
  const blockTimestamps = new Map<bigint, bigint>();
  // From the same broadcast receipt the addresses come from. `lib/deployments.ts` can lag a redeploy,
  // and a floor above the registry that holds the touches would hide them.
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

    // Resolved once per campaign, and only for a campaign with an event-sourced KPI worth scanning.
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
      // Not event-sourced. Every campaign seeded before this feature is in this branch, which is
      // why running the indexer against a live chain cannot disturb them.
      if (!source) continue;

      const label = `campaign ${view.campaignId} kpi ${kpiIndex}`;
      const signature = catalogSignature(source.topic0) ?? source.topic0;
      console.log(`\n${label} — ${signature} on ${source.source}`);

      // Pre-flight against the contract's own guards, so a skip prints a reason instead of
      // burning gas on a revert. Each mirrors a named error in Campaign.reportUserAction.
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
        console.log(`  skipped: aggregate KPI — AggregateKpi would revert (see decision D7)`);
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

      // Attribution first, because it bounds the activity scan. `newTotal` is cumulative over the
      // referral's whole attributed life, so the range may only leave out blocks that could never have
      // been credited — nothing at or before the campaign's first touch can. Within the range each
      // action is then resolved against its own referral's windows. An explicit `--from-block` wins.
      const {attribution, attributedFrom} = await attributionFor();
      if (attributedFrom === null && !fromBlockFlag) {
        console.log(`  skipped: no touch was ever stored on this campaign — nobody to credit`);
        skipped++;
        continue;
      }
      const fromBlock = fromBlockFlag ? BigInt(fromBlockFlag) : attributedFrom!;

      console.log(`  blocks ${fromBlock}..${head}`);
      const logs = await fetchLogs(publicClient, source, fromBlock, head);
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

        // Sent for every KPI, verifier or not: `Campaign` decodes it itself to credit each action to
        // whoever held the referral at that action's block.
        const evidence = encodeActions(foldToLimit(decision.actions, MAX_EVIDENCE_ACTIONS));

        if (dryRun || !wallet || !account) {
          console.log(`  · ${total.referral}: would report ${decision.newTotal} (dry run)`);
          continue;
        }

        const hash = await wallet.writeContract({
          address: view.campaign,
          abi: CampaignAbi,
          functionName: "reportUserAction",
          args: [BigInt(kpiIndex), total.referral, decision.newTotal, evidence],
          chain: publicClient.chain,
          account,
        });
        const receipt = await publicClient.waitForTransactionReceipt({hash});

        console.log(
          `  · ${total.referral}: reported ${decision.newTotal} — ${hash} (${receipt.status})`,
        );
        reported++;
      }
    }
  }

  console.log(`\n${reported} report(s) sent, ${skipped} skipped.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
