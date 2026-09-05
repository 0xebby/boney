/**
 * Answers "could this campaign report progress right now" by mirroring every guard in
 * `Campaign.reportUserAction` against live state — campaign-level, per-KPI, and per-user.
 *
 * Takes a campaign address, or defaults to the newest one in the registry.
 */
import {createPublicClient, http, getAddress, decodeAbiParameters, type Hex} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {baseSepolia} from "viem/chains";
import {CampaignAbi, EventMetricKpiVerifierAbi, GuardedKpiVerifierAbi, ReputationRegistryAbi} from "../src/lib/abis";
import {decodeEventSource, eventTopic} from "../src/lib/kpiSource";
import {KPI_KIND} from "../src/lib/types";

const client = createPublicClient({
  chain: baseSepolia,
  transport: http(process.env.BASE_SEPOLIA_RPC ?? "https://base-sepolia-rpc.publicnode.com"),
});
const REGISTRY = getAddress("0x3e0a2fc423dE77bEE9147879308BFfFC6129c4EE");
const ATTR = getAddress("0xe04C5185eDd4C9b1c91e31c790843c335766258e");
const REP = getAddress("0x8B601B46C9Bd74F991F5A17d4bF674A837Ebed52");
const EVENT_METRIC = getAddress("0xFF69E2B4A1Cb96a59dbDD138fb7215dCa58aEBd6");
const GUARDED = getAddress("0xa8134d0d4E2a2E092527c3306CeA349292CB8a88");
const ZERO32 = `0x${"0".repeat(64)}`;
const head = await client.getBlockNumber();
const ok = (b: boolean) => (b ? "PASS" : "FAIL");

type Log = {topics: readonly Hex[]; data: Hex; blockNumber: bigint};
async function scan(address: Hex, topic0: Hex, from: bigint) {
  const out: Log[] = [];
  for (let f = from; f <= head; ) {
    const to = f + 9000n - 1n > head ? head : f + 9000n - 1n;
    try {
      const got = await client.getLogs({address, fromBlock: f, toBlock: to} as never);
      for (const l of got as never as Log[]) if (l.topics[0]?.toLowerCase() === topic0.toLowerCase()) out.push(l);
    } catch { /* chunk skipped */ }
    f = to + 1n;
  }
  return out;
}

const created = await scan(REGISTRY, eventTopic("CampaignCreated(uint256,address,address,address,string)"), 46110182n);
const CAMPAIGN = getAddress(process.argv[2] ?? `0x${created.at(-1)!.topics[2]!.slice(26)}`);
const born = created.find((l) => l.topics[2]!.slice(26).toLowerCase() === CAMPAIGN.slice(2).toLowerCase())?.blockNumber ?? 46110182n;
const r = (functionName: string, args: readonly unknown[] = []) =>
  client.readContract({address: CAMPAIGN, abi: CampaignAbi, functionName, args} as never);

const [name, status, startTime, endTime, project, kpiCount, pool, remaining, minRep] = (await Promise.all([
  r("name"), r("status"), r("startTime"), r("endTime"), r("project"), r("kpiCount"), r("rewardPool"), r("remainingPool"), r("minReputation"),
])) as [string, number, bigint, bigint, Hex, bigint, bigint, bigint, bigint];
const STATUS = ["Pending", "Active", "Paused", "Ended", "Cancelled"];
const now = BigInt(Math.floor(Date.now() / 1000));
const iso = (t: bigint) => new Date(Number(t) * 1000).toISOString().replace(".000Z", "Z");

console.log(`head=${head}  ${created.length} campaign(s) in the registry`);
console.log(`\ncampaign  ${CAMPAIGN}  "${name}"  born block ${born}`);
console.log(`status    ${STATUS[Number(status)]}   window ${iso(startTime)} → ${iso(endTime)}   now ${iso(now)}`);
console.log(`pool      ${pool / 10n ** 18n} (remaining ${remaining / 10n ** 18n})   minReputation ${minRep}`);
console.log(`\n— campaign-level guards —`);
console.log(`${ok(Number(status) === 1)}  status is Active`);
console.log(`${ok(now >= startTime && now <= endTime)}  now inside [start, end] — else OutsideWindow`);
console.log(`${ok(Number(kpiCount) > 0)}  kpiCount = ${kpiCount}`);

console.log(`\n— reporter identity — must equal project ${project}`);
for (const k of ["PRIVATE_KEY", "REPORTER_PRIVATE_KEY", "BONEY_RELAYER_KEY"]) {
  const v = process.env[k];
  if (!v) { console.log(`     ${k} unset in this shell`); continue; }
  try {
    const a = privateKeyToAccount((v.startsWith("0x") ? v : `0x${v}`) as Hex);
    console.log(`${ok(a.address.toLowerCase() === project.toLowerCase())}  ${k} → ${a.address} — else NotReporter`);
  } catch { console.log(`     ${k} set but not a valid key`); }
}

