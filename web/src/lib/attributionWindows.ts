import type {Hex} from "viem";

/**
 * Who held a referral at the moment of each action, mirrored off chain.
 *
 * `AttributionRegistry` keeps every superseded touch, and `Campaign.reportUserAction` asks it who
 * held a user at each evidence action's block. The relayer's ceiling and the indexer's claim have to
 * measure the same activity as that walk, so both build their view of attribution here rather than
 * reading the live touch.
 */

/** One `TouchStored` log, reduced to what attribution depends on. */
export type TouchLog = {
  user: `0x${string}`;
  promoterId: Hex;
  signedAt: bigint;
  expiresAt: bigint;
  /** Block the touch was stored in, i.e. `TouchRecord.storedAtBlock`. */
  blockNumber: bigint;
};

/** One spell during which a single promoter held a referral. */
export type AttributionWindow = {
  /** Block the touch landed in. It covers actions strictly after this block. */
  fromBlock: bigint;
  /** Timestamp the touch lapses at, exclusive. */
  expiresAt: bigint;
  promoterId: Hex;
};

/** Per-referral windows, keyed by lowercased address and ordered oldest first. */
export type AttributionWindows = ReadonlyMap<string, AttributionWindow[]>;

/** Attribution as the chain would resolve it, for one campaign. */
export type AttributionLookup = {
  /**
   * The promoter holding `user` at that action, or null when nobody was.
   *
   * @param user Referral that performed the action.
   * @param blockNumber Block the action landed in.
   * @param timestamp Timestamp of that block.
   * @returns The promoter id, or null.
   */
  at(user: `0x${string}`, blockNumber: bigint, timestamp: bigint): Hex | null;
  /**
   * Whether this referral was ever attributed on the campaign.
   *
   * @param user Referral to look up.
   * @returns True when at least one touch was stored for them.
   */
  known(user: `0x${string}`): boolean;
};

/**
 * Groups `TouchStored` logs into per-referral attribution windows.
 *
 * @param touches Touch logs for one campaign, in any order.
 * @returns Windows per lowercased referral address, oldest first.
 */
export function buildAttributionWindows(
  touches: readonly TouchLog[],
): Map<string, AttributionWindow[]> {
  const out = new Map<string, AttributionWindow[]>();

  for (const touch of touches) {
    const key = touch.user.toLowerCase();
    const list = out.get(key) ?? [];
    list.push({
      fromBlock: touch.blockNumber,
      expiresAt: touch.expiresAt,
      promoterId: touch.promoterId,
    });
    out.set(key, list);
  }

  for (const list of out.values()) {
    list.sort((a, b) => (a.fromBlock === b.fromBlock ? 0 : a.fromBlock < b.fromBlock ? -1 : 1));
  }

  return out;
}

/**
 * Folds `extra` windows into `base`, keeping every distinct spell from both.
 *
 * A window `base` already carries — same touch block and promoter for the same referral — is not
 * repeated.
 *
 * @param base Windows from the primary source.
 * @param extra Windows to add wherever `base` does not already carry them.
 * @returns A new map holding both sets, per referral oldest first.
 */
export function mergeAttributionWindows(
  base: AttributionWindows,
  extra: AttributionWindows,
): Map<string, AttributionWindow[]> {
  const out = new Map<string, AttributionWindow[]>();
  for (const [key, list] of base) out.set(key, list.slice());

  for (const [key, list] of extra) {
    const merged = out.get(key) ?? [];
    const seen = new Set(merged.map((w) => `${w.fromBlock}:${w.promoterId.toLowerCase()}`));

    for (const window of list) {
      const id = `${window.fromBlock}:${window.promoterId.toLowerCase()}`;
      if (seen.has(id)) continue;
      seen.add(id);
      merged.push(window);
    }

    out.set(key, merged);
  }

  for (const list of out.values()) {
    list.sort((a, b) => (a.fromBlock === b.fromBlock ? 0 : a.fromBlock < b.fromBlock ? -1 : 1));
  }

  return out;
}

/**
 * Lowest block whose activity any of these windows can credit.
 *
 * A window covers actions strictly after the block its touch landed in, so nothing at or before the
 * campaign's first touch is creditable to anybody.
 *
 * @param windows Per-referral windows from `buildAttributionWindows`.
 * @returns The block just after the earliest touch, or null when no touch was ever stored.
 */
export function earliestAttributedBlock(windows: AttributionWindows): bigint | null {
  let earliest: bigint | null = null;

  for (const list of windows.values()) {
    const first = list[0];
    if (!first) continue;
    if (earliest === null || first.fromBlock < earliest) earliest = first.fromBlock;
  }

  return earliest === null ? null : earliest + BigInt(1);
}

/**
 * Wraps windows in the resolution rule `AttributionRegistry.promoterAt` applies.
 *
 * The newest window stored *strictly before* the action's block wins, so a touch sharing an action's
 * block does not capture it. That window credits nothing once it has lapsed, and resolution never
 * falls back past it to an older one that is still live.
 *
 * @param windows Per-referral windows from `buildAttributionWindows`.
 * @param startTime Campaign start; actions before it are creditable to nobody.
 * @returns A lookup usable by `indexerCore` and `relayCore`.
 */
export function attributionLookup(
  windows: AttributionWindows,
  startTime: bigint,
): AttributionLookup {
  return {
    at(user, blockNumber, timestamp) {
      if (timestamp === BigInt(0) || timestamp < startTime) return null;

      const list = windows.get(user.toLowerCase());
      if (!list) return null;

      for (let i = list.length - 1; i >= 0; i--) {
        const window = list[i]!;
        if (window.fromBlock >= blockNumber) continue;
        if (timestamp >= window.expiresAt) return null;
        return window.promoterId;
      }
      return null;
    },
    known(user) {
      return windows.has(user.toLowerCase());
    },
  };
}
