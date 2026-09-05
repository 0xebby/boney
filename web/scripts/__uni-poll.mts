/** Throwaway: waits for the relay's ceiling and then the indexer's credit to catch up to the swap. */
import {createPublicClient, http, getAddress, type PublicClient} from "viem";
import {baseSepolia} from "viem/chains";
import {CampaignAbi, EventMetricKpiVerifierAbi} from "../src/lib/abis";
import {GENERATED_DEPLOYMENTS} from "../src/lib/deployments";

const D = GENERATED_DEPLOYMENTS[baseSepolia.id]!;
const CAMPAIGN = getAddress("0x101431E3Cc9d8fec1221c0ED888c210f5E362b8b");
const USER = getAddress("0x314464CF0aC30168881B1B20CAc8099982D335D1");
const PROMOTER = getAddress("0x98405c5776a63547E7Cb16000bA04cA53D9Fb2f8");

const client = createPublicClient({
  chain: baseSepolia,
  transport: http("https://base-sepolia-rpc.publicnode.com", {retryCount: 6, retryDelay: 800}),
}) as PublicClient;

const DEADLINE = Date.now() + 12 * 60 * 1000;
for (;;) {
  const cells = await Promise.all(
    [0n, 1n].flatMap((kpi) => [
      client.readContract({address: D.eventMetricKpiVerifier, abi: EventMetricKpiVerifierAbi, functionName: "verifiedTotalOf", args: [CAMPAIGN, kpi, USER]}) as Promise<bigint>,
      client.readContract({address: CAMPAIGN, abi: CampaignAbi, functionName: "progressOf", args: [PROMOTER, kpi]}) as Promise<bigint>,
      client.readContract({address: CAMPAIGN, abi: CampaignAbi, functionName: "totalProgress", args: [kpi]}) as Promise<bigint>,
    ]),
  );
  const [c0, p0, t0, c1, p1, t1] = cells;
  console.log(`[${new Date().toISOString().slice(11, 19)}]  KPI0 ceiling=${c0} progress=${p0} total=${t0}   KPI1 ceiling=${c1} progress=${p1} total=${t1}`);
  if (p0 > 0n && p1 > 0n) {
    const paid = await client.readContract({address: CAMPAIGN, abi: CampaignAbi, functionName: "paidOut"}) as bigint;
    console.log(`both KPIs credited on chain. paidOut=${paid}`);
    break;
  }
  if (Date.now() > DEADLINE) {
    console.log("deadline reached without a full credit.");
    break;
  }
  await new Promise((r) => setTimeout(r, 45_000));
}
