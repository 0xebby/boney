/**
 * Throwaway: dumps every verification layer's live state for one campaign as JSON.
 *
 * Run: pnpm tsx scripts/__gyn-verify-state.mts <campaign> > /tmp/state.json
 */
import {createPublicClient, http, getAddress, type Hex, type PublicClient} from "viem";
import {
  CampaignAbi,
  EventMetricKpiVerifierAbi,
  GuardedKpiVerifierAbi,
  AttributionRegistryAbi,
  ReputationRegistryAbi,
  EscrowVaultAbi,
  IERC20MetadataAbi,
} from "../src/lib/abis";
import {GENERATED_DEPLOYMENTS} from "../src/lib/deployments";
import {decodeEventSource} from "../src/lib/kpiSource";
import {catalogSignature} from "../src/lib/eventNames";

const RPC = process.env.BASE_SEPOLIA_RPC ?? "https://base-sepolia-rpc.publicnode.com";
const D = GENERATED_DEPLOYMENTS[84532]!;
const campaign = getAddress(process.argv[2]!);

const client = createPublicClient({transport: http(RPC, {retryCount: 5})}) as PublicClient;

const read = <T,>(address: Hex, abi: unknown, functionName: string, args: unknown[] = []) =>
  client.readContract({address, abi, functionName, args} as never) as Promise<T>;

/** Promoters and referrals, from the subgraph — cheaper and complete versus a log scan. */
async function graph() {
  const q = `{ campaign(id:"${campaign.toLowerCase()}"){ campaignId name project token status
    promoters{ promoterId wallet reputation joinedAtBlock }
    touches{ user promoterId signedAt expiresAt blockNumber } } _meta{ block{ number } } }`;
  const r = await fetch(process.env.NEXT_PUBLIC_SUBGRAPH_URL!, {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({query: q}),
  });
  return (await r.json()).data;
}

