"use client";

import {useQuery} from "@tanstack/react-query";
import {usePublicClient} from "wagmi";
import type {PublicClient} from "viem";
import {
  classifyEventSource,
  probeEventSource,
  type ProbeInput,
  type ProbeFinding,
} from "@/lib/kpiSource";
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
 * Findings are `"error"`, `"warn"`, or `"ok"`, ordered worst-first. The chain-free structural checks
 * answer immediately; the reads behind them arrive a debounce later and replace the list.
 *
 * The probe never blocks the form: its findings are *advisory* and a campaign can be created while
 * they are still loading, or even when they report an error. The chain is the only authority on
 * what gets credited; the probe is a second opinion before the gas is spent.
 */
export function useEventSourceProbe(input: ProbeInput) {
  const client = usePublicClient({chainId: useBoneyChainId()});
  const chainId = client?.chain?.id;

  const enabled = Boolean(client) && input.source.trim().length > 0;

  /*
    The chain-free half, computed every render.

    `classifyEventSource` is pure, so there is no reason to make a reader wait a debounce for a
    finding that needed no network — and one of its findings, the count-mode scale warning, is about
    two fields that have nothing to do with the address. Without this the query's `enabled` gate would
    withhold that warning entirely from a form where the contract has not been pasted yet, which is
    exactly the moment it is most useful.
  */
  const structural = classifyEventSource(input);

  const query = useQuery({
    /*
      The mode and scale are in the key, not just the input. They feed a structural finding
      (`classifyEventSource`'s count-mode scale warning) that needs no chain read — but react-query
      only recomputes on a key change, so leaving them out would freeze the warning at whatever the
      mode was when the address last changed.
    */
    queryKey: [
      "eventSourceProbe",
      chainId,
      input.source.trim().toLowerCase(),
      input.signature.trim(),
      input.amountMode,
      input.scale?.trim(),
    ] as const,
    enabled,
    staleTime: PROBE_DEBOUNCE_MS,
    queryFn: async (): Promise<ProbeFinding[]> => {
      if (!client) return [];
      // The chain id is what lets the probe name a known contract — an address means nothing without
      // the chain it was deployed on. Already in the query key, so a network switch re-probes.
      return probeEventSource(client as PublicClient, input, {chainId});
    },
  });

  return {
    /*
      The chain's answer once it lands, the structural findings until then.

      Not a merge: `probeEventSource` already carries the structural advisories through every one of
      its return paths, so unioning the two lists would print the scale warning twice.
    */
    findings: query.data ?? structural,
    isLoading: enabled && (query.isLoading || query.isFetching),
    error: query.error,
  };
}
