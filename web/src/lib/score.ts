import {buildScoreReport, EthosError, type ScoreReport} from "@/lib/ethos";

/**
 * The prospective score, cached, in the one shape both readers need.
 *
 * Two callers, and keeping them on one path is the point of this module:
 *
 *  - `/api/score` — the browser's card fetches this over HTTP.
 *  - `lib/cardServer.ts` — the public card at `/b/<wallet>` is server-rendered with no wallet and no
 *    client JS, so it cannot fetch its own API route sensibly. It calls in directly.
 *
 * Both funnel through `scoreResponse`, so a status or a payload field can never mean one thing on the
 * card and another on the share page. It also means they share the cache: a visitor who opens somebody's
 * public card and then their own does not pay for two fan-outs to Ethos.
 *
 * ## Why it caches at all
 *
 * `buildScoreReport` fans out to Ethos plus `fetchFollowers` and `fetchSmartFollowers`, and the follower
 * sources throttle back-to-back requests — `lib/follower-health.ts` exists because they are the least
 * stable dependency in the system. Without a cache, rendering a card and then re-rendering it costs two
 * full fan-outs and a refresh loop reads as an outage.
 *
 * Failures are cached too, for much less time. A wallet with no Ethos profile is the *expected*
 * first-run state and would otherwise re-hit Ethos on every render, but the TTL stays short so someone
 * who claims a profile is not told they have none for the next hour.
 *
 * Per-process and best-effort: a serverless cold start simply misses.
 */

const OK_TTL_MS = 5 * 60 * 1000;
const ERROR_TTL_MS = 30 * 1000;

/** Keyed by lowercased address. Bounded below so a scan cannot grow it without limit. */
const cache = new Map<string, Entry>();
const MAX_CACHE_ENTRIES = 500;

export type ScorePayload = {
  wallet: `0x${string}`;
  ethos: number;
  reach: number;
  followers: number;
  smartFollowers: number;
  handle: string | null;
  profileId: number;
  reachUnconfirmed: boolean;
  computedAt: number;
};

export type ScoreError = {error: string; message: string};

type Entry =
  | {kind: "ok"; body: ScorePayload; until: number}
  | {kind: "error"; body: ScoreError; status: number; until: number};

/**
 * Whether a reach of 0 is a number we can stand behind.
 *
 * `fetchFollowers` returns 0 on every failure path by design — its note is explicit that an outage
 * should cost a promoter their reach points rather than their ability to join — and that a zero from a
 * live source is indistinguishable from a genuinely empty account. So this cannot detect a throttle,
 * only suspect one, and the suspicion is worth carrying because reach is 30% of the score: presenting
 * an unconfirmed 0 as fact is a silent 30% haircut.
 *
 * The heuristic is that a wallet whose Ethos profile *names* an X handle, whose follower count came
 * back 0, is more likely throttled than genuinely followerless. Where no handle exists there is nothing
 * to suspect: reach is legitimately 0 and the card says so plainly.
 */
export function reachIsUnconfirmed(report: ScoreReport): boolean {
  return report.handle !== null && report.followers === 0;
}

export function payloadFrom(report: ScoreReport): ScorePayload {
  return {
    wallet: report.wallet,
    ethos: report.ethos,
    reach: report.reach,
    followers: report.followers,
    smartFollowers: report.smartFollowers,
    handle: report.handle,
    profileId: report.profileId,
    reachUnconfirmed: reachIsUnconfirmed(report),
    // Stamped because this number can fall with nothing happening: Ethos moves, follower counts move.
    // The card renders the date so it is never presented as timeless — the same reason `discovery.ts`
    // named its field `scoreAtJoin`.
    computedAt: Math.floor(Date.now() / 1000),
  };
}

function remember(key: string, entry: Entry) {
  // Evict oldest-inserted first. Map preserves insertion order, so the first key is the stalest.
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, entry);
}

/**
 * A wallet's score as a status and a body — the HTTP shape, whether or not HTTP is involved.
 *
 * Returning the status rather than throwing is what lets both callers agree: the route serialises it,
 * and the server-rendered card hands the pair straight to `cardScoreFrom`, which is the same function
 * the browser's card uses on the same pair. A failure is data here, never an exception, because
 * `no_ethos_profile` is the ordinary first-run state and not an error condition.
 */
export async function scoreResponse(
  wallet: `0x${string}`,
): Promise<{status: number; body: ScorePayload | ScoreError}> {
  const key = wallet.toLowerCase();
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) {
    return hit.kind === "ok" ? {status: 200, body: hit.body} : {status: hit.status, body: hit.body};
  }

  try {
    const body = payloadFrom(await buildScoreReport(wallet));
    remember(key, {kind: "ok", body, until: Date.now() + OK_TTL_MS});
    return {status: 200, body};
  } catch (error) {
    const {code, message, status} =
      error instanceof EthosError
        ? {code: error.code, message: error.message, status: error.httpStatus}
        : {
            code: "ethos_unavailable",
            message: "Could not build a score for this wallet.",
            status: 502,
          };

    const body: ScoreError = {error: code, message};
    remember(key, {kind: "error", body, status, until: Date.now() + ERROR_TTL_MS});
    return {status, body};
  }
}
