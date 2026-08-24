import type {PublicClient} from "viem";
import {CampaignAbi, EscrowVaultAbi} from "./abis";
import {kpiKindFromIndex, statusFromIndex, type KpiSpec, type RewardTier} from "./types";

/**
 * Detail reads for a single campaign.
 *
 * The `Boney` facade only exposes summary rows (`campaignView` / `browseCampaigns`) — it has no
 * KPI or tier accessors. So the detail view talks to the `Campaign` contract directly, which is
 * the only place `kpi(i)`, `tiers(i)`, `endedAt()`, and `remainingPool()` live.
 *
 * Reads are issued in parallel and **pinned to one block**, not batched through viem's
 * `multicall`. Two reasons, in order of importance:
 *
 *  1. `multicall` requires a Multicall3 deployment at the canonical address. A stock anvil node
 *     has no such contract, so every detail read threw `ChainDoesNotSupportContract` against a
 *     live local chain — a failure no mock could have surfaced.
 *  2. Pinning `blockNumber` makes the record internally consistent. Un-pinned parallel reads can
 *     straddle a block and produce a `paidOut` that disagrees with `remainingPool`.
 *
 * The parallel calls are still one HTTP round trip when the transport has request batching on.
 */

/** One KPI with its reward ladder and aggregate progress. */
export type KpiDetail = {
  index: number;
  spec: KpiSpec;
  tiers: RewardTier[];
  /** Sum of every promoter's credited progress for this KPI. */
  totalProgress: bigint;
};

/** Everything the detail page renders that a summary row does not carry. */
export type CampaignDetail = {
  address: `0x${string}`;
  project: `0x${string}`;
  /** The campaign's display name, unique across the registry that created it. */
  name: string;
  token: `0x${string}`;
  rewardPool: bigint;
  paidOut: bigint;
  remainingPool: bigint;
  /**
   * Tokens the escrow vault actually holds for this campaign.
   *
   * Distinct from `remainingPool` (`rewardPool - paidOut`): that is accounting, this is custody.
   * They diverge on an unfunded campaign, and the contract's `NotFunded` / `NothingToReclaim`
   * guards both check this one.
   */
  escrowBalance: bigint;
  startTime: bigint;
  endTime: bigint;
  /** When `end()`/`cancel()` was actually called; 0 while the campaign is still open. */
  endedAt: bigint;
  attributionWindow: bigint;
  minReputation: bigint;
  status: ReturnType<typeof statusFromIndex>;
  claimGrace: bigint;
  kpis: KpiDetail[];
  /** The block every field above was read at. */
  blockNumber: bigint;
};

/** Per-promoter state for one KPI, for the "your progress" panel. */
export type PromoterKpiState = {
  kpiIndex: number;
  progress: bigint;
  /** Count of the next unsettled tier — see `unsettledRewards`. */
  settledTiers: number;
};

export type PromoterState = {
  joined: boolean;
  promoterId: `0x${string}`;
  perKpi: PromoterKpiState[];
};

const ZERO_ID = "0x0000000000000000000000000000000000000000000000000000000000000000";

/**
 * The block to pin a record to.
 *
 * `cacheTime: 0` is load-bearing, not a tuning knob. viem memoizes `getBlockNumber` for
 * `cacheTime` ms (default: the 4s polling interval), so a refetch issued right after a write
 * gets handed the *pre-write* block number and every pinned read below it returns pre-write
 * state. That is invisible in a mock — a fake client's `getBlockNumber` has no cache — and it
 * presented as "funding succeeds on chain but the panel never notices", with `activate` staying
 * disabled behind a stale `NotFunded`.
 *
 * Bypassing the cache keeps the block *pinning* (reads still share one block, so the record
 * cannot straddle) while guaranteeing the block is current.
 */
function currentBlock(client: PublicClient): Promise<bigint> {
  return client.getBlockNumber({cacheTime: 0});
}

/** Reads one `Campaign` view function, pinned to a block when one is given. */
function read<T>(
  client: PublicClient,
  address: `0x${string}`,
  blockNumber: bigint | undefined,
  functionName: string,
  args?: readonly unknown[],
): Promise<T> {
  return client.readContract({
    address,
    abi: CampaignAbi,
    // The ABI is generated from the Foundry artifact, so an unknown name fails here rather
    // than silently decoding to undefined.
    functionName: functionName as never,
    args: args as never,
    blockNumber,
  }) as Promise<T>;
}

/**
 * Loads the full detail record for a campaign address.
 *
 * Two stages: the scalar config first (which yields `kpiCount`), then the per-KPI reads. Both
 * stages pin the same block, so the KPI ladders belong to the same state as the header numbers.
 */
