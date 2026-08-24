import type {CampaignView} from "./types";

/**
 * What a campaign has actually paid each promoter, folded out of `TierSettled` logs.
 *
 * The project owner's view of its own campaign needs a figure the contract does not store: `paidOut`
 * is one campaign-wide total, and `_settledTiers` is a per-promoter *count*. Multiplying that count
 * back through the ladder is wrong in the one case that matters — `Campaign._settle` pays
 * `min(reward, rewardPool - paidOut)` and marks the tier settled regardless, so a promoter whose
 * payout was clipped by an exhausted pool would be reported as fully paid. `TierSettled.paid` is the
 * amount that left the vault, which is the number an owner is reconciling against.
 *
 * Pure, so the folding is tested against fixture logs rather than a chain — the same split
 * `lib/promoters` and `lib/reporting` use for their scans.
 */

/** One `TierSettled`, reduced to what a payout table needs. */
export type SettlementEntry = {
  promoter: `0x${string}`;
  kpiIndex: number;
  tier: number;
  /** Amount actually released — may be below the tier's configured reward. */
  paid: bigint;
  blockNumber: bigint;
};

export type PromoterPayout = {
  /** Lowercased, so it keys a `Map` without checksum surprises. */
  promoter: string;
  paid: bigint;
  /** How many tiers this promoter has been settled for, across every KPI. */
  tiers: number;
  /** Block of the most recent settlement — the "last paid" column. */
  lastBlock: bigint;
};

/**
 * Sums settlements per promoter.
 *
 * Deduplicated on `(promoter, kpiIndex, tier)`: a tier settles exactly once on chain
 * (`_settledTiers` only advances), so a repeat means overlapping scan windows or a reorg replay, and
 * adding it twice would overstate a payout. The first occurrence wins — the scan runs oldest-window
 * first, so that is the earlier block, which is the one that stuck.
 */
export function foldSettlements(entries: readonly SettlementEntry[]): Map<string, PromoterPayout> {
  const seen = new Set<string>();
  const byPromoter = new Map<string, PromoterPayout>();

  for (const entry of entries) {
    const promoter = entry.promoter.toLowerCase();
    const key = `${promoter}:${entry.kpiIndex}:${entry.tier}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const current = byPromoter.get(promoter);
    if (current) {
      current.paid += entry.paid;
      current.tiers += 1;
      if (entry.blockNumber > current.lastBlock) current.lastBlock = entry.blockNumber;
    } else {
      byPromoter.set(promoter, {
        promoter,
        paid: entry.paid,
        tiers: 1,
        lastBlock: entry.blockNumber,
      });
    }
  }

  return byPromoter;
}

/** Total across every promoter — what the table's footer should agree with. */
export function totalPaid(payouts: ReadonlyMap<string, PromoterPayout>): bigint {
  let total = BigInt(0);
  for (const payout of payouts.values()) total += payout.paid;
  return total;
}

/**
 * Whether the scan accounts for everything the campaign says it paid.
 *
 * `Campaign.paidOut` is authoritative and cheap to read; the fold is neither, because a windowed log
 * scan has a floor (see `planWindows`). When the two disagree, settlements happened below that floor
 * and the table is a partial picture — which the UI has to say rather than let an owner reconcile
 * against a total that is quietly short.
 *
 * Returns the shortfall, or 0 when the fold accounts for all of it. Never negative: a fold above
 * `paidOut` would mean double counting, and reporting that as "unaccounted" would be a lie in the
 * other direction — the caller sees 0 and the sum it can check for itself.
 */
export function unaccountedPaid(
  paidOut: bigint,
  payouts: ReadonlyMap<string, PromoterPayout>,
): bigint {
  const folded = totalPaid(payouts);
  return paidOut > folded ? paidOut - folded : BigInt(0);
}

/**
 * One row per promoter, paid-first.
 *
 * Takes the join list as the spine rather than the settlements: a promoter who has earned nothing yet
 * is still a promoter, and an owner asking "who is working on this" needs the zero rows most of all.
 * Ordering puts the earners first, then falls back to seniority so the unpaid tail is stable rather
 * than shuffling between refetches.
 */
export type PromoterRow = {
  promoter: `0x${string}`;
  promoterId: `0x${string}`;
  reputation: bigint;
  joinedBlock: bigint;
  paid: bigint;
  tiers: number;
};

export function buildPromoterRows(
  promoters: readonly {
    promoter: `0x${string}`;
    promoterId: `0x${string}`;
    reputation: bigint;
    blockNumber: bigint;
  }[],
  payouts: ReadonlyMap<string, PromoterPayout>,
): PromoterRow[] {
  return promoters
    .map((entry) => {
      const payout = payouts.get(entry.promoter.toLowerCase());
      return {
        promoter: entry.promoter,
        promoterId: entry.promoterId,
        reputation: entry.reputation,
        joinedBlock: entry.blockNumber,
        paid: payout?.paid ?? BigInt(0),
        tiers: payout?.tiers ?? 0,
      };
    })
    .sort((a, b) => {
      if (a.paid !== b.paid) return a.paid > b.paid ? -1 : 1;
      if (a.joinedBlock !== b.joinedBlock) return a.joinedBlock < b.joinedBlock ? -1 : 1;
      return a.promoter.toLowerCase() < b.promoter.toLowerCase() ? -1 : 1;
    });
}

/**
 * Payouts to wallets that are not in the join list.
 *
 * Should be empty: `_settle` runs only for a joined promoter. It is not, however, impossible to see —
 * the join list is a windowed scan with a floor, so a promoter who joined below it is missing from the
 * spine while their settlements sit above it. Surfacing the count is what stops those payouts from
 * silently vanishing out of the table's total.
 */
export function countOrphanPayouts(
  promoters: readonly {promoter: `0x${string}`}[],
  payouts: ReadonlyMap<string, PromoterPayout>,
): number {
  const known = new Set(promoters.map((p) => p.promoter.toLowerCase()));
  let orphans = 0;
  for (const promoter of payouts.keys()) if (!known.has(promoter)) orphans += 1;
  return orphans;
}

/** Narrow view of what the settlement scan needs from a campaign row. */
export type SettlementTarget = Pick<CampaignView, "campaign">;
