/**
 * TypeScript mirrors of the protocol's Solidity types.
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
  "GenerateVolume",
  "OnboardAnActiveUser",
  "SignUps",
  "Downloads",
  "Withdraw" ,
  "CreatePool",
  "ProvideLiquidity",
  "RemoveLiquidity",
  "Redeem",
  "Claim",
  "Burn",
  "Repay",
  "Borrow",
  "Lend",
  "Vote",
  "Referral"
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
  GenerateVolume: "Volume generated",
  OnboardAnActiveUser: "Active users",
  SignUps: "Sign-ups",
  Downloads: "Downloads",
  Withdraw: "Withdrawals",
  CreatePool: "CreatePool",
  ProvideLiquidity: "ProvideLiquidity",
  RemoveLiquidity: "RemoveLiquidity",
  Redeem: "Redeem",
  Claim: "Claim",
  Burn: "Burn",
  Repay: "Repay",
  Borrow: "Borrow",
  Lend: "Lend",
  Vote: "Vote",
  Referral: "Referral"
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
