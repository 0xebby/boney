/**
 * Dev-wallet stub for the three upstream profile APIs — `pnpm ethos:stub:dev`.
 *
 * Usage: pnpm ethos:stub:dev [--port 8787]
 *                            [--pin 0xaddr:score:followers] (repeatable)
 *
 * Why this exists alongside `ethos-stub.ts`
 * -----------------------------------------
 * The general stub's `--score` / `--followers` are *global* overrides: they force the same values
 * for every address that asks. That is right for exercising one specific score end-to-end, and
 * wrong for everything else — with them set, the promoter directory, the rank badges and the reach
 * curve all collapse to a single point, because every wallet reports identically.
 *
 * This stub pins *named wallets* instead. A pinned address gets exactly the score and follower
 * count you asked for; every other address falls through to the same derived pseudo-profile the
 * general stub produces, so the directory stays populated across the whole rank ladder while your
 * own wallet sits at a known, reproducible number.
 *
 * Point the four upstream vars at it exactly as with the general stub — the route shapes are
 * identical, so `web/.env.local` needs no change when switching between the two:
 *
 *   ETHOS_API=http://127.0.0.1:8787/ethos
 *   FXTWITTER_API=http://127.0.0.1:8787/fx
 *   VXTWITTER_API=http://127.0.0.1:8787/vx
 *   KAITO_API=http://127.0.0.1:8787/smart
 *
 * Only ever bound to loopback, for the same reason as the general stub: this mints reputation, and
 * the only client that needs to reach it is the Next server on the same host.
 */

import {createServer, type IncomingMessage, type ServerResponse} from "node:http";

/** One wallet's pinned upstream identity. */
type Pin = {score: number; followers: number; handle: string};

/**
 * Wallets pinned by default.
 *
 * The dev wallet is registered as an attestor on the Base Sepolia `AttestationVerifier`, so it can
 * sign its own attestations and submit them — the whole point of pinning it is to drive that path
 * against a known BoneyScore rather than whatever its address happens to hash to.
 *
 * 2750 Ethos with 30,000 followers gives `7*2750 + 3*reachFromFollowers(30000)` = 7*2750 + 3*1790
 * = 24,620 of a possible 28,000. High enough to clear any plausible `minReputation`, and still a
 * real point on the reach curve rather than the 2800 ceiling — a maxed-out reach would hide any
 * bug in the log normalisation, since every large follower count clamps to the same value.
 */
const DEFAULT_PINS: Record<string, Pin> = {
  "0x98405c5776a63547e7cb16000ba04ca53d9fb2f8": {
    score: 2750,
    followers: 30_000,
    handle: "dev_98405c",
  },
};

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

/**
 * Parse every `--pin 0xaddr:score:followers` occurrence.
 *
 * Repeatable rather than comma-separated because a pin already contains colons and would make a
 * comma-separated list of triples hard to read. Malformed pins are a hard exit, not a warning: a
 * silently-ignored pin looks exactly like the stub serving a derived profile, and you would chase
 * the wrong bug.
 */
function parsePins(): Record<string, Pin> {
  const pins: Record<string, Pin> = {...DEFAULT_PINS};

  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] !== "--pin") continue;
    const raw = process.argv[i + 1];
    const [address, score, followers] = (raw ?? "").split(":");

    if (!ADDRESS_RE.test(address ?? "") || !Number.isFinite(Number(score)) || !Number.isFinite(Number(followers))) {
      console.error(`Bad --pin "${raw}". Expected 0x<40 hex>:<score>:<followers>.`);
      process.exit(1);
    }

    const lower = address.toLowerCase();
    pins[lower] = {
      score: Number(score),
      followers: Number(followers),
      // Derived from the address so a pin added on the command line still gets a stable handle
      // without having to spell one out.
      handle: `dev_${lower.slice(2, 8)}`,
    };
  }

  return pins;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const PORT = Number(flag("--port") ?? 8787);
const PINS = parsePins();

/**
 * Reverse index from handle back to its pin.
 *
 * Necessary because the follower endpoints are keyed by *handle*, not address: `lib/ethos.ts` reads
 * the handle out of the Ethos response and never passes the address along. Without this map a
 * pinned wallet would get its pinned Ethos score but a derived follower count, which is the exact
 * mismatch the general stub avoids only by forcing followers globally.
 */
