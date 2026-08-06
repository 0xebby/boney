"use client";

import {useQuery} from "@tanstack/react-query";
import {usePublicClient, useAccount} from "wagmi";
import {CampaignAbi} from "@/lib/abis";
import type {CampaignView} from "@/lib/types";
import type {PublicClient} from "viem";

const ZERO_ID = "0x0000000000000000000000000000000000000000000000000000000000000000";

export type JoinedCampaign = {
  view: CampaignView;
  promoterId: `0x${string}`;
};

/**
 * Which of `campaigns` the connected wallet has joined as a promoter.
 *
 * There is no "campaigns I joined" accessor on the facade — membership lives on each `Campaign`
 * as `promoterIdOf(address)` — so this is one read per campaign. That is fine at marketplace
 * scale (the list is already capped by `useCampaigns`'s `limit`) but it is a fan-out, not an
 * index: if the campaign count ever grows past a few hundred this needs an indexer rather than
 * a bigger loop.
 *
 * Reads are pinned to a single block so membership cannot straddle a join landing mid-query and
 * report a campaign as both absent and joined. `cacheTime: 0` for the same reason it is set in
 * `campaignDetail` — viem memoizes `getBlockNumber`, and a refetch right after a join would
 * otherwise be answered from the pre-join block.
 */
export function useJoinedCampaigns(campaigns: readonly CampaignView[]) {
  const client = usePublicClient();
  const {address} = useAccount();

  const query = useQuery({
    queryKey: [
      "joinedCampaigns",
      address,
      client?.chain?.id,
      campaigns.map((c) => c.campaign).join(","),
    ],
    enabled: Boolean(client && address && campaigns.length > 0),
    queryFn: async (): Promise<JoinedCampaign[]> => {
      if (!client || !address) return [];

      const blockNumber = await (client as PublicClient).getBlockNumber({cacheTime: 0});

      const results = await Promise.all(
        campaigns.map(async (view) => {
          try {
            const promoterId = (await (client as PublicClient).readContract({
              address: view.campaign,
              abi: CampaignAbi,
              functionName: "promoterIdOf",
              args: [address],
              blockNumber,
            })) as `0x${string}`;

            return promoterId === ZERO_ID ? null : {view, promoterId};
          } catch {
            // A single unreadable campaign should not blank the whole dashboard — an address
            // that is not a live Campaign (or a node that dropped one call) is not a reason to
            // hide the other memberships.
            return null;
          }
        }),
      );

      return results.filter((r): r is JoinedCampaign => r !== null);
    },
  });

  return {
    joined: query.data ?? [],
    isLoading: query.isLoading,
    isRefreshing: query.isFetching && !query.isLoading,
    error: query.error,
    refetch: query.refetch,
  };
}
