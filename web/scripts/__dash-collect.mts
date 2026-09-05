/**
 * Throwaway: collects every verification layer for every campaign on the live Base Sepolia fixture
 * and writes one JSON blob the static verification dashboard is built from.
 *
 * Layers per KPI: the claim (`userCreditedOf`), the ceiling (`verifiedTotalOf` /
 * `observedProgressOf`), the subgraph's fold of `Credit` and `TierPayout`, an independent
 * `eth_getLogs` re-scan of the KPI's own `params`, and escrow (`paidOut` / `remainingPool`).
 */
import {writeFileSync, readFileSync} from "node:fs";
import {createPublicClient, http, getAddress, type Hex} from "viem";
import {baseSepolia} from "viem/chains";
import {CampaignAbi} from "../src/lib/abis/Campaign";
import {CampaignRegistryAbi} from "../src/lib/abis/CampaignRegistry";
import {GuardedKpiVerifierAbi} from "../src/lib/abis/GuardedKpiVerifier";
import {EventMetricKpiVerifierAbi} from "../src/lib/abis/EventMetricKpiVerifier";
import {decodeEventSource, AMOUNT_MODE, matchesTopicFilter, effectiveScale} from "../src/lib/kpiSource";

const REGISTRY = getAddress("0x3e0a2fc423dE77bEE9147879308BFfFC6129c4EE");
const ZERO = "0x0000000000000000000000000000000000000000";
const RESCAN = !process.argv.includes("--no-rescan");
const OUT = new URL("./__dash-data.json", import.meta.url);

const client = createPublicClient({
  chain: baseSepolia,
  transport: http(process.env.BASE_SEPOLIA_RPC ?? "https://base-sepolia-rpc.publicnode.com"),
});

const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const SUBGRAPH = env.split("\n").find((l) => /^\s*NEXT_PUBLIC_SUBGRAPH_URL\s*=/.test(l))!
  .split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, "");

/** POSTs a GraphQL query, retrying the flaky gateway. */
const gql = async (query: string): Promise<Record<string, never>> => {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await fetch(SUBGRAPH, {
        method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({query}),
      });
      const body = await res.json() as {data?: Record<string, never>; errors?: unknown};
      if (body.errors) throw new Error(JSON.stringify(body.errors).slice(0, 300));
      if (body.data) return body.data;
    } catch (err) {
      if (attempt === 5) throw err;
    }
  }
  throw new Error("unreachable");
};

/** Reads one view, returning undefined instead of throwing when it reverts. */
const read = async (address: Hex, abi: unknown, functionName: string, args: unknown[]) => {
  try {
    return await client.readContract({address, abi, functionName, args} as never);
  } catch { return undefined; }
};

const s = (v: unknown) => (typeof v === "bigint" ? v.toString() : v);
const head = await client.getBlockNumber();
const meta = await gql("{_meta{block{number} hasIndexingErrors}}") as never as
  {_meta: {block: {number: number}; hasIndexingErrors: boolean}};

const count = await client.readContract({
  address: REGISTRY, abi: CampaignRegistryAbi, functionName: "campaignCount",
}) as bigint;

const gaps = await gql(`{
  unsupportedSources(first: 100) { source topic0 actorTopic amountMode kpiCount firstSeenAtBlock }
  spawnedSources(first: 100) { template address spawnedAtBlock }
}`) as never as {
  unsupportedSources: Record<string, string>[];
  spawnedSources: Record<string, string>[];
};

