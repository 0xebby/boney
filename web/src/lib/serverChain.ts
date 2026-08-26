/**
 * Chain lookup for server-side reads.
 *
 * Extracted because four server readers need it — `/api/attest` for a nonce read, `/api/campaign-guide`
 * for `Campaign.project()`, `/api/stub-wallets` for signature verification, and `lib/cardServer.ts` for
 * the public card's block times and token metadata — and a copy of the same eight lines in each was one
 * too many. The endpoints must agree with what the client uses: a server read that hits a different node
 * than the browser can contradict what the user is looking at.
 *
 * The URL selection itself now lives in `chains.rpcUrlFor`, which `wagmi.ts` reads too, so the browser
 * and every server reader resolve one endpoint from one place.
 */

import {anvil, sepolia, baseSepolia, mainnet, rpcUrlFor} from "./chains";

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
export const rpcFor = rpcUrlFor;
