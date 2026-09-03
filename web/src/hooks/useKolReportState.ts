"use client";

import {useQuery} from "@tanstack/react-query";
import {usePublicClient} from "wagmi";
import type {PublicClient} from "viem";
import {CampaignAbi, EventMetricKpiVerifierAbi} from "@/lib/abis";
import {getDeployment} from "@/lib/chains";
import {useBoneyChainId} from "@/hooks/useBoneyChain";

/**
 * The on-chain figures a KOL report has to be built from.
 *
 * Per-KPI point lookups the campaign detail record does not carry:
 *
 *  - `progressOf(promoter, kpiIndex)` — where the *selected* KOL sits on the ladder. `detail`'s
 *    `PromoterKpiState` is loaded for the connected wallet only, and the project wallet is never
 *    the promoter it is crediting, so that record cannot answer this.
 *  - `userCreditedOf(referral, kpiIndex)` — what each referral already has. `reportUserAction`
 *    takes a *cumulative* total, so a report built without these either reverts `NonMonotonic` or
 *    silently under-credits a referral with prior progress.
 *  - `creditedToOf(referral, kpiIndex, promoterId)` — what the *selected* KOL already has for that
 *    referral. The cumulative total above spans every promoter who ever held the referral, so it says
 *    what the report may claim but not what this KOL gains from it; only this figure does. Without it
 *    a re-touched referral's panel credits the previous spell's work to whoever holds it now.
 *  - `observedProgressOf(campaign, kpiIndex, referral)` on Boney's `EventMetricKpiVerifier` — the
 *    **ceiling** a claim is trimmed to. Read here rather than in its own hook because it is one of the
 *    figures a report is built from, and splitting it out would give the panel a second loading state
 *    for one extra `readContract`.
 *
 * The ceiling is the one that changes what a project sees before clicking. A gated KPI credits
 * `min(claim, ceiling)`, and a report that lands before the relayer has scanned *succeeds and credits
 * nothing* — no revert, nothing to catch. See `describeCeiling` for why that shape of failure is worth
 * a dedicated read.
 *
 * Plain `readContract` calls under `Promise.all` rather than `multicall`, matching
 * `lib/campaignDetail`: a stock anvil node has no Multicall3 at the canonical address, so batching
 * would break local development for a saving that does not matter at this size.
 */
