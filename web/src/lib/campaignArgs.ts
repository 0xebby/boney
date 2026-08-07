import {KPI_KIND, type CampaignConfig, type KpiSpec, type RewardTier} from "./types";
import {parseAmount, parseCount, isAddress, type CampaignDraft, type EventSourceDraft} from "./validation";
import {AMOUNT_MODE, encodeEventSource, eventTopic, type AmountMode} from "./kpiSource";

/**
 * Converts a validated `CampaignDraft` into the exact tuple arguments
 * `Boney.createCampaign(cfg, kpis, tiers)` expects.
 *
 * Pure and React-free (decision F6) so the encoding is unit-tested without a wallet: this is
 * where a draft's decimal strings become base units and enum labels become the `uint8` indices
 * the contract reads. Both are silent-corruption risks — a reward parsed as `1` instead of
 * `1e18`, or a KPI kind off by one, produces a campaign that deploys successfully and pays the
 * wrong thing.
 *
 * Callers run `validateCampaignDraft` first. This throws on unparseable input rather than
 * coercing, because a draft reaching the encoder with a bad amount is a bug in the caller,
 * not user error to be smoothed over.
 */

export class DraftEncodingError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "DraftEncodingError";
  }
}

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

export type CreateCampaignArgs = readonly [
  CampaignConfig,
  readonly KpiSpec[],
  readonly (readonly RewardTier[])[],
];

/** Maps a KPI kind label to the `uint8` the contract stores. Order is load-bearing. */
export function kpiKindToIndex(kind: KpiSpec["kind"]): number {
  const index = KPI_KIND.indexOf(kind);
  if (index < 0) throw new DraftEncodingError("kpi.kind", `unknown KPI kind "${kind}"`);
  return index;
}

/**
 * Builds `createCampaign` arguments.
 *
 * `project` is passed in rather than read from the draft: `Boney.createCampaign` reverts with
 * `NotProject` unless `cfg.project == msg.sender`, so the connected wallet is the only correct
 * value and letting a form field set it would only create a way to get it wrong.
 */
export function buildCreateCampaignArgs(
  draft: CampaignDraft,
  opts: {project: `0x${string}`; tokenDecimals: number},
): CreateCampaignArgs {
  const {project, tokenDecimals} = opts;

  if (!isAddress(draft.token)) {
    throw new DraftEncodingError("token", "not a valid address");
  }

  const rewardPool = requireAmount(draft.rewardPool, tokenDecimals, "rewardPool");
  const minReputation = draft.minReputation.trim()
    ? requireCount(draft.minReputation, "minReputation")
    : BigInt(0);

  const cfg: CampaignConfig = {
    project,
    token: draft.token as `0x${string}`,
    rewardPool,
    startTime: BigInt(draft.startTime),
    endTime: BigInt(draft.endTime),
    attributionWindow: BigInt(draft.attributionWindow),
    minReputation,
  };

  const kpis: KpiSpec[] = draft.kpis.map((kpi, i) => ({
    kind: kpi.kind,
    verifier: normalizeVerifier(kpi.verifier, `kpis.${i}.verifier`),
    // A target is advisory metadata (the tier ladder is what pays), so an empty box means 0
    // rather than being an error.
    target: kpi.target.trim() ? requireCount(kpi.target, `kpis.${i}.target`) : BigInt(0),
    aggregate: kpi.aggregate,
    params: encodeKpiParams(kpi.eventSource, `kpis.${i}.eventSource`),
  }));

  const tiers = draft.kpis.map((kpi, i) =>
    kpi.tiers.map((tier, j) => ({
      threshold: requireCount(tier.threshold, `kpis.${i}.tiers.${j}.threshold`),
      reward: requireAmount(tier.reward, tokenDecimals, `kpis.${i}.tiers.${j}.reward`),
    })),
  );

  return [cfg, kpis, tiers];
}

/**
 * The tuple `KpiSpec` becomes on the wire — `kind` as its numeric index.
 *
 * viem encodes a struct from an object keyed by field name, and the ABI types `kind` as `uint8`.
 * The app's own `KpiSpec` carries the label, so the conversion happens here at the boundary.
 */
export function toWireKpis(
  kpis: readonly KpiSpec[],
): readonly {
  kind: number;
  verifier: `0x${string}`;
  target: bigint;
  aggregate: boolean;
  params: `0x${string}`;
}[] {
  return kpis.map((k) => ({
    kind: kpiKindToIndex(k.kind),
    verifier: k.verifier,
    target: k.target,
    aggregate: k.aggregate,
    params: k.params,
  }));
}

/**
 * Encodes a KPI's event source into `KpiSpec.params`, or `"0x"` when it has none.
 *
 * An empty `source` is the normal case — every campaign created before event sourcing existed, and
 * every KPI a project intends to report by hand. It encodes to `"0x"`, which `decodeEventSource`
 * reads back as "not event-sourced".
 *
 * The signature is hashed here rather than stored, because `topics[0]` is the hash and carrying
 * the string on chain would cost calldata for something no consumer compares against.
 */
function encodeKpiParams(src: EventSourceDraft | undefined, path: string): `0x${string}` {
  if (!src || !src.source.trim()) return "0x";

  if (!isAddress(src.source.trim())) {
    throw new DraftEncodingError(`${path}.source`, "not a valid address");
  }
  const signature = src.signature.trim();
  if (!signature) {
    throw new DraftEncodingError(`${path}.signature`, "event signature is required");
  }

  const actorTopic = Number(src.actorTopic);
  if (!Number.isInteger(actorTopic) || actorTopic < 1 || actorTopic > 3) {
    throw new DraftEncodingError(`${path}.actorTopic`, `must be 1..3, got "${src.actorTopic}"`);
  }

  const amountMode: AmountMode =
    src.amountMode === "count" ? AMOUNT_MODE.count : AMOUNT_MODE.dataWord0;

  // A blank scale means no scaling, matching how a blank target means 0.
  const scale = src.scale.trim() ? requireCount(src.scale, `${path}.scale`) : BigInt(1);

  return encodeEventSource({
    source: src.source.trim() as `0x${string}`,
    topic0: eventTopic(signature),
    actorTopic: actorTopic as 1 | 2 | 3,
    amountMode,
    scale,
  });
}

function normalizeVerifier(raw: string, path: string): `0x${string}` {
  const value = raw.trim();
  if (!value) return ZERO_ADDRESS;
  if (!isAddress(value)) throw new DraftEncodingError(path, "not a valid address");
  return value as `0x${string}`;
}

function requireAmount(raw: string, decimals: number, path: string): bigint {
  const parsed = parseAmount(raw, decimals);
  if (parsed === null) throw new DraftEncodingError(path, `cannot parse "${raw}" as an amount`);
  return parsed;
}

function requireCount(raw: string, path: string): bigint {
  const parsed = parseCount(raw);
  if (parsed === null) throw new DraftEncodingError(path, `cannot parse "${raw}" as an integer`);
  return parsed;
}

/**
 * Total escrow the campaign needs before `activate()` will succeed.
 *
 * `Campaign.activate` reverts with `NotFunded` unless the vault balance covers `rewardPool` in
 * full, so this is the amount the fund step must reach — not the sum of the tier ladders.
 */
export function requiredFunding(cfg: Pick<CampaignConfig, "rewardPool">): bigint {
  return cfg.rewardPool;
}
