/** Throwaway: polls one promoter's credited progress on two KPIs until both reach a target. */
import {createPublicClient, http, getAddress, type PublicClient} from "viem";
import {CampaignAbi} from "../src/lib/abis";

const client = createPublicClient({
  transport: http("https://base-sepolia-rpc.publicnode.com", {retryCount: 5}),
}) as PublicClient;
const campaign = getAddress(process.argv[2]!);
const promoter = getAddress(process.argv[3]!);
const target = BigInt(process.argv[4] ?? "25");

for (let i = 0; i < 60; i++) {
  const [k0, k1] = await Promise.all(
    [0, 1].map((kpi) =>
      client.readContract({
        address: campaign,
        abi: CampaignAbi,
        functionName: "progressOf",
        args: [promoter, kpi],
      }) as Promise<bigint>,
    ),
  );
  const stamp = new Date().toTimeString().slice(0, 8);
  console.log(`[${stamp}] kpi0 ${k0}/${target}  kpi1 ${k1}/${target}`);
  if (k0! >= target && k1! >= target) {
    console.log("both KPIs credited in full.");
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 30_000));
}
console.log("timed out waiting for credit.");
