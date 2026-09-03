import {Address, BigInt, Bytes, log} from "@graphprotocol/graph-ts";
import {CampaignCreated} from "../generated/CampaignRegistry/CampaignRegistry";
import {Campaign as CampaignContract} from "../generated/CampaignRegistry/Campaign";
import {Campaign, Kpi, SpawnedSource, UnsupportedSource} from "../generated/schema";
import {
  AaveSupply,
  CampaignEvents,
  SygmaDeposit,
  TransferToActor,
  TransferToActorCount,
  WethDeposit,
  WethWithdrawal,
} from "../generated/templates";
import {decodeEventSource, templateFor} from "./kpiSource";

/**
 * Campaign creation — the entry point that wires everything else up.
 *
 * `CampaignCreated` carries the campaign address but not its KPIs, so the specs are read back with an
 * `eth_call`. That call is what makes the whole design work: `KpiSpec.params` names the contract and
 * event a campaign measures, and until it is decoded there is no way to know which template to spawn
 * or at what address.
 */
export function handleCampaignCreated(event: CampaignCreated): void {
  const campaignAddress = event.params.campaign;
  const campaignId = campaignAddress.toHexString();

  const campaign = new Campaign(campaignId);
  campaign.campaignId = event.params.campaignId;
  campaign.project = event.params.project;
  campaign.token = event.params.token;
  campaign.name = event.params.name;
  campaign.createdAtBlock = event.block.number;
  campaign.createdAt = event.block.timestamp;
  campaign.save();

  // Campaign addresses are unique by construction, so this needs no dedupe guard.
  CampaignEvents.create(campaignAddress);

  const contract = CampaignContract.bind(campaignAddress);

  const countResult = contract.try_kpiCount();
  if (countResult.reverted) {
    // The campaign exists — the registry just deployed it — so a reverting `kpiCount` means the ABI
    // and the deployed bytecode disagree. Logged rather than swallowed: every KPI on this campaign is
    // silently unobservable if this happens, and that is indistinguishable from a quiet campaign.
    log.error("kpiCount() reverted for campaign {} — its KPIs will not be indexed", [campaignId]);
    return;
  }

  const kpiCount = countResult.value.toI32();

  for (let i = 0; i < kpiCount; i++) {
    const specResult = contract.try_kpi(BigInt.fromI32(i));
    if (specResult.reverted) {
      log.error("kpi({}) reverted for campaign {}", [i.toString(), campaignId]);
      continue;
    }
    const spec = specResult.value;

    const kpi = new Kpi(campaignId + "-" + i.toString());
    kpi.campaign = campaignId;
    kpi.index = i;
    kpi.kind = spec.kind;
    kpi.verifier = spec.verifier;
    kpi.target = spec.target;
    kpi.aggregate = spec.aggregate;

    const source = decodeEventSource(spec.params);
    if (source == null) {
      // Not event-sourced: params carry a `TouchWindowVerifier` lookback, or nothing. The KPI is still
      // recorded so the campaign's KPI list is complete; its source fields stay null.
      kpi.save();
      continue;
    }

    kpi.source = source.source;
    kpi.topic0 = source.topic0;
    kpi.actorTopic = source.actorTopic;
    kpi.amountMode = source.amountMode;
    kpi.scale = source.scale;
    kpi.filterTopic = source.filterTopic;
    kpi.filterValue = source.filterValue;
    kpi.save();

    const template = templateFor(source);
    if (template == null) {
      recordUnsupported(source.source, source.topic0, source.actorTopic, source.amountMode, event.block.number);
      continue;
    }

    spawnOnce(template as string, source.source, event.block.number);
  }
}

/**
 * Spawns a template against an address at most once.
 *
 * The failure this prevents is silent and total. graph-node does not dedupe dynamic data sources, so
 * two campaigns watching the same contract with the same preset would each spawn one, both would
 * handle every matching log, and every action would be written twice — doubling observed activity for
 * every referral on both campaigns. The current fixture is exactly this case: all six campaigns track
 * `Transfer` on the *same* escrow token, so without this guard the first six campaigns would
 * six-count every transfer.
 */
function spawnOnce(template: string, address: Bytes, blockNumber: BigInt): void {
  const id = template + "-" + address.toHexString();
  if (SpawnedSource.load(id) != null) return;

  const target = changetype<Address>(address);
  if (template == "TransferToActor") {
    TransferToActor.create(target);
  } else if (template == "TransferToActorCount") {
    TransferToActorCount.create(target);
  } else if (template == "WethDeposit") {
    WethDeposit.create(target);
  } else if (template == "WethWithdrawal") {
    WethWithdrawal.create(target);
  } else if (template == "AaveSupply") {
    AaveSupply.create(target);
  } else if (template == "SygmaDeposit") {
    SygmaDeposit.create(target);
  } else {
    // `templateFor` named a template this function cannot spawn. Unreachable unless the two drift —
    // logged and returned *before* the record is written, because a `SpawnedSource` row for a source
    // that was never actually spawned is worse than none: it makes the dedupe guard permanently
    // suppress the retry, so the KPI indexes nothing forever while the data claims it is covered.
    log.error("templateFor returned unknown template {} for {}", [template, address.toHexString()]);
    return;
  }

  const record = new SpawnedSource(id);
  record.template = template;
  record.address = address;
  record.spawnedAtBlock = blockNumber;
  record.save();
}

/**
 * Records an event shape no template covers.
 *
 * Written rather than dropped because the consequence is invisible otherwise: the KPI indexes nothing,
 * its campaign shows no activity forever, and that reads identically to "nobody has acted yet". A row
 * here turns it into a queryable gap — and `kpiCount` says how many KPIs are waiting on the shape,
 * which is the number that decides whether it is worth a manifest release.
 */
function recordUnsupported(
  source: Bytes,
  topic0: Bytes,
  actorTopic: i32,
  amountMode: i32,
  blockNumber: BigInt,
): void {
  const id = source.toHexString() + "-" + topic0.toHexString();
  let record = UnsupportedSource.load(id);

  if (record == null) {
    record = new UnsupportedSource(id);
    record.source = source;
    record.topic0 = topic0;
    record.actorTopic = actorTopic;
    record.amountMode = amountMode;
    record.kpiCount = 0;
    record.firstSeenAtBlock = blockNumber;
  }

  record.kpiCount = record.kpiCount + 1;
  record.save();

  log.warning("No template covers event {} on {} (actorTopic {}, amountMode {}) — KPI not indexed", [
    topic0.toHexString(),
    source.toHexString(),
    actorTopic.toString(),
    amountMode.toString(),
  ]);
}
