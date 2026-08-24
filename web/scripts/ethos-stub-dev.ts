/**
 * Dev-wallet stub for the three upstream profile APIs — `pnpm ethos:stub:dev`.
 *
 * Usage: pnpm ethos:stub:dev [--port 8787]
 *                            [--pin 0xaddr:score:followers] (repeatable)
 *
 * ## This is the *global* stub, and it is no longer the usual path
 *
 * The app now synthesises a fabricated profile in-process for any wallet on the stub allowlist — see
 * `src/lib/stubProfile` and `src/lib/stubWalletStore` — so the dev wallet needs no server running at
 * all, and works the same on a deploy where a loopback port cannot be reached.
 *
 * What this script is still for is the *other* mode: pointing `ETHOS_API`/`FXTWITTER_API`/
 * `VXTWITTER_API`/`KAITO_API` at it, which stubs **every** wallet regardless of the allowlist. That is
 * the right tool for exercising the promoter directory across a whole rank ladder, or for working
 * offline, and the wrong one for testing that real profiles resolve.
 *
 * Why this stub alongside `ethos-stub.ts`
 * --------------------------------------
 * The general stub's `--score` / `--followers` are *global* overrides: they force the same values for
 * every address that asks, so every wallet reports identically and the rank badges and reach curve all
 * collapse to a single point. This one pins *named wallets* and derives everyone else, so the directory
 * stays populated while your own wallet sits at a known, reproducible number.
 *
 *   ETHOS_API=http://127.0.0.1:8787/ethos
 *   FXTWITTER_API=http://127.0.0.1:8787/fx
 *   VXTWITTER_API=http://127.0.0.1:8787/vx
 *   KAITO_API=http://127.0.0.1:8787/smart
 *
 * Only ever bound to loopback: this mints reputation, and the only client that needs to reach it is
 * the Next server on the same host.
 *
 * The pins and the derivation live in `src/lib/stubProfile`, imported rather than duplicated, so a
 * pinned wallet reads identically whether this served it or the app synthesised it.
 */

import {createServer, type IncomingMessage, type ServerResponse} from "node:http";
import {
  ethosResponseShape,
  stubFiguresFor,
  stubHandleFor,
  stubPins,
  type StubPin,
} from "../src/lib/stubProfile";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

/**
 * Parse every `--pin 0xaddr:score:followers` occurrence, on top of the committed defaults.
 *
 * Repeatable rather than comma-separated because a pin already contains colons and would make a
 * comma-separated list of triples hard to read. Malformed pins are a hard exit here, unlike the
 * `BONEY_STUB_PINS` env var the app reads: this is a foreground process someone just started, so
 * failing loudly is cheap, and a silently-ignored pin looks exactly like the stub serving a derived
 * profile — you would chase the wrong bug.
 */
function parsePins(): Record<string, StubPin> {
  const pins: Record<string, StubPin> = {...stubPins()};

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
      handle: stubHandleFor(lower),
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
 * Necessary because the follower endpoints are keyed by *handle*, not address: a client reads the
 * handle out of the Ethos response and never passes the address along. Without this map a pinned
 * wallet would get its pinned Ethos score but a derived follower count, which is the exact mismatch
 * the general stub avoids only by forcing followers globally.
 */
const PINS_BY_HANDLE: Record<string, StubPin> = Object.fromEntries(
  Object.values(PINS).map((pin) => [pin.handle, pin]),
);

/**
 * Profile for an address — the shared synthesiser, plus any pin added on the command line.
 *
 * A `--pin` cannot be pushed into `stubProfile` (it reads the environment, not argv), so it is applied
 * over the top here. Everything else, pinned or derived, comes from the shared module.
 */
function profileForAddress(address: string) {
  const lower = address.toLowerCase();
  const pin = PINS[lower];
  const base = stubFiguresFor(lower);
  if (!pin) return base;

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
  // Keyed by handle rather than address, so the derived spread is over a different input space. The
  // `handle:` prefix keeps it from colliding with an address's own derived profile.
  const base = stubFiguresFor(`handle:${handleName}`);
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
    return json(response, 200, ethosResponseShape(address, p));
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
