"use client";

import {useQuery} from "@tanstack/react-query";
import {usePublicClient} from "wagmi";
import type {PublicClient} from "viem";
import {ReputationRegistryAbi} from "@/lib/abis";
import {getDeployment} from "@/lib/chains";
import {
  SCHEMA_ETHOS,
  SCHEMA_REACH,
  combineFreshness,
  type SchemaFreshness,
} from "@/lib/boneyscore";
import {keccak256, toHex} from "viem";

/**
 * A wallet's reputation score, plus when it goes stale.
 *
 * Returns 0 rather than throwing when the registry has never seen the wallet: an unattested
 * wallet genuinely has no score, and that is only disqualifying on campaigns that set a
 * `minReputation` floor — which `canJoin` decides, not this.
 *
 * Freshness is read alongside the score because `scoreOf` counts only values inside their schema's
 * `maxAge`. A score can therefore fall with no transaction touching the wallet, and the difference
 * between "never verified" and "verified, then expired" is invisible from the number alone — both
 * read 0. The two need different instructions ("verify" vs "re-verify"), so the panel needs to tell
 * them apart.
 *
 * **The freshness reads are optional and must fail independently of the score.** `isValueFresh` and
 * `expiresAtOf` were added to `ReputationRegistry` after the first deployments, so a registry
 * already on chain does not have them and reverts the call. Batching all of it into one
 * `Promise.all` meant those two rejections took down the score read as well — the panel lost the
 * number it actually needs in order to surface a warning that was never going to render anyway.
 * The score is therefore awaited on its own, and freshness degrades to "nothing expires".
 *
 * Reads are not batched through viem's `multicall` for the same reason as `campaignDetail.ts`: a
 * stock anvil node has no Multicall3 at the canonical address.
 */

/** Schema ids are `keccak256(name)`, matching `ReputationRegistry.schemaId`. */
const ETHOS_SCHEMA_ID = keccak256(toHex(SCHEMA_ETHOS));
const REACH_SCHEMA_ID = keccak256(toHex(SCHEMA_REACH));

export type ReputationFreshness = {
  score: bigint;
  /** True when a value was attested but has aged out of its window. */
  hasExpired: boolean;
  /** Earliest expiry across the scoring schemas, or undefined when nothing expires. */
  expiresAt?: number;
  /**
   * False when the registry predates the freshness gate, so the UI can stay silent rather than
   * claiming nothing expires — which is indistinguishable from "everything is fresh".
   */
  freshnessSupported: boolean;
};

export function usePromoterReputation(wallet: `0x${string}` | undefined) {
  const client = usePublicClient();
  const chainId = client?.chain?.id;
  const deployment = getDeployment(chainId);

  const query = useQuery({
    queryKey: ["reputation", chainId, wallet],
    enabled: Boolean(client && wallet && deployment),
    queryFn: async (): Promise<ReputationFreshness> => {
      if (!client || !wallet || !deployment) {
        return {score: BigInt(0), hasExpired: false, freshnessSupported: false};
      }

      const registry = {
        address: deployment.reputationRegistry,
        abi: ReputationRegistryAbi,
      } as const;

      const readFreshness = async (schemaId: `0x${string}`): Promise<SchemaFreshness> => {
        try {
          const [fresh, expiresAt, updatedAt] = await Promise.all([
            (client as PublicClient).readContract({
              ...registry,
              functionName: "isValueFresh",
              args: [wallet, schemaId],
            }),
            (client as PublicClient).readContract({
              ...registry,
              functionName: "expiresAtOf",
              args: [wallet, schemaId],
            }),
            (client as PublicClient).readContract({
              ...registry,
              functionName: "updatedAtOf",
              args: [wallet, schemaId],
            }),
          ]);
          return {
            fresh: fresh as boolean,
            expiresAt: Number(expiresAt as bigint),
            updatedAt: Number(updatedAt as bigint),
          };
        } catch {
          // Registry predates the freshness gate, so it has no opinion on staleness.
          return null;
        }
      };

      // The score is the load-bearing read and is awaited on its own, so a registry that cannot
      // answer the freshness questions still yields a usable number.
      const score = (await (client as PublicClient).readContract({
        ...registry,
        functionName: "scoreOf",
        args: [wallet],
      })) as bigint;

      const [ethos, reach] = await Promise.all([
        readFreshness(ETHOS_SCHEMA_ID),
        readFreshness(REACH_SCHEMA_ID),
      ]);

      return {score, ...combineFreshness([ethos, reach])};
    },
  });

  return {
    reputation: query.data?.score,
    hasExpired: query.data?.hasExpired ?? false,
    expiresAt: query.data?.expiresAt,
    freshnessSupported: query.data?.freshnessSupported ?? false,
    isLoading: query.isLoading,
    refetch: query.refetch,
  };
}
