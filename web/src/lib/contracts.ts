import type {PublicClient} from "viem";
import {getDeployment, ZERO_ADDRESS} from "./chains";
import {BoneyAbi} from "./abis";
import {statusFromIndex, type CampaignView} from "./types";

/**
 * Typed read helpers over the Boney facade.
 *
 * Every function resolves its address from the deployment config and decodes results into the
 * app's domain types, so the UI never handles raw `uint8` enum indices or bare tuples. Reads
 * against an undeployed chain return empty values rather than throwing, letting the UI render a
 * clear "not deployed here" state.
 */

/** Raw tuple shape `campaignView` / `browseCampaigns` return. */
type ViewTuple = {
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
  status: number;
  kpiCount: bigint;
};

function decodeView(raw: ViewTuple): CampaignView {
  return {
    campaignId: raw.campaignId,
    campaign: raw.campaign,
    project: raw.project,
    name: raw.name,
    token: raw.token,
    rewardPool: raw.rewardPool,
    paidOut: raw.paidOut,
    startTime: raw.startTime,
    endTime: raw.endTime,
    minReputation: raw.minReputation,
    status: statusFromIndex(Number(raw.status)),
    kpiCount: raw.kpiCount,
  };
}

/** Resolves the facade address, or undefined when the protocol is not deployed on this chain. */
function boneyAddress(client: PublicClient): `0x${string}` | undefined {
  const d = getDeployment(client.chain?.id);
  if (!d || d.boney === ZERO_ADDRESS) return undefined;
  return d.boney;
}

export function isProtocolDeployed(chainId: number | undefined): boolean {
  const d = getDeployment(chainId);
  return d !== undefined && d.boney !== ZERO_ADDRESS;
}

export async function fetchCampaignCount(client: PublicClient): Promise<bigint> {
  const address = boneyAddress(client);
  if (!address) return BigInt(0);

  return client.readContract({address, abi: BoneyAbi, functionName: "campaignCount"});
}

export async function fetchCampaignView(
  client: PublicClient,
  campaignId: bigint,
): Promise<CampaignView | null> {
  const address = boneyAddress(client);
  if (!address) return null;

  const raw = (await client.readContract({
    address,
    abi: BoneyAbi,
    functionName: "campaignView",
    args: [campaignId],
  })) as unknown as ViewTuple;

  return decodeView(raw);
}

export async function fetchBrowseCampaigns(
  client: PublicClient,
  offset: bigint,
  limit: bigint,
): Promise<CampaignView[]> {
  const address = boneyAddress(client);
  if (!address) return [];

  const raws = (await client.readContract({
    address,
    abi: BoneyAbi,
    functionName: "browseCampaigns",
    args: [offset, limit],
  })) as unknown as readonly ViewTuple[];

  return raws.map(decodeView);
}

export async function fetchReputation(
  client: PublicClient,
  wallet: `0x${string}`,
): Promise<bigint> {
  const address = boneyAddress(client);
  if (!address) return BigInt(0);

  return client.readContract({
    address,
    abi: BoneyAbi,
    functionName: "reputationOf",
    args: [wallet],
  });
}

export async function fetchPromoterProgress(
  client: PublicClient,
  campaignId: bigint,
  promoter: `0x${string}`,
  kpiIndex: bigint,
): Promise<bigint> {
  const address = boneyAddress(client);
  if (!address) return BigInt(0);

  return client.readContract({
    address,
    abi: BoneyAbi,
    functionName: "promoterProgress",
    args: [campaignId, promoter, kpiIndex],
  });
}
