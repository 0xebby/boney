/**
 * Chain lookup and RPC selection for server-side reads.
 *
 * Extracted because three route handlers need it — `/api/attest` for a nonce read, `/api/campaign-guide`
 * for `Campaign.project()`, and `/api/stub-wallets` for signature verification — and a fourth copy of
 * the same eight lines was one too many. The endpoints must agree with what the client uses: a server
 * read that hits a different node than the browser can contradict what the user is looking at.
 */

import {anvil, sepolia, baseSepolia, mainnet} from "./chains";

/** viem chain objects by id. */
const CHAINS = [anvil, sepolia, baseSepolia, mainnet];

export const chainFor = (id: number) => CHAINS.find((c) => c.id === id);

/**
 * The endpoint the rest of the app already reads through, per chain — `undefined` to take viem's
 * default for chains that have no override.
 *
 * `http()` with no URL uses the chain's built-in RPC, which for Base Sepolia is `sepolia.base.org`:
 * the endpoint `wagmi.ts` and `.env.local` both deliberately moved off, because it 502s roughly one
 * call in three. A flake on a server-side read is indistinguishable from a genuine negative answer —
 * "no campaign at that address", "that signature is not the admin's" — so the one server read must
 * not be the flaky one.
 */
export function rpcFor(chainId: number): string | undefined {
  if (chainId === baseSepolia.id) {
    return process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC ?? "https://base-sepolia-rpc.publicnode.com";
  }
  if (chainId === anvil.id) return process.env.NEXT_PUBLIC_ANVIL_RPC ?? "http://127.0.0.1:8545";
  if (chainId === sepolia.id) return process.env.NEXT_PUBLIC_SEPOLIA_RPC;
  return process.env.NEXT_PUBLIC_MAINNET_RPC;
}
