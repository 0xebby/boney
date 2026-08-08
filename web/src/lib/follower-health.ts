/**
 * Health check for the follower sources.
 *
 * These are free, community-run endpoints with no SLA, no versioning, and no deprecation notice.
 * They break in a specific and dangerous way: not by erroring, but by answering 200 with a
 * well-formed body carrying a zero. `fetchFollowers` treats that as "no data" and degrades to zero
 * reach, so a promoter silently loses 30% of their BoneyScore and nothing anywhere reports a fault. That
 * is exactly how the retired gomtu proxy failed — it kept returning `followersCount: 0` long enough
 * to become the normal case.
 *
 * So the check does not ask "did it respond". It asks whether each source still returns a count
 * within tolerance of a known-large reference account. A source that answers 200-with-zero is
 * reported broken, which is the whole point.
 *
 * Run it from CI on a schedule (`pnpm followers:health`); a non-zero exit means a source needs
 * attention. Deliberately dependency-free and separate from the Vitest suite so `pnpm test` never
 * depends on the network.
 */

import {FOLLOWER_SOURCES, fetchSmartFollowers} from "./ethos";

/**
 * Reference handle and the floor its follower count must clear.
 *
 * A large, long-lived, unlikely-to-be-deleted account. The floor is set far below the true count
 * (~7.3M) so ordinary drift never trips it — this detects a source going dark or changing its
 * payload shape, not day-to-day movement.
 */
const REFERENCE_HANDLE = "VitalikButerin";
const REFERENCE_FLOOR = 1_000_000;

/** A small account, to catch a source that only resolves famous handles. */
const SMALL_HANDLE = "peceka";

export type SourceHealth = {
  name: string;
  ok: boolean;
  count: number | null;
  detail: string;
};

async function probe(
  source: (typeof FOLLOWER_SOURCES)[number],
  handle: string,
  floor: number,
): Promise<SourceHealth> {
  const url = source.url(encodeURIComponent(handle));
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(15_000),
      headers: {accept: "application/json"},
      cache: "no-store",
    });
    if (!response.ok) {
      return {name: source.name, ok: false, count: null, detail: `HTTP ${response.status}`};
    }
    const count = source.read(await response.json());
    if (typeof count !== "number") {
      return {name: source.name, ok: false, count: null, detail: "payload shape changed"};
    }
    if (count < floor) {
      // The failure mode that matters: a valid-looking response with a useless number.
      return {name: source.name, ok: false, count, detail: `below floor ${floor}`};
    }
    return {name: source.name, ok: true, count, detail: "ok"};
  } catch (error) {
    return {name: source.name, ok: false, count: null, detail: (error as Error).message};
  }
}

export type HealthReport = {
  /** True when at least one source can still produce a real count. */
  healthy: boolean;
  reference: SourceHealth[];
  small: SourceHealth[];
  smartFollowers: {ok: boolean; count: number; detail: string};
};

export async function checkFollowerSources(): Promise<HealthReport> {
  const [reference, small, smart] = await Promise.all([
    Promise.all(FOLLOWER_SOURCES.map((s) => probe(s, REFERENCE_HANDLE, REFERENCE_FLOOR))),
    // A floor of 1 only asks whether the handle resolves at all.
    Promise.all(FOLLOWER_SOURCES.map((s) => probe(s, SMALL_HANDLE, 1))),
    fetchSmartFollowers(REFERENCE_HANDLE),
  ]);

  return {
    // Reach survives as long as one source works, so that — not every source passing — is the bar.
    healthy: reference.some((r) => r.ok),
    reference,
    small,
    smartFollowers: {
      ok: smart > 0,
      count: smart,
      // Sparse by nature and display-only, so this never fails the check on its own.
      detail: smart > 0 ? "ok" : "no smart-follower data (non-fatal)",
    },
  };
}
