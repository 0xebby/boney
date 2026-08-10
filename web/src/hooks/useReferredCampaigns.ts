"use client";

import {useQuery} from "@tanstack/react-query";
import {usePublicClient, useAccount} from "wagmi";
import type {PublicClient} from "viem";
import {AttributionRegistryAbi, CampaignAbi} from "@/lib/abis";
import {getDeployment} from "@/lib/chains";
import {useBoneyChainId} from "@/hooks/useBoneyChain";
import {ZERO_ID, type ReferredCampaign, type StoredTouch} from "@/lib/referrals";
import type {CampaignView} from "@/lib/types";

/**
 * Which of `campaigns` the connected wallet has been attributed on as a referral.
 *
 * The mirror image of `useJoinedCampaigns`, and deliberately built the same way: a fan-out of point
 * lookups pinned to one block, with per-campaign failures collapsing to `null` so one unreadable
 * campaign cannot blank the table.
 *
 * It reads `touchOf` rather than `activePromoter` even though the latter is the authoritative
 * "is this live" check the indexer uses. `touchOf` returns the whole struct in the same single
 * call, which is what lets the UI distinguish an *expired* attribution from one that never
 * existed — `activePromoter` collapses both to a zero id. Expiry is then a timestamp comparison
 * done client-side in `classifyTouch`, against the same clock the rest of the page uses.
 *
 * Cost is `1 + N` for the touches, plus one `promoterOf` per campaign that actually has one. That
 * second pass is bounded by how many campaigns referred *this* wallet, which is a handful even
 * when the marketplace is not — it is not another full fan-out.
 */
export function useReferredCampaigns(campaigns: readonly CampaignView[]) {
  const client = usePublicClient({chainId: useBoneyChainId()});
  const {address} = useAccount();
  const chainId = client?.chain?.id;
  const registry = getDeployment(chainId)?.attributionRegistry;

  const query = useQuery({
    queryKey: [
      "referredCampaigns",
      address,
      chainId,
      campaigns.map((c) => c.campaign).join(","),
    ],
    enabled: Boolean(client && address && registry) && campaigns.length > 0,
    // Same reasoning as `useJoinedCampaigns`: an attribution changes only when this wallet signs a
    // touch, and that path refetches directly.
    staleTime: 60_000,
    queryFn: async (): Promise<ReferredCampaign[]> => {
      if (!client || !address || !registry) return [];

      // Pinned for the same reason the other fan-outs pin: a touch landing mid-query must not let
      // one campaign report the new attribution while another still reports the old.
      const blockNumber = await (client as PublicClient).getBlockNumber({cacheTime: 0});

      const touched = await Promise.all(
        campaigns.map(async (view) => {
          try {
            const touch = (await (client as PublicClient).readContract({
              address: registry,
              abi: AttributionRegistryAbi,
              functionName: "touchOf",
              args: [view.campaign, address],
              blockNumber,
            })) as StoredTouch;

            // An empty slot decodes to a zeroed struct rather than reverting, so this is the only
            // signal that the wallet was never attributed here.
            return touch.promoterId === ZERO_ID ? null : {view, touch};
          } catch {
            // One unreadable campaign is not a reason to hide the wallet's other attributions.
            return null;
          }
        }),
      );

      const present = touched.filter((t): t is {view: CampaignView; touch: StoredTouch} => t !== null);

      // Second pass: resolve who referred them. Only for campaigns that actually have a touch, and
      // read from the campaign rather than the registry — `promoterId` is minted by `Campaign.join`
      // and only the campaign maps it back to a wallet.
      return Promise.all(
        present.map(async ({view, touch}) => {
          let promoter: `0x${string}` | undefined;
          try {
            promoter = (await (client as PublicClient).readContract({
              address: view.campaign,
              abi: CampaignAbi,
              functionName: "promoterOf",
              args: [touch.promoterId],
              blockNumber,
            })) as `0x${string}`;
          } catch {
            // The attribution is still real without a resolved wallet; the row renders the id.
            promoter = undefined;
          }

          return {
            view,
            promoterId: touch.promoterId,
            promoter,
            signedAt: touch.signedAt,
            expiresAt: touch.expiresAt,
          };
        }),
      );
    },
  });

  return {
    referred: query.data ?? [],
    isLoading: query.isLoading,
    isRefreshing: query.isFetching && !query.isLoading,
    error: query.error,
    refetch: query.refetch,
  };
}