const out: Record<string, unknown> = {
  collectedAt: new Date().toISOString(),
  head: s(head),
  registry: REGISTRY,
  subgraph: {
    url: SUBGRAPH.replace(/^.*\/subgraphs\//, ".../subgraphs/"),
    block: meta._meta.block.number,
    lag: Number(head) - meta._meta.block.number,
    hasIndexingErrors: meta._meta.hasIndexingErrors,
  },
  unsupportedSources: gaps.unsupportedSources,
  spawnedSources: gaps.spawnedSources,
  campaigns: [] as unknown[],
};
console.log(`head=${head} subgraphBlock=${meta._meta.block.number} lag=${Number(head) - meta._meta.block.number}`);

let eventMetric: Hex | undefined;
const windowStarts: bigint[] = [];

for (let id = 0n; id < count; id++) {
  const address = await client.readContract({
    address: REGISTRY, abi: CampaignRegistryAbi, functionName: "campaignAt", args: [id],
  }) as Hex;
  const [cfg, status, remainingPool, paidOut, kpiCount] = await Promise.all([
    client.readContract({address, abi: CampaignAbi, functionName: "config"}),
    client.readContract({address, abi: CampaignAbi, functionName: "status"}),
    client.readContract({address, abi: CampaignAbi, functionName: "remainingPool"}),
    client.readContract({address, abi: CampaignAbi, functionName: "paidOut"}),
    client.readContract({address, abi: CampaignAbi, functionName: "kpiCount"}),
  ]) as [Record<string, unknown>, number, bigint, bigint, bigint];

  const sub = await gql(`{
    campaign(id: "${address.toLowerCase()}") {
      promoters { promoterId wallet reputation joinedAtBlock }
      touches(first: 1000, orderBy: blockNumber) { user promoterId signedAt expiresAt blockNumber relayer }
    }
  }`) as never as {campaign: {
    promoters: {promoterId: Hex; wallet: Hex; reputation: string; joinedAtBlock: string}[];
    touches: {user: Hex; promoterId: Hex; signedAt: string; expiresAt: string; blockNumber: string; relayer: Hex}[];
  } | null};

  // `Credit` and `TierPayout` carry a campaign edge but no reverse field, so they page from the root.
  const page = async <T>(entity: string, fields: string): Promise<T[]> => {
    const rows: T[] = [];
    for (let cursor = ""; ;) {
      const data = await gql(`{ ${entity}(first: 1000, orderBy: id, where: {campaign: "${address.toLowerCase()}"` +
        `${cursor ? `, id_gt: "${cursor}"` : ""}}) { id ${fields} } }`) as never as Record<string, T[]>;
      const batch = data[entity]!;
      rows.push(...batch);
      if (batch.length < 1000) return rows;
      cursor = (batch[batch.length - 1] as {id: string}).id;
    }
  };
  const promoters = sub.campaign?.promoters ?? [];
  const touches = sub.campaign?.touches ?? [];
  const credits = await page<{kpiIndex: number; promoterId: Hex; user: Hex; amount: string; blockNumber: string}>(
    "credits", "kpiIndex promoterId user amount blockNumber");
  const payouts = await page<{kpiIndex: number; promoterId: Hex; promoter: Hex; tier: number; paid: string; blockNumber: string}>(
    "tierPayouts", "kpiIndex promoterId promoter tier paid blockNumber");
  const walletOf = new Map(promoters.map((p) => [p.promoterId.toLowerCase(), getAddress(p.wallet)]));

  /** Newest touch per referral — the one row `AttributionRegistry` keeps. */
  const live = new Map<string, {promoterId: Hex; signedAt: number; blockNumber: bigint}>();
  for (const t of touches) {
    const seen = live.get(t.user.toLowerCase());
    if (!seen || Number(t.signedAt) > seen.signedAt) {
      live.set(t.user.toLowerCase(), {
        promoterId: t.promoterId, signedAt: Number(t.signedAt), blockNumber: BigInt(t.blockNumber),
      });
    }
  }
  const firstTouchBlock = touches.length
    ? touches.reduce((m, t) => (BigInt(t.blockNumber) < m ? BigInt(t.blockNumber) : m), 2n ** 60n)
    : 0n;
  console.log(`\n=== ${id} ${cfg.name} ${address} promoters=${promoters.length} referrals=${live.size} touches=${touches.length}`);

  const kpis: unknown[] = [];
  for (let k = 0n; k < kpiCount; k++) {
    const [spec, tiers, totalProgress] = await Promise.all([
      client.readContract({address, abi: CampaignAbi, functionName: "kpi", args: [k]}),
      client.readContract({address, abi: CampaignAbi, functionName: "tiers", args: [k]}),
      client.readContract({address, abi: CampaignAbi, functionName: "totalProgress", args: [k]}),
    ]) as [Record<string, unknown>, {threshold: bigint; reward: bigint}[], bigint];
    const src = decodeEventSource(spec.params as Hex);
    const verifier = spec.verifier as Hex;
    const gated = verifier !== ZERO;

    let guard: Record<string, unknown> | undefined;
    let relay: Record<string, unknown> | undefined;
    let checkpoint: bigint | undefined;
    if (gated) {
      guard = await read(verifier, GuardedKpiVerifierAbi, "guardOf", [address, k]) as never;
      eventMetric ??= await read(verifier, GuardedKpiVerifierAbi, "boneyVerifier", []) as Hex;
      relay = await read(eventMetric!, EventMetricKpiVerifierAbi, "configOf", [address, k]) as never;
      checkpoint = await read(eventMetric!, EventMetricKpiVerifierAbi, "checkpointOf", [address, k]) as never;
      if (relay?.windowStartBlock) windowStarts.push(relay.windowStartBlock as bigint);
    }

    // The one column that does not come from the code path that produced the number it checks:
    // the KPI's own params, replayed against the node, narrowed to this campaign's referrals.
    const observed = new Map<string, {units: bigint; logs: number}>();
    const failed: string[] = [];
    if (src && RESCAN && live.size > 0 && firstTouchBlock > 0n) {
      const scale = effectiveScale(src);
      for (let from = firstTouchBlock + 1n; from <= head; from += 9000n) {
        const to = from + 8999n > head ? head : from + 8999n;
        const topics: (Hex | Hex[] | null)[] = [src.topic0 as Hex, null, null, null];
        if (src.filterTopic) topics[src.filterTopic] = src.filterValue as Hex;
        topics[src.actorTopic] = [...live.keys()].map((a) => `0x${"0".repeat(24)}${a.slice(2)}` as Hex);
        while (topics.length && topics[topics.length - 1] === null) topics.pop();
        let logs: {topics: Hex[]; data: Hex}[] = [];
        let ok = false;
        for (let attempt = 0; attempt < 3 && !ok; attempt++) {
          try {
            logs = await client.request({method: "eth_getLogs", params: [{
              address: src.source, topics, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`,
            }]} as never) as never;
            ok = true;
          } catch { /* retry */ }
        }
        if (!ok) { failed.push(`${from}-${to}`); continue; }
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

    const referrals: unknown[] = [];
    for (const [user, touch] of live) {
      const [credited, creditedToLive, lastReportBlock] = await Promise.all([
        client.readContract({address, abi: CampaignAbi, functionName: "userCreditedOf", args: [user as Hex, k]}),
        client.readContract({address, abi: CampaignAbi, functionName: "creditedToOf", args: [user as Hex, k, touch.promoterId]}),
        client.readContract({address, abi: CampaignAbi, functionName: "lastReportBlockOf", args: [user as Hex, k]}),
      ]) as [bigint, bigint, bigint];
      let ceilingRaw: bigint | undefined;
      let ceilingScaled: bigint | undefined;
      if (gated && eventMetric) {
        ceilingRaw = await read(eventMetric, EventMetricKpiVerifierAbi, "verifiedTotalOf", [address, k, user as Hex]) as never;
        ceilingScaled = await read(eventMetric, EventMetricKpiVerifierAbi, "observedProgressOf", [address, k, user as Hex]) as never;
      }
      const seen = observed.get(user);
      // The subgraph's own fold of `Credit`, which must reproduce `userCreditedOf` exactly.
      const graphCredited = credits
        .filter((c) => Number(c.kpiIndex) === Number(k) && c.user.toLowerCase() === user)
        .reduce((sum, c) => sum + BigInt(c.amount), 0n);
      referrals.push({
        user: getAddress(user as Hex),
        viaPromoterId: touch.promoterId,
        viaWallet: walletOf.get(touch.promoterId.toLowerCase()) ?? null,
        touchBlock: s(touch.blockNumber),
        touchSignedAt: touch.signedAt,
        credited: s(credited),
        creditedToLive: s(creditedToLive),
        lastReportBlock: s(lastReportBlock),
        graphCredited: s(graphCredited),
        ceilingRaw: s(ceilingRaw),
        ceilingScaled: s(ceilingScaled),
        rescanUnits: seen ? s(seen.units) : RESCAN ? "0" : null,
        rescanLogs: seen ? seen.logs : null,
      });
    }

    const promoterRows: unknown[] = [];
    for (const p of promoters) {
      const [progress, settled] = await Promise.all([
        client.readContract({address, abi: CampaignAbi, functionName: "progressOf", args: [getAddress(p.wallet), k]}),
        client.readContract({address, abi: CampaignAbi, functionName: "settledTiersOf", args: [getAddress(p.wallet), k]}),
      ]) as [bigint, bigint];
      const graphProgress = credits
        .filter((c) => Number(c.kpiIndex) === Number(k) && c.promoterId.toLowerCase() === p.promoterId.toLowerCase())
        .reduce((sum, c) => sum + BigInt(c.amount), 0n);
      const graphPaid = payouts
        .filter((c) => Number(c.kpiIndex) === Number(k) && c.promoterId.toLowerCase() === p.promoterId.toLowerCase())
        .reduce((sum, c) => sum + BigInt(c.paid), 0n);
      const graphTiers = payouts
        .filter((c) => Number(c.kpiIndex) === Number(k) && c.promoterId.toLowerCase() === p.promoterId.toLowerCase()).length;
      promoterRows.push({
        wallet: getAddress(p.wallet), promoterId: p.promoterId,
        progress: s(progress), settledTiers: s(settled),
        graphProgress: s(graphProgress), graphPaid: s(graphPaid), graphTiers,
      });
    }

    kpis.push({
      index: Number(k),
      kind: Number(spec.kind),
      aggregate: spec.aggregate,
      target: s(spec.target),
      verifier,
      gated,
      source: src ? {
        source: src.source, topic0: src.topic0, actorTopic: src.actorTopic,
        amountMode: src.amountMode, scale: s(effectiveScale(src)),
        filterTopic: src.filterTopic ?? null, filterValue: src.filterValue ?? null,
      } : null,
      tiers: tiers.map((t) => ({threshold: s(t.threshold), reward: s(t.reward)})),
      totalProgress: s(totalProgress),
      guard: guard ? {
        projectVerifier: guard.projectVerifier, toleranceBps: Number(guard.toleranceBps),
        mode: Number(guard.mode), configured: guard.configured,
      } : null,
      relay: relay ? {
        targetContract: relay.targetContract, eventSignature: relay.eventSignature,
        userParamIndex: Number(relay.userParamIndex), valueParamIndex: Number(relay.valueParamIndex),
        aggregation: Number(relay.aggregation), scale: s(relay.scale),
        windowStartBlock: s(relay.windowStartBlock), windowEndBlock: s(relay.windowEndBlock),
        configured: relay.configured, epoch: s(relay.epoch),
      } : null,
      checkpoint: s(checkpoint),
      rescanFailedWindows: failed,
      referrals,
      promoterRows,
      graphCredits: credits.filter((c) => Number(c.kpiIndex) === Number(k)).length,
      graphPayouts: payouts.filter((c) => Number(c.kpiIndex) === Number(k)).length,
    });
    const cp = checkpoint === undefined ? "n/a" : `${checkpoint}`;
    console.log(`  KPI ${k} gated=${gated} totalProgress=${totalProgress} checkpoint=${cp} rescanned=${observed.size} failed=${failed.length}`);
  }

  (out.campaigns as unknown[]).push({
    id: Number(id), address, name: cfg.name, status: Number(status),
    project: cfg.project, token: cfg.token,
    rewardPool: s(cfg.rewardPool), remainingPool: s(remainingPool), paidOut: s(paidOut),
    startTime: s(cfg.startTime), endTime: s(cfg.endTime),
    attributionWindow: s(cfg.attributionWindow), minReputation: s(cfg.minReputation),
    firstTouchBlock: s(firstTouchBlock),
    promoters: promoters.map((p) => ({
      promoterId: p.promoterId, wallet: getAddress(p.wallet),
      reputation: p.reputation, joinedAtBlock: p.joinedAtBlock,
    })),
    touches: touches.map((t) => ({
      user: getAddress(t.user), promoterId: t.promoterId, signedAt: t.signedAt,
      expiresAt: t.expiresAt, blockNumber: t.blockNumber, relayer: getAddress(t.relayer),
    })),
    graphTotals: {credits: credits.length, payouts: payouts.length,
      paidSum: s(payouts.reduce((sum, p) => sum + BigInt(p.paid), 0n))},
    kpis,
  });
  writeFileSync(OUT, JSON.stringify(out, null, 1));
}

// The checkpoint timeline. No subgraph data source watches the verifier, so this is a log scan —
// the only way to see the observation layer's history today.
if (eventMetric) {
  out.eventMetric = eventMetric;
  out.reporter = await read(eventMetric, EventMetricKpiVerifierAbi, "reporter", []);
  const abi = EventMetricKpiVerifierAbi as unknown as {type: string; name: string}[];
  const events = ["CheckpointAdvanced", "VerifiedTotalReported", "KpiConfigured", "KpiTotalsInvalidated"]
    .map((name) => abi.find((e) => e.type === "event" && e.name === name)!);
  const from0 = windowStarts.length ? windowStarts.reduce((m, w) => (w < m ? w : m)) : head - 200000n;
  const history: unknown[] = [];
  for (let from = from0; from <= head; from += 9000n) {
    const to = from + 8999n > head ? head : from + 8999n;
    for (const event of events) {
      let logs: unknown[] = [];
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          logs = await client.getLogs({address: eventMetric, event: event as never, fromBlock: from, toBlock: to});
          break;
        } catch { /* retry */ }
      }
      for (const log of logs as {args: Record<string, unknown>; blockNumber: bigint; transactionHash: Hex}[]) {
        const args: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(log.args)) args[key] = s(value);
        history.push({event: event.name, blockNumber: s(log.blockNumber), tx: log.transactionHash, args});
      }
    }
    if ((from - from0) % 90000n === 0n) console.log(`  history scan ${from} (${history.length} so far)`);
  }
  history.sort((a, b) => Number((a as {blockNumber: string}).blockNumber) - Number((b as {blockNumber: string}).blockNumber));
  out.checkpointHistory = history;
  console.log(`\ncheckpointHistory=${history.length} events, from block ${from0}`);
}

writeFileSync(OUT, JSON.stringify(out, null, 1));
console.log(`wrote ${OUT.pathname}`);
