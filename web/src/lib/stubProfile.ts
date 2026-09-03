/**
 * A fabricated upstream profile, for wallets on the stub allowlist.
 *
 * One source of truth for two consumers that must never disagree: `lib/ethos.ts` synthesises a
 * profile in-process for an allowlisted wallet, and `scripts/ethos-stub-dev.ts` serves the same
 * numbers over HTTP for the global-override mode. A pinned wallet has to read identically either
 * way, or a score changes depending on which mechanism happened to be in play.
 *
 * ## Why in-process at all
 *
 * The stub script binds loopback, which a Netlify function cannot reach — and the allowlist is meant
 * to work on the deploy, not only on a laptop. Synthesising here needs no reachable host, no extra
 * env var, and no self-fetch, and it behaves the same in both places. The script remains the right
 * tool for the *global* override (`ETHOS_API=…`), which stubs every wallet rather than named ones.
 *
 * Pure and dependency-free apart from the shared score curve, so it is testable without a server.
 */

import {boneyScore, reachFromFollowers} from "./boneyscore";

/** One wallet's pinned upstream figures. */
export type StubPin = {score: number; followers: number; handle: string};

/** The wallet the dev fixture is driven from, and the authority over the allowlist. */
export const DEV_STUB_WALLET = "0x98405c5776a63547e7cb16000ba04ca53d9fb2f8" as const;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Wallets pinned with no configuration anywhere.
 *
 * The dev wallet is registered as an attestor on the Base Sepolia `AttestationVerifier`, so it can
 * sign its own attestations and submit them — the point of pinning it is to drive that path against
 * a known BoneyScore rather than whatever its address happens to hash to.
 *
 * 2750 Ethos with 30,000 followers gives `7*2750 + 3*reachFromFollowers(30000)` = 7*2750 + 3*1790 =
 * 24,620 of a possible 28,000. High enough to clear any plausible `minReputation`, and still a real
 * point on the reach curve rather than the 2800 ceiling — a maxed-out reach would hide any bug in
 * the log normalisation, since every large follower count clamps to the same value.
 */
export const DEFAULT_PINS: Readonly<Record<string, StubPin>> = {
  [DEV_STUB_WALLET]: {score: 2750, followers: 30_000, handle: "dev_98405c"},
};

/** Handle for a pin added without one. Derived from the address so it is stable. */
export function stubHandleFor(address: string): string {
  return `dev_${address.toLowerCase().slice(2, 8)}`;
}

/**
 * Parse `BONEY_STUB_PINS` — `0xaddr:score:followers`, comma-separated.
 *
 * Mirrors the script's repeatable `--pin` flag so a deploy can pin a wallet the committed defaults
 * do not cover. A malformed entry is skipped rather than fatal: this runs inside a request on a
 * deploy, where exiting the process over a typo in an env var would take the whole site down. The
 * skip is silent for the same reason a bad entry cannot be fixed from here — the committed default
 * still applies, so the failure mode is "your extra pin did nothing", not a broken app.
 */
function envPins(): Record<string, StubPin> {
  const raw = process.env.BONEY_STUB_PINS;
  if (!raw) return {};

  const pins: Record<string, StubPin> = {};
  for (const entry of raw.split(",")) {
    const [address, score, followers] = entry.trim().split(":");
    if (!ADDRESS_RE.test(address ?? "")) continue;
    if (!Number.isFinite(Number(score)) || !Number.isFinite(Number(followers))) continue;

    const lower = (address as string).toLowerCase();
    pins[lower] = {
      score: Number(score),
      followers: Number(followers),
      handle: stubHandleFor(lower),
    };
  }
  return pins;
}

/** Every pin in force: the committed defaults, with `BONEY_STUB_PINS` overriding by address. */
export function stubPins(): Record<string, StubPin> {
  return {...DEFAULT_PINS, ...envPins()};
}

