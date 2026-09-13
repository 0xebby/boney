/**
 * Loopback profile stub with per-wallet pins.
 *
 * Usage: pnpm ethos:stub:dev [--port 8787]
 *                            [--pin 0xaddr:score:followers] (repeatable)
 *
 * Unpinned wallets use the shared derived profile.
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
 * Parses repeatable `--pin 0xaddr:score:followers` arguments over the defaults.
 *
 * Malformed pins exit with status 1.
 *
 * @returns Pins keyed by lowercase address.
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

/** Pins keyed by handle for follower endpoints. */
const PINS_BY_HANDLE: Record<string, StubPin> = Object.fromEntries(
  Object.values(PINS).map((pin) => [pin.handle, pin]),
);

/** Returns a shared derived profile with command-line pins applied. */
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
  // Prefix handle keys to keep them separate from address keys.
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
