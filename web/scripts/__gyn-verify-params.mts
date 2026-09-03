/**
 * Decodes the KPI params the Solidity seed encoded, through the app's own event-source decoder.
 *
 * Proves `SeedGyndore`'s `abi.encode` and `web/src/lib/kpiSource.ts` agree on the 224-byte filtered
 * layout — the two halves that must not disagree, and which nothing else checks.
 */
import {readFileSync} from "node:fs";
import {decodeFunctionData, parseAbi} from "viem";
import {decodeEventSource, describeTopicFilter, eventSourceSummary} from "../src/lib/kpiSource";
import {resolveTrackedEvent} from "../src/lib/eventNames";

const abi = parseAbi([
  "struct CampaignConfig { address project; string name; address token; uint256 rewardPool; uint64 startTime; uint64 endTime; uint64 attributionWindow; uint256 minReputation; }",
  "struct KpiSpec { uint8 kind; address verifier; uint256 target; bool aggregate; bytes params; }",
  "struct RewardTier { uint256 threshold; uint256 reward; }",
  "function createCampaign(CampaignConfig cfg, KpiSpec[] kpis, RewardTier[][] tiers)",
]);

const input = readFileSync("/tmp/gyn-create.hex", "utf8").trim() as `0x${string}`;
const {args} = decodeFunctionData({abi, data: input});
const [cfg, kpis, tiers] = args as [
  {name: string; token: string; rewardPool: bigint; minReputation: bigint; attributionWindow: number},
  readonly {kind: number; verifier: string; aggregate: boolean; params: `0x${string}`}[],
  readonly readonly {threshold: bigint; reward: bigint}[][],
];

console.log(`campaign "${cfg.name}"`);
console.log(`  token            ${cfg.token}`);
console.log(`  rewardPool       ${cfg.rewardPool} (${Number(cfg.rewardPool) / 1e18} GYND)`);
console.log(`  minReputation    ${cfg.minReputation}`);
console.log(`  attributionWindow ${cfg.attributionWindow}s`);

let bad = 0;
/** The signatures `SeedGyndore` hands `setKpiConfig`, in KPI order. */
const CONFIG_SIGNATURES = [
  "Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
  "Staked(address indexed user, address indexed token, uint256 amount)",
  "Transfer(address indexed from, address indexed to, uint256 tokenId)",
];

kpis.forEach((kpi, i) => {
  const src = decodeEventSource(kpi.params);
  console.log(`\nkpi ${i}  kind=${kpi.kind} aggregate=${kpi.aggregate} verifier=${kpi.verifier}`);
  console.log(`  params           ${(kpi.params.length - 2) / 2} bytes`);
  if (!src) {
    console.log(`  DECODE FAILED — the web half cannot read this blob`);
    bad++;
    return;
  }
  const ev = resolveTrackedEvent({
    source: src,
    kind: kpi.kind,
    chainId: 84532,
    configSignature: CONFIG_SIGNATURES[i],
  });
  console.log(`  decoded          ${eventSourceSummary(src, ev.event)}`);
  console.log(`  protocol         ${ev.protocol} (from ${ev.protocolFrom})`);
  console.log(`  actorTopic=${src.actorTopic} amountMode=${src.amountMode} scale=${src.scale}`);
  console.log(`  filter           ${describeTopicFilter(src) ?? "(none)"}`);
  const ladder = tiers[i].map((t) => `${t.threshold}→${Number(t.reward) / 1e18}`).join("  ");
  console.log(`  tiers            ${ladder}`);
  if (ev.drift) {
    console.log(`  DRIFT — configured signature hashes to a different topic than params: ${ev.drift}`);
    bad++;
  }
  if (kpi.aggregate && tiers[i].length > 0) {
    console.log(`  AGGREGATE WITH TIERS — can never pay`);
    bad++;
  }
});

console.log(bad === 0 ? "\nall KPIs decode cleanly" : `\n${bad} problem(s)`);
process.exit(bad === 0 ? 0 : 1);
