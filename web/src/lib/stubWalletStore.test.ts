import {describe, it, expect, afterEach, beforeEach} from "vitest";
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {
  addStubWallet,
  isStubListPersisted,
  isStubbedWallet,
  listStubWallets,
  removeStubWallet,
  stubAdminWallet,
} from "./stubWalletStore";
import {DEV_STUB_WALLET, canonicalStubAllowlistMessage, normalizeStubWallet} from "./stubWallets";

/**
 * The stub allowlist.
 *
 * Every test redirects `BONEY_STUB_STORE` first, because the default path is `.data/stub-wallets.json`
 * beside the running app and a materialised file *wins* over the committed defaults — a test that
 * wrote there would silently change which wallets the dev server stubs.
 *
 * The cases worth pinning are the ones where being wrong is invisible: the dev wallet being stubbed
 * with no configuration at all (otherwise the fixture cannot be driven on a fresh deploy), a removal
 * surviving a re-read (otherwise the panel reports a success that never held), and a corrupt file
 * reading as absent rather than throwing (otherwise a hand edit takes the site down).
 */

const WALLET = "0x1111111111111111111111111111111111111111" as const;
const OTHER = "0x2222222222222222222222222222222222222222" as const;

const originalEnv = {
  BONEY_STUB_WALLETS: process.env.BONEY_STUB_WALLETS,
  BONEY_STUB_STORE: process.env.BONEY_STUB_STORE,
  BONEY_STUB_ADMIN: process.env.BONEY_STUB_ADMIN,
};

let dir: string;
let storeFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "boney-stub-store-"));
  storeFile = join(dir, "stub-wallets.json");
  process.env.BONEY_STUB_STORE = storeFile;
  delete process.env.BONEY_STUB_WALLETS;
  delete process.env.BONEY_STUB_ADMIN;
});