async function main() {
  const g = await graph();
  const promoters = g.campaign.promoters as {
    promoterId: Hex;
    wallet: Hex;
    reputation: string;
    joinedAtBlock: string;
  }[];
  const touches = g.campaign.touches as {
    user: Hex;
    promoterId: Hex;
    signedAt: string;
    expiresAt: string;
    blockNumber: string;
  }[];

  const head = await client.getBlockNumber();
  const out: Record<string, unknown> = {rpc: RPC, head: head.toString(), campaign};

  // ── campaign + escrow ────────────────────────────────────────────
  const [
    name,
    project,
    token,
    rewardPool,
    startTime,
    endTime,
    attributionWindow,
    minReputation,
    status,
    remainingPool,
    paidOut,
    kpiCount,
    claimGrace,
  ] = await Promise.all([
    read<string>(campaign, CampaignAbi, "name"),
    read<Hex>(campaign, CampaignAbi, "getProject"),
    read<Hex>(campaign, CampaignAbi, "token"),
    read<bigint>(campaign, CampaignAbi, "rewardPool"),
    read<bigint>(campaign, CampaignAbi, "startTime"),
    read<bigint>(campaign, CampaignAbi, "endTime"),
    read<bigint>(campaign, CampaignAbi, "attributionWindow"),
    read<bigint>(campaign, CampaignAbi, "minReputation"),
    read<number>(campaign, CampaignAbi, "status"),
    read<bigint>(campaign, CampaignAbi, "remainingPool"),
    read<bigint>(campaign, CampaignAbi, "paidOut"),
    read<bigint>(campaign, CampaignAbi, "kpiCount"),
    read<bigint>(campaign, CampaignAbi, "CLAIM_GRACE"),
  ]);

  const [symbol, decimals, escrowBalance] = await Promise.all([
    read<string>(token, IERC20MetadataAbi, "symbol"),
    read<number>(token, IERC20MetadataAbi, "decimals"),
    read<bigint>(D.escrowVault, EscrowVaultAbi, "balanceOf", [campaign]),
  ]);

  out.campaignInfo = {
    campaignId: g.campaign.campaignId,
    name,
    project,
    token,
    symbol,
    decimals,
    rewardPool: rewardPool.toString(),
    startTime: startTime.toString(),
    endTime: endTime.toString(),
    attributionWindow: attributionWindow.toString(),
    minReputation: minReputation.toString(),
    status,
    remainingPool: remainingPool.toString(),
    paidOut: paidOut.toString(),
    escrowBalance: escrowBalance.toString(),
    claimGrace: claimGrace.toString(),
    kpiCount: Number(kpiCount),
  };

  // ── layer 1: reputation ──────────────────────────────────────────
  const maxScore = await read<bigint>(D.reputationRegistry, ReputationRegistryAbi, "maxScore");
  const schemaCount = await read<bigint>(D.reputationRegistry, ReputationRegistryAbi, "schemaCount");
  const schemas: unknown[] = [];
  for (let i = 0n; i < schemaCount; i++) {
    const id = await read<Hex>(D.reputationRegistry, ReputationRegistryAbi, "schemaIdAt", [i]);
    const [info, maxAge, maxValue, enabled] = await Promise.all([
      read<[string, bigint, boolean]>(D.reputationRegistry, ReputationRegistryAbi, "schemaInfo", [id]),
      read<bigint>(D.reputationRegistry, ReputationRegistryAbi, "schemaMaxAge", [id]),
      read<bigint>(D.reputationRegistry, ReputationRegistryAbi, "schemaMaxValue", [id]),
      read<boolean>(D.reputationRegistry, ReputationRegistryAbi, "isSchemaEnabled", [id]),
    ]);
    schemas.push({
      id,
      name: info[0],
      weight: info[1].toString(),
      exists: info[2],
      maxAge: maxAge.toString(),
      maxValue: maxValue.toString(),
      enabled,
    });
  }
  out.reputation = {maxScore: maxScore.toString(), schemas};

  // ── layer 2: attribution ─────────────────────────────────────────
  const [maxTouchDuration, effectiveMaxDuration] = await Promise.all([
    read<bigint>(D.attributionRegistry, AttributionRegistryAbi, "maxTouchDuration"),
    read<bigint>(D.attributionRegistry, AttributionRegistryAbi, "effectiveMaxDuration", [campaign]),
  ]);

  const promoterRows: unknown[] = [];
  for (const p of promoters) {
    const [onChainScore, registered] = await Promise.all([
      read<bigint>(D.reputationRegistry, ReputationRegistryAbi, "scoreOf", [p.wallet]),
      read<boolean>(D.attributionRegistry, AttributionRegistryAbi, "isRegistered", [
        campaign,
        p.promoterId,
      ]),
    ]);
    promoterRows.push({
      ...p,
      onChainScore: onChainScore.toString(),
      promoterIdRegistered: registered,
    });
  }

  const referralRows: unknown[] = [];
  for (const t of touches) {
    const live = await read<Record<string, unknown>>(
      D.attributionRegistry,
      AttributionRegistryAbi,
      "touchOf",
      [campaign, t.user],
    );
    const historyLength = await read<bigint>(
      D.attributionRegistry,
      AttributionRegistryAbi,
      "touchHistoryLength",
      [campaign, t.user],
    );
    referralRows.push({
      ...t,
      historyLength: historyLength.toString(),
      onChainTouch: Object.fromEntries(
        Object.entries(live).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]),
      ),
    });
  }

  out.attribution = {
    registry: D.attributionRegistry,
    maxTouchDuration: maxTouchDuration.toString(),
    effectiveMaxDuration: effectiveMaxDuration.toString(),
    promoters: promoterRows,
    referrals: referralRows,
  };

  // ── layers 3-5: per KPI ──────────────────────────────────────────
  const kpis: unknown[] = [];
  for (let i = 0n; i < kpiCount; i++) {
    const spec = await read<{kind: number; verifier: Hex; target: bigint; aggregate: boolean; params: Hex}>(
      campaign,
      CampaignAbi,
      "kpi",
      [i],
    );
    const tiers = await read<{threshold: bigint; reward: bigint}[]>(campaign, CampaignAbi, "tiers", [i]);
    const source = decodeEventSource(spec.params);

    // Boney's observation config + checkpoint.
    const cfg = await read<Record<string, unknown>>(
      D.eventMetricKpiVerifier,
      EventMetricKpiVerifierAbi,
      "configOf",
      [campaign, i],
    );
    const checkpoint = await read<bigint>(
      D.eventMetricKpiVerifier,
      EventMetricKpiVerifierAbi,
      "checkpointOf",
      [campaign, i],
    );
    const guard = await read<Record<string, unknown>>(
      D.guardedKpiVerifier,
      GuardedKpiVerifierAbi,
      "guardOf",
      [campaign, i],
    );

    // Per-referral: what Boney vouched for vs what the project has claimed.
    const perReferral: unknown[] = [];
    for (const t of touches) {
      const [verified, credited] = await Promise.all([
        read<bigint>(D.eventMetricKpiVerifier, EventMetricKpiVerifierAbi, "verifiedTotalOf", [
          campaign,
          i,
          t.user,
        ]),
        read<bigint>(campaign, CampaignAbi, "userCreditedOf", [t.user, i]),
      ]);
      const creditedTo = await read<bigint>(campaign, CampaignAbi, "creditedToOf", [
        t.user,
        i,
        t.promoterId,
      ]);
      perReferral.push({
        user: t.user,
        promoterId: t.promoterId,
        verifiedTotal: verified.toString(),
        userCredited: credited.toString(),
        creditedToPromoter: creditedTo.toString(),
      });
    }

    // Per-promoter: progress and tiers settled. Both key on the promoter *wallet*, not the id.
    const perPromoter: unknown[] = [];
    for (const p of promoters) {
      const [prog, settled] = await Promise.all([
        read<bigint>(campaign, CampaignAbi, "progressOf", [p.wallet, i]),
        read<bigint>(campaign, CampaignAbi, "settledTiersOf", [p.wallet, i]),
      ]);
      perPromoter.push({
        wallet: p.wallet,
        promoterId: p.promoterId,
        progress: prog.toString(),
        tiersSettled: Number(settled),
      });
    }

    kpis.push({
      index: Number(i),
      kind: spec.kind,
      aggregate: spec.aggregate,
      target: spec.target.toString(),
      verifier: spec.verifier,
      gated: getAddress(spec.verifier) === getAddress(D.guardedKpiVerifier),
      paramsLength: (spec.params.length - 2) / 2,
      source: source
        ? {
            source: source.source,
            topic0: source.topic0,
            signature: catalogSignature(source.topic0) ?? null,
            actorTopic: source.actorTopic,
            amountMode: source.amountMode,
            scale: source.scale.toString(),
            filterTopic: source.filterTopic ?? null,
            filterValue: source.filterValue ?? null,
          }
        : null,
      tiers: tiers.map((t) => ({threshold: t.threshold.toString(), reward: t.reward.toString()})),
      observation: {
        ...Object.fromEntries(
          Object.entries(cfg).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]),
        ),
        checkpoint: checkpoint.toString(),
      },
      guard: Object.fromEntries(
        Object.entries(guard).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]),
      ),
      perReferral,
      perPromoter,
    });
  }
  out.kpis = kpis;

  // ── reporter identity ────────────────────────────────────────────
  out.reporter = await read<Hex>(D.eventMetricKpiVerifier, EventMetricKpiVerifierAbi, "reporter");
  out.verifierOwner = await read<Hex>(D.eventMetricKpiVerifier, EventMetricKpiVerifierAbi, "owner");
  out.guardOwner = await read<Hex>(D.guardedKpiVerifier, GuardedKpiVerifierAbi, "owner");
  out.boneyVerifier = await read<Hex>(D.guardedKpiVerifier, GuardedKpiVerifierAbi, "boneyVerifier");

  console.log(JSON.stringify(out, null, 2));
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
