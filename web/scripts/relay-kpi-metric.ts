/**
 * Boney's KPI relayer: real on-chain logs → `EventMetricKpiVerifier.verifiedTotals`.
 *
 * Usage: pnpm relay --campaign <address> --kpi <index> [--rpc <url>] [--verifier <address>] [--dry-run]
 *
 * The independent half of KPI verification. `indexer.ts` reports what a *project* claims; this
 * reports what Boney *observed*, and a claim is capped at the smaller of the two. The two are
 * deliberately separate processes with separate keys — a single process doing both would make the
 * cap a formality.
 *
 * Deliberately thin, the same way `indexer.ts` is: decoding, attribution filtering, aggregation and
 * batch planning all live in `lib/relayCore.ts` where fixture logs prove them. This file is RPC
 * pagination, key handling, and transaction sending.
 *
 * Three properties worth stating plainly:
 *
 *  - **Stateless.** There is no cursor file. The checkpoint lives on chain (`lastScannedBlock`), so
 *    any instance on any machine resumes exactly where the last one stopped. Losing this host costs
 *    nothing.
 *  - **Bounded on chain.** `reportBatch` rejects a checkpoint past `windowEndBlock`, so even a buggy
 *    run cannot report past the campaign's real reporting close.
 *  - **Retry-safe.** A run split across transactions advances the checkpoint only on the last one, so
 *    a partial failure leaves it untouched and the whole run can simply be repeated.
 *
 * Trust model: whoever holds `REPORTER_PRIVATE_KEY` is trusted to report honestly. This is not a
 * trustless oracle. What it does guarantee is that a project cannot credit itself more than an
 * independent observer saw.
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
import {CampaignAbi, EventMetricKpiVerifierAbi, AttributionRegistryAbi} from "../src/lib/abis";
import {getDeployment} from "../src/lib/chains";
import {
  decodeEventSource,
  matchesTopicFilter,
  topicFilterArray,
  type EventSource,
} from "../src/lib/kpiSource";
import {blockChunks} from "../src/lib/indexerCore";
import {
  attributionLookup,
  buildAttributionWindows,
  type TouchLog,
} from "../src/lib/attributionWindows";
import {blockAtTimestamp, earliestCoveringTouch} from "../src/lib/blockSearch";
import {TOUCH_STORED} from "../src/lib/events";
import {
  aggregateDeltas,
  decodeUserEvents,
  describeConfigDrift,
  nextTotals,
  parseEventSignature,
  planReportBatches,
  resolveScanRange,
  uniqueBlocks,
  validateParamIndexes,
  type KpiConfig,
  type RelayLog,
} from "../src/lib/relayCore";
import {readStartBlock} from "./generate-deployments";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");

/**
 * Base's public endpoint rejects wider `eth_getLogs` ranges outright:
 * `-32602: query exceeds max block range 2000`. Same constant `indexer.ts` uses, same reason.
 */
const MAX_LOG_RANGE = BigInt(2_000);

/**
 * Blocks left between the head and the end of a scan.
 *
 * The checkpoint is monotonic on chain and cannot be walked back, so a checkpoint set on a block that
 * a reorg then discards is permanent damage. Staying a few blocks behind costs one extra run's
 * latency and removes the failure mode.
 */
const CONFIRMATIONS = BigInt(5);

/** Users per `reportBatch` transaction. Bounded by block gas, not by anything on chain. */
const BATCH_SIZE = 200;

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

/**
 * The relayer's key, read the way `indexer.ts:envPrivateKey` reads the project's.
 *
 * `REPORTER_PRIVATE_KEY` and not `PRIVATE_KEY`: the reporter is meant to be a different account from
 * the project, since the whole point is an independent observation. Falls back to the repo-root
 * `.env` because this is a plain node script and nothing else loads it.
 */
function reporterKey(): Hex | undefined {
  if (process.env.REPORTER_PRIVATE_KEY) return process.env.REPORTER_PRIVATE_KEY as Hex;
  const path = resolve(REPO_ROOT, ".env");
  if (!existsSync(path)) return undefined;
  const line = readFileSync(path, "utf8")
    .split("\n")
    .find((l) => /^\s*REPORTER_PRIVATE_KEY\s*=/.test(l));
  const value = line?.split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, "");
  return (value || undefined) as Hex | undefined;
}

