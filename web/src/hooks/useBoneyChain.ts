"use client";

import {useAccount} from "wagmi";
import {DEFAULT_CHAIN_ID} from "@/lib/chains";

/**
 * The chain every read in the app should target.
 *
 * wagmi's bare `usePublicClient()` is not usable here. `createConfig` seeds its store with
 * `chains[0].id` and `getClient` resolves `config.chainId ?? store.getState().chainId`, so a
 * visitor with no wallet silently gets `chains[0]` — `anvil`, a local node they cannot reach. That
 * made the marketplace blank until you connected a wallet, which is the funnel backwards for a
 * public listing.
 *
 * It is not only a disconnected-visitor problem. wagmi rehydrates its persisted state inside a
 * `useEffect` and this app passes no `initialState`, so **every** page load — connected or not —
 * renders at least once with the store still on `chains[0]`. Pinning the client to this value
 * instead means that first render reads the right chain rather than briefly reading anvil and
 * throwing away the result.
 *
 * `isConnected` rather than a raw chain id, because a connected wallet on an unsupported network
 * should keep reporting that network: `isDeployed` then correctly returns false and the page says
 * so, which is more honest than quietly showing it Base Sepolia's campaigns.
 *
 * Returns a plain id, not a client, so callers stay in charge of `usePublicClient` vs
 * `useWalletClient` — writes must go to the wallet's real chain, never to a default.
 */
export function useBoneyChainId(): number {
  const {isConnected, chainId} = useAccount();
  return isConnected && chainId !== undefined ? chainId : DEFAULT_CHAIN_ID;
}
