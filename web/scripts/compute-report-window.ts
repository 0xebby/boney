/**
 * Derives `windowStartBlock` / `windowEndBlock` for `EventMetricKpiVerifier.setKpiConfig`.
 *
 * Usage: pnpm report-window --campaign <address> [--rpc <url>]
 *
 * `setKpiConfig` bounds the relayer in *blocks*, but a campaign describes itself in *timestamps*, so
 * something has to convert one to the other. This is that something.
 *
 * **The window end is the subtle half.** A campaign's reporting close is not simply
 * `endTime + CLAIM_GRACE`. `Campaign._requireReportableStatus` closes reporting at
 * `endedAt + CLAIM_GRACE`, and `endedAt` is set when `end()` is actually called — which is
 * permissionless but not automatic, so it can land well after `endTime`. Two cases follow:
 *
 *  - **Already Ended** — `endedAt` is known, so the close is exact.
 *  - **Not yet ended** — the close is unknowable, because it depends on when someone calls `end()`.
 *    The projection uses `endTime + CLAIM_GRACE` as the earliest it could possibly be, and says so.
 *    Since `setKpiConfig` overwrites, re-running this after `end()` lands tightens or extends it
 *    without disturbing any stored total or the checkpoint.
 *
 * Bias high when in doubt. `windowEndBlock` only bounds how far the relayer may checkpoint, and
 * `Campaign` enforces its own report window regardless — so over-estimating wastes a little scanning,
 * while under-estimating stops the relayer early and under-credits promoters.
 */
import {createPublicClient, http, getAddress, type PublicClient} from "viem";
import {CampaignAbi} from "../src/lib/abis";
import {getDeployment} from "../src/lib/chains";
import {blockAtTimestamp} from "../src/lib/blockSearch";

/** `Types.CampaignStatus`. Only `Ended` changes how the close is computed. */
const STATUS_ENDED = 3;

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

/**
 * A block-timestamp reader for `blockAtTimestamp`.
 *
 * The search is bounded below by the protocol's deployment block rather than genesis: a binary search
 * over an L2's full height is ~25 sequential round trips against an endpoint that 502s often enough to
 * matter, and every block before deployment is known to be too early anyway.
 */
function timestampReader(client: PublicClient) {
  return async (blockNumber: bigint) => (await client.getBlock({blockNumber})).timestamp;
}

function iso(timestamp: bigint): string {
  return new Date(Number(timestamp) * 1000).toISOString();
}

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
  // The protocol's own deployment block is the earliest block that could hold anything relevant.
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

  // A close in the future has no block yet. Falling back to the head keeps the relayer working — it
  // stops at the head each run anyway — and this script gets re-run as chain time catches up.
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
