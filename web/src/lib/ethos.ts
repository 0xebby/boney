/**
 * Ethos lookup + BoneyScore composition, with no signing and no Next.js coupling.
 *
 * Split out from the route handler so the interesting logic — which profiles are refused, how a
 * missing follower count degrades — is testable without a private key or an HTTP server.
 */

import {reachFromFollowers} from "./boneyscore";

const ETHOS_API = process.env.ETHOS_API ?? "https://api.ethos.network";
const GOMTU_API = process.env.GOMTU_API ?? "https://gomtu.xyz/api";
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
 * returns a record whose `profileId` is null. The distinction is invisible to a KOL — either way
 * the fix is to go and claim a profile — so both paths give the same instruction.
 */
const NO_PROFILE_MESSAGE =
  "This wallet has no claimed Ethos profile. Claim one at app.ethos.network to join reputation-gated campaigns.";

/**
 * Fetch an Ethos profile, refusing anything that is not a claimed one.
 *
 * There are two distinct ways a wallet fails this, both verified against the live API:
 *
 *  - **404 `User not found`** for an address Ethos has no record of at all. This is the ordinary
 *    case for a new KOL, so it must not surface as an upstream failure — a 404 is Ethos answering
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
 * `derivePromoterId` in `lib/kol`: case carries no meaning in an address, so normalise rather than
 * let a hand-typed one fail as though Ethos were down.
 */
export async function fetchEthosProfile(wallet: string): Promise<EthosProfile> {
  if (!isAddress(wallet)) {
    throw new EthosError("invalid_address", "Not a valid Ethereum address.", 400);
  }

  let raw: unknown;
  try {
    raw = await getJson(`${ETHOS_API}/api/v2/user/by/address/${wallet.toLowerCase()}`);
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
 * Follower count for an X handle, or 0 when unavailable.
 *
 * Deliberately total: every failure path returns 0 rather than throwing. Reach is the softer half
 * of BoneyScore and the follower sources are the least reliable dependency in the system — an
 * outage there should cost a KOL their reach points, not their ability to join at all.
 *
 * Tries gomtu's Twitter proxy first, then Kaito's user_status, which carries `follower_count` for
 * accounts Kaito tracks.
 */
export async function fetchFollowers(handle: string): Promise<number> {
  const encoded = encodeURIComponent(handle);

  try {
    const raw = (await getJson(`${GOMTU_API}/twitter/user/profile?username=${encoded}`)) as {
      followersCount?: number;
    };
    if (typeof raw?.followersCount === "number" && raw.followersCount > 0) {
      return raw.followersCount;
    }
  } catch {
    // fall through to the Kaito source
  }

  try {
    const raw = (await getJson(`${GOMTU_API}/kaito/user_status?username=${encoded}`)) as {
      data?: {follower_count?: number};
    };
    const count = raw?.data?.follower_count;
    if (typeof count === "number" && count > 0) return count;
  } catch {
    // no follower data available
  }

  return 0;
}

export type ScoreReport = {
  wallet: `0x${string}`;
  ethos: number;
  followers: number;
  reach: number;
  handle: string | null;
  profileId: number;
  status: string | null;
};

/** Everything the attestor needs to sign, assembled from Ethos plus a best-effort follower count. */
export async function buildScoreReport(wallet: string): Promise<ScoreReport> {
  const profile = await fetchEthosProfile(wallet);
  const handle = xHandleOf(profile);
  const followers = handle ? await fetchFollowers(handle) : 0;

  return {
    wallet: wallet as `0x${string}`,
    ethos: profile.score,
    followers,
    reach: reachFromFollowers(followers),
    handle,
    profileId: profile.profileId as number,
    status: profile.status,
  };
}
