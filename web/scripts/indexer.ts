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
 *  - **It cannot credit strangers.** `reportUserAction` reverts `NoAttribution` without a live
 *    touch, and a touch needs the user's own EIP-712 signature. Indexing all traffic on a contract
 *    and crediting it is not a thing this can do, by construction.
 *  - **Reports are cumulative and idempotent.** `newTotal` is a running total, not a delta, and a
 *    re-run over the same range decides to send nothing. Losing the cursor file costs a rescan,
 *    not double-crediting.
 *
 * Trust model: with `verifier == address(0)` the campaign credits the reported number as-is. This
 * indexer is honest but unverified on chain — a state-reading `IKpiVerifier` would bound it, and
 * is the natural next step.
 */
import {readFileSync, writeFileSync, existsSync} from "node:fs";
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
import {CampaignAbi, AttributionRegistryAbi, BoneyAbi} from "../src/lib/abis";
import {decodeEventSource, knownSignature, type EventSource} from "../src/lib/kpiSource";
import {
  aggregateByActor,
  blockChunks,
  decideReport,
  encodeActions,
  type IndexedLog,
} from "../src/lib/indexerCore";
import {readBroadcast} from "./generate-deployments";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const STATE_PATH = resolve(REPO_ROOT, ".indexer-state.json");

/**
 * Base's public endpoint rejects wider `eth_getLogs` ranges outright:
 * `-32602: query exceeds max block range 2000`. Observed against sepolia.base.org, not guessed.
 */
const MAX_LOG_RANGE = BigInt(2_000);

/**
 * How far back to scan when there is no cursor and no `--from-block`.
 *
 * Scanning from genesis on an L2 is thousands of requests. A campaign that needs deeper history
 * gets an explicit `--from-block`; silently scanning 40M blocks would look like a hang.
 */
const DEFAULT_LOOKBACK = BigInt(50_000);

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

type State = Record<string, string>;

function loadState(): State {
  if (!existsSync(STATE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8")) as State;
  } catch {
    // A corrupt cursor costs a rescan, which is a no-op thanks to cumulative reporting. Refusing
    // to run would be the worse failure.
    console.warn("  cursor file unreadable — rescanning from the default lookback");
    return {};
  }
}

function saveState(state: State): void {
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

function cursorKey(chainId: number, campaign: string, kpiIndex: number): string {
  return `${chainId}:${campaign.toLowerCase()}:${kpiIndex}`;
}

/** Fetches logs across a range the RPC will actually accept. */
async function fetchLogs(
  client: PublicClient,
  source: EventSource,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<IndexedLog[]> {
  const out: IndexedLog[] = [];
  const chunks = blockChunks(fromBlock, toBlock, MAX_LOG_RANGE);
  // Block timestamps are needed for verifier evidence, and one block carries many logs — cache so
  // a busy range does not re-request the same block dozens of times.
  const timestamps = new Map<bigint, bigint>();

  for (const [i, chunk] of chunks.entries()) {
    process.stdout.write(`\r    scanning ${i + 1}/${chunks.length} chunks…`);

    const logs = await client.getLogs({
      address: source.source,
      fromBlock: chunk.from,
      toBlock: chunk.to,
    });

    for (const log of logs) {
      if (log.topics[0]?.toLowerCase() !== source.topic0.toLowerCase()) continue;

      let timestamp = timestamps.get(log.blockNumber!);
      if (timestamp === undefined) {
        const block = await client.getBlock({blockNumber: log.blockNumber!});
        timestamp = block.timestamp;
        timestamps.set(log.blockNumber!, timestamp);
      }

      out.push({
        topics: log.topics as readonly Hex[],
        data: log.data,
        blockNumber: log.blockNumber!,
        timestamp,
      });
    }
  }

  if (chunks.length > 0) process.stdout.write("\r");
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
  const state = loadState();

  // The Boney facade only exposes summary rows; KPI specs live on the Campaign itself.
  const views = (await publicClient.readContract({
    address: boney,
    abi: BoneyAbi,
    functionName: "browseCampaigns",
    args: [BigInt(0), BigInt(1_000)],
  })) as readonly {campaign: `0x${string}`; campaignId: bigint; kpiCount: bigint}[];

  let reported = 0;
  let skipped = 0;

  for (const view of views) {
    if (onlyCampaign && view.campaign.toLowerCase() !== onlyCampaign) continue;

    const [status, startTime, endTime, project, kpiCount] = await Promise.all([
      publicClient.readContract({address: view.campaign, abi: CampaignAbi, functionName: "status"}),
      publicClient.readContract({address: view.campaign, abi: CampaignAbi, functionName: "startTime"}),
      publicClient.readContract({address: view.campaign, abi: CampaignAbi, functionName: "endTime"}),
      publicClient.readContract({address: view.campaign, abi: CampaignAbi, functionName: "project"}),
      publicClient.readContract({address: view.campaign, abi: CampaignAbi, functionName: "kpiCount"}),
    ]);

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
      const signature = knownSignature(source.topic0) ?? source.topic0;
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

      const key = cursorKey(chainId, view.campaign, kpiIndex);
      const fromBlock = fromBlockFlag
        ? BigInt(fromBlockFlag)
        : state[key]
          ? BigInt(state[key])
          : head > DEFAULT_LOOKBACK
            ? head - DEFAULT_LOOKBACK
            : BigInt(0);

      console.log(`  blocks ${fromBlock}..${head}`);
      const logs = await fetchLogs(publicClient, source, fromBlock, head);
      console.log(`  ${logs.length} matching log(s)`);

      const totals = aggregateByActor(logs, source);

      for (const total of totals.values()) {
        const [promoterId, alreadyCredited] = await Promise.all([
          publicClient.readContract({
            address: attributionRegistry,
            abi: AttributionRegistryAbi,
            functionName: "activePromoter",
            args: [view.campaign, total.user],
          }),
          publicClient.readContract({
            address: view.campaign,
            abi: CampaignAbi,
            functionName: "userCreditedOf",
            args: [total.user, BigInt(kpiIndex)],
          }),
        ]);

        const attributed =
          promoterId !== "0x0000000000000000000000000000000000000000000000000000000000000000";

        const decision = decideReport(total, attributed, alreadyCredited as bigint);
        if (!decision.send) {
          console.log(`  · ${total.user}: ${decision.reason}`);
          skipped++;
          continue;
        }

        // Evidence is only read when the KPI names a verifier (Campaign.sol:325); paying calldata
        // for a blob nothing decodes would be waste.
        const evidence =
          spec.verifier === "0x0000000000000000000000000000000000000000"
            ? "0x"
            : encodeActions(decision.actions);

        if (dryRun || !wallet || !account) {
          console.log(`  · ${total.user}: would report ${decision.newTotal} (dry run)`);
          continue;
        }

        const hash = await wallet.writeContract({
          address: view.campaign,
          abi: CampaignAbi,
          functionName: "reportUserAction",
          args: [BigInt(kpiIndex), total.user, decision.newTotal, evidence],
          chain: publicClient.chain,
          account,
        });
        const receipt = await publicClient.waitForTransactionReceipt({hash});

        console.log(
          `  · ${total.user}: reported ${decision.newTotal} — ${hash} (${receipt.status})`,
        );
        reported++;
      }

      // Advance past the head we scanned, not past the last log: an empty range still means
      // everything below is settled, and rescanning it would find nothing.
      if (!dryRun) {
        state[key] = (head + BigInt(1)).toString();
        saveState(state);
      }
    }
  }

  console.log(`\n${reported} report(s) sent, ${skipped} skipped.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
