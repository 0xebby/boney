/**
 * Loopback stand-in for the upstream profile APIs.
 *
 * Usage: pnpm ethos:stub [--port 8787] [--score N] [--followers N]
 *                        [--no-profile 0xa,0xb] [--unclaimed 0xa,0xb]
 *
 * Values are stable per address unless overridden.
 */

import {createServer, type IncomingMessage, type ServerResponse} from "node:http";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

function addressSet(name: string): Set<string> {
  const raw = flag(name);
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((a) => a.trim().toLowerCase())
      .filter((a) => a.length > 0),
  );
}

const PORT = Number(flag("--port") ?? 8787);
const FORCED_SCORE = flag("--score") ? Number(flag("--score")) : undefined;
const FORCED_FOLLOWERS = flag("--followers") ? Number(flag("--followers")) : undefined;
/** Addresses served with a 404. */
const NO_PROFILE = addressSet("--no-profile");
/** Addresses served with an unclaimed Ethos profile. */
const UNCLAIMED = addressSet("--unclaimed");

/** Stable FNV-1a hash. */
function hash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** Stable pseudo-profile spanning the score and follower ranges. */
function profileFor(address: string) {
  const h = hash(address.toLowerCase());
  const score = FORCED_SCORE ?? 600 + (h % 2051);
  const exponent = 2 + ((h >>> 11) % 1000) / 1000 * 4.7;
  const followers = FORCED_FOLLOWERS ?? Math.round(10 ** exponent);
  return {
    score,
    followers,
    // Smart followers are a small fraction of total followers.
    smartFollowers: Math.floor(followers * (0.001 + ((h >>> 21) % 40) / 10_000)),
    handle: `stub_${address.slice(2, 8).toLowerCase()}`,
    profileId: 10_000 + (h % 90_000),
  };
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Upstream-compatible routes. */
function handle(request: IncomingMessage, response: ServerResponse): void {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${PORT}`);
  const path = url.pathname;

  // Ethos: /ethos/api/v2/user/by/address/0x…
  const ethosMatch = path.match(/^\/ethos\/api\/v2\/user\/by\/address\/(.+)$/);
  if (ethosMatch) {
    const address = decodeURIComponent(ethosMatch[1]);
    if (!ADDRESS_RE.test(address)) return json(response, 400, {error: "Invalid address"});

    const lower = address.toLowerCase();
    if (NO_PROFILE.has(lower)) return json(response, 404, {error: "User not found"});

    const p = profileFor(address);
    return json(response, 200, {
      id: p.profileId,
      // `--unclaimed` preserves the score while returning a null profile ID.
      profileId: UNCLAIMED.has(lower) ? null : p.profileId,
      score: p.score,
      status: UNCLAIMED.has(lower) ? "UNINITIALIZED" : "ACTIVE",
      username: p.handle,
      userkeys: [`address:${lower}`, `service:x.com:${p.profileId}`],
    });
  }

  // fxtwitter: /fx/<handle>
  const fxMatch = path.match(/^\/fx\/([^/]+)$/);
  if (fxMatch) {
    const p = profileFor(`handle:${decodeURIComponent(fxMatch[1])}`);
    return json(response, 200, {
      code: 200,
      message: "OK",
      user: {screen_name: decodeURIComponent(fxMatch[1]), followers: p.followers},
    });
  }

  // vxtwitter: /vx/<handle>
  const vxMatch = path.match(/^\/vx\/([^/]+)$/);
  if (vxMatch) {
    const p = profileFor(`handle:${decodeURIComponent(vxMatch[1])}`);
    return json(response, 200, {followers_count: p.followers});
  }

  // Kaito smart followers: /smart/kaito/user_status?username=<handle>
  if (path === "/smart/kaito/user_status") {
    const username = url.searchParams.get("username") ?? "";
    const p = profileFor(`handle:${username}`);
    return json(response, 200, {data: {smart_follower_count: p.smartFollowers}});
  }

  if (path === "/health") return json(response, 200, {ok: true, port: PORT});

  json(response, 404, {error: `No stub route for ${path}`});
}

/** Follower endpoints derive values from handles; Ethos derives them from addresses. */
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
  console.log(`Ethos stub on http://127.0.0.1:${PORT} — every address gets a claimed profile.`);
  console.log("Set these in web/.env.local, then restart `pnpm dev`:");
  console.log(`  ETHOS_API=http://127.0.0.1:${PORT}/ethos`);
  console.log(`  FXTWITTER_API=http://127.0.0.1:${PORT}/fx`);
  console.log(`  VXTWITTER_API=http://127.0.0.1:${PORT}/vx`);
  console.log(`  KAITO_API=http://127.0.0.1:${PORT}/smart`);
  if (FORCED_SCORE !== undefined) console.log(`Forcing Ethos score ${FORCED_SCORE}.`);
  if (FORCED_FOLLOWERS !== undefined) console.log(`Forcing follower count ${FORCED_FOLLOWERS}.`);
  if (NO_PROFILE.size > 0) console.log(`404 for: ${[...NO_PROFILE].join(", ")}`);
  if (UNCLAIMED.size > 0) console.log(`Unclaimed (profileId null) for: ${[...UNCLAIMED].join(", ")}`);
});

