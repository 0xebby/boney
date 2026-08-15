/**
 * Ethos lookup + BoneyScore composition, with no signing and no Next.js coupling.
 *
 * Split out from the route handler so the interesting logic — which profiles are refused, how a
 * missing follower count degrades — is testable without a private key or an HTTP server.
 */

import {reachFromFollowers} from "./boneyscore";
import {isStubbedWallet} from "./stubWallets";

const DEFAULT_ETHOS_API = "https://api.ethos.network";
const DEFAULT_ETHOS_STUB_API = "http://127.0.0.1:8787/ethos";
/** FixTweet's public JSON API. Primary follower source. */
const DEFAULT_FXTWITTER_API = "https://api.fxtwitter.com";
const DEFAULT_FXTWITTER_STUB_API = "http://127.0.0.1:8787/fx";
/** vxTwitter's public JSON API. Independent implementation, used when FixTweet is down. */
const DEFAULT_VXTWITTER_API = "https://api.vxtwitter.com";
const DEFAULT_VXTWITTER_STUB_API = "http://127.0.0.1:8787/vx";

const ETHOS_API = () => process.env.ETHOS_API ?? DEFAULT_ETHOS_API;
const ETHOS_STUB_API = () => process.env.ETHOS_STUB_API ?? DEFAULT_ETHOS_STUB_API;
const FXTWITTER_API = () => process.env.FXTWITTER_API ?? DEFAULT_FXTWITTER_API;
const FXTWITTER_STUB_API = () => process.env.FXTWITTER_STUB_API ?? DEFAULT_FXTWITTER_STUB_API;
const VXTWITTER_API = () => process.env.VXTWITTER_API ?? DEFAULT_VXTWITTER_API;
const VXTWITTER_STUB_API = () => process.env.VXTWITTER_STUB_API ?? DEFAULT_VXTWITTER_STUB_API;
/**
 * Kaito's crypto-Twitter index, reached through gomtu's proxy.
 *
 * Note this is *not* a follower source. gomtu's own Twitter proxy used to be the primary one and
 * was removed: it returns `followersCount: 0` for effectively every handle now (and 500s outright
 * for most), so it only ever cost a lookup. Kaito is kept for `smart_follower_count`, which is a
 * different signal — see `fetchSmartFollowers`.
 */
const KAITO_API = process.env.KAITO_API ?? "https://gomtu.xyz/api";
const TIMEOUT_MS = 10_000;

/** Ethos user record, narrowed to the fields we depend on. */
export type EthosProfile = {
  score: number;
  /** null for an address Ethos has auto-created a placeholder for. */
  profileId: number | null;
  status: string | null;
  username: string | null;
  userkeys: string[];
};

export class EthosError extends Error {
  constructor(
    readonly code: "invalid_address" | "no_ethos_profile" | "ethos_unavailable",
    message: string,
    readonly httpStatus: number,
  ) {
    super(message);
    this.name = "EthosError";
  }
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function isAddress(value: unknown): value is `0x${string}` {
  return typeof value === "string" && ADDRESS_RE.test(value);
}

/** Carries the status code, so callers can tell "no such user" apart from "upstream is down". */
class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
    this.name = "HttpError";
  }
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {accept: "application/json"},
    cache: "no-store",
  });
  if (!response.ok) throw new HttpError(response.status);
  return response.json();
}

/**
 * Shown for both ways a wallet can lack a usable profile: Ethos 404s the address outright, or
 * returns a record whose `profileId` is null. The distinction is invisible to a promoter — either way
 * the fix is to go and claim a profile — so both paths give the same instruction.
 */
const NO_PROFILE_MESSAGE =
  "This wallet has no claimed Ethos profile. Claim one at app.ethos.network to join campaigns on boneyard.";

