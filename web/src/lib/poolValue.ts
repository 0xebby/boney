/**
 * Reward pools valued in dollars.
 *
 * Reward pools are escrowed in a dollar-pegged stablecoin, so one whole token unit is one dollar and
 * pools held in different token contracts share a single total. Pure — no React, no chain reads.
 */

import {UNKNOWN_TOKEN, type TokenMeta} from "@/lib/token";
import type {CampaignView} from "@/lib/types";

/** Cents in one whole token unit. */
const CENTS_PER_UNIT = BigInt(100);

/** Dollar totals across a set of campaigns. */
export type PoolValue = {pool: number; paidOut: number};

/**
 * Converts a stablecoin amount from base units to dollars.
 *
 * @param raw Amount in the token's smallest unit.
 * @param decimals The token's decimals.
 * @returns The amount in dollars, truncated to whole cents.
 */
export function toDollars(raw: bigint, decimals: number): number {
  if (decimals < 0) throw new RangeError("decimals must be >= 0");

  const negative = raw < BigInt(0);
  const abs = negative ? -raw : raw;

  // Scaled to cents in bigint before the float conversion, so a pool larger than
  // `Number.MAX_SAFE_INTEGER` in base units still reads exactly.
  const cents = (abs * CENTS_PER_UNIT) / BigInt(10) ** BigInt(decimals);

  return (negative ? -Number(cents) : Number(cents)) / 100;
}

/**
 * Dollar totals for the reward pools and payouts of a set of campaigns.
 *
 * Each campaign is read at its own token's decimals, so a mixed-token list still totals.
 *
 * @param views The campaigns to total.
 * @param tokens Escrow token metadata, keyed by lowercased address.
 * @returns The pool and paid-out totals, in dollars.
 */
export function poolValue(
  views: readonly Pick<CampaignView, "token" | "rewardPool" | "paidOut">[],
  tokens: Record<string, TokenMeta>,
): PoolValue {
  let pool = 0;
  let paidOut = 0;

  for (const view of views) {
    const {decimals} = tokens[view.token.toLowerCase()] ?? UNKNOWN_TOKEN;
    pool += toDollars(view.rewardPool, decimals);
    paidOut += toDollars(view.paidOut, decimals);
  }

  return {pool, paidOut};
}
