/**
 * TypeScript mirrors of the protocol's Solidity types.
 *
 * These match `src/libraries/Types.sol` and the `IBoney.CampaignView` struct. Enum ordering is
 * load-bearing — the contract returns a `uint8` index, so these arrays must stay in the same
 * order as the Solidity enums.
 */

/** Mirrors `Types.CampaignStatus`. Order matters. */
export const CAMPAIGN_STATUS = ["Pending", "Active", "Paused", "Ended", "Cancelled"] as const;

export type CampaignStatus = (typeof CAMPAIGN_STATUS)[number];

/** Mirrors `Types.KpiKind`. Order matters. */
export const KPI_KIND = [
  "Custom",
  "Mint",
  "Swap",
  "TokenPurchase",
  "Deposit",
  "Stake",
  "Bridge",
  "Tvl",
  "Volume",
  "ActiveUser",
  "signUps",
  "downloads",
] as const;

export type KpiKind = (typeof KPI_KIND)[number];

/** Human-readable labels for KPI kinds. */
export const KPI_KIND_LABEL: Record<KpiKind, string> = {
  Custom: "Custom",
  Mint: "NFT mints",
  Swap: "Swaps",
  TokenPurchase: "Token purchases",
  Deposit: "Deposits",
  Stake: "Staking",
  Bridge: "Bridge txs",
  Tvl: "TVL generated",
  Volume: "Volume generated",
  ActiveUser: "Active users",
  // Lower-camel because the Solidity enum spells them that way (`Types.KpiKind.signUps`), and this
  // array's job is to mirror it exactly. Renaming here would silently shift every index above 9.
  signUps: "Sign-ups",
  downloads: "Downloads",
};

export function statusFromIndex(index: number): CampaignStatus {
  return CAMPAIGN_STATUS[index] ?? "Pending";
}

export function kpiKindFromIndex(index: number): KpiKind {
  return KPI_KIND[index] ?? "Custom";
}

/** Mirrors `Types.KpiSpec`. */
export type KpiSpec = {
  kind: KpiKind;
  verifier: `0x${string}`;
  target: bigint;
  aggregate: boolean;
  params: `0x${string}`;
};

/** Mirrors `Types.RewardTier`. */
export type RewardTier = {
  threshold: bigint;
  reward: bigint;
};

/** Mirrors `Types.CampaignConfig`. */
export type CampaignConfig = {
  project: `0x${string}`;
  name: string;
  token: `0x${string}`;
  rewardPool: bigint;
  startTime: bigint;
  endTime: bigint;
  attributionWindow: bigint;
  minReputation: bigint;
};

/** Mirrors `IBoney.CampaignView` — the summary row the marketplace table renders. */
export type CampaignView = {
  campaignId: bigint;
  campaign: `0x${string}`;
  project: `0x${string}`;
  name: string;
  token: `0x${string}`;
  rewardPool: bigint;
  paidOut: bigint;
  startTime: bigint;
  endTime: bigint;
  minReputation: bigint;
  status: CampaignStatus;
  kpiCount: bigint;
};

/** Raw shape returned by the contract, before status is mapped to a label. */
export type RawCampaignView = Omit<CampaignView, "status"> & {status: number};

export function toCampaignView(raw: RawCampaignView): CampaignView {
  return {...raw, status: statusFromIndex(raw.status)};
}

/** Shape caps enforced by `Campaign`'s constructor; the create form validates against these. */
export const MAX_KPIS = 32;
export const MAX_TIERS_PER_KPI = 32;
export const MAX_SCHEMAS = 64;

/**
 * `Names.MAX_NAME_BYTES` — longest campaign name the contract accepts.
 *
 * Bytes on chain, characters here: `Names` rejects every byte outside printable ASCII, so the two
 * counts are the same and a character counter in the form cannot promise a name the chain refuses.
 * That restriction is also why a name cannot contain emoji or accented letters — see
 * `src/libraries/Names.sol` for why folding Unicode on chain was not worth the impersonation risk.
 */
export const MAX_CAMPAIGN_NAME_LENGTH = 32;

/**
 * `Campaign.CLAIM_GRACE` — seconds after a campaign ends before the project may reclaim.
 *
 * [bscoretest] Mirrors the shortened on-chain constant (was `7 * 24 * 60 * 60`). This is only a
 * fallback for code paths with no live read; `fetchCampaignDetail` reads `CLAIM_GRACE()` from the
 * contract, so a stale value here does not affect the campaign detail page. Restore with the
 * contract before any release/merge to main.
 */
export const CLAIM_GRACE_SECONDS = 20 * 60;
