/**
 * Throwaway: one authoritative read for a campaign card — chain first, subgraph for the roster.
 *
 * @param argv[2] campaign address
 */
import {readFileSync} from "node:fs";
import {createPublicClient, http, getAddress, formatUnits, type Hex} from "viem";
import {baseSepolia} from "viem/chains";
import {CampaignAbi} from "../src/lib/abis/Campaign";
import {IERC20MetadataAbi} from "../src/lib/abis/IERC20Metadata";
import {decodeEventSource, effectiveScale, AMOUNT_MODE} from "../src/lib/kpiSource";
import {catalogSignature, shortTopic} from "../src/lib/eventNames";
import {knownContractName} from "../src/lib/knownContracts";
import {actionNoun} from "../src/lib/kpiUnits";
import {KPI_KIND_LABEL, kpiKindFromIndex, statusFromIndex} from "../src/lib/types";

const CAMPAIGN = getAddress(process.argv[2]!);

const txt = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const url = txt.split("\n").find((l) => /^\s*NEXT_PUBLIC_SUBGRAPH_URL\s*=/.test(l))!
  .split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, "");

const gql = async (query: string) => {
  const r = await fetch(url, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({query})});
  const {data, errors} = await r.json();
  if (errors) throw new Error(JSON.stringify(errors).slice(0, 500));
  return data;
};

const sub = await gql(`{
  campaign(id: "${CAMPAIGN.toLowerCase()}") {
    campaignId name project token status createdAt
    promoters { promoterId wallet reputation joinedAtBlock }
    touches(first: 1000, orderBy: blockNumber) { user promoterId signedAt blockNumber }
    kpis { index kind target aggregate }
  }
  credits(first: 1000, where: {campaign: "${CAMPAIGN.toLowerCase()}"}, orderBy: blockNumber) {
    kpiIndex promoterId user amount blockNumber timestamp
  }
  _meta { block { number } hasIndexingErrors }
}`);

const c = sub.campaign;
const credits = sub.credits as Array<{kpiIndex: number; promoterId: string; user: string; amount: string; blockNumber: string}>;
console.log(`SUBGRAPH  block=${sub._meta.block.number}  indexingErrors=${sub._meta.hasIndexingErrors}`);
console.log(`  #${c.campaignId} ${c.name}  project=${c.project}  promoters=${c.promoters.length} touches=${c.touches.length} credits=${credits.length}`);

const client = createPublicClient({
  chain: baseSepolia,
  transport: http("https://base-sepolia-rpc.publicnode.com", {retryCount: 6, retryDelay: 800}),
});
const read = <T,>(functionName: string, args: unknown[] = []) =>
  client.readContract({address: CAMPAIGN, abi: CampaignAbi, functionName, args}) as Promise<T>;

const cfg = await read<any>("config");
const [status, count, pool, paid, block] = await Promise.all([
  read<number>("status"), read<bigint>("kpiCount"),
  read<bigint>("remainingPool"), read<bigint>("paidOut"), client.getBlockNumber(),
]);
const [sym, dec] = await Promise.all([
  client.readContract({address: cfg.token, abi: IERC20MetadataAbi, functionName: "symbol"}) as Promise<string>,
  client.readContract({address: cfg.token, abi: IERC20MetadataAbi, functionName: "decimals"}) as Promise<number>,
]);
const amt = (v: bigint) => `${formatUnits(v, dec)} ${sym}`;

console.log(`\nCHAIN  block=${block}  name=${cfg.name}  status=${statusFromIndex(status)}  kpis=${count}`);
console.log(`  token=${cfg.token} (${sym}, ${dec} dec)`);
console.log(`  pool=${amt(cfg.rewardPool)}  remaining=${amt(pool)}  paidOut=${amt(paid)}`);
console.log(`  start=${new Date(Number(cfg.startTime)*1000).toISOString().slice(0,16)}Z  end=${new Date(Number(cfg.endTime)*1000).toISOString().slice(0,16)}Z`);
console.log(`  attributionWindow=${Number(cfg.attributionWindow)/86400}d  minReputation=${cfg.minReputation}`);

const promoters = (c.promoters as Array<{promoterId: string; wallet: string; reputation: string}>)
  .map((p) => ({...p, wallet: getAddress(p.wallet)}));

for (let i = 0; i < Number(count); i++) {
  const spec = await read<any>("kpi", [BigInt(i)]);
  const src = decodeEventSource(spec.params as Hex);
  const sig = src ? catalogSignature(src.topic0) : undefined;
  const noun = actionNoun(sig, kpiKindFromIndex(spec.kind));
  const [total, tiers] = await Promise.all([
    read<bigint>("totalProgress", [BigInt(i)]), read<any[]>("tiers", [BigInt(i)]),
  ]);
  console.log(`\nKPI #${i}  kind=${KPI_KIND_LABEL[kpiKindFromIndex(spec.kind)]}  target=${spec.target}  aggregate=${spec.aggregate}`);
  console.log(`  totalProgress=${total}   noun: one ${noun.one} / many ${noun.many}`);
  if (src) {
    console.log(`  watches ${knownContractName(src.source) ?? src.source}  ${sig ?? shortTopic(src.topic0)}`);
    console.log(`  actorTopic=${src.actorTopic}  amountMode=${src.amountMode === AMOUNT_MODE.count ? "count" : "dataWord0"}  scale=${effectiveScale(src)}`);
    console.log(`  filterTopic=${src.filterTopic ?? "-"} filterValue=${src.filterValue ?? "-"}`);
  } else console.log(`  params did not decode`);
  console.log(`  tiers: ${tiers.map((t: any) => `${t.threshold}→${amt(t.reward)}`).join("  ") || "none"}`);

  let progSum = 0n, earnSum = 0n;
  for (const p of promoters) {
    const [prog, settled] = await Promise.all([
      read<bigint>("progressOf", [p.wallet, BigInt(i)]),
      read<bigint>("settledTiersOf", [p.wallet, BigInt(i)]),
    ]);
    const earned = tiers.slice(0, Number(settled)).reduce((s: bigint, t: any) => s + t.reward, 0n);
    progSum += prog; earnSum += earned;
    const cr = credits.filter((x) => Number(x.kpiIndex) === i && x.promoterId.toLowerCase() === p.promoterId.toLowerCase())
      .reduce((s, x) => s + BigInt(x.amount), 0n);
    console.log(`    ${p.wallet}  id=${p.promoterId}  progress=${prog}  subgraphCredits=${cr}${cr === prog ? "" : "  ** MISMATCH **"}  tiers=${settled}  earned=${amt(earned)}`);
  }
  console.log(`  SUM progress=${progSum}${progSum === total ? " == totalProgress" : ` != totalProgress ${total}`}  earned=${amt(earnSum)}`);
}
