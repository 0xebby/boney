/**
 * The writable half of the stub allowlist — a JSON file on disk, plus the env fallbacks around it.
 *
 * Server-only: it touches `node:fs`, so importing it from a client component would fail the build.
 * `lib/ethos` and `/api/stub-wallets` are the only callers. The pure half — what the admin signs, how
 * an address is normalised — is `lib/stubWallets`, which a component may import.
 *
 * ## Where the list comes from
 *
 * Three sources, resolved in one order:
 *
 *  1. `DEFAULT_STUB_WALLETS`, committed. The dev wallet is here so it works with no configuration on
 *     any deploy, including one with nothing writable.
 *  2. `BONEY_STUB_WALLETS`, comma-separated, unioned with the defaults.
 *  3. The store file, which **replaces** both once it exists.
 *
 * The file replacing rather than merging is what lets a *removal* stick. Under a merge, deleting the
 * dev wallet would be undone by the committed default on the very next read, and the panel would
 * report a success that never held. The first write materialises the whole resolved set, so from then
 * on the file is the complete answer.
 *
 * ## Persistence, and where it does not persist
 *
 * Same trade as `lib/guideStore`, which this follows. On Netlify the function filesystem is read-only
 * outside `/tmp`, so a write there fails — and unlike a campaign guide, the change is still worth
 * applying: it is mirrored into `process.env` so it holds for the running instance, and the caller is
 * told `persisted: false`. Good for the length of a warm instance, gone after a redeploy. The
 * committed default needs no write at all, which is why the dev wallet works on a deploy regardless.
 */

import {mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {getStore} from "@netlify/blobs";
import {
  DEFAULT_STUB_WALLETS,
  DEV_STUB_WALLET,
  STUB_ADDRESS_RE,
  normalizeStubWallet,
} from "./stubWallets";

const ENV_KEY = "BONEY_STUB_WALLETS";

/**
 * The wallet allowed to change the list.
 *
 * Overridable so a deploy can hand the authority elsewhere, but it defaults to the dev wallet and is
 * never empty. An unset admin must not read as "anyone", which is the failure the whole gate exists to
 * prevent — so a malformed override falls back rather than opening up.
 */
export function stubAdminWallet(): string {
  const override = process.env.BONEY_STUB_ADMIN?.trim().toLowerCase();
  return override && STUB_ADDRESS_RE.test(override) ? override : DEV_STUB_WALLET;
}

/**
 * Where the list lives.
 *
 * `.data/` beside the app rather than `public/`, which is served verbatim and would publish the file at
 * a guessable URL. Overridable with `BONEY_STUB_STORE` so a test can point it at a temp file.
 */
function storePath(): string {
  return process.env.BONEY_STUB_STORE ?? join(process.cwd(), ".data", "stub-wallets.json");
}

/**
 * The stored list, or null when there is no persisted list.
 *
 * Never throws. A missing file is the ordinary first-run state and an unreadable one is the ordinary
 * steady state on a read-only deploy; both mean "fall back to the defaults", which is a working app
 * rather than a crashing one. A file holding anything that is not an array of addresses is treated the
 * same way, because it is editable by hand and a typo there should not take the site down.
 */
function parseWallets(value: unknown): Set<string> | null {
  const list = (value as {wallets?: unknown})?.wallets;
  if (!Array.isArray(list)) return null;

  return new Set(
    list
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => STUB_ADDRESS_RE.test(entry)),
  );
}

function readFileStore(): Set<string> | null {
  try {
    return parseWallets(JSON.parse(readFileSync(storePath(), "utf8")));
  } catch {
    return null;
  }
}

const BLOB_STORE = "stub-wallets";
const BLOB_KEY = "wallets";

function blobsBacked(): boolean {
  if (process.env.BONEY_STUB_STORE) return false;
  const injected = (globalThis as {netlifyBlobsContext?: unknown}).netlifyBlobsContext;
  return Boolean(process.env.NETLIFY_BLOBS_CONTEXT || injected);
}