/**
 * Fetches matching logs across a range the RPC will actually accept.
 *
 * @param client Chain to read from.
 * @param address Contract whose logs are scanned.
 * @param topic0 Event signature hash to match.
 * @param source Event source from the KPI's params, or null when it could not be decoded.
 * @param fromBlock First block to scan.
 * @param toBlock Last block to scan.
 * @returns Every matching log in the range.
 */
async function fetchLogs(
  client: PublicClient,
  address: `0x${string}`,
  topic0: Hex,
  source: EventSource | null,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<RelayLog[]> {
  const out: RelayLog[] = [];
  const chunks = blockChunks(fromBlock, toBlock, MAX_LOG_RANGE);

  for (const [i, chunk] of chunks.entries()) {
    process.stdout.write(`\r    scanning ${i + 1}/${chunks.length} chunks…`);
    const logs = await client.getLogs({
      address,
      fromBlock: chunk.from,
      toBlock: chunk.to,
      topics: [
        topic0.toLowerCase() as Hex,
        ...(source ? topicFilterArray(source) : []),
      ],
    });

    for (const log of logs) {
      if (log.topics[0]?.toLowerCase() !== topic0.toLowerCase()) continue;
      if (source && !matchesTopicFilter(log, source)) continue;
      if (log.blockNumber === null) continue;
      out.push({topics: log.topics, data: log.data, blockNumber: log.blockNumber});
    }
  }
  if (chunks.length > 0) process.stdout.write("\r\x1b[K");

  return out;
}

async function main(): Promise<void> {
  const rpcUrl = arg("--rpc") ?? "http://127.0.0.1:8545";
  const dryRun = process.argv.includes("--dry-run");

  const campaignArg = arg("--campaign");
  if (!campaignArg) throw new Error("--campaign <address> is required");
  const campaign = getAddress(campaignArg);

  const kpiIndex = BigInt(arg("--kpi") ?? "0");

  const client = createPublicClient({transport: http(rpcUrl)}) as PublicClient;
  const chainId = await client.getChainId();

  const verifierArg = arg("--verifier") ?? getDeployment(chainId)?.eventMetricKpiVerifier;
  if (!verifierArg) {
    throw new Error(
      `No EventMetricKpiVerifier known for chain ${chainId}.\n` +
        `Pass --verifier <address>, or deploy and run \`pnpm deployments\`.`,
    );
  }
  const verifier = getAddress(verifierArg);

  console.log(`Relaying KPI ${kpiIndex} of ${campaign}`);
  console.log(`  chain:    ${chainId}`);
  console.log(`  verifier: ${verifier}`);

  // ── config ─────────────────────────────────────────────────────

  const raw = await client.readContract({
    address: verifier,
    abi: EventMetricKpiVerifierAbi,
    functionName: "configOf",
    args: [campaign, kpiIndex],
  });

  const config: KpiConfig = {
    targetContract: getAddress(raw.targetContract),
    eventSignature: raw.eventSignature,
    userParamIndex: Number(raw.userParamIndex),
    valueParamIndex: Number(raw.valueParamIndex),
    aggregation: Number(raw.aggregation) === 1 ? 1 : 0,
    scale: raw.scale,
    windowStartBlock: raw.windowStartBlock,
    windowEndBlock: raw.windowEndBlock,
    configured: raw.configured,
  };

  if (!config.configured) {
    throw new Error(
      `KPI ${kpiIndex} of ${campaign} is not configured on ${verifier}.\n` +
        `Run setKpiConfig first — \`pnpm report-window --campaign ${campaign}\` derives the block bounds.`,
    );
  }

  const {event, topic0} = parseEventSignature(config.eventSignature);
  validateParamIndexes(event, config);

  console.log(`  watching: ${config.eventSignature}`);
  console.log(`            on ${config.targetContract} (topic0 ${topic0})`);
  console.log(
    `  mode:     ${config.aggregation === 1 ? "SUM" : "COUNT"}` +
      `  user=param${config.userParamIndex}` +
      (config.aggregation === 1 ? `  value=param${config.valueParamIndex}` : "") +
      `  scale=${config.scale}`,
  );
  console.log(`  window:   [${config.windowStartBlock}, ${config.windowEndBlock}]`);

  // ── drift guard ────────────────────────────────────────────────

  // The indexer reads its event source from `KpiSpec.params` while this reads `KpiConfig`. If the two
  // ever name different events the cap sits at 0 and every report is a silent no-op, so it is worth
  // one comparison at startup rather than a week of "why is progress not moving".
  const spec = await client.readContract({
    address: campaign,
    abi: CampaignAbi,
    functionName: "kpi",
    args: [kpiIndex],
  });
  const indexerSource = decodeEventSource(spec.params);
  const drift = describeConfigDrift({
    event,
    verifierTopic0: topic0,
    verifierTarget: config.targetContract,
    verifierScale: config.scale,
    verifierAggregation: config.aggregation,
    verifierUserParamIndex: config.userParamIndex,
    indexerTopic0: indexerSource?.topic0,
    indexerSource: indexerSource?.source,
    indexerScale: indexerSource?.scale,
    indexerAmountMode: indexerSource?.amountMode,
    indexerActorTopic: indexerSource?.actorTopic,
  });
  if (drift) {
    throw new Error(
      `Config drift between the verifier and the KPI's params:\n  ${drift}\n\n` +
        `The project would claim progress from one event while Boney verified another, so every ` +
        `report would silently credit nothing. Fix one side before relaying.`,
    );
  }

  // ── scan range ─────────────────────────────────────────────────

  const [checkpoint, head] = await Promise.all([
    client.readContract({
      address: verifier,
      abi: EventMetricKpiVerifierAbi,
      functionName: "checkpointOf",
      args: [campaign, kpiIndex],
    }),
    client.getBlockNumber(),
  ]);

  const range = resolveScanRange({
    checkpoint,
    windowStartBlock: config.windowStartBlock,
    windowEndBlock: config.windowEndBlock,
    head,
    confirmations: CONFIRMATIONS,
  });

  console.log(`  checkpoint: ${checkpoint}  (head ${head})`);

  if (!range.scan) {
    console.log(`\n  ${range.reason}`);
    return;
  }
  console.log(`  scanning:   ${range.fromBlock} → ${range.toBlock}`);

  // ── scan and decode ────────────────────────────────────────────

  const logs = await fetchLogs(
    client,
    config.targetContract,
    topic0,
    indexerSource,
    range.fromBlock,
    range.toBlock,
  );
  const {decoded, undecodable} = decodeUserEvents(logs, event, config);

  console.log(`\n  ${logs.length} matching log(s), ${decoded.length} decoded`);
  if (undecodable > 0) {
    console.log(`  ${undecodable} log(s) failed to decode — topic matched but the shape did not`);
  }

  // ── attribution filtering ──────────────────────────────────────

  const deltas = new Map<string, bigint>();
  let excludedPreAttribution = 0;
  let unattributed: string[] = [];

  if (decoded.length > 0) {
    const [registry, startTime] = await Promise.all([
      client.readContract({
        address: campaign,
        abi: CampaignAbi,
        functionName: "attributionRegistry",
      }),
      client.readContract({address: campaign, abi: CampaignAbi, functionName: "startTime"}),
    ]);

    const maxDuration = (await client.readContract({
      address: registry,
      abi: AttributionRegistryAbi,
      functionName: "effectiveMaxDuration",
      args: [campaign],
    })) as bigint;

    // Every touch that could still cover creditable work, scanned from before the activity range: a
    // touch can predate the actions it covers, and a window this cannot see would drop activity the
    // chain would credit. A touch older than `startTime - effectiveMaxDuration` has already lapsed by
    // the campaign's own start, so it covers nothing. The floor comes from the broadcast receipt rather
    // than `lib/deployments.ts`, which can lag a redeploy.
    const touchFloor = await blockAtTimestamp(
      async (blockNumber) => (await client.getBlock({blockNumber})).timestamp,
      earliestCoveringTouch(BigInt(startTime), BigInt(maxDuration)),
      BigInt(readStartBlock(chainId)),
      range.toBlock,
    );
    const touches: TouchLog[] = [];
    for (const chunk of blockChunks(touchFloor, range.toBlock, MAX_LOG_RANGE)) {
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
    const attribution = attributionLookup(buildAttributionWindows(touches), BigInt(startTime));

    // One read per distinct block, not per log. A busy range shares blocks heavily.
    const blockTimestamps = new Map<bigint, bigint>();
    await Promise.all(
      uniqueBlocks(decoded).map(async (blockNumber) => {
        const block = await client.getBlock({blockNumber});
        blockTimestamps.set(blockNumber, block.timestamp);
      }),
    );

    const result = aggregateDeltas({decoded, attribution, blockTimestamps});
    for (const [user, delta] of result.deltas) deltas.set(user, delta);
    excludedPreAttribution = result.excludedPreAttribution;
    unattributed = result.unattributed;
  }

  if (unattributed.length > 0) {
    console.log(
      `  ${unattributed.length} user(s) skipped with no attribution touch — ` +
        `their activity is not creditable to any promoter`,
    );
  }
  if (excludedPreAttribution > 0) {
    console.log(`  ${excludedPreAttribution} log(s) excluded as unattributed activity`);
  }
  console.log(`  creditable activity for ${deltas.size} user(s)`);

  // ── totals ─────────────────────────────────────────────────────

  const current = new Map<string, bigint>();
  await Promise.all(
    [...deltas.keys()].map(async (user) => {
      const total = await client.readContract({
        address: verifier,
        abi: EventMetricKpiVerifierAbi,
        functionName: "verifiedTotalOf",
        args: [campaign, kpiIndex, getAddress(user)],
      });
      current.set(user, total);
    }),
  );

  const {users, totals} = nextTotals(deltas, current);
  for (const [i, user] of users.entries()) {
    console.log(`    ${user}: ${current.get(user.toLowerCase()) ?? BigInt(0)} → ${totals[i]}`);
  }

  const batches = planReportBatches({
    users,
    totals,
    size: BATCH_SIZE,
    newCheckpoint: range.toBlock,
  });

  if (dryRun) {
    console.log(`\n  --dry-run: would send ${batches.length} transaction(s), nothing sent.`);
    return;
  }

  // ── report ─────────────────────────────────────────────────────

  const pk = reporterKey();
  if (!pk) {
    throw new Error(
      `Reporting needs the relayer's key. Set REPORTER_PRIVATE_KEY in ${resolve(REPO_ROOT, ".env")},\n` +
        `or re-run with --dry-run to see what would be sent.`,
    );
  }

  const account = privateKeyToAccount(pk);
  const wallet = createWalletClient({account, transport: http(rpcUrl)});
  console.log(`\n  reporting as ${account.address}`);

  const onChainReporter = await client.readContract({
    address: verifier,
    abi: EventMetricKpiVerifierAbi,
    functionName: "reporter",
  });
  if (getAddress(onChainReporter) !== account.address) {
    throw new Error(
      `This key is not the verifier's reporter.\n` +
        `  verifier expects: ${onChainReporter}\n` +
        `  this key is:      ${account.address}`,
    );
  }

  for (const [i, batch] of batches.entries()) {
    const empty = batch.users.length === 0;
    const hash = empty
      ? await wallet.writeContract({
          chain: null,
          address: verifier,
          abi: EventMetricKpiVerifierAbi,
          functionName: "advanceCheckpoint",
          args: [campaign, kpiIndex, batch.checkpoint],
        })
      : await wallet.writeContract({
          chain: null,
          address: verifier,
          abi: EventMetricKpiVerifierAbi,
          functionName: "reportBatch",
          args: [campaign, kpiIndex, batch.users, batch.totals, batch.checkpoint],
        });

    const label = empty ? "checkpoint only" : `${batch.users.length} user(s)`;
    console.log(`    tx ${i + 1}/${batches.length} (${label}): ${hash}`);
    await client.waitForTransactionReceipt({hash});
  }

  console.log(`\n  done — checkpoint now at ${range.toBlock}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
