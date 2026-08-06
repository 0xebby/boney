"use client";

import {useQuery} from "@tanstack/react-query";
import {usePublicClient} from "wagmi";
import type {PublicClient} from "viem";
import {ReputationRegistryAbi} from "@/lib/abis";
import {getDeployment} from "@/lib/chains";

/**
 * A wallet's reputation score, for `Campaign.join`'s `InsufficientReputation` guard.
 *
 * Returns 0 rather than throwing when the registry has never seen the wallet: an unattested
 * wallet genuinely has no score, and that is only disqualifying on campaigns that set a
 * `minReputation` floor — which `canJoin` decides, not this.
 */
export function usePromoterReputation(wallet: `0x${string}` | undefined) {
  const client = usePublicClient();
  const chainId = client?.chain?.id;
  const deployment = getDeployment(chainId);

  const query = useQuery({
    queryKey: ["reputation", chainId, wallet],
    enabled: Boolean(client && wallet && deployment),
    queryFn: async (): Promise<bigint> => {
      if (!client || !wallet || !deployment) return BigInt(0);

      const score = await (client as PublicClient).readContract({
        address: deployment.reputationRegistry,
        abi: ReputationRegistryAbi,
        functionName: "scoreOf",
        args: [wallet],
      });
      return score as bigint;
    },
  });

  return {
    reputation: query.data,
    isLoading: query.isLoading,
    refetch: query.refetch,
  };
}
