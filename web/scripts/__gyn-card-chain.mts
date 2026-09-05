/** Throwaway: the on-chain truth for the Gyndore card — specs, ladders, and credited progress. */
import {createPublicClient, http, getAddress, type Hex} from "viem";
import {baseSepolia} from "viem/chains";
import {CampaignAbi} from "../src/lib/abis/Campaign";
import {decodeEventSource, effectiveScale, AMOUNT_MODE} from "../src/lib/kpiSource";
import {catalogSignature, shortTopic} from "../src/lib/eventNames";
import {knownContractName} from "../src/lib/knownContracts";
import {actionNoun} from "../src/lib/kpiUnits";
import {KPI_KIND_LABEL, kpiKindFromIndex, statusFromIndex} from "../src/lib/types";

const CAMPAIGN = getAddress("0x86B7b22aEd09452232Ca1A072db5BE7a837F06fc");
const PROMOTERS = [
  "0xc27a65590409a88e4722ba53895d111ea3b3cd44",
  "0x64d15744acdba91559b27d03a18f3b2b697cc6d9",
  "0x27781bd062b4e7efda001ed97786e1ebdc2fd433",
  "0xc7df188878c319c46294b6c655865ca999375c5f",
  "0x0198fa30b0458b4775b8ba98a9a97dc243eaad22",
  "0x98405c5776a63547e7cb16000ba04ca53d9fb2f8",
].map((a) => getAddress(a));

const client = createPublicClient({
  chain: baseSepolia,
  transport: http("https://base-sepolia-rpc.publicnode.com", {retryCount: 6, retryDelay: 800}),
});
const read = <T,>(functionName: string, args: unknown[] = []) =>
  client.readContract({address: CAMPAIGN, abi: CampaignAbi, functionName, args}) as Promise<T>;

const cfg = await read<any>("config");
const [status, count, pool, paid] = await Promise.all([
  read<number>("status"), read<bigint>("kpiCount"),
  read<bigint>("remainingPool"), read<bigint>("paidOut"),
]);
console.log(`CONFIG  name=${cfg.name}  status=${statusFromIndex(status)}  kpis=${count}`);
console.log(`  token=${cfg.token}  pool=${cfg.rewardPool}  remaining=${pool}  paidOut=${paid}`);
console.log(`  start=${new Date(Number(cfg.startTime)*1000).toISOString().slice(0,16)}  end=${new Date(Number(cfg.endTime)*1000).toISOString().slice(0,16)}`);
console.log(`  attributionWindow=${Number(cfg.attributionWindow)/86400}d  minReputation=${cfg.minReputation}`);

for (let i = 0; i < Number(count); i++) {
  const spec = await read<any>("kpi", [BigInt(i)]);
  const src = decodeEventSource(spec.params as Hex);
  const sig = src ? catalogSignature(src.topic0) : undefined;
  const noun = actionNoun(sig, kpiKindFromIndex(spec.kind));
  const total = await read<bigint>("totalProgress", [BigInt(i)]);
  const tiers = await read<any[]>("tiers", [BigInt(i)]);
  console.log(`\nKPI #${i}  kind=${KPI_KIND_LABEL[kpiKindFromIndex(spec.kind)]}  target=${spec.target}  aggregate=${spec.aggregate}  totalProgress=${total}`);
  if (src) {
    console.log(`  watches ${knownContractName(src.source) ?? src.source}  ${sig ?? shortTopic(src.topic0)}`);
    console.log(`  actorTopic=${src.actorTopic}  amountMode=${src.amountMode === AMOUNT_MODE.count ? "count" : "dataWord0"}  scale=${effectiveScale(src)}`);
    console.log(`  filterTopic=${src.filterTopic ?? "-"} filterValue=${src.filterValue ?? "-"}`);
  } else console.log(`  params did not decode (${(spec.params as string).length} chars)`);
  console.log(`  noun: one ${noun.one} / many ${noun.many}`);
  console.log(`  tiers: ${tiers.map((t: any) => `${t.threshold}→${t.reward}`).join("  ") || "none"}`);

  for (const p of PROMOTERS) {
    const prog = await read<bigint>("progressOf", [p, BigInt(i)]);
    if (prog > 0n) console.log(`    progressOf ${p.slice(0,6)}…${p.slice(-4)} = ${prog}`);
  }
}
