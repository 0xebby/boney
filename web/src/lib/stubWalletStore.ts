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
 * The stored list, or null when there is no usable file.
 *
 * Never throws. A missing file is the ordinary first-run state and an unreadable one is the ordinary
 * steady state on a read-only deploy; both mean "fall back to the defaults", which is a working app
 * rather than a crashing one. A file holding anything that is not an array of addresses is treated the
 * same way, because it is editable by hand and a typo there should not take the site down.
 */
function readStore(): Set<string> | null {
  try {
    const parsed = JSON.parse(readFileSync(storePath(), "utf8"));
    const list = (parsed as {wallets?: unknown})?.wallets;
    if (!Array.isArray(list)) return null;

    return new Set(
      list
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim().toLowerCase())
        .filter((value) => STUB_ADDRESS_RE.test(value)),
    );
  } catch {
    return null;
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

/** The list in force. The file wins outright; otherwise defaults ∪ env. */
function resolve(): Set<string> {
  const stored = readStore();
  if (stored) return stored;

  const wallets = parseEnvList();
  for (const wallet of DEFAULT_STUB_WALLETS) wallets.add(wallet);
  return wallets;
}

/**
 * Write the whole set, reporting whether the filesystem accepted it.
 *
 * `process.env` is updated either way, so a failed write still applies to this instance. An allowlist
 * that silently did nothing would send someone chasing a score bug instead of a filesystem one;
 * returning false is what lets the route say which it was.
 */
function persist(wallets: Set<string>): boolean {
  const sorted = [...wallets].sort();
  process.env[ENV_KEY] = sorted.join(",");

  try {
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
export function isStubListPersisted(): boolean {
  return readStore() !== null;
}

export type StubWalletUpdate = {wallets: string[]; persisted: boolean};

export function addStubWallet(wallet: string): StubWalletUpdate {
  const normalized = normalizeStubWallet(wallet);
  if (!normalized) throw new Error("Invalid wallet address.");

  const wallets = resolve();
  wallets.add(normalized);
  return {wallets: [...wallets].sort(), persisted: persist(wallets)};
}

export function removeStubWallet(wallet: string): StubWalletUpdate {
  const normalized = normalizeStubWallet(wallet);
  if (!normalized) throw new Error("Invalid wallet address.");

  const wallets = resolve();
  wallets.delete(normalized);
  return {wallets: [...wallets].sort(), persisted: persist(wallets)};
}

export function listStubWallets(): string[] {
  return [...resolve()].sort();
}

export function isStubbedWallet(wallet: string | undefined): boolean {
  if (!wallet) return false;
  const normalized = normalizeStubWallet(wallet);
  return normalized ? resolve().has(normalized) : false;
}
