/**
 * Throwaway: dumps everything a verification-flow write-up needs for two campaigns — the gated one
 * and an ungated one — read off the live Base Sepolia fixture rather than from docs.
 */
import {createPublicClient, http, getAddress, type Hex} from "viem";
import {baseSepolia} from "viem/chains";
import {CampaignAbi} from "../src/lib/abis/Campaign";
import {CampaignRegistryAbi} from "../src/lib/abis/CampaignRegistry";
import {GuardedKpiVerifierAbi} from "../src/lib/abis/GuardedKpiVerifier";
import {EventMetricKpiVerifierAbi} from "../src/lib/abis/EventMetricKpiVerifier";
import {decodeEventSource, AMOUNT_MODE} from "../src/lib/kpiSource";

const client = createPublicClient({
  chain: baseSepolia,
  transport: http(process.env.BASE_SEPOLIA_RPC ?? "https://base-sepolia-rpc.publicnode.com"),
});

const REGISTRY = getAddress("0x3e0a2fc423dE77bEE9147879308BFfFC6129c4EE");
const GUARDED = getAddress("0xa8134d0d4E2a2E092527c3306CeA349292CB8a88");
const EVENT_METRIC = getAddress("0xFF69E2B4A1Cb96a59dbDD138fb7215dCa58aEBd6");
const TOUCH_WINDOW = getAddress("0xEDF152A9875588276242e67C9201b558Ef8C9B8b");

const j = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}` : x), 1).replace(/\n\s*/g, " ");

const count = await client.readContract({
  address: REGISTRY, abi: CampaignRegistryAbi, functionName: "campaignCount",
}) as bigint;
console.log(`registry ${REGISTRY} campaignCount=${count}`);

for (let id = 0n; id <= count; id++) {
  let address: `0x${string}`;
  try {
    address = await client.readContract({
      address: REGISTRY, abi: CampaignRegistryAbi, functionName: "campaignAt", args: [id],
    }) as `0x${string}`;
  } catch {
    console.log(`\n=== id ${id}: no such campaign`);
    continue;
  }

  const [cfg, status, kpiCount, remaining] = await Promise.all([
    client.readContract({address, abi: CampaignAbi, functionName: "config"}),
    client.readContract({address, abi: CampaignAbi, functionName: "status"}),
    client.readContract({address, abi: CampaignAbi, functionName: "kpiCount"}),
    client.readContract({address, abi: CampaignAbi, functionName: "remainingPool"}),
  ]) as [Record<string, unknown>, number, bigint, bigint];

  console.log(`\n=== id ${id} ${cfg.name} ${address}`);
  console.log(`  status=${status} remainingPool=${remaining} cfg=${j(cfg)}`);

  for (let k = 0n; k < kpiCount; k++) {
    const spec = await client.readContract({
      address, abi: CampaignAbi, functionName: "kpi", args: [k],
    }) as Record<string, unknown>;
    const tiers = await client.readContract({
      address, abi: CampaignAbi, functionName: "tiers", args: [k],
    }) as readonly Record<string, unknown>[];
    const total = await client.readContract({
      address, abi: CampaignAbi, functionName: "totalProgress", args: [k],
    }) as bigint;

    const verifier = spec.verifier as `0x${string}`;
    const label =
      verifier === "0x0000000000000000000000000000000000000000" ? "UNGATED"
      : getAddress(verifier) === GUARDED ? "GUARDED"
      : getAddress(verifier) === EVENT_METRIC ? "EVENT_METRIC(direct)"
      : getAddress(verifier) === TOUCH_WINDOW ? "TOUCH_WINDOW"
      : "unknown";

    const src = decodeEventSource(spec.params as Hex);
    const srcText = src
      ? `source=${src.source} topic0=${(src.topic0 as string).slice(0, 12)}… actor=T${src.actorTopic}` +
        ` amount=${src.amountMode === AMOUNT_MODE.count ? "count" : "dataWord0"} scale=${src.scale}` +
        (src.filterTopic ? ` filter=T${src.filterTopic}=${src.filterValue}` : "")
      : `none (params ${((spec.params as string).length - 2) / 2} bytes)`;

    console.log(`  KPI ${k}: kind=${spec.kind} aggregate=${spec.aggregate} target=${spec.target}` +
      ` verifier=${verifier} [${label}] totalProgress=${total}`);
    console.log(`    params: ${srcText}`);
    console.log(`    tiers:  ${tiers.map((t) => `${t.threshold}→${t.reward}`).join("  ")}`);

    if (label === "GUARDED") {
      const guard = await client.readContract({
        address: GUARDED, abi: GuardedKpiVerifierAbi, functionName: "guardOf", args: [address, k],
      }) as Record<string, unknown>;
      const conf = await client.readContract({
        address: EVENT_METRIC, abi: EventMetricKpiVerifierAbi, functionName: "configOf",
        args: [address, k],
      }) as Record<string, unknown>;
      console.log(`    guard:  ${j(guard)}`);
      console.log(`    relay:  ${j(conf)}`);
    }
  }
}

const reporter = await client.readContract({
  address: EVENT_METRIC, abi: EventMetricKpiVerifierAbi, functionName: "reporter",
}) as `0x${string}`;
console.log(`\neventMetric.reporter=${reporter}`);