afterEach(() => {
  rmSync(dir, {recursive: true, force: true});
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("defaults", () => {
  it("stubs the dev wallet with nothing configured", () => {
    expect(listStubWallets()).toEqual([DEV_STUB_WALLET]);
    expect(isStubbedWallet(DEV_STUB_WALLET)).toBe(true);
    expect(isStubListPersisted()).toBe(false);
  });

  it("accepts the dev wallet in any hex case", () => {
    const upper = `0x${DEV_STUB_WALLET.slice(2).toUpperCase()}`;
    expect(isStubbedWallet(upper)).toBe(true);
  });

  it("stubs nothing else", () => {
    expect(isStubbedWallet(WALLET)).toBe(false);
    expect(isStubbedWallet(undefined)).toBe(false);
    expect(isStubbedWallet("not-an-address")).toBe(false);
  });

  it("unions BONEY_STUB_WALLETS with the defaults", () => {
    process.env.BONEY_STUB_WALLETS = `${WALLET}, ${OTHER}`;
    expect(listStubWallets()).toEqual([WALLET, OTHER, DEV_STUB_WALLET].sort());
  });

  it("ignores malformed entries in BONEY_STUB_WALLETS", () => {
    process.env.BONEY_STUB_WALLETS = `${WALLET},nonsense,0x123`;
    expect(listStubWallets()).toEqual([WALLET, DEV_STUB_WALLET].sort());
  });
});

describe("writes", () => {
  it("persists an addition and reports that it did", () => {
    const result = addStubWallet(WALLET);
    expect(result.persisted).toBe(true);
    expect(result.wallets).toContain(WALLET);
    expect(isStubListPersisted()).toBe(true);
    expect(isStubbedWallet(WALLET)).toBe(true);
  });

  it("normalises a mixed-case address on the way in", () => {
    const {wallets} = addStubWallet("0xAbCdEf0123456789aBcDeF0123456789AbCdEf01");
    expect(wallets).toContain("0xabcdef0123456789abcdef0123456789abcdef01");
  });

  it("refuses an address that is not one", () => {
    expect(() => addStubWallet("0x123")).toThrow(/Invalid wallet address/);
  });

  /**
   * The case the merge-based design got wrong: with the defaults unioned in on every read, removing
   * the dev wallet is undone by the very next read. The file has to replace the defaults, not extend
   * them.
   */
  it("keeps a removed default removed", () => {
    const {persisted, wallets} = removeStubWallet(DEV_STUB_WALLET);
    expect(persisted).toBe(true);
    expect(wallets).not.toContain(DEV_STUB_WALLET);
    expect(isStubbedWallet(DEV_STUB_WALLET)).toBe(false);
    expect(listStubWallets()).toEqual([]);
  });

  it("is idempotent in both directions", () => {
    addStubWallet(WALLET);
    const twice = addStubWallet(WALLET);
    expect(twice.wallets.filter((w) => w === WALLET)).toHaveLength(1);

    removeStubWallet(WALLET);
    expect(removeStubWallet(WALLET).wallets).not.toContain(WALLET);
  });

  it("materialises the whole resolved set on first write, not just the change", () => {
    process.env.BONEY_STUB_WALLETS = OTHER;
    addStubWallet(WALLET);

    // The env var is no longer consulted once the file exists, so anything it contributed has to have
    // been written down or it would silently vanish.
    delete process.env.BONEY_STUB_WALLETS;
    expect(listStubWallets()).toEqual([WALLET, OTHER, DEV_STUB_WALLET].sort());
  });
});

describe("a store file that cannot be trusted", () => {
  it("reads unparseable JSON as absent", () => {
    writeFileSync(storeFile, "{ not json", "utf8");
    expect(isStubListPersisted()).toBe(false);
    expect(listStubWallets()).toEqual([DEV_STUB_WALLET]);
  });

  it("reads a file with no wallets array as absent", () => {
    writeFileSync(storeFile, JSON.stringify({wallets: "0xdeadbeef"}), "utf8");
    expect(listStubWallets()).toEqual([DEV_STUB_WALLET]);
  });

  it("drops junk entries but keeps the valid ones", () => {
    writeFileSync(storeFile, JSON.stringify({wallets: [WALLET, "0x1", 42, null]}), "utf8");
    expect(listStubWallets()).toEqual([WALLET]);
  });

  /**
   * An unwritable store still has to apply for the running instance — that is the Netlify case, where
   * the filesystem is read-only outside `/tmp`. Reporting `persisted: false` is how the panel can say
   * the change will not outlive a redeploy without pretending it failed.
   */
  it("still applies a change it could not write, and says so", () => {
    // A regular file where a directory would have to be: `mkdirSync` fails ENOTDIR, which is the
    // portable way to make the write fail without depending on permissions.
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "not a directory", "utf8");
    process.env.BONEY_STUB_STORE = join(blocker, "stub-wallets.json");

    const result = addStubWallet(WALLET);

    expect(result.persisted).toBe(false);
    expect(result.wallets).toContain(WALLET);
    expect(isStubbedWallet(WALLET)).toBe(true);
  });
});

describe("stubAdminWallet", () => {
  it("defaults to the dev wallet", () => {
    expect(stubAdminWallet()).toBe(DEV_STUB_WALLET);
  });

  it("takes a valid override", () => {
    process.env.BONEY_STUB_ADMIN = `0x${WALLET.slice(2).toUpperCase()}`;
    expect(stubAdminWallet()).toBe(WALLET);
  });

  /** An unset or malformed admin must never read as "anyone". */
  it("falls back rather than opening up on a malformed override", () => {
    process.env.BONEY_STUB_ADMIN = "everybody";
    expect(stubAdminWallet()).toBe(DEV_STUB_WALLET);

    process.env.BONEY_STUB_ADMIN = "";
    expect(stubAdminWallet()).toBe(DEV_STUB_WALLET);
  });
});

describe("canonicalStubAllowlistMessage", () => {
  it("names every field the server acts on", () => {
    const message = canonicalStubAllowlistMessage({
      action: "add",
      wallet: WALLET,
      chainId: 84532,
      issuedAt: 1787500000,
    });

    expect(message).toBe(
      [
        "Boney dev stub allowlist",
        "action: add",
        `wallet: ${WALLET}`,
        "chain: 84532",
        "issued: 1787500000",
      ].join("\n"),
    );
  });

  /**
   * Each of these is a distinct signature, which is what stops one from being lifted onto another
   * action, address, chain, or moment.
   */
  it("differs on every field", () => {
    const base = {action: "add", wallet: WALLET, chainId: 84532, issuedAt: 1} as const;
    const messages = new Set([
      canonicalStubAllowlistMessage(base),
      canonicalStubAllowlistMessage({...base, action: "remove"}),
      canonicalStubAllowlistMessage({...base, wallet: OTHER}),
      canonicalStubAllowlistMessage({...base, chainId: 31337}),
      canonicalStubAllowlistMessage({...base, issuedAt: 2}),
    ]);
    expect(messages.size).toBe(5);
  });

  it("signs the lowercase address, so case cannot change the message", () => {
    const lower = canonicalStubAllowlistMessage({
      action: "add",
      wallet: WALLET,
      chainId: 1,
      issuedAt: 1,
    });
    const upper = canonicalStubAllowlistMessage({
      action: "add",
      wallet: `0x${WALLET.slice(2).toUpperCase()}`,
      chainId: 1,
      issuedAt: 1,
    });
    expect(upper).toBe(lower);
  });
});

describe("normalizeStubWallet", () => {
  it("lowercases and trims", () => {
    expect(normalizeStubWallet(`  0x${WALLET.slice(2).toUpperCase()}  `)).toBe(WALLET);
  });

  it("rejects anything that is not 20 hex bytes", () => {
    expect(normalizeStubWallet("0x123")).toBeUndefined();
    expect(normalizeStubWallet(`${WALLET}00`)).toBeUndefined();
    expect(normalizeStubWallet(WALLET.slice(2))).toBeUndefined();
    expect(normalizeStubWallet(undefined as unknown as string)).toBeUndefined();
  });
});