function blobStore(): ReturnType<typeof getStore> {
  return getStore({name: BLOB_STORE, consistency: "strong"});
}

type ReadResult = {ok: true; wallets: Set<string> | null} | {ok: false};

async function readPersisted(): Promise<ReadResult> {
  try {
    if (blobsBacked()) {
      const value = await blobStore().get(BLOB_KEY, {type: "json"});
      return {ok: true, wallets: value === null ? null : parseWallets(value)};
    }
    return {ok: true, wallets: readFileStore()};
  } catch {
    return {ok: false};
  }
}

function parseEnvList(): Set<string> {
  const raw = process.env[ENV_KEY];
  if (!raw) return new Set();

  return new Set(
    raw
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter((value) => STUB_ADDRESS_RE.test(value)),
  );
}

function fallbackWallets(): Set<string> {
  const wallets = parseEnvList();
  for (const wallet of DEFAULT_STUB_WALLETS) wallets.add(wallet);
  return wallets;
}

/** The list in force. Persisted storage wins outright; otherwise defaults union env. */
async function resolve(): Promise<{wallets: Set<string>; readable: boolean; persisted: boolean}> {
  const result = await readPersisted();
  if (!result.ok) return {wallets: fallbackWallets(), readable: false, persisted: false};
  if (result.wallets) return {wallets: result.wallets, readable: true, persisted: true};
  return {wallets: fallbackWallets(), readable: true, persisted: false};
}

/**
 * Write the whole set, reporting whether the filesystem accepted it.
 *
 * `process.env` is updated either way, so a failed write still applies to this instance. An allowlist
 * that silently did nothing would send someone chasing a score bug instead of a filesystem one;
 * returning false is what lets the route say which it was.
 */
async function persist(wallets: Set<string>): Promise<boolean> {
  const sorted = [...wallets].sort();
  process.env[ENV_KEY] = sorted.join(",");

  try {
    if (blobsBacked()) {
      await blobStore().setJSON(BLOB_KEY, {wallets: sorted});
      return true;
    }
    const path = storePath();
    mkdirSync(dirname(path), {recursive: true});
    writeFileSync(path, `${JSON.stringify({wallets: sorted}, null, 2)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the list being served is backed by the store file.
 *
 * False means it is coming from the committed defaults and `BONEY_STUB_WALLETS` — correct, but not
 * somewhere a change can be written back to. Reported by `GET` so the panel can say so without having
 * to attempt a write first.
 */
export async function isStubListPersisted(): Promise<boolean> {
  const result = await resolve();
  return result.persisted;
}

export type StubWalletUpdate = {wallets: string[]; persisted: boolean};

export async function addStubWallet(wallet: string): Promise<StubWalletUpdate> {
  const normalized = normalizeStubWallet(wallet);
  if (!normalized) throw new Error("Invalid wallet address.");

  const result = await resolve();
  const wallets = result.wallets;
  wallets.add(normalized);
  return {wallets: [...wallets].sort(), persisted: result.readable && (await persist(wallets))};
}

export async function removeStubWallet(wallet: string): Promise<StubWalletUpdate> {
  const normalized = normalizeStubWallet(wallet);
  if (!normalized) throw new Error("Invalid wallet address.");

  const result = await resolve();
  const wallets = result.wallets;
  wallets.delete(normalized);
  return {wallets: [...wallets].sort(), persisted: result.readable && (await persist(wallets))};
}

export async function listStubWallets(): Promise<string[]> {
  return [...(await resolve()).wallets].sort();
}

export function isStubbedWallet(wallet: string | undefined, wallets: ReadonlySet<string>): boolean {
  if (!wallet) return false;
  const normalized = normalizeStubWallet(wallet);
  return normalized ? wallets.has(normalized) : false;
}

/** Reads one request's allowlist snapshot. */
export async function loadStubWallets(): Promise<Set<string>> {
  return (await resolve()).wallets;
}
