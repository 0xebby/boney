/**
 * The block-timestamp cache both reporting processes keep on disk.
 *
 * `relay-kpi-metric.ts` runs once per gated KPI and `indexer.ts` once per pass, so a cache held only
 * in memory is discarded between invocations whose block ranges almost entirely overlap. One file per
 * chain is shared by both: a block's timestamp is the same fact whoever asked for it.
 */
import {readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, unlinkSync} from "node:fs";
import {resolve, dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {
  parseTimestamps,
  pruneTimestamps,
  serializeTimestamps,
  type BlockTimestamps,
} from "../src/lib/blockTimestamps";

const here = dirname(fileURLToPath(import.meta.url));

/** Blocks the cache keeps between passes, oldest dropped first. */
const TIMESTAMP_CACHE_LIMIT = 150_000;

/**
 * Where a chain's timestamp cache is kept between passes.
 *
 * @param chainId Chain the cache belongs to.
 * @returns Absolute path to that chain's cache file.
 */
export function cachePath(chainId: number): string {
  return resolve(here, "../.cache", `block-timestamps-${chainId}.json`);
}

/**
 * Reads back the timestamps earlier passes on this chain already paid for.
 *
 * @param chainId Chain the cache belongs to.
 * @returns The cached timestamps, empty when none were stored or the file is unreadable.
 */
export function loadTimestampCache(chainId: number): BlockTimestamps {
  const path = cachePath(chainId);
  if (!existsSync(path)) return new Map();
  try {
    return parseTimestamps(readFileSync(path, "utf8"));
  } catch {
    return new Map();
  }
}

/**
 * Stores the timestamps a pass gathered, trimmed to the cache limit.
 *
 * Written to a sibling temp file and renamed over the target, so a relay pass and an indexer pass
 * writing at once leave a whole file rather than a half-written one.
 *
 * @param chainId Chain the cache belongs to.
 * @param cache Timestamps to store; pruned in place to the cache limit.
 * @returns Nothing.
 */
export function saveTimestampCache(chainId: number, cache: BlockTimestamps): void {
  pruneTimestamps(cache, TIMESTAMP_CACHE_LIMIT);
  const path = cachePath(chainId);
  const temp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), {recursive: true});
    writeFileSync(temp, serializeTimestamps(cache));
    renameSync(temp, path);
  } catch {
    // A cache that cannot be written costs the next pass some reads and nothing else.
    try {
      unlinkSync(temp);
    } catch {
      // Nothing to clean up.
    }
  }
}
