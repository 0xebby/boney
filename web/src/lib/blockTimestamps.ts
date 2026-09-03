/**
 * A pass's block timestamps, gathered once and shared by everything that needs them.
 *
 * The relayer resolves attribution at each action's own block, so every log it decodes needs the
 * timestamp of the block it landed in. Nodes return that timestamp on the log itself, and the reads
 * that remain are deduplicated, batched and carried across the pass rather than issued per log.
 */

/** Block number => that block's timestamp. */
export type BlockTimestamps = Map<bigint, bigint>;

/** A log as the node returned it, before its fields are read. */
export type TimestampedLog = {
  blockNumber?: bigint | null;
  blockTimestamp?: bigint | number | string | null;
};

/** Serialised cache entry: `[blockNumber, timestamp]`, both decimal strings. */
type StoredEntry = [string, string];

/**
 * Reads a JSON-RPC quantity in any of the shapes a node may return it in.
 *
 * @param value Field value from a log or block.
 * @returns The number, or null when it is absent or unparseable.
 */
function quantity(value: bigint | number | string | null | undefined): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return Number.isFinite(value) ? BigInt(value) : null;
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/**
 * Takes the timestamps the node already put on these logs.
 *
 * @param logs Logs as returned, which may or may not carry `blockTimestamp`.
 * @param into Cache to fill, extended in place.
 * @returns How many blocks the logs supplied that the cache did not already hold.
 */
export function harvestLogTimestamps(
  logs: readonly TimestampedLog[],
  into: BlockTimestamps,
): number {
  let added = 0;

  for (const log of logs) {
    const blockNumber = quantity(log.blockNumber);
    const timestamp = quantity(log.blockTimestamp);
    if (blockNumber === null || timestamp === null || timestamp === BigInt(0)) continue;
    if (into.has(blockNumber)) continue;
    into.set(blockNumber, timestamp);
    added++;
  }

  return added;
}

/**
 * Blocks still needing a read, each named once.
 *
 * @param blocks Blocks whose timestamps are wanted, in any order and with repeats.
 * @param cache Timestamps already held.
 * @returns The absent blocks, ascending and deduplicated.
 */
export function missingTimestamps(
  blocks: readonly bigint[],
  cache: BlockTimestamps,
): bigint[] {
  const out = new Set<bigint>();
  for (const block of blocks) if (!cache.has(block)) out.add(block);
  return [...out].sort((a, b) => (a === b ? 0 : a < b ? -1 : 1));
}

/**
 * Splits a block list into batches of at most `size`.
 *
 * @param blocks Blocks to batch.
 * @param size Largest batch, which must be positive.
 * @returns The batches, in the order given.
 */
export function timestampBatches(blocks: readonly bigint[], size: number): bigint[][] {
  if (size <= 0) throw new Error("batch size must be positive");

  const out: bigint[][] = [];
  for (let i = 0; i < blocks.length; i += size) out.push(blocks.slice(i, i + size));
  return out;
}

/**
 * Drops the lowest-numbered entries until the cache fits `limit`.
 *
 * @param cache Cache to trim in place.
 * @param limit Most entries to keep, which must be positive.
 * @returns How many entries were dropped.
 */
export function pruneTimestamps(cache: BlockTimestamps, limit: number): number {
  if (limit <= 0) throw new Error("limit must be positive");
  if (cache.size <= limit) return 0;

  const ordered = [...cache.keys()].sort((a, b) => (a === b ? 0 : a < b ? -1 : 1));
  const drop = ordered.slice(0, cache.size - limit);
  for (const block of drop) cache.delete(block);
  return drop.length;
}

/**
 * Renders the cache as JSON a later pass can read back.
 *
 * @param cache Timestamps to store.
 * @returns The JSON text.
 */
export function serializeTimestamps(cache: BlockTimestamps): string {
  const entries: StoredEntry[] = [...cache]
    .sort(([a], [b]) => (a === b ? 0 : a < b ? -1 : 1))
    .map(([block, timestamp]) => [block.toString(), timestamp.toString()]);
  return JSON.stringify({version: 1, entries});
}

/**
 * Reads back what `serializeTimestamps` wrote, ignoring anything malformed.
 *
 * @param text JSON text, or undefined when no cache was stored.
 * @returns The timestamps the text held, empty when it held none.
 */
export function parseTimestamps(text: string | undefined): BlockTimestamps {
  const out: BlockTimestamps = new Map();
  if (!text) return out;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return out;
  }

  const entries = (parsed as {entries?: unknown})?.entries;
  if (!Array.isArray(entries)) return out;

  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const block = quantity(entry[0] as string);
    const timestamp = quantity(entry[1] as string);
    if (block === null || timestamp === null) continue;
    out.set(block, timestamp);
  }

  return out;
}
