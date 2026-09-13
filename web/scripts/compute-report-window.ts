/**
 * Derives EventMetric block bounds from campaign timestamps.
 *
 * An ended campaign closes at `endedAt + CLAIM_GRACE`; otherwise the projected close is
 * `endTime + CLAIM_GRACE`. Future closes use the current head until the config is refreshed.
 *
 * Usage: `pnpm report-window --campaign <address> [--rpc <url>]`.
 */
import {createPublicClient, http, getAddress, type PublicClient} from "viem";
import {CampaignAbi} from "../src/lib/abis";
import {getDeployment} from "../src/lib/chains";
import {blockAtTimestamp} from "../src/lib/blockSearch";

/** `Types.CampaignStatus`. Only `Ended` changes how the close is computed. */
const STATUS_ENDED = 3;

/**
 * Reads one command-line option.
 *
 * @param flag Option name to find.
 * @returns The following argument, if present.
 */
function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

/**
 * Creates a block-timestamp reader.
 *
 * @param client Public client used for block reads.
 * @returns A timestamp reader for block searches.
 */
function timestampReader(client: PublicClient): (blockNumber: bigint) => Promise<bigint> {
  return async (blockNumber: bigint) => (await client.getBlock({blockNumber})).timestamp;
}

/**
 * Formats a Unix timestamp as ISO 8601.
 *
 * @param timestamp Unix timestamp in seconds.
 * @returns ISO-formatted timestamp.
 */
function iso(timestamp: bigint): string {
  return new Date(Number(timestamp) * 1000).toISOString();
}

/**
 * Computes and prints report-window block bounds.
 *
 * @returns Nothing.
 */
async function main(): Promise<void> {
  const rpcUrl = arg("--rpc") ?? "http://127.0.0.1:8545";
  const campaignArg = arg("--campaign");
  if (!campaignArg) {
    throw new Error("--campaign <address> is required");
  }
  const campaign = getAddress(campaignArg);

  const client = createPublicClient({transport: http(rpcUrl)}) as PublicClient;
  const chainId = await client.getChainId();

  const [startTime, endTime, claimGrace, status, endedAt] = await Promise.all([
    client.readContract({address: campaign, abi: CampaignAbi, functionName: "startTime"}),
    client.readContract({address: campaign, abi: CampaignAbi, functionName: "endTime"}),
    client.readContract({address: campaign, abi: CampaignAbi, functionName: "CLAIM_GRACE"}),
    client.readContract({address: campaign, abi: CampaignAbi, functionName: "status"}),
    client.readContract({address: campaign, abi: CampaignAbi, functionName: "endedAt"}),
  ]);

  const grace = BigInt(claimGrace);
  const ended = Number(status) === STATUS_ENDED;
  const closesAt = ended ? BigInt(endedAt) + grace : BigInt(endTime) + grace;

  console.log(`Campaign ${campaign} on chain ${chainId}`);
  console.log(`  startTime:      ${startTime}  (${iso(BigInt(startTime))})`);
  console.log(`  endTime:        ${endTime}  (${iso(BigInt(endTime))})`);
  console.log(`  CLAIM_GRACE:    ${grace}s`);
  console.log(`  status:         ${status}${ended ? " (Ended)" : ""}`);
  if (ended) console.log(`  endedAt:        ${endedAt}  (${iso(BigInt(endedAt))})`);
  console.log(`  reporting ends: ${closesAt}  (${iso(closesAt)})${ended ? "" : "  [projected]"}`);

  const head = await client.getBlock({blockTag: "latest"});
  const floor = getDeployment(chainId)?.startBlock ?? BigInt(0);
  const readTimestamp = timestampReader(client);
  const probed = new Map<bigint, bigint>();

  const windowStartBlock = await blockAtTimestamp(
    readTimestamp,
    BigInt(startTime),
    floor,
    head.number,
    probed,
  );

  const closeInFuture = closesAt > head.timestamp;
  const windowEndBlock = closeInFuture
    ? head.number
    : await blockAtTimestamp(readTimestamp, closesAt, windowStartBlock, head.number, probed);

  console.log("");
  console.log(`  windowStartBlock: ${windowStartBlock}`);
  console.log(`  windowEndBlock:   ${windowEndBlock}`);

  if (closeInFuture) {
    console.log("");
    console.log("  Note: the reporting close is in the future, so windowEndBlock is the current head.");
    console.log("  The relayer will keep stopping there until you re-run this and update the config.");
  } else if (!ended) {
    console.log("");
    console.log("  Note: this campaign has not been ended yet, so the close is the earliest it could");
    console.log("  be. Calling end() late pushes it later — re-run this afterwards to extend.");
  }

  console.log("");
  console.log("  Pass these to setKpiConfig(..., scale, windowStartBlock, windowEndBlock).");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