export function useKolReportState({
  campaign,
  promoter,
  promoterId,
  referrals,
  kpiIndex,
  kpiVerifier,
  enabled,
}: {
  campaign: `0x${string}` | undefined;
  promoter: `0x${string}` | undefined;
  /** The selected KOL's campaign-bound id, which `creditedToOf` is keyed by. */
  promoterId: `0x${string}` | undefined;
  referrals: readonly `0x${string}`[];
  kpiIndex: number;
  /** `KpiSpec.verifier`, so the hook can tell whether Boney's ceiling actually applies. */
  kpiVerifier: `0x${string}` | undefined;
  enabled: boolean;
}) {
  const client = usePublicClient({chainId: useBoneyChainId()});
  const chainId = client?.chain?.id;
  const deployment = getDeployment(chainId);
  const verifier = deployment?.eventMetricKpiVerifier;
  const key = referrals.map((r) => r.toLowerCase()).join(",");

  /**
   * Whether this KPI is capped by Boney's verifier specifically.
   *
   * Matched against the deployed `GuardedKpiVerifier` rather than just "non-zero", because
   * `observedProgressOf` is only the binding ceiling when the KPI actually routes through the guard
   * that consults Boney. A KPI pointing at some other verifier is still capped, but by a number this
   * hook cannot see — and showing Boney's figure for it would be confidently wrong. Unknown verifiers
   * therefore read as ungated, so the panel stays quiet instead of misreporting.
   */
  const gated = Boolean(
    kpiVerifier &&
      deployment?.guardedKpiVerifier &&
      kpiVerifier.toLowerCase() === deployment.guardedKpiVerifier.toLowerCase(),
  );

  const query = useQuery({
    queryKey: [
      "kolReportState",
      chainId,
      campaign,
      promoter,
      promoterId,
      kpiIndex,
      key,
      verifier,
      gated,
    ],
    enabled: enabled && Boolean(client && campaign && promoter && promoterId),
    queryFn: async () => {
      if (!client || !campaign || !promoter || !promoterId) {
        return {
          progress: BigInt(0),
          credited: EMPTY,
          creditedTo: EMPTY,
          ceiling: BigInt(0),
          configured: false,
        };
      }

      const read = (functionName: "progressOf" | "userCreditedOf", who: `0x${string}`) =>
        (client as PublicClient).readContract({
          address: campaign,
          abi: CampaignAbi,
          functionName,
          args: [who, BigInt(kpiIndex)],
        }) as Promise<bigint>;

      const readHeld = (who: `0x${string}`) =>
        (client as PublicClient).readContract({
          address: campaign,
          abi: CampaignAbi,
          functionName: "creditedToOf",
          args: [who, BigInt(kpiIndex), promoterId],
        }) as Promise<bigint>;

      const [progress, ...figures] = await Promise.all([
        read("progressOf", promoter),
        ...referrals.map((r) => read("userCreditedOf", r)),
        ...referrals.map((r) => readHeld(r)),
      ]);

      const credited = new Map<string, bigint>();
      const creditedTo = new Map<string, bigint>();
      referrals.forEach((r, i) => {
        credited.set(r.toLowerCase(), figures[i] ?? BigInt(0));
        creditedTo.set(r.toLowerCase(), figures[referrals.length + i] ?? BigInt(0));
      });

      // A chain with no deployed verifier, or a KPI Boney does not gate, has no ceiling to report.
      // Skipped entirely rather than read and discarded — that is one round trip per referral.
      if (!verifier || !gated) {
        return {progress, credited, creditedTo, ceiling: BigInt(0), configured: false};
      }

      // `observedProgressOf` does not revert on an unconfigured KPI — it divides by `_effectiveScale`,
      // which reads an unset scale as 1, so it returns 0. That makes "never configured" and "nothing
      // observed yet" indistinguishable from the total alone, which is why `configured` is read too.
      const [config, ...observed] = await Promise.all([
        (client as PublicClient).readContract({
          address: verifier,
          abi: EventMetricKpiVerifierAbi,
          functionName: "configOf",
          args: [campaign, BigInt(kpiIndex)],
        }) as Promise<{configured: boolean}>,
        ...referrals.map(
          (r) =>
            (client as PublicClient).readContract({
              address: verifier,
              abi: EventMetricKpiVerifierAbi,
              functionName: "observedProgressOf",
              args: [campaign, BigInt(kpiIndex), r],
            }) as Promise<bigint>,
        ),
      ]);

      return {
        progress,
        credited,
        creditedTo,
        ceiling: observed.reduce((sum, v) => sum + v, BigInt(0)),
        configured: config.configured,
      };
    },
  });

  return {
    progress: query.data?.progress ?? BigInt(0),
    credited: query.data?.credited ?? EMPTY,
    /** What the selected KOL already holds for each referral — `creditedToOf`, keyed lowercase. */
    creditedTo: query.data?.creditedTo ?? EMPTY,
    /** Sum of `observedProgressOf` across the live referrals — what a claim is trimmed to. */
    ceiling: query.data?.ceiling ?? BigInt(0),
    /** Whether Boney's verifier has a config for this KPI at all. */
    configured: query.data?.configured ?? false,
    /** Whether Boney's ceiling applies to this KPI. False means the readout should stay quiet. */
    gated,
    isLoading: query.isLoading,
    refetch: query.refetch,
  };
}

/** Stable identity so a consumer's `useMemo` does not re-run on every render while loading. */
const EMPTY: ReadonlyMap<string, bigint> = new Map();
