"use client";

import {useAccount} from "wagmi";
import {DEFAULT_CHAIN_ID} from "@/lib/chains";

/**
 * The chain every read in the app should target.
 *
 * Pass it as `usePublicClient({chainId: useBoneyChainId()})`. A bare `usePublicClient()` resolves to
 * `chains[0]` — anvil.
 *
 * @returns The connected wallet's chain id, or `DEFAULT_CHAIN_ID` when there is no wallet.
 */
export function useBoneyChainId(): number {
  const {isConnected, chainId} = useAccount();
  return isConnected && chainId !== undefined ? chainId : DEFAULT_CHAIN_ID;
}