/**
 * Fetch an Ethos profile, refusing anything that is not a claimed one.
 *
 * There are two distinct ways a wallet fails this, both verified against the live API:
 *
 *  - **404 `User not found`** for an address Ethos has no record of at all. This is the ordinary
 *    case for a new promoter, so it must not surface as an upstream failure — a 404 is Ethos answering
 *    correctly, not Ethos being unreachable.
 *  - **HTTP 200 with `profileId: null`** for an address Ethos knows of but nobody has claimed —
 *    typically resolved via ENS or seen in someone else's graph. These still carry a *score*
 *    (`vitalik.eth` returns 1317, a null address returns 1205), so attesting them would hand out
 *    thousands of BoneyScore points for a profile no one controls. That is the whole sybil surface,
 *    which is why a null `profileId` is a refusal rather than a zero.
 *
 * The address is lowercased first. Ethos validates EIP-55 and rejects a mixed-case address whose
 * checksum does not compute with a 400, while accepting the all-lowercase form of the same
 * address — and `isAddress` above deliberately accepts any hex case. Same reasoning as
 * `derivePromoterId` in `lib/promoter`: case carries no meaning in an address, so normalise rather than
 * let a hand-typed one fail as though Ethos were down.
 */
export async function fetchEthosProfile(wallet: string): Promise<EthosProfile> {
  if (!isAddress(wallet)) {
    throw new EthosError("invalid_address", "Not a valid Ethereum address.", 400);
  }

  const base = isStubbedWallet(wallet) ? ETHOS_STUB_API() : ETHOS_API();

  let raw: unknown;
  try {
    raw = await getJson(`${base}/api/v2/user/by/address/${wallet.toLowerCase()}`);
  } catch (cause) {
    if (cause instanceof HttpError && cause.status === 404) {
      throw new EthosError("no_ethos_profile", NO_PROFILE_MESSAGE, 400);
    }
    throw new EthosError(
      "ethos_unavailable",
      `Could not reach Ethos: ${(cause as Error).message}`,
      502,
    );
  }

  const profile = raw as Partial<EthosProfile>;
  if (typeof profile?.score !== "number") {
    throw new EthosError("ethos_unavailable", "Ethos returned an unexpected payload.", 502);
  }

  if (profile.profileId === null || profile.profileId === undefined) {
    throw new EthosError("no_ethos_profile", NO_PROFILE_MESSAGE, 400);
  }

  return {
    score: profile.score,
    profileId: profile.profileId,
    status: profile.status ?? null,
    username: profile.username ?? null,
    userkeys: profile.userkeys ?? [],
  };
}

/**
 * The X handle Ethos has on file, or null.
 *
 * Prefers the `username` field and falls back to parsing the `service:x.com:<id>` userkey. The
 * userkey holds a numeric id rather than a handle, so it is only useful as a marker that an X
 * account is linked at all — callers treat a null handle as "no reach data available".
 */
export function xHandleOf(profile: EthosProfile): string | null {
  if (profile.username) return profile.username;
  const key = profile.userkeys.find((k) => k.startsWith("service:x.com:"));
  if (!key) return null;
  const id = key.slice("service:x.com:".length);
  return id.length > 0 ? id : null;
}

/**
 * One follower source: a URL to try and how to read a count out of the response.
 *
 * Modelled as data rather than a chain of try/catch blocks because these endpoints are the least
 * stable dependency in the system and the list is expected to churn. Adding, reordering, or
 * dropping a source is an edit to this array; the traversal in `fetchFollowers` never changes, and
 * `FOLLOWER_SOURCES` is exported so a health check can probe each one by name.
 */
export type FollowerSource = {
  /** Stable identifier, used in health-check output. */
  name: string;
  url: (encodedHandle: string, wallet?: string) => string;
  /** Pull the count out of a parsed response, or return null when the payload carries none. */
  read: (raw: unknown) => number | null;
};

function sourceBaseForWallet(wallet: string | undefined, production: string, stub: string) {
  return isStubbedWallet(wallet) ? stub : production;
}

export const FOLLOWER_SOURCES: ReadonlyArray<FollowerSource> = [
  {
    // FixTweet reads X's public GraphQL layer, so its count is the live one. Verified against
    // handles from 718 to 241M followers.
    name: "fxtwitter",
    url: (h, wallet) => `${sourceBaseForWallet(wallet, FXTWITTER_API(), FXTWITTER_STUB_API())}/${h}`,
    read: (raw) => {
      const body = raw as {code?: number; user?: {followers?: unknown}};
      const count = body?.user?.followers;
      return typeof count === "number" ? count : null;
    },
  },
  {
    // Independent implementation of the same idea. Runs a few thousand followers behind FixTweet on
    // large accounts, which is well inside the log curve's noise floor.
    name: "vxtwitter",
    url: (h, wallet) => `${sourceBaseForWallet(wallet, VXTWITTER_API(), VXTWITTER_STUB_API())}/${h}`,
    read: (raw) => {
      const count = (raw as {followers_count?: unknown})?.followers_count;
      return typeof count === "number" ? count : null;
    },
  },
];