const touches = (await scan(ATTR, eventTopic("TouchStored(address,address,bytes32,uint64,uint64,address)"), born))
  .filter((l) => l.topics[1]!.slice(26).toLowerCase() === CAMPAIGN.slice(2).toLowerCase());
console.log(`\n— attribution on this campaign — ${touches.length} touch(es) since block ${born}`);
const users: {user: Hex; promoterId: Hex; block: bigint}[] = [];
for (const l of touches) {
  const user = getAddress(`0x${l.topics[2]!.slice(26)}`);
  const promoterId = l.topics[3]!;
  const owner = (await r("promoterOf", [promoterId])) as Hex;
  users.push({user, promoterId, block: l.blockNumber});
  console.log(`${ok(owner !== "0x0000000000000000000000000000000000000000")}  user ${user} → promoter ${owner} @${l.blockNumber} — else NoAttribution`);
}
if (touches.length === 0) console.log(`FAIL  no touch stored — every report reverts NoAttribution`);

for (let i = 0; i < Number(kpiCount); i++) {
  const spec = (await r("kpi", [BigInt(i)])) as {kind: number; verifier: Hex; target: bigint; aggregate: boolean; params: Hex};
  const tiers = (await r("tiers", [BigInt(i)])) as readonly {threshold: bigint; reward: bigint}[];
  const src = decodeEventSource(spec.params);
  console.log(`\n— KPI ${i} — kind=${KPI_KIND[spec.kind]} aggregate=${spec.aggregate} verifier=${spec.verifier}`);
  console.log(`     params ${(spec.params.length - 2) / 2} B${src ? ` → ${src.topic0.slice(0, 12)}… on ${src.source} actorTopic=${src.actorTopic} mode=${src.amountMode} scale=${src.scale}${src.filterTopic ? ` filter T${src.filterTopic}` : ""}` : " — not an event source"}`);
  console.log(`     tiers ${tiers.map((t) => `${t.threshold}→${t.reward / 10n ** 18n}`).join("  ")}`);
  console.log(`${ok(!spec.aggregate)}  not aggregate — else AggregateKpi`);
  if (spec.verifier === "0x0000000000000000000000000000000000000000") {
    console.log(`PASS  verifier is zero — no verifier call, the claim is credited as-is`);
  } else {
    if (spec.verifier.toLowerCase() === GUARDED.toLowerCase()) {
      const g = (await client.readContract({address: GUARDED, abi: GuardedKpiVerifierAbi, functionName: "guardOf", args: [CAMPAIGN, BigInt(i)]} as never)) as {projectVerifier: Hex; mode: number; configured: boolean};
      console.log(`${ok(g.configured)}  GuardedKpiVerifier.guardOf configured (projectVerifier ${g.projectVerifier}, mode ${g.mode}) — else NotConfigured`);
    }
    const c = (await client.readContract({address: EVENT_METRIC, abi: EventMetricKpiVerifierAbi, functionName: "configOf", args: [CAMPAIGN, BigInt(i)]} as never)) as {configured: boolean; eventSignature: string; targetContract: Hex; userParamIndex: number};
    console.log(`${ok(c.configured)}  EventMetricKpiVerifier.configOf configured — else KpiNotConfigured`);
    if (c.configured) console.log(`     "${c.eventSignature}" on ${c.targetContract} userParamIndex=${c.userParamIndex}`);
  }

  if (!src) continue;
  const logs = await scan(src.source as Hex, src.topic0 as Hex, born);
  const actors = new Set(logs.map((l) => l.topics[src.actorTopic]?.slice(26).toLowerCase()));
  console.log(`${ok(logs.length > 0)}  watched source has ${logs.length} log(s) since block ${born} — nothing to report otherwise`);
  for (const {user, block} of users) {
    const hit = logs.filter((l) => l.topics[src.actorTopic]?.slice(26).toLowerCase() === user.slice(2).toLowerCase() && l.blockNumber > block);
    const score = (await client.readContract({address: REP, abi: ReputationRegistryAbi, functionName: "scoreOf", args: [user]} as never)) as bigint;
    let gate = 0n;
    let joined = ZERO32 as Hex;
    try {
      gate = (await client.readContract({address: src.source as Hex, abi: CampaignAbi, functionName: "minReputation"} as never)) as bigint;
      joined = (await client.readContract({address: src.source as Hex, abi: CampaignAbi, functionName: "promoterIdOf", args: [user]} as never)) as Hex;
    } catch { /* source is not a campaign */ }
    console.log(`${ok(hit.length > 0)}  ${user} has ${hit.length} matching log(s) after its touch @${block}`);
    if (gate > 0n || joined !== ZERO32) {
      console.log(`     source is a campaign: gate ${gate}, this wallet scores ${score} (${score >= gate ? "clears" : "BELOW"}), alreadyJoined=${joined !== ZERO32}`);
    }
  }
  void actors;
  void decodeAbiParameters;
}
