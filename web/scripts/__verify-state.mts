/**
 * Throwaway: per-referral verification state for one campaign — claim, ceiling, credit — plus an
 * independent log re-scan of the KPI's own `params`, so an ungated claim can be checked against
 * what the chain actually shows.
 *
 * @param argv[2] campaign address
 */
import {readFileSync} from "node:fs";
import {createPublicClient, http, getAddress, type Hex} from "viem";
import {baseSepolia} from "viem/chains";
import {CampaignAbi} from "../src/lib/abis/Campaign";
import {EventMetricKpiVerifierAbi} from "../src/lib/abis/EventMetricKpiVerifier";
import {decodeEventSource, AMOUNT_MODE, matchesTopicFilter, effectiveScale} from "../src/lib/kpiSource";

const CAMPAIGN = getAddress(process.argv[2]!);
const EVENT_METRIC = getAddress("0xFF69E2B4A1Cb96a59dbDD138fb7215dCa58aEBd6");

const client = createPublicClient({
  chain: baseSepolia,
  transport: http(process.env.BASE_SEPOLIA_RPC ?? "https://base-sepolia-rpc.publicnode.com"),
});

const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const url = env.split("\n").find((l) => /^\s*NEXT_PUBLIC_SUBGRAPH_URL\s*=/.test(l))!
  .split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, "");

const query = `{
    campaign(id: "${CAMPAIGN.toLowerCase()}") {
      promoters { promoterId wallet reputation joinedAtBlock }
      touches(first: 1000, orderBy: blockNumber) { user promoterId signedAt blockNumber }
    }
  }`;
let body: {data?: never; errors?: unknown} | undefined;
for (let attempt = 0; attempt < 5 && !body; attempt++) {
  try {
    const res = await fetch(url, {
      method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({query}),
    });
    body = await res.json();
  } catch { console.log(`  (subgraph attempt ${attempt + 1} failed, retrying)`); }
}
const {data, errors} = body!;
if (errors) throw new Error(JSON.stringify(errors).slice(0, 400));

const promoters = data.campaign.promoters as {promoterId: Hex; wallet: Hex; reputation: string; joinedAtBlock: string}[];
const touches = data.campaign.touches as {user: Hex; promoterId: Hex; signedAt: string; blockNumber: string}[];
const walletOf = new Map(promoters.map((p) => [p.promoterId.toLowerCase(), getAddress(p.wallet)]));

/** Newest touch per referral, the row the registry keeps. */
const live = new Map<string, {promoterId: Hex; signedAt: number; blockNumber: bigint}>();
for (const t of touches) {
  const seen = live.get(t.user.toLowerCase());
  if (!seen || Number(t.signedAt) > seen.signedAt) {
    live.set(t.user.toLowerCase(), {promoterId: t.promoterId, signedAt: Number(t.signedAt), blockNumber: BigInt(t.blockNumber)});
  }
}
const firstTouchBlock = touches.reduce((m, t) => (BigInt(t.blockNumber) < m ? BigInt(t.blockNumber) : m), 2n ** 60n);
const head = await client.getBlockNumber();
const kpiCount = await client.readContract({address: CAMPAIGN, abi: CampaignAbi, functionName: "kpiCount"}) as bigint;

console.log(`campaign ${CAMPAIGN}  promoters=${promoters.length}  referrals=${live.size}` +
  `  firstTouchBlock=${firstTouchBlock}  head=${head}`);
for (const p of promoters) {
  console.log(`  promoter ${getAddress(p.wallet)} id=${p.promoterId.slice(0, 10)}… rep=${p.reputation} joined@${p.joinedAtBlock}`);
}

