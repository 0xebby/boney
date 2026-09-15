/** Shared on-disk block-timestamp cache for reporting processes. */
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

/** Maximum cached blocks per chain. */
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
 * Saves timestamps within the cache limit.
 *
 * Writes through a sibling temporary file so readers only see complete cache files.
 *
 * @param chainId Chain the cache belongs to.
 * @param cache Timestamps to prune and store.
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
    try {
      unlinkSync(temp);
    } catch {
      // Temporary-file cleanup is best effort.
    }
  }
}
