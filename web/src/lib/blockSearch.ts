/**
 * Turning a campaign's clock into a block range.
 *
 * A campaign describes itself in timestamps and every log scan is bounded in blocks, so the scripts
 * that scan on a campaign's behalf all need the same conversion.
 */

/** Reads one block's timestamp, so a fixture can stand in for a chain. */
export type ReadTimestamp = (blockNumber: bigint) => Promise<bigint>;

/**
 * Highest block at or before `target`.
 *
 * @param readTimestamp Reader for a block's timestamp.
 * @param target Timestamp to land on or before.
 * @param lo Lowest block the search may return, and the answer when every block is later.
 * @param hi Highest block to consider.
 * @param cache Block timestamps already read, extended in place so repeated searches share probes.
 * @returns The block number.
 */
export async function blockAtTimestamp(
  readTimestamp: ReadTimestamp,
  target: bigint,
  lo: bigint,
  hi: bigint,
  cache: Map<bigint, bigint> = new Map(),
): Promise<bigint> {
  let low = lo;
  let high = hi;
  let result = lo;

  while (low <= high) {
    const mid = (low + high) / BigInt(2);

    let timestamp = cache.get(mid);
    if (timestamp === undefined) {
      timestamp = await readTimestamp(mid);
      cache.set(mid, timestamp);
    }

    if (timestamp <= target) {
      result = mid;
      low = mid + BigInt(1);
    } else {
      if (mid === BigInt(0)) break;
      high = mid - BigInt(1);
    }
  }

  return result;
}

/**
 * Earliest moment a touch can still cover work a campaign will credit.
 *
 * A touch stored at `T` expires no later than `T + maxTouchDuration`, and activity before the
 * campaign's own start is creditable to nobody, so a touch older than this covers nothing.
 *
 * @param startTime Campaign start.
 * @param maxTouchDuration Longest horizon a touch for this campaign may claim.
 * @returns The timestamp, floored at zero.
 */
export function earliestCoveringTouch(startTime: bigint, maxTouchDuration: bigint): bigint {
  return startTime > maxTouchDuration ? startTime - maxTouchDuration : BigInt(0);
}