/**
 * Total follower count for an X handle, or 0 when unavailable.
 *
 * Deliberately total: every failure path returns 0 rather than throwing. Reach is the softer half
 * of BoneyScore and these are the least reliable dependency in the system — an outage should cost a
 * promoter their reach points, not their ability to join at all.
 *
 * Walks `FOLLOWER_SOURCES` in order and takes the first positive count. A zero is treated as "no
 * data" and falls through, because every source observed so far reports an unreadable handle as 0
 * while still returning a well-formed body — so a zero cannot be distinguished from a genuinely
 * empty account, and falling through costs one request while trusting it costs the promoter 30% of their
 * score.
 */
export async function fetchFollowers(handle: string, wallet?: string): Promise<number> {
  const encoded = encodeURIComponent(handle);

  for (const source of FOLLOWER_SOURCES) {
    try {
      const count = source.read(await getJson(source.url(encoded, wallet)));
      if (typeof count === "number" && count > 0) return count;
    } catch {
      // Try the next source. A 404 here means "no such handle" and every source will agree, but
      // distinguishing that from an outage is not worth the branch when the answer is 0 either way.
    }
  }

  return 0;
}

/**
 * Kaito's *smart* follower count for a handle, or 0 when Kaito does not track it.
 *
 * A different signal from `fetchFollowers`, not a fallback for it: Kaito counts followers it
 * considers reputable crypto-Twitter accounts, so the number is far smaller than the total
 * (`VitalikButerin` reads ~14k smart against ~7.3M total). Mixing the two would be a bug — a smart
 * count fed into `reachFromFollowers` understates reach by orders of magnitude, which is exactly
 * what the old gomtu-then-Kaito ladder did whenever the primary source failed.
 *
 * Kept out of the BoneyScore arithmetic for now and surfaced for display only. It is the more
 * sybil-resistant of the two counts and a plausible future input, but it is also sparse — most
 * handles return 0 — so weighting it today would penalise everyone Kaito has not indexed.
 */
export async function fetchSmartFollowers(handle: string, wallet?: string): Promise<number> {
  const base = isStubbedWallet(wallet)
    ? (process.env.KAITO_STUB_API ?? "http://127.0.0.1:8787/smart")
    : (process.env.KAITO_API ?? "https://gomtu.xyz/api");

  try {
    const raw = (await getJson(`${base}/kaito/user_status?username=${encodeURIComponent(handle)}`)) as {
      data?: {smart_follower_count?: unknown};
    };
    const count = raw?.data?.smart_follower_count;
    return typeof count === "number" && count > 0 ? count : 0;
  } catch {
    return 0;
  }
}

export type ScoreReport = {
  wallet: `0x${string}`;
  ethos: number;
  followers: number;
  /** Kaito's smart-follower count. Display only — contributes nothing to the score. */
  smartFollowers: number;
  reach: number;
  handle: string | null;
  profileId: number;
  status: string | null;
};

/** Everything the attestor needs to sign, assembled from Ethos plus a best-effort follower count. */
export async function buildScoreReport(wallet: string): Promise<ScoreReport> {
  const profile = await fetchEthosProfile(wallet);
  const handle = xHandleOf(profile);
  // Independent lookups against different hosts, so run them together rather than serially.
  const [followers, smartFollowers] = handle
    ? await Promise.all([fetchFollowers(handle, wallet), fetchSmartFollowers(handle, wallet)])
    : [0, 0];

  return {
    wallet: wallet as `0x${string}`,
    ethos: profile.score,
    followers,
    smartFollowers,
    reach: reachFromFollowers(followers),
    handle,
    profileId: profile.profileId as number,
    status: profile.status,
  };
}
