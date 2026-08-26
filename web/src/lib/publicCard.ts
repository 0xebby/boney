import {isAddress} from "viem/utils";
import type {Rank} from "./ranks";
import {shortAddress} from "./format";
import {DEFAULT_CHAIN_ID} from "./chains";

/**
 * The public card at `/b/<wallet>` — everything about it that is a decision rather than a fetch.
 *
 * Pure and React-free, per F6, so the URL rules and the share copy can be pinned by tests. The IO
 * lives in `lib/cardServer.ts` and the rendering in `components/PublicBoneyCard.tsx`.
 *
 * ## The address is the URL. A handle is not.
 *
 * `/b/0x98405c…` and nothing else. This was the plan's first open question and it resolves against
 * handles for a reason that is not about effort:
 *
 *  - `ReputationRegistry` stores no social handles by design, so there is no on-chain map to read.
 *  - **An X handle is re-assignable.** Someone gives up `@alice`, someone else takes it, and every
 *    link ever shared now points at a different person's card. An address cannot change hands.
 *
 * So the address is canonical. A handle can still be *displayed* — `buildScoreReport` returns the one
 * on the Ethos profile — and could later become an alias that redirects to the address form, which is
 * additive and needs no decision now. What must not happen is a handle in the canonical URL.
 *
 * ## The card must survive having nothing to say
 *
 * A valid address with no Ethos profile and no campaigns is a real card, not a 404: level 1, no score,
 * an empty milestone ladder. Only a malformed path is missing. That distinction is what
 * `parseCardWallet` exists to draw.
 */

/**
 * The wallet a `/b/<param>` path refers to, or undefined if the path is not one.
 *
 * Lowercased, because this value becomes a cache key, a subgraph `Bytes` filter and a canonical URL,
 * and a checksummed address would silently match nothing in the third case. `strict: false` so a
 * mixed-case address someone pasted from a block explorer still resolves rather than 404ing on a
 * checksum this page has no reason to enforce.
 *
 * A non-address — `/b/alice` — returns undefined and the page 404s. See the module note.
 */
export function parseCardWallet(param: string | undefined): `0x${string}` | undefined {
  if (!param) return undefined;
  const trimmed = decodeURIComponent(param).trim();
  if (!isAddress(trimmed, {strict: false})) return undefined;
  return trimmed.toLowerCase() as `0x${string}`;
}

/**
 * How to name the card's subject in prose.
 *
 * The handle when Ethos knows one, because `@alice` is what a reader recognises; the shortened address
 * otherwise. Never the bare 42 characters — a sentence with a full address in it is unreadable, and
 * the full value is available to copy from the card head regardless.
 */
export function subjectLabel(wallet: `0x${string}`, handle: string | null | undefined): string {
  return handle ? `@${handle}` : shortAddress(wallet);
}

/**
 * Page title.
 *
 * The rank is included when there is one because it is the part a reader can compare to something —
 * "Legend" means more at a glance than a five-digit score. A card with no score falls back to the
 * subject alone rather than to a zero.
 */
export function cardTitle(input: {
  subject: string;
  rank?: Rank | undefined;
  score?: number | undefined;
}): string {
  if (input.rank && input.score !== undefined) {
    return `${input.subject} — ${input.rank.name}, BoneyScore ${input.score.toLocaleString()}`;
  }
  return `${input.subject} — BoneyCard`;
}

/**
 * Share description.
 *
 * Built from cumulative counts only, and it states what the numbers are: credibility and reach for the
 * score, campaigns and tiers for the history. A share card that implied the BoneyScore measured
 * *delivery* would be advertising the one thing it does not contain.
 *
 * Every clause is omitted rather than zeroed when its number is missing. A description reading
 * "0 campaigns, 0 tiers" for a wallet whose history simply failed to load is a claim about a person
 * that a failed fetch has not earned the right to make — the same rule the card itself follows.
 */
export function cardDescription(input: {
  subject: string;
  level?: number | undefined;
  campaigns?: number | undefined;
  tiers?: number | undefined;
}): string {
  const parts: string[] = [];
  if (input.campaigns !== undefined && input.campaigns > 0) {
    parts.push(`${input.campaigns} ${input.campaigns === 1 ? "campaign" : "campaigns"} promoted`);
  }
  if (input.tiers !== undefined && input.tiers > 0) {
    parts.push(`${input.tiers} reward ${input.tiers === 1 ? "tier" : "tiers"} crossed`);
  }

  const history = parts.length > 0 ? ` ${parts.join(", ")}.` : "";
  const level = input.level !== undefined ? ` Bone level ${input.level}.` : "";
  return `${input.subject}'s promoter card on Boneyard — credibility, reach and verified delivery.${level}${history}`.trim();
}

/** Canonical path for a wallet's card. One place, so a link and an `og:url` cannot disagree. */
export function cardPath(wallet: string): string {
  return `/b/${wallet.toLowerCase()}`;
}

/**
 * The card link for a wallet seen on `chainId`, or undefined when there is no honest one.
 *
 * **A card is per-deployment.** `loadPublicCard` reads `DEFAULT_CHAIN_ID` and the path carries no chain,
 * which is deliberate — merged cross-chain cards are out of scope, and two registries with two mock bUSD
 * tokens exist today. So a promoter row on any *other* chain has no card to point at: following the link
 * would answer a question about Base Sepolia with a row the reader is looking at on anvil, and the
 * numbers would look like a bug in the card rather than a link to the wrong deployment.
 *
 * Undefined rather than a disabled link, so each caller keeps whatever it already showed — the explorer
 * link in `ProjectPromotersPanel`, plain text in `PromoterDirectory`.
 */
export function cardLink(wallet: string, chainId: number | undefined): string | undefined {
  return chainId === DEFAULT_CHAIN_ID ? cardPath(wallet) : undefined;
}
