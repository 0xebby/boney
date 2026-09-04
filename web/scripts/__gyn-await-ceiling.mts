/** Throwaway: blocks until Boney's observed ceiling covers the activity just driven. */
import {createPublicClient, http, getAddress, type Hex, type PublicClient} from "viem";
import {baseSepolia} from "viem/chains";
import {EventMetricKpiVerifierAbi} from "../src/lib/abis";
import {GENERATED_DEPLOYMENTS} from "../src/lib/deployments";

const client = createPublicClient({
  chain: baseSepolia,
  transport: http(process.env.BASE_SEPOLIA_RPC ?? "https://base-sepolia-rpc.publicnode.com", {retryCount: 5}),
}) as PublicClient;
const V = GENERATED_DEPLOYMENTS[baseSepolia.id]!.eventMetricKpiVerifier;
const CAMPAIGN = getAddress("0x86B7b22aEd09452232Ca1A072db5BE7a837F06fc");

const WANT: {kpi: bigint; user: Hex; label: string; want: bigint}[] = [
  {kpi: 0n, user: "0x5Ae96df858Ed87F98a34b177Bd306c829316E727", label: "KOL2_REF1 swaps", want: 51n},
  {kpi: 0n, user: "0x3A49b254FF5CfbA10185AC7e7d92c1005A22eeA1", label: "KOL2_REF2 swaps", want: 51n},
  {kpi: 1n, user: "0x3fdcedEbf2119a7342547472f1679D67E555A2a3", label: "KOL1_REF1 stakes", want: 17n},
  {kpi: 1n, user: "0x79C963aD6E0bdA1a0826DD4f2d10a0DFcb0Fa2aC", label: "KOL1_REF2 stakes", want: 17n},
  {kpi: 1n, user: "0xEbb868Cf46F55766cc31B72bfa7dbD7B8d07f4C3", label: "KOL1_REF3 stakes", want: 17n},
  {kpi: 1n, user: "0x5Ae96df858Ed87F98a34b177Bd306c829316E727", label: "KOL2_REF1 stakes", want: 24n},
  {kpi: 1n, user: "0x3A49b254FF5CfbA10185AC7e7d92c1005A22eeA1", label: "KOL2_REF2 stakes", want: 24n},
];

const DEADLINE = Date.now() + 15 * 60 * 1000;

for (;;) {
  const seen = await Promise.all(
    WANT.map((w) =>
      client.readContract({
        address: V,
        abi: EventMetricKpiVerifierAbi,
        functionName: "verifiedTotalOf",
        args: [CAMPAIGN, w.kpi, w.user],
      }) as Promise<bigint>,
    ),
  );
  const short = WANT.filter((w, i) => seen[i] < w.want);
  const stamp = new Date().toISOString().slice(11, 19);
  console.log(
    `[${stamp}] ` + WANT.map((w, i) => `${w.label}=${seen[i]}/${w.want}`).join("  "),
  );
  if (short.length === 0) {
    console.log("ceiling covers everything driven — safe to index.");
    break;
  }
  if (Date.now() > DEADLINE) {
    console.log(`gave up waiting; still short: ${short.map((s) => s.label).join(", ")}`);
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 20000));
}
