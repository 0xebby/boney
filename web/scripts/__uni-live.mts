/** Throwaway: read the seeded Uniswap campaign back off chain — specs, ladders and verifier configs. */
import {createPublicClient, http, getAddress, type Hex} from "viem";
import {baseSepolia} from "viem/chains";
import {CampaignAbi, EventMetricKpiVerifierAbi, GuardedKpiVerifierAbi} from "../src/lib/abis";
import {decodeEventSource, effectiveScale, AMOUNT_MODE} from "../src/lib/kpiSource";
import {catalogSignature, shortTopic} from "../src/lib/eventNames";
import {knownContractName} from "../src/lib/knownContracts";
import {KPI_KIND_LABEL, kpiKindFromIndex, statusFromIndex} from "../src/lib/types";

const CAMPAIGN = getAddress("0x101431E3Cc9d8fec1221c0ED888c210f5E362b8b");
const EVENT_VERIFIER = getAddress("0xFF69E2B4A1Cb96a59dbDD138fb7215dCa58aEBd6");
const GUARDED = getAddress("0xa8134d0d4E2a2E092527c3306CeA349292CB8a88");

const client = createPublicClient({
  chain: baseSepolia,
  transport: http("https://base-sepolia-rpc.publicnode.com", {retryCount: 6, retryDelay: 800}),
});
const read = <T,>(functionName: string, args: unknown[] = []) =>
  client.readContract({address: CAMPAIGN, abi: CampaignAbi, functionName, args}) as Promise<T>;

const [status, count, pool] = await Promise.all([
  read<number>("status"), read<bigint>("kpiCount"), read<bigint>("remainingPool"),
]);
console.log(`status=${statusFromIndex(status)}  kpis=${count}  remainingPool=${pool / 10n ** 18n} bUSD`);

for (let i = 0n; i < count; i++) {
  const spec = await read<any>("kpi", [i]);
  const tiers = await read<any[]>("tiers", [i]);
  const src = decodeEventSource(spec.params as Hex);
  const sig = src ? catalogSignature(src.topic0) : undefined;
  console.log(`\nKPI #${i}  ${KPI_KIND_LABEL[kpiKindFromIndex(spec.kind)]}  target=${spec.target}  aggregate=${spec.aggregate}  verifier=${spec.verifier === GUARDED ? "guarded" : spec.verifier}`);
  if (src) {
    console.log(`  blob:   ${knownContractName(src.source) ?? src.source}  ${sig ?? shortTopic(src.topic0)}`);
    console.log(`          actorTopic=${src.actorTopic}  mode=${src.amountMode === AMOUNT_MODE.count ? "count" : "dataWord0"}  scale=${effectiveScale(src)}  filter=${src.filterTopic ? `topics[${src.filterTopic}] == ${src.filterValue!.slice(0, 26)}…` : "none"}`);
  } else console.log("  blob:   DID NOT DECODE");
  console.log(`  ladder: ${tiers.map((t: any) => `${t.threshold}->${t.reward / 10n ** 18n}`).join("  ")}`);

  const cfg = (await client.readContract({
    address: EVENT_VERIFIER, abi: EventMetricKpiVerifierAbi, functionName: "configOf", args: [CAMPAIGN, i],
  })) as any;
  console.log(`  verifier config: ${cfg.targetContract}  "${cfg.eventSignature}"`);
  console.log(`          userParam=${cfg.userParamIndex}  agg=${cfg.aggregation}  valueParam=${cfg.valueParamIndex}  scale=${cfg.scale}  window=${cfg.windowStartBlock}..${cfg.windowEndBlock}`);

  const guard = (await client.readContract({
    address: GUARDED, abi: GuardedKpiVerifierAbi, functionName: "guardOf", args: [CAMPAIGN, i],
  })) as any;
  console.log(`  guard: secondary=${guard.secondary}  tolerance=${guard.toleranceBps}  mode=${guard.mode}`);
}
