import {describe, it, expect, afterEach, beforeEach, vi} from "vitest";
import {mkdirSync, mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {
  fetchEthosProfile,
  xHandleOf,
  fetchFollowers,
  fetchSmartFollowers,
  buildScoreReport,
  isAddress,
  EthosError,
  type EthosProfile,
} from "./ethos";
import {addStubWallet, removeStubWallet, listStubWallets, isStubbedWallet} from "./stubWalletStore";
import {DEV_STUB_WALLET} from "./stubWallets";
import {stubFiguresFor} from "./stubProfile";
import {reachFromFollowers} from "./boneyscore";

/**
 * Ethos client tests.
 *
 * The mocked suite pins the *refusal* rules, which are the security-relevant half of this module:
 * every path that must not produce an attestation, and every path that must degrade to zero reach
 * instead of failing. Addresses here are obviously fake so nothing depends on a stranger's live
 * reputation staying put.
 *
 * The live suite at the bottom runs only with `LIVE_ETHOS=1` and asserts the real API still behaves
 * the way this module assumes — the same opt-in shape `live.test.ts` uses for the chain. Ethos is a
 * third-party service whose contract can shift under us, so those assumptions are worth a periodic
 * check without making every `pnpm test` depend on the network.
 */

/** Fake wallets — the mocked suite never reaches the network, so these need only be well-formed. */
const WALLET = "0x1111111111111111111111111111111111111111" as const;
const MIXED_CASE = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01" as const;

/** A claimed, ACTIVE Ethos profile: `zp_land`, profileId 20. Used only by the live suite. */
const LIVE_CLAIMED = "0xBF47fE944705AeD612143C49315AE0D9161C7A97" as const;
/** Ethos 200s this one but leaves `profileId` null — known address, unclaimed profile. */
const LIVE_UNCLAIMED = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" as const;
/** Well-formed and, as far as Ethos is concerned, nonexistent: answers 404. */
const LIVE_UNKNOWN = "0x9a3f8b2c1d4e5f60718293a4b5c6d7e8f9012345" as const;

type Reply = {status?: number; body?: unknown; throws?: boolean};

/** Records every requested URL and replies per the handler. */
function stubFetch(handler: (url: string) => Reply) {
  const urls: string[] = [];
  vi.stubGlobal("fetch", async (input: unknown) => {
    const url = String(input);
    urls.push(url);
    const {status = 200, body = {}, throws} = handler(url);
    if (throws) throw new Error("network down");
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  });
  return urls;
}

const profile = (over: Partial<EthosProfile> = {}): EthosProfile => ({
  score: 2034,
  profileId: 20,
  status: "ACTIVE",
  username: "zp_land",
  userkeys: ["address:0x1", "service:x.com:1520516860155944960"],
  ...over,
});

const originalEnv = {
  ETHOS_API: process.env.ETHOS_API,
  FXTWITTER_API: process.env.FXTWITTER_API,
  VXTWITTER_API: process.env.VXTWITTER_API,
  KAITO_API: process.env.KAITO_API,
  BONEY_STUB_WALLETS: process.env.BONEY_STUB_WALLETS,
  BONEY_STUB_STORE: process.env.BONEY_STUB_STORE,
};

/**
 * A throwaway store path, set before anything can write.
 *
 * `addStubWallet` persists to `.data/stub-wallets.json` by default, and a test that materialised that
 * file would not just litter — the file *wins* over the committed defaults, so it would silently
 * change which wallets the dev server stubs. Every test in this file redirects the store first.
 */
const STORE_DIR = mkdtempSync(join(tmpdir(), "boney-stub-ethos-"));

beforeEach(() => {
  process.env.BONEY_STUB_STORE = join(STORE_DIR, "stub-wallets.json");
  delete process.env.BONEY_STUB_WALLETS;
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(STORE_DIR, {recursive: true, force: true});
  mkdirSync(STORE_DIR, {recursive: true});
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("stub wallet routing", () => {
  it("uses the live Ethos API by default for real wallets", async () => {
    process.env.ETHOS_API = "https://live-ethos.example";

    const urls = stubFetch(() => ({body: profile()}));
    await fetchEthosProfile(WALLET);

    expect(urls[0]).toContain("https://live-ethos.example/api/v2/user/by/address/");
    expect(isStubbedWallet(WALLET)).toBe(false);
  });

  /**
   * The allowlisted path must not touch the network at all. Asserting "no fetch" rather than "fetched
   * a stub URL" is the whole point of the in-process design: a loopback stub cannot be reached from a
   * deploy, so a request escaping here would work locally and fail there.
   */
  it("serves an allowlisted wallet in-process, without any fetch", async () => {
    process.env.ETHOS_API = "https://live-ethos.example";
    process.env.FXTWITTER_API = "https://live-x.example";

    addStubWallet(WALLET);
    expect(isStubbedWallet(WALLET)).toBe(true);
    expect(listStubWallets()).toContain(WALLET.toLowerCase());

    const urls = stubFetch(() => ({body: profile()}));
    const report = await buildScoreReport(WALLET);

    expect(urls).toEqual([]);

    const figures = stubFiguresFor(WALLET);
    expect(report.ethos).toBe(figures.score);
    expect(report.followers).toBe(figures.followers);
    expect(report.handle).toBe(figures.handle);
  });

  it("stops stubbing a wallet once it is removed", async () => {
    process.env.ETHOS_API = "https://live-ethos.example";

    addStubWallet(WALLET);
    removeStubWallet(WALLET);
    expect(isStubbedWallet(WALLET)).toBe(false);

    const urls = stubFetch(() => ({body: profile()}));
    await fetchEthosProfile(WALLET);
    expect(urls[0]).toContain("https://live-ethos.example/api/v2/user/by/address/");
  });

  /**
   * The dev wallet is unclaimed on Ethos, so a fixture that depends on it cannot be driven unless it
   * is stubbed with no configuration at all — including on a deploy with nothing writable, where the
   * store file never comes into existence.
   */
  it("stubs the dev wallet with no configuration", () => {
    expect(isStubbedWallet(DEV_STUB_WALLET)).toBe(true);
  });
});

describe("isAddress", () => {
  it("accepts any hex case", () => {
    expect(isAddress(WALLET)).toBe(true);
    expect(isAddress(MIXED_CASE)).toBe(true);
    expect(isAddress(WALLET.toUpperCase().replace("0X", "0x"))).toBe(true);
  });

  it("rejects anything that is not 20 hex bytes", () => {
    expect(isAddress("0x123")).toBe(false);
    expect(isAddress(`${WALLET}00`)).toBe(false);
    expect(isAddress("0xZZZZef0123456789aBcDeF0123456789AbCdEf01")).toBe(false);
    expect(isAddress(WALLET.slice(2))).toBe(false);
    expect(isAddress(undefined)).toBe(false);
    expect(isAddress(null)).toBe(false);
    expect(isAddress(12345)).toBe(false);
  });
});

describe("fetchEthosProfile", () => {
  it("returns a claimed profile", async () => {
    stubFetch(() => ({body: profile()}));
    const result = await fetchEthosProfile(WALLET);
    expect(result.score).toBe(2034);
    expect(result.profileId).toBe(20);
    expect(result.status).toBe("ACTIVE");
    expect(result.username).toBe("zp_land");
  });

  it("lowercases the address, because Ethos enforces EIP-55 on mixed case", async () => {
    // A mixed-case address whose checksum does not compute earns a 400 from Ethos, which this
    // module would then report as "could not reach Ethos". Normalising sidesteps the whole class.
    const urls = stubFetch(() => ({body: profile()}));
    await fetchEthosProfile(MIXED_CASE);
    expect(urls[0]).toContain(MIXED_CASE.toLowerCase());
    expect(urls[0]).not.toContain(MIXED_CASE);
  });

  it("refuses an invalid address without calling out", async () => {
    const urls = stubFetch(() => ({body: profile()}));
    await expect(fetchEthosProfile("0xnope")).rejects.toThrow(EthosError);
    expect(urls).toHaveLength(0);
  });

  /**
   * The regression this suite exists for. A wallet Ethos has never seen 404s, and mapping that to
   * `ethos_unavailable` told a new promoter the service was broken when the real answer was "go claim a
   * profile" — the single most common outcome for a first-time visitor.
   */
  it("treats a 404 as an unclaimed profile, not an outage", async () => {
    stubFetch(() => ({status: 404, body: {code: "NOT_FOUND", message: "User not found"}}));
    const error = await fetchEthosProfile(WALLET).catch((e) => e as EthosError);
    expect(error).toBeInstanceOf(EthosError);
    expect(error.code).toBe("no_ethos_profile");
    expect(error.httpStatus).toBe(400);
    expect(error.message).toMatch(/claim/i);
  });

  it("refuses a known-but-unclaimed profile", async () => {
    // Ethos answers 200 with a real score for addresses it resolved via ENS or saw in someone
    // else's graph. Attesting those would mint reputation for a profile nobody controls.
    stubFetch(() => ({body: profile({profileId: null, status: "INACTIVE", username: null})}));
    const error = await fetchEthosProfile(WALLET).catch((e) => e as EthosError);
    expect(error.code).toBe("no_ethos_profile");
    expect(error.httpStatus).toBe(400);
  });

  it("refuses when profileId is absent entirely", async () => {
    const {profileId: _drop, ...withoutId} = profile();
    stubFetch(() => ({body: withoutId}));
    const error = await fetchEthosProfile(WALLET).catch((e) => e as EthosError);
    expect(error.code).toBe("no_ethos_profile");
  });

  it("reports a genuine upstream failure as unavailable", async () => {
    stubFetch(() => ({status: 500}));
    const error = await fetchEthosProfile(WALLET).catch((e) => e as EthosError);
    expect(error.code).toBe("ethos_unavailable");
    expect(error.httpStatus).toBe(502);
  });

  it("reports a network error as unavailable", async () => {
    stubFetch(() => ({throws: true}));
    const error = await fetchEthosProfile(WALLET).catch((e) => e as EthosError);
    expect(error.code).toBe("ethos_unavailable");
    expect(error.httpStatus).toBe(502);
  });

  it("rejects a payload with no numeric score", async () => {
    stubFetch(() => ({body: {profileId: 20, score: "high"}}));
    const error = await fetchEthosProfile(WALLET).catch((e) => e as EthosError);
    expect(error.code).toBe("ethos_unavailable");
  });

  it("defaults the optional fields", async () => {
    stubFetch(() => ({body: {score: 1500, profileId: 7}}));
    const result = await fetchEthosProfile(WALLET);
    expect(result.status).toBeNull();
    expect(result.username).toBeNull();
    expect(result.userkeys).toEqual([]);
  });
});

describe("xHandleOf", () => {
  it("prefers the username", () => {
    expect(xHandleOf(profile({username: "zp_land"}))).toBe("zp_land");
  });

  it("falls back to the x.com userkey id", () => {
    const handle = xHandleOf(profile({username: null}));
    expect(handle).toBe("1520516860155944960");
  });

  it("returns null with no X link at all", () => {
    expect(xHandleOf(profile({username: null, userkeys: ["address:0x1"]}))).toBeNull();
    expect(xHandleOf(profile({username: null, userkeys: []}))).toBeNull();
  });

  it("returns null for an empty userkey id", () => {
    expect(xHandleOf(profile({username: null, userkeys: ["service:x.com:"]}))).toBeNull();
  });
});

describe("fetchFollowers", () => {
  const fx = (url: string) => url.includes("fxtwitter");
  const vx = (url: string) => url.includes("vxtwitter");

  it("uses the primary source when it has a count", async () => {
    const urls = stubFetch((url) => (fx(url) ? {body: {user: {followers: 24_000}}} : {body: {}}));
    expect(await fetchFollowers("zp_land")).toBe(24_000);
    // Nothing to gain from the fallback once the primary answered.
    expect(urls.filter(vx)).toHaveLength(0);
  });

  /**
   * A zero has to fall through rather than being trusted. Every source observed so far reports a
   * handle it cannot read as 0 while still returning a well-formed body, so a zero is
   * indistinguishable from a genuinely empty account — and this is precisely how the retired gomtu
   * proxy failed, quietly, for months.
   */
  it("falls through when the primary reports zero", async () => {
    stubFetch((url) =>
      fx(url) ? {body: {code: 200, user: {followers: 0}}} : {body: {followers_count: 7_336_664}},
    );
    expect(await fetchFollowers("VitalikButerin")).toBe(7_336_664);
  });

  it("falls through when the primary fails", async () => {
    stubFetch((url) => (fx(url) ? {throws: true} : {body: {followers_count: 1_234}}));
    expect(await fetchFollowers("someone")).toBe(1_234);
  });

  it("falls through on a 404 from the primary", async () => {
    stubFetch((url) =>
      fx(url) ? {status: 404, body: {code: 404, message: "User not found"}} : {body: {followers_count: 99}},
    );
    expect(await fetchFollowers("renamed_account")).toBe(99);
  });

  it("degrades to zero when both sources are useless", async () => {
    stubFetch((url) => (fx(url) ? {body: {user: {followers: 0}}} : {body: {followers_count: 0}}));
    expect(await fetchFollowers("small_account")).toBe(0);
  });

  it("degrades to zero when both sources fail", async () => {
    // Reach is the soft half of BoneyScore: an outage in the least reliable dependency in the
    // system must cost a promoter their reach points, never their ability to join.
    stubFetch(() => ({throws: true}));
    expect(await fetchFollowers("anyone")).toBe(0);
  });

  it("degrades to zero on a malformed payload", async () => {
    stubFetch(() => ({body: {user: {followers: "lots"}}}));
    expect(await fetchFollowers("anyone")).toBe(0);
  });

  it("never asks the retired gomtu twitter proxy", async () => {
    // It answered `followersCount: 0` for effectively every handle, so it only ever cost a lookup.
    const urls = stubFetch(() => ({body: {user: {followers: 500}}}));
    await fetchFollowers("anyone");
    expect(urls.filter((u) => u.includes("/twitter/user/profile"))).toHaveLength(0);
  });

  it("url-encodes the handle", async () => {
    const urls = stubFetch(() => ({body: {}}));
    await fetchFollowers("a b&c");
    expect(urls[0]).toContain("a%20b%26c");
    expect(urls[0]).not.toContain("a b&c");
  });
});

describe("fetchSmartFollowers", () => {
  it("reads Kaito's smart follower count", async () => {
    stubFetch(() => ({body: {data: {smart_follower_count: 14_220, follower_count: 5_942}}}));
    expect(await fetchSmartFollowers("VitalikButerin")).toBe(14_220);
  });

  /**
   * The bug this separation exists to prevent. Kaito's `follower_count` is not a total follower
   * count — it reads 5,942 for an account with 7.3M followers. The old ladder fell back to it
   * whenever the primary source failed, so a promoter's reach silently collapsed by three orders of
   * magnitude. Smart followers are now their own signal and never reach `reachFromFollowers`.
   */
  it("never returns Kaito's follower_count", async () => {
    stubFetch(() => ({body: {data: {smart_follower_count: 0, follower_count: 5_942}}}));
    expect(await fetchSmartFollowers("VitalikButerin")).toBe(0);
  });

  it("degrades to zero when Kaito does not track the handle", async () => {
    stubFetch(() => ({body: {data: {smart_follower_count: 0}}}));
    expect(await fetchSmartFollowers("unknown")).toBe(0);
  });

  it("degrades to zero when Kaito is down", async () => {
    stubFetch(() => ({throws: true}));
    expect(await fetchSmartFollowers("anyone")).toBe(0);
  });
});

describe("buildScoreReport", () => {
  it("composes the score from Ethos plus a follower count", async () => {
    stubFetch((url) => {
      if (url.includes("/user/by/address/")) return {body: profile()};
      if (url.includes("fxtwitter")) return {body: {user: {followers: 24_000}}};
      if (url.includes("/kaito/user_status")) return {body: {data: {smart_follower_count: 310}}};
      return {body: {}};
    });

    const report = await buildScoreReport(WALLET);
    expect(report.ethos).toBe(2034);
    expect(report.followers).toBe(24_000);
    expect(report.reach).toBe(reachFromFollowers(24_000));
    expect(report.handle).toBe("zp_land");
    expect(report.profileId).toBe(20);
    expect(report.status).toBe("ACTIVE");
  });

  it("reports smart followers alongside the total, without scoring them", async () => {
    stubFetch((url) => {
      if (url.includes("/user/by/address/")) return {body: profile()};
      if (url.includes("fxtwitter")) return {body: {user: {followers: 7_375_685}}};
      if (url.includes("/kaito/user_status")) return {body: {data: {smart_follower_count: 14_220}}};
      return {body: {}};
    });

    const report = await buildScoreReport(WALLET);
    expect(report.smartFollowers).toBe(14_220);
    // Reach comes from the total only; the smart count is display data.
    expect(report.reach).toBe(reachFromFollowers(7_375_685));
  });

  it("skips both follower lookups with no linked X account", async () => {
    const urls = stubFetch((url) =>
      url.includes("/user/by/address/")
        ? {body: profile({username: null, userkeys: ["address:0x1"]})}
        : {body: {user: {followers: 99}}},
    );

    const report = await buildScoreReport(WALLET);
    expect(report.handle).toBeNull();
    expect(report.followers).toBe(0);
    expect(report.smartFollowers).toBe(0);
    expect(report.reach).toBe(0);
    expect(urls).toHaveLength(1);
  });

  it("still produces a report when the follower sources are down", async () => {
    stubFetch((url) => (url.includes("/user/by/address/") ? {body: profile()} : {throws: true}));

    const report = await buildScoreReport(WALLET);
    expect(report.ethos).toBe(2034);
    expect(report.followers).toBe(0);
    expect(report.smartFollowers).toBe(0);
    expect(report.reach).toBe(0);
  });

  it("propagates a refusal rather than scoring an unclaimed wallet", async () => {
    stubFetch(() => ({status: 404}));
    const error = await buildScoreReport(WALLET).catch((e) => e as EthosError);
    expect(error).toBeInstanceOf(EthosError);
    expect(error.code).toBe("no_ethos_profile");
  });
});

/**
 * Live checks against the real Ethos API — `LIVE_ETHOS=1 pnpm test`.
 *
 * These assert the upstream contract this module is built on, not our own arithmetic: that 404 still
 * means unknown wallet, that an unclaimed profile still arrives as a 200 carrying a score, and that
 * a claimed one still exposes the X handle reach depends on. Scores drift, so nothing here asserts
 * an exact number.
 *
 * Each test carries an explicit timeout: these reach three separate third-party services, and
 * `fetchFollowers` walks its whole source ladder before giving up, so the default 5s is not enough
 * for a fallback path to run to completion.
 */
describe.skipIf(!process.env.LIVE_ETHOS)("live Ethos API", () => {
  /** Generous enough for a full ladder traversal with one source timing out. */
  const LIVE_TIMEOUT = 30_000;
  it("resolves a claimed profile and its X handle", async () => {
    const result = await fetchEthosProfile(LIVE_CLAIMED);
    expect(result.profileId).toBe(20);
    expect(result.status).toBe("ACTIVE");
    expect(result.score).toBeGreaterThan(0);
    expect(xHandleOf(result)).toBe("zp_land");
  }, LIVE_TIMEOUT);

  it("accepts a checksummed address and its lowercase form alike", async () => {
    const [checksummed, lowercased] = await Promise.all([
      fetchEthosProfile(LIVE_CLAIMED),
      fetchEthosProfile(LIVE_CLAIMED.toLowerCase()),
    ]);
    expect(checksummed.profileId).toBe(lowercased.profileId);
  }, LIVE_TIMEOUT);

  it("404s an address it has no record of", async () => {
    const error = await fetchEthosProfile(LIVE_UNKNOWN).catch((e) => e as EthosError);
    expect(error).toBeInstanceOf(EthosError);
    expect(error.code).toBe("no_ethos_profile");
    expect(error.httpStatus).toBe(400);
  }, LIVE_TIMEOUT);

  it("still refuses a known address with no claimed profile", async () => {
    // Carries a real score despite being unclaimed — precisely why profileId, not score, decides.
    const error = await fetchEthosProfile(LIVE_UNCLAIMED).catch((e) => e as EthosError);
    expect(error).toBeInstanceOf(EthosError);
    expect(error.code).toBe("no_ethos_profile");
  }, LIVE_TIMEOUT);

  it("builds a full report for a claimed wallet", async () => {
    const report = await buildScoreReport(LIVE_CLAIMED);
    expect(report.ethos).toBeGreaterThan(0);
    expect(report.handle).toBe("zp_land");
    // Follower sources are unreliable by design here; only the invariant is safe to assert.
    expect(report.reach).toBe(reachFromFollowers(report.followers));
    expect(report.reach).toBeLessThanOrEqual(2800);
  }, LIVE_TIMEOUT);

  it("never throws from the follower lookup", async () => {
    await expect(fetchFollowers("VitalikButerin")).resolves.toBeTypeOf("number");
    await expect(fetchFollowers("no_such_handle_9f8a7b6c5d")).resolves.toBe(0);
  }, LIVE_TIMEOUT);

  /**
   * The check that the retired gomtu proxy would have failed. A source that answers but returns 0
   * is worse than one that errors, because it degrades reach silently — so assert a real count for a
   * handle with millions of followers, not merely that something came back.
   */
  it("returns a real follower count for a large account", async () => {
    expect(await fetchFollowers("VitalikButerin")).toBeGreaterThan(1_000_000);
  }, LIVE_TIMEOUT);

  it("resolves a small account too, not just famous ones", async () => {
    expect(await fetchFollowers("peceka")).toBeGreaterThan(0);
  }, LIVE_TIMEOUT);

  it("keeps smart followers well below the total", async () => {
    // Guards the confusion that motivated splitting them: Kaito's number is a different signal, and
    // if it ever exceeded the total that would mean the two got crossed somewhere.
    const [total, smart] = await Promise.all([
      fetchFollowers("VitalikButerin"),
      fetchSmartFollowers("VitalikButerin"),
    ]);
    expect(smart).toBeLessThan(total);
  }, LIVE_TIMEOUT);
});
