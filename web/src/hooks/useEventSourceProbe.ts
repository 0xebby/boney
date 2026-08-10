"use client";

import {useQuery} from "@tanstack/react-query";
import {usePublicClient} from "wagmi";
import type {PublicClient} from "viem";
import {probeEventSource, type ProbeInput, type ProbeFinding} from "@/lib/kpiSource";
import {useBoneyChainId} from "@/hooks/useBoneyChain";

/**
 * Debounce interval for the probe, matching the form's keystroke pace.
 *
 * The probe fires `getCode` and `getLogs` — round trips to a rate-limited public endpoint. Without a
 * debounce, every keystroke in the source field would fire both, and the last one would beat back a
 * dozen already in flight. This holds the query until the input has been stable for this long.
 */
const PROBE_DEBOUNCE_MS = 600;

/**
 * Asks the chain whether the named contract could serve as a KPI event source.
 *
 * Returns `[]` while the probe is pending or when the input is empty, so the form renders a loading
 * needle and an unconfigured KPI identically — both are "nothing to say yet". Findings are
 * `"error"`, `"warn"`, or `"ok"`, ordered worst-first.
 *
 * The probe never blocks the form: its findings are *advisory* and a campaign can be created while
 * they are still loading, or even when they report an error. The chain is the only authority on
 * what gets credited; the probe is a second opinion before the gas is spent.
 */
export function useEventSourceProbe(input: ProbeInput) {
  const client = usePublicClient({chainId: useBoneyChainId()});
  const chainId = client?.chain?.id;

  const enabled = Boolean(client) && input.source.trim().length > 0;

  const query = useQuery({
    queryKey: ["eventSourceProbe", chainId, input.source.trim().toLowerCase(), input.signature.trim()] as const,
    enabled,
    staleTime: PROBE_DEBOUNCE_MS,
    queryFn: async (): Promise<ProbeFinding[]> => {
      if (!client) return [];
      return probeEventSource(client as PublicClient, input);
    },
  });

  return {
    findings: query.data ?? [],
    isLoading: enabled && (query.isLoading || query.isFetching),
    error: query.error,
  };
}
