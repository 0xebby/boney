"use client";

import {useQuery} from "@tanstack/react-query";
import {usePublicClient} from "wagmi";
import type {PublicClient} from "viem";
import {CampaignAbi} from "@/lib/abis";
import {useBoneyChainId} from "@/hooks/useBoneyChain";

/**
 * The two on-chain figures a KOL report has to be built from.
 *
 * Both are per-KPI point lookups the campaign detail record does not carry:
 *
 *  - `progressOf(promoter, kpiIndex)` — where the *selected* KOL sits on the ladder. `detail`'s
 *    `PromoterKpiState` is loaded for the connected wallet only, and the project wallet is never
 *    the promoter it is crediting, so that record cannot answer this.
 *  - `userCreditedOf(referral, kpiIndex)` — what each referral already has. `reportUserAction`
 *    takes a *cumulative* total, so a report built without these either reverts `NonMonotonic` or
 *    silently under-credits a referral with prior progress.
 *
 * Plain `readContract` calls under `Promise.all` rather than `multicall`, matching
 * `lib/campaignDetail`: a stock anvil node has no Multicall3 at the canonical address, so batching
 * would break local development for a saving that does not matter at this size.
 */
export function useKolReportState({
  campaign,
  promoter,
  referrals,
  kpiIndex,
  enabled,
}: {
  campaign: `0x${string}` | undefined;
  promoter: `0x${string}` | undefined;
  referrals: readonly `0x${string}`[];
  kpiIndex: number;
  enabled: boolean;
}) {
  const client = usePublicClient({chainId: useBoneyChainId()});
  const chainId = client?.chain?.id;
  const key = referrals.map((r) => r.toLowerCase()).join(",");

  const query = useQuery({
    queryKey: ["kolReportState", chainId, campaign, promoter, kpiIndex, key],
    enabled: enabled && Boolean(client && campaign && promoter),
    queryFn: async () => {
      if (!client || !campaign || !promoter) {
        return {progress: BigInt(0), credited: new Map<string, bigint>()};
      }

      const read = (functionName: "progressOf" | "userCreditedOf", who: `0x${string}`) =>
        (client as PublicClient).readContract({
          address: campaign,
          abi: CampaignAbi,
          functionName,
          args: [who, BigInt(kpiIndex)],
        }) as Promise<bigint>;

      const [progress, ...totals] = await Promise.all([
        read("progressOf", promoter),
        ...referrals.map((r) => read("userCreditedOf", r)),
      ]);

      const credited = new Map<string, bigint>();
      referrals.forEach((r, i) => credited.set(r.toLowerCase(), totals[i] ?? BigInt(0)));

      return {progress, credited};
    },
  });

  return {
    progress: query.data?.progress ?? BigInt(0),
    credited: query.data?.credited ?? EMPTY,
    isLoading: query.isLoading,
    refetch: query.refetch,
  };
}

/** Stable identity so a consumer's `useMemo` does not re-run on every render while loading. */
const EMPTY: ReadonlyMap<string, bigint> = new Map();