for (let k = 0n; k < kpiCount; k++) {
  const spec = await client.readContract({address: CAMPAIGN, abi: CampaignAbi, functionName: "kpi", args: [k]}) as Record<string, unknown>;
  const src = decodeEventSource(spec.params as Hex);
  const gated = (spec.verifier as string) !== "0x0000000000000000000000000000000000000000";
  console.log(`\n--- KPI ${k}  gated=${gated}  source=${src?.source ?? "none"}`);

  // Independent re-scan: the KPI's own params, folded per referral, exactly as the indexer narrows.
  const observed = new Map<string, {units: bigint; logs: number}>();
  if (src) {
    const scale = effectiveScale(src);
    for (let from = firstTouchBlock + 1n; from <= head; from += 9000n) {
      const to = from + 8999n > head ? head : from + 8999n;
      const topics: (Hex | Hex[] | null)[] = [src.topic0 as Hex, null, null, null];
      if (src.filterTopic) topics[src.filterTopic] = src.filterValue as Hex;
      // Let the node narrow to these referrals, the way `useObservedActions` does — the LP source
      // emits about one matching log per block, and an unnarrowed range is megabytes of response.
      topics[src.actorTopic] = [...live.keys()].map((a) => `0x${"0".repeat(24)}${a.slice(2)}` as Hex);
      while (topics.length && topics[topics.length - 1] === null) topics.pop();
      let logs: {topics: Hex[]; data: Hex}[] = [];
      try {
        logs = await client.request({method: "eth_getLogs", params: [{
          address: src.source, topics, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`,
        }]} as never) as never;
      } catch { console.log(`    (chunk ${from}-${to} failed)`); continue; }
      for (const log of logs) {
        if (!matchesTopicFilter(src, log.topics)) continue;
        const slot = log.topics[src.actorTopic];
        if (!slot) continue;
        const actor = `0x${slot.slice(26)}`.toLowerCase();
        if (!live.has(actor)) continue;
        const raw = src.amountMode === AMOUNT_MODE.count ? 1n : BigInt(log.data.slice(0, 66) as Hex);
        const row = observed.get(actor) ?? {units: 0n, logs: 0};
        observed.set(actor, {units: row.units + raw, logs: row.logs + 1});
      }
    }
    for (const [actor, row] of observed) observed.set(actor, {units: row.units / scale, logs: row.logs});
  }

  for (const [user, touch] of live) {
    const [credited, creditedTo] = await Promise.all([
      client.readContract({address: CAMPAIGN, abi: CampaignAbi, functionName: "userCreditedOf", args: [user as Hex, k]}),
      client.readContract({address: CAMPAIGN, abi: CampaignAbi, functionName: "creditedToOf", args: [user as Hex, k, touch.promoterId]}),
    ]) as [bigint, bigint];
    let ceiling = "n/a";
    if (gated) {
      const [raw, capped] = await Promise.all([
        client.readContract({address: EVENT_METRIC, abi: EventMetricKpiVerifierAbi, functionName: "verifiedTotalOf", args: [CAMPAIGN, k, user as Hex]}),
        client.readContract({address: EVENT_METRIC, abi: EventMetricKpiVerifierAbi, functionName: "observedProgressOf", args: [CAMPAIGN, k, user as Hex]}),
      ]) as [bigint, bigint];
      ceiling = `raw=${raw} scaled=${capped}`;
    }
    const seen = observed.get(user);
    console.log(`    ${user} via ${(walletOf.get(touch.promoterId.toLowerCase()) ?? "?").slice(0, 8)}…` +
      `  credited=${credited} toThisPromoter=${creditedTo}  rescan=${seen ? `${seen.units} (${seen.logs} logs)` : "0"}  ceiling ${ceiling}`);
  }

  for (const p of promoters) {
    const [progress, settled] = await Promise.all([
      client.readContract({address: CAMPAIGN, abi: CampaignAbi, functionName: "progressOf", args: [getAddress(p.wallet), k]}),
      client.readContract({address: CAMPAIGN, abi: CampaignAbi, functionName: "settledTiersOf", args: [getAddress(p.wallet), k]}),
    ]) as [bigint, bigint];
    if (progress > 0n || settled > 0n) {
      console.log(`    progressOf(${getAddress(p.wallet).slice(0, 8)}…) = ${progress}  settledTiers=${settled}`);
    }
  }
}
