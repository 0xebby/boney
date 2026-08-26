/**
 * The stub allowlist's pure half — what an entry is, and what the admin signs to change one.
 *
 * Client-safe on purpose: `AppShell`'s admin panel builds the signing message from here, and the
 * server rebuilds the identical string in `/api/stub-wallets` before verifying. One definition, two
 * callers, no drift. The reading and writing of the list itself lives in `lib/stubWalletStore`, which
 * touches `node:fs` and must not be imported from a component — the same split `lib/campaignGuide`
 * and `lib/guideStore` already use.
 *
 * ## What the list means
 *
 * A wallet on it is scored by `lib/stubProfile` rather than by Ethos, and `/api/attest` then signs
 * those fabricated numbers with the attestor key. That is the whole reason the write is gated: the
 * list is the one lever that turns a made-up score into on-chain reputation.
 */

import {DEV_STUB_WALLET} from "./stubProfile";

export {DEV_STUB_WALLET};

/**
 * Stubbed with no configuration anywhere.
 *
 * Committed rather than left to an env var so the dev wallet works on a deploy with no writable
 * filesystem — the same "committed default, writable overlay" split as `campaignGuide.CATALOG`. The
 * dev wallet is unclaimed on Ethos, so without this entry the fixture cannot be driven at all.
 */
export const DEFAULT_STUB_WALLETS: readonly string[] = [DEV_STUB_WALLET];

export const STUB_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Lowercased address, or undefined when it is not one. Case carries no meaning in an address. */
export function normalizeStubWallet(wallet: string): string | undefined {
  if (typeof wallet !== "string") return undefined;
  const value = wallet.trim().toLowerCase();
  return STUB_ADDRESS_RE.test(value) ? value : undefined;
}

/**
 * The message the admin wallet signs to change the list.
 *
 * Modelled on `canonicalGuideMessage`: every field the server will act on is in the text, so a
 * signature cannot be lifted onto a different action, a different address, or a different chain. The
 * server rebuilds this from its own normalised values rather than trusting the client's string, which
 * is what makes signing one thing and sending another fail rather than succeed quietly.
 *
 * `issuedAt` bounds replay. It is not a nonce and does not need to be: both actions are idempotent, so
 * the worst a replay inside the window achieves is re-applying a change the admin already authorised.
 * A nonce would need server state that survives a read-only deploy, which the store deliberately does
 * not assume.
 */
export function canonicalStubAllowlistMessage(input: {
  action: "add" | "remove";
  wallet: string;
  chainId: number;
  issuedAt: number;
}): string {
  return [
    "Boney dev stub allowlist",
    `action: ${input.action}`,
    `wallet: ${input.wallet.toLowerCase()}`,
    `chain: ${input.chainId}`,
    `issued: ${input.issuedAt}`,
  ].join("\n");
}

/**
 * How long a signature stays usable, in seconds.
 *
 * Long enough for a slow hardware-wallet prompt, short enough that a signature scraped from a log is
 * not a standing permission.
 */
export const STUB_SIGNATURE_TTL_SECONDS = 300;