/** FNV-1a. The derived profile has to be stable across processes, so this is spelled out. */
export function hashKey(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * The bands a derived profile draws its Ethos score and follower count from.
 *
 * `7*ethos + 3*reach` over these ranges composes to a BoneyScore between 20,550 and 26,464: clear of
 * any `minReputation` the fixture gates on, and short of the 28,000 ceiling. The follower band spans
 * 10^4 to ~10^6.6, which keeps reach a real point on the log curve rather than the 2800 clamp.
 */
const DERIVED_ETHOS_FLOOR = 2250;
const DERIVED_ETHOS_SPREAD = 401;
const DERIVED_FOLLOWER_FLOOR_EXP = 4;
const DERIVED_FOLLOWER_EXP_SPREAD = 2.6;

/**
 * Pseudo-profile for an unpinned key.
 *
 * Banded high rather than spread across the whole rank ladder. A key reaches this function because its
 * wallet is on the stub allowlist, and an allowlisted wallet that still lands under a campaign's gate
 * is indistinguishable from a bypass that did not take effect — so the weakest derived profile clears
 * the gate. Figures still vary per key within the band, so a directory of derived wallets exercises
 * the reach curve instead of collapsing to one point; a wallet that has to read *low*, to test a
 * refusal, is what `BONEY_STUB_PINS` is for.
 */
export function derivedProfile(key: string): {
  score: number;
  followers: number;
  smartFollowers: number;
  profileId: number;
} {
  const h = hashKey(key.toLowerCase());
  const exponent =
    DERIVED_FOLLOWER_FLOOR_EXP + (((h >>> 11) % 1000) / 1000) * DERIVED_FOLLOWER_EXP_SPREAD;
  const followers = Math.round(10 ** exponent);
  return {
    score: DERIVED_ETHOS_FLOOR + (h % DERIVED_ETHOS_SPREAD),
    followers,
    smartFollowers: Math.floor(followers * (0.001 + ((h >>> 21) % 40) / 10_000)),
    profileId: 10_000 + (h % 90_000),
  };
}

/**
 * The full stub figures for an address — pinned if known, derived otherwise.
 *
 * The `dev_` / `stub_` handle prefix is deliberately visible: it is how a reader of an
 * `/api/attest` response can tell at a glance that a score was fabricated and, of the two, whether
 * it came from a pin or from the address's own bytes.
 */
export function stubFiguresFor(address: string): StubFigures {
  const lower = address.toLowerCase();
  const base = derivedProfile(lower);
  const pin = stubPins()[lower];

  if (!pin) return {...base, handle: `stub_${lower.slice(2, 8)}`};

  return {
    ...base,
    score: pin.score,
    followers: pin.followers,
    // Kaito tracks a small fraction of any audience; 0.4% keeps a pinned wallet's smart count on the
    // same order as a derived one instead of implying Kaito indexes everybody.
    smartFollowers: Math.floor(pin.followers * 0.004),
    handle: pin.handle,
  };
}

/** The figures a fabricated profile is built from. */
export type StubFigures = {
  score: number;
  followers: number;
  smartFollowers: number;
  profileId: number;
  handle: string;
};

/**
 * The stub profile in the shape Ethos returns it.
 *
 * Takes the figures rather than deriving them, so `scripts/ethos-stub-dev.ts` — which can override a
 * pin from argv, something this module cannot see — serialises through the same shape rather than
 * assembling its own. The wire format lives in one place; only the numbers vary.
 */
export function ethosResponseShape(address: string, figures: StubFigures): Record<string, unknown> {
  return {
    id: figures.profileId,
    profileId: figures.profileId,
    score: figures.score,
    status: "ACTIVE",
    username: figures.handle,
    userkeys: [`address:${address.toLowerCase()}`, `service:x.com:${figures.profileId}`],
  };
}

/** The stub profile for an address, in Ethos's wire shape. */
export function stubEthosResponse(address: string): Record<string, unknown> {
  return ethosResponseShape(address, stubFiguresFor(address));
}

/** The BoneyScore a stubbed address composes to, for tests and for explaining a fixture. */
export function stubBoneyScoreFor(address: string): number {
  const {score, followers} = stubFiguresFor(address);
  return boneyScore({ethos: score, reach: reachFromFollowers(followers)});
}