const PINS_BY_HANDLE: Record<string, Pin> = Object.fromEntries(
  Object.values(PINS).map((pin) => [pin.handle, pin]),
);

/** FNV-1a. Matches `ethos-stub.ts` so an unpinned address keeps the same profile across both. */
function hash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** Derived pseudo-profile for an unpinned key. Mirrors `ethos-stub.ts`'s spread exactly. */
function derived(key: string) {
  const h = hash(key.toLowerCase());
  const exponent = 2 + (((h >>> 11) % 1000) / 1000) * 4.7;
  const followers = Math.round(10 ** exponent);
  return {
    score: 600 + (h % 2051),
    followers,
    smartFollowers: Math.floor(followers * (0.001 + ((h >>> 21) % 40) / 10_000)),
    profileId: 10_000 + (h % 90_000),
  };
}

/** Profile for an address — pinned if we know it, derived otherwise. */
function profileForAddress(address: string) {
  const lower = address.toLowerCase();
  const base = derived(lower);
  const pin = PINS[lower];
  if (!pin) return {...base, handle: `stub_${lower.slice(2, 8)}`};

  return {
    ...base,
    score: pin.score,
    followers: pin.followers,
    smartFollowers: Math.floor(pin.followers * 0.004),
    handle: pin.handle,
  };
}

/** Follower figures for a handle — pinned if the handle belongs to a pinned wallet. */
function profileForHandle(handleName: string) {
  const pin = PINS_BY_HANDLE[handleName];
  if (pin) {
    return {followers: pin.followers, smartFollowers: Math.floor(pin.followers * 0.004)};
  }
  const base = derived(`handle:${handleName}`);
  return {followers: base.followers, smartFollowers: base.smartFollowers};
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

/** Routes, in the shape each upstream actually returns. Identical to `ethos-stub.ts`. */
function handle(request: IncomingMessage, response: ServerResponse): void {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${PORT}`);
  const path = url.pathname;

  const ethosMatch = path.match(/^\/ethos\/api\/v2\/user\/by\/address\/(.+)$/);
  if (ethosMatch) {
    const address = decodeURIComponent(ethosMatch[1]);
    if (!ADDRESS_RE.test(address)) return json(response, 400, {error: "Invalid address"});

    const p = profileForAddress(address);
    const lower = address.toLowerCase();
    return json(response, 200, {
      id: p.profileId,
      profileId: p.profileId,
      score: p.score,
      status: "ACTIVE",
      username: p.handle,
      userkeys: [`address:${lower}`, `service:x.com:${p.profileId}`],
    });
  }

  const fxMatch = path.match(/^\/fx\/([^/]+)$/);
  if (fxMatch) {
    const name = decodeURIComponent(fxMatch[1]);
    return json(response, 200, {
      code: 200,
      message: "OK",
      user: {screen_name: name, followers: profileForHandle(name).followers},
    });
  }

  const vxMatch = path.match(/^\/vx\/([^/]+)$/);
  if (vxMatch) {
    const name = decodeURIComponent(vxMatch[1]);
    return json(response, 200, {followers_count: profileForHandle(name).followers});
  }

  if (path === "/smart/kaito/user_status") {
    const name = url.searchParams.get("username") ?? "";
    return json(response, 200, {data: {smart_follower_count: profileForHandle(name).smartFollowers}});
  }

  if (path === "/health") {
    return json(response, 200, {ok: true, port: PORT, pinned: Object.keys(PINS)});
  }

  json(response, 404, {error: `No stub route for ${path}`});
}

const server = createServer((request, response) => {
  const started = Date.now();
  response.on("finish", () => {
    console.log(`  ${response.statusCode}  ${request.url}  ${Date.now() - started}ms`);
  });
  try {
    handle(request, response);
  } catch (error) {
    json(response, 500, {error: (error as Error).message});
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Dev stub on http://127.0.0.1:${PORT} — pinned wallets, derived everyone else.`);
  for (const [address, pin] of Object.entries(PINS)) {
    console.log(`  pinned  ${address}  score=${pin.score}  followers=${pin.followers}  @${pin.handle}`);
  }
  console.log("Every other address falls through to a derived profile.");
});