export async function fetchCampaignDetail(
  client: PublicClient,
  address: `0x${string}`,
  atBlock?: bigint,
): Promise<CampaignDetail> {
  const blockNumber = atBlock ?? (await currentBlock(client));
  const at = <T>(fn: string, args?: readonly unknown[]) =>
    read<T>(client, address, blockNumber, fn, args);

  const [
    project,
    name,
    token,
    rewardPool,
    paidOut,
    remainingPool,
    startTime,
    endTime,
    endedAt,
    attributionWindow,
    minReputation,
    status,
    claimGrace,
    kpiCount,
    escrowVault,
  ] = await Promise.all([
    at<`0x${string}`>("project"),
    at<string>("name"),
    at<`0x${string}`>("token"),
    at<bigint>("rewardPool"),
    at<bigint>("paidOut"),
    at<bigint>("remainingPool"),
    at<bigint>("startTime"),
    at<bigint>("endTime"),
    at<bigint>("endedAt"),
    at<bigint>("attributionWindow"),
    at<bigint>("minReputation"),
    at<number>("status"),
    at<bigint>("CLAIM_GRACE"),
    at<bigint>("kpiCount"),
    at<`0x${string}`>("escrowVault"),
  ]);

  // Escrow balance is what `activate` (NotFunded) and `reclaimUnspent` (NothingToReclaim)
  // actually check — it is not derivable from `remainingPool`, which is the accounting figure
  // `rewardPool - paidOut` and stays at the full pool on a campaign that was never funded.
  // Read from the vault the campaign itself names, at the same pinned block.
  const escrowBalance = await client.readContract({
    address: escrowVault,
    abi: EscrowVaultAbi,
    functionName: "balanceOf",
    args: [address],
    blockNumber,
  });

  const kpis = await fetchKpis(client, address, Number(kpiCount), blockNumber);

  return {
    address,
    project,
    name,
    token,
    rewardPool,
    paidOut,
    remainingPool,
    escrowBalance: escrowBalance as bigint,
    startTime: BigInt(startTime),
    endTime: BigInt(endTime),
    endedAt: BigInt(endedAt),
    attributionWindow: BigInt(attributionWindow),
    minReputation,
    status: statusFromIndex(Number(status)),
    claimGrace: BigInt(claimGrace),
    kpis,
    blockNumber,
  };
}

/** Reads `kpi(i)`, `tiers(i)`, and `totalProgress(i)` for every index, all at the same block. */
async function fetchKpis(
  client: PublicClient,
  address: `0x${string}`,
  count: number,
  blockNumber: bigint,
): Promise<KpiDetail[]> {
  if (count <= 0) return [];

  const indices = Array.from({length: count}, (_, i) => i);

  return Promise.all(
    indices.map(async (i) => {
      const [spec, ladder, totalProgress] = await Promise.all([
        readKpiSpec(client, address, i, blockNumber),
        read<readonly {threshold: bigint; reward: bigint}[]>(client, address, blockNumber, "tiers", [
          BigInt(i),
        ]),
        read<bigint>(client, address, blockNumber, "totalProgress", [BigInt(i)]),
      ]);

      return {
        index: i,
        spec,
        tiers: ladder.map((t) => ({threshold: t.threshold, reward: t.reward})),
        totalProgress,
      };
    }),
  );
}

/**
 * Reads and decodes one `kpi(i)` — the single `kpi(i)` call site.
 *
 * Shared so the enum index is mapped to a label in exactly one place. `kind` arrives as a `uint8`,
 * and a second decode site is a second chance for the mapping to drift from `Types.KpiKind`.
 */
async function readKpiSpec(
  client: PublicClient,
  address: `0x${string}`,
  index: number,
  blockNumber?: bigint,
): Promise<KpiSpec> {
  const raw = await read<{
    kind: number;
    verifier: `0x${string}`;
    target: bigint;
    aggregate: boolean;
    params: `0x${string}`;
  }>(client, address, blockNumber, "kpi", [BigInt(index)]);

  return {
    kind: kpiKindFromIndex(Number(raw.kind)),
    verifier: raw.verifier,
    target: raw.target,
    aggregate: raw.aggregate,
    params: raw.params,
  };
}

/**
 * Just the KPI specs for a campaign — no ladders, no progress.
 *
 * For the marketplace list, which wants to say *what* each campaign measures without paying for the
 * three reads per KPI the detail page needs. Left unpinned by default: a `KpiSpec` is written in
 * `Campaign`'s constructor and has no setter, so there is no state here that a straddled block could
 * make inconsistent — which is also why the caller can cache it forever.
 */
export function fetchKpiSpecs(
  client: PublicClient,
  address: `0x${string}`,
  count: number,
  atBlock?: bigint,
): Promise<KpiSpec[]> {
  if (count <= 0) return Promise.resolve([]);

  return Promise.all(
    Array.from({length: count}, (_, i) => readKpiSpec(client, address, i, atBlock)),
  );
}

/**
 * Loads one promoter's progress and settlement counters across every KPI.
 *
 * Returns `joined: false` when the wallet has no promoter id — the campaign's `progressOf` would
 * read zero either way, but "not joined" and "joined with no progress" are different UI states.
 */
export async function fetchPromoterState(
  client: PublicClient,
  address: `0x${string}`,
  promoter: `0x${string}`,
  kpiCount: number,
  atBlock?: bigint,
): Promise<PromoterState> {
  const blockNumber = atBlock ?? (await currentBlock(client));

  const promoterId = await read<`0x${string}`>(
    client,
    address,
    blockNumber,
    "promoterIdOf",
    [promoter],
  );

  const joined = promoterId !== ZERO_ID;
  if (!joined || kpiCount <= 0) {
    return {joined, promoterId, perKpi: []};
  }

  const indices = Array.from({length: kpiCount}, (_, i) => i);

  const perKpi = await Promise.all(
    indices.map(async (i) => {
      const [progress, settledTiers] = await Promise.all([
        read<bigint>(client, address, blockNumber, "progressOf", [promoter, BigInt(i)]),
        read<bigint>(client, address, blockNumber, "settledTiersOf", [promoter, BigInt(i)]),
      ]);
      return {kpiIndex: i, progress, settledTiers: Number(settledTiers)};
    }),
  );

  return {joined, promoterId, perKpi};
}
