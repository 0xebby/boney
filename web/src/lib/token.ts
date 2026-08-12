import type {CampaignView} from "./types";

/**
 * Escrow token metadata and the rules for when two tokens count as one unit.
 *
 * Pure — no React, no chain reads. The hooks fetch `symbol`/`decimals`; this decides what may
 * be added together afterwards.
 */

/** Token metadata, needed to format escrow amounts correctly. */
export type TokenMeta = {symbol: string; decimals: number};

/**
 * Stand-in for a token whose metadata could not be read. A token without the metadata extension
 * is still valid escrow, so the read falls back here rather than failing the whole list.
 *
 * Shared and read-only: `denominations` compares against it by symbol, so a caller that mutated
 * it would silently change what counts as an unnamed token.
 */
export const UNKNOWN_TOKEN: TokenMeta = Object.freeze({symbol: "???", decimals: 18});

/**
 * The distinct units a set of campaigns is denominated in, in first-appearance order.
 *
 * One entry means every campaign escrows the same unit and their amounts may be summed into a
 * single figure; more than one means a total would be adding unlike things and the caller should
 * say so instead of producing a number.
 *
 * Grouped by symbol *and* decimals rather than by token address, because two contracts are the
 * same unit to a reader if they present as the same unit — the Base Sepolia deployment carries
 * two separate deployments of the same mock bUSD, and refusing to total them told a visitor "2
 * tokens" while every row on screen said bUSD. Decimals are part of the key because they set the
 * scale a raw amount is read at: two contracts sharing a symbol but not a scale cannot be added
 * in base units, whatever they call themselves.
 *
 * A token whose metadata did not resolve keys on its address instead. Two tokens that both failed
 * to name themselves are not evidence of a shared unit, and `UNKNOWN_TOKEN` would otherwise
 * collapse every one of them into a single confident "???" total.
 */
export function denominations(
  views: readonly Pick<CampaignView, "token">[],
  tokens: Record<string, TokenMeta>,
): TokenMeta[] {
  const byUnit = new Map<string, TokenMeta>();

  for (const view of views) {
    const address = view.token.toLowerCase();
    const meta = tokens[address];
    const key =
      meta !== undefined && meta.symbol !== UNKNOWN_TOKEN.symbol
        ? `${meta.symbol}|${meta.decimals}`
        : address;

    // First metadata seen for a unit wins. Entries under a symbol key agree by construction, and
    // an address key only ever has one token behind it, so this is about keeping the returned
    // order stable rather than resolving a conflict.
    if (!byUnit.has(key)) byUnit.set(key, meta ?? UNKNOWN_TOKEN);
  }

  return [...byUnit.values()];
}
