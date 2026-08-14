"use client";

import {useEffect, useState} from "react";
import {useQuery} from "@tanstack/react-query";
import {usePublicClient} from "wagmi";
import type {PublicClient} from "viem";
import {CampaignRegistryAbi} from "@/lib/abis";
import {getDeployment, ZERO_ADDRESS} from "@/lib/chains";
import {useBoneyChainId} from "@/hooks/useBoneyChain";
import {isPrintableAscii} from "@/lib/validation";
import {MAX_CAMPAIGN_NAME_LENGTH} from "@/lib/types";

/**
 * Asks the registry whether a campaign name is still free.
 *
 * The check has to happen on chain because the registry compares *normalized* names — it trims,
 * collapses inner spaces and folds case before hashing (`src/libraries/Names.sol`). Reimplementing
 * that here to compare against a locally cached list would be a second source of truth for what
 * "the same name" means, and the failure mode is the worst kind: a form that says a name is free and
 * then reverts `NameTaken` after the user has approved a transaction.
 *
 * `isNameAvailable` answers `false` for a malformed name rather than reverting, so this hook does not
 * need to distinguish "taken" from "unusable" — the form's own length and charset checks produce the
 * specific message. It skips the call entirely for input that cannot pass those checks, which keeps
 * an RPC round trip off every keystroke of a name that is too long anyway.
 */

export type NameAvailability = {
  /** Nothing worth asking about yet — empty, too long, or not printable ASCII. */
  isIdle: boolean;
  isLoading: boolean;
  /** True only when the registry has confirmed the name is claimed. */
  isTaken: boolean;
  /** The registry could not be reached; treated as "not taken" so the chain stays the decider. */
  isUnavailable: boolean;
};

/** Keystrokes settle for this long before a read goes out. */
const DEBOUNCE_MS = 350;

export function useNameAvailability(name: string): NameAvailability {
  const chainId = useBoneyChainId();
  const client = usePublicClient({chainId});
  const registry = getDeployment(chainId)?.campaignRegistry;

  const trimmed = name.trim();
  const worthAsking =
    trimmed.length > 0 && name.length <= MAX_CAMPAIGN_NAME_LENGTH && isPrintableAscii(name);

  // Debounced separately from the query key so react-query is not handed a new key per keystroke.
  const [settled, setSettled] = useState(trimmed);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(trimmed), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [trimmed]);

  const enabled =
    Boolean(client) && Boolean(registry) && registry !== ZERO_ADDRESS && worthAsking && settled === trimmed;

  const query = useQuery({
    // Keyed on the raw settled string: the contract normalizes, so "Aave" and "aave" share an
    // answer, but caching them separately is merely redundant rather than wrong.
    queryKey: ["nameAvailable", chainId, settled],
    enabled,
    retry: false,
    // A name can be claimed by someone else mid-session, so this is not cached indefinitely the way
    // token metadata is — but it is also re-read at submit time by the contract itself, which is the
    // only check that decides anything.
    staleTime: 15_000,
    queryFn: async (): Promise<boolean> => {
      const c = client as PublicClient;
      return (await c.readContract({
        address: registry as `0x${string}`,
        abi: CampaignRegistryAbi,
        functionName: "isNameAvailable",
        args: [settled],
      })) as boolean;
    },
  });

  return {
    isIdle: !worthAsking,
    isLoading: enabled && query.isLoading,
    // `isNameAvailable` returning false is what "taken" means here; a failed read is not.
    isTaken: query.data === false,
    isUnavailable: enabled && query.isError,
  };
}
