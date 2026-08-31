/**
 * Escrow token metadata.
 *
 * Pure — no React, no chain reads. The hooks fetch `symbol`/`decimals`; a row formats its own
 * amount with them, and `poolValue` reads them to total pools in dollars.
 */

/** Token metadata, needed to format escrow amounts correctly. */
export type TokenMeta = {symbol: string; decimals: number};

/**
 * Stand-in for a token whose metadata could not be read. A token without the metadata extension
 * is still valid escrow, so the read falls back here rather than failing the whole list.
 *
 * Shared and read-only.
 */
export const UNKNOWN_TOKEN: TokenMeta = Object.freeze({symbol: "???", decimals: 18});

