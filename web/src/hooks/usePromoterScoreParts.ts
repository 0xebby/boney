"use client";

import {useQuery} from "@tanstack/react-query";
import {usePublicClient} from "wagmi";
import type {PublicClient} from "viem";
import {keccak256, toHex} from "viem";
import {ReputationRegistryAbi} from "@/lib/abis";
import {getDeployment} from "@/lib/chains";
import {useBoneyChainId} from "@/hooks/useBoneyChain";
import {SCHEMA_ETHOS, SCHEMA_REACH, type ScoreParts} from "@/lib/boneyscore";

/** Schema ids are `keccak256(name)`, matching `ReputationRegistry.schemaId`. */
const ETHOS_SCHEMA_ID = keccak256(toHex(SCHEMA_ETHOS));
const REACH_SCHEMA_ID = keccak256(toHex(SCHEMA_REACH));

/**
 * Wallets read per batch. Two `valueOf` calls each, so this is 12 in-flight requests at a time.
 *
 * Not batched through viem's `multicall` for the same reason as `campaignDetail.ts` and
 * `usePromoterReputation`: a stock anvil node has no Multicall3 at the canonical address.
 */
const BATCH_SIZE = 6;

/**
 * Hard cap on how many wallets get a split. Beyond this the table still renders every promoter —
 * it just stops annotating them, and says so.
 *
 * `useCampaignPromoters` already caps its log scan so "a nice-to-have directory cannot hammer a
 * rate-limited endpoint", and this is strictly additional load on the same page: two reads per
 * promoter on top of the scan that found them. A directory that grows to 200 promoters would
 * otherwise silently turn one page view into 400 RPC calls.
 */
export const MAX_SPLIT_WALLETS = 60;

export type ScorePartsIndex = {
  /** Keyed by lowercase address. A missing entry means "not read", never "zero". */
  parts: Map<string, ScoreParts>;
  /** Wallets beyond `MAX_SPLIT_WALLETS`, which were deliberately not read. */
  skipped: number;
};

const EMPTY: ScorePartsIndex = {parts: new Map(), skipped: 0};

/**
 * Live per-schema values for a set of wallets, for the trust/reach split on `/discover`.
 *
 * A wallet is absent from the map when its read failed or was skipped — never present with zeroes.
 * That distinction is the whole point: `valueOf` answers 0 both for a wallet with no attestation
 * and for a schema the registry has never registered, so a zero that arrives from a *failed* read
 * is indistinguishable from a real one. Rendering "0% trust / 100% reach" for a promoter whose read
 * timed out would libel them to exactly the audience this page serves — a project deciding who to
 * fund. Absence lets the row stay silent instead.
 *
 * Batched rather than one query per row. A hook per table row is the idiomatic shape, but it fires
 * every read simultaneously on mount, and this page already runs the most expensive scan in the app
 * before it can even list the wallets.
 *
 * **The values are current; the score beside them is the starting one.** Attestations expire and weights are
 * governable, so a promoter admitted at 19,494 can split differently today having done nothing.
 * The two numbers answer different questions and the UI has to label them as such.
 */
export function usePromoterScoreParts(wallets: readonly `0x${string}`[]) {
  const client = usePublicClient({chainId: useBoneyChainId()});
  const chainId = client?.chain?.id;
  const deployment = getDeployment(chainId);

  // Sorted and deduped so the key is stable across re-renders and re-sorts of the same set: the
  // table reorders on filter changes, which must not invalidate the cache.
  const unique = [...new Set(wallets.map((w) => w.toLowerCase()))].sort();

  const query = useQuery({
    queryKey: ["promoterScoreParts", chainId, unique.join(",")],
    enabled: Boolean(client && deployment) && unique.length > 0,
    staleTime: 60_000,
    queryFn: async (): Promise<ScorePartsIndex> => {
      if (!client || !deployment) return EMPTY;

      const registry = {
        address: deployment.reputationRegistry,
        abi: ReputationRegistryAbi,
      } as const;

      const targets = unique.slice(0, MAX_SPLIT_WALLETS);
      const parts = new Map<string, ScoreParts>();

      const readOne = async (wallet: string): Promise<void> => {
        try {
          const [ethos, reach] = await Promise.all([
            (client as PublicClient).readContract({
              ...registry,
              functionName: "valueOf",
              args: [wallet as `0x${string}`, ETHOS_SCHEMA_ID],
            }),
            (client as PublicClient).readContract({
              ...registry,
              functionName: "valueOf",
              args: [wallet as `0x${string}`, REACH_SCHEMA_ID],
            }),
          ]);
          parts.set(wallet, {ethos: Number(ethos as bigint), reach: Number(reach as bigint)});
        } catch {
          // Leave the wallet out of the map. See the module note: absent means "unknown", and a
          // zeroed entry would be a claim this read is not entitled to make.
        }
      };

      for (let i = 0; i < targets.length; i += BATCH_SIZE) {
        await Promise.all(targets.slice(i, i + BATCH_SIZE).map(readOne));
      }

      return {parts, skipped: Math.max(0, unique.length - targets.length)};
    },
  });

  return {
    parts: query.data?.parts ?? EMPTY.parts,
    skipped: query.data?.skipped ?? 0,
    isLoading: query.isLoading,
    error: query.error,
  };
}
