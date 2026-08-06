import {describe, it, expect} from "vitest";
import {fetchCampaignDetail, fetchPromoterState} from "./campaignDetail";
import {CampaignAbi} from "./abis";

/**
 * Detail-layer decode tests.
 *
 * These use a fake client rather than a chain. They are not testing "does the RPC work" — they
 * pin two properties that broke in practice:
 *
 *  - every field decodes from the function that actually supplies it (a `readContract` call is
 *    named, so this catches a field wired to the wrong read);
 *  - every read in one record is pinned to a single block, so the record cannot straddle a block
 *    and report a `paidOut` that disagrees with `remainingPool`.
 *
 * The live-chain test in `live.test.ts` covers the real ABI round trip — a mock cannot disagree
 * with the chain, which is exactly how the Multicall3 failure got through.
 */

type Call = {
  functionName: string;
  args?: readonly unknown[];
  blockNumber?: bigint;
  address?: string;
  abi?: readonly unknown[];
};

const BLOCK = BigInt(4_242);
const ADDRESS = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const PROMOTER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const PROJECT = "0xcccccccccccccccccccccccccccccccccccccccc" as const;
const TOKEN = "0xdddddddddddddddddddddddddddddddddddddddd" as const;
const VERIFIER = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as const;
const PROMOTER_ID = `0x${"11".repeat(32)}` as const;
const ZERO_ID = `0x${"00".repeat(32)}` as const;
const VAULT = "0xffffffffffffffffffffffffffffffffffffffff" as const;

/** Values keyed by the function name each slot corresponds to, so order is asserted not assumed. */
const SCALARS: Record<string, unknown> = {
  project: PROJECT,
  token: TOKEN,
  rewardPool: BigInt(1_000_000),
  paidOut: BigInt(250_000),
  remainingPool: BigInt(750_000),
  startTime: BigInt(1_700_000_000),
  endTime: BigInt(1_700_600_000),
  endedAt: BigInt(1_700_500_000),
  attributionWindow: BigInt(86_400),
  minReputation: BigInt(42),
  status: 3, // Ended
  CLAIM_GRACE: BigInt(7 * 86_400),
  kpiCount: BigInt(2),
  escrowVault: VAULT,
};

/**
 * Vault custody, deliberately different from `remainingPool` above.
 *
 * The two are not the same quantity — `remainingPool()` is `rewardPool - paidOut` (accounting)
 * while this is what the vault actually holds. Giving them different values means a test that
 * confuses the two fails instead of passing by coincidence.
 */
const ESCROW_BALANCE = BigInt(600_000);

const KPI_SPECS = [
  {kind: 1, verifier: VERIFIER, target: BigInt(500), aggregate: false, params: "0x" as const},
  {kind: 7, verifier: VERIFIER, target: BigInt(9_000), aggregate: true, params: "0xbeef" as const},
];

const LADDERS = [
  [
    {threshold: BigInt(100), reward: BigInt(10_000)},
    {threshold: BigInt(400), reward: BigInt(50_000)},
  ],
  [{threshold: BigInt(9_000), reward: BigInt(120_000)}],
];

const TOTALS = [BigInt(275), BigInt(9_500)];

const PROGRESS = [BigInt(275), BigInt(9_500)];
const SETTLED = [BigInt(1), BigInt(0)];

/**
 * Fake client that answers by function name.
 *
 * Also records every call so the tests can assert *how* the reads were issued, not just what
 * they decoded to — the block pinning is a correctness property worth locking down.
 */
function makeClient(overrides: Record<string, unknown> = {}) {
  const scalars = {...SCALARS, ...overrides};
  const calls: Call[] = [];
  /** Options each `getBlockNumber` call was made with, so the cache bypass is assertable. */
  const blockNumberOpts: (Record<string, unknown> | undefined)[] = [];

  const client = {
    getBlockNumber: async (opts?: Record<string, unknown>) => {
      blockNumberOpts.push(opts);
      return BLOCK;
    },
    readContract: async (c: Call) => {
      calls.push(c);
      switch (c.functionName) {
        case "balanceOf":
          return overrides.balanceOf ?? ESCROW_BALANCE;
        case "kpi":
          return KPI_SPECS[Number(c.args![0])];
        case "tiers":
          return LADDERS[Number(c.args![0])];
        case "totalProgress":
          return TOTALS[Number(c.args![0])];
        case "promoterIdOf":
          return overrides.promoterIdOf ?? PROMOTER_ID;
        case "progressOf":
          return PROGRESS[Number(c.args![1])];
        case "settledTiersOf":
          return SETTLED[Number(c.args![1])];
        default:
          return scalars[c.functionName];
      }
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  return {client, calls, blockNumberOpts};
}

describe("fetchCampaignDetail", () => {
  it("decodes every scalar into the right field", async () => {
    const detail = await fetchCampaignDetail(makeClient().client, ADDRESS);

    expect(detail.address).toBe(ADDRESS);
    expect(detail.project).toBe(PROJECT);
    expect(detail.token).toBe(TOKEN);
    expect(detail.rewardPool).toBe(BigInt(1_000_000));
    expect(detail.paidOut).toBe(BigInt(250_000));
    expect(detail.remainingPool).toBe(BigInt(750_000));
    expect(detail.startTime).toBe(BigInt(1_700_000_000));
    expect(detail.endTime).toBe(BigInt(1_700_600_000));
    expect(detail.attributionWindow).toBe(BigInt(86_400));
    expect(detail.minReputation).toBe(BigInt(42));
    expect(detail.claimGrace).toBe(BigInt(7 * 86_400));
  });

  it("keeps endedAt distinct from endTime", async () => {
    // These are different facts and the reclaim math depends on endedAt. Wiring the field to
    // the wrong read would make the grace countdown wrong by the gap between the two.
    const detail = await fetchCampaignDetail(makeClient().client, ADDRESS);
    expect(detail.endedAt).toBe(BigInt(1_700_500_000));
    expect(detail.endedAt).not.toBe(detail.endTime);
  });

  it("pins every read to one block", async () => {
    // An un-pinned record can straddle a block: paidOut from block N and remainingPool from
    // N+1 would not sum to the pool. Every read must carry the same explicit blockNumber.
    const {client, calls} = makeClient();
    const detail = await fetchCampaignDetail(client, ADDRESS);

    expect(detail.blockNumber).toBe(BLOCK);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.blockNumber, `${c.functionName} was not pinned`).toBe(BLOCK);
    }
  });

  it("honors an explicitly supplied block", async () => {
    const {client, calls} = makeClient();
    const pinned = BigInt(99);
    const detail = await fetchCampaignDetail(client, ADDRESS, pinned);

    expect(detail.blockNumber).toBe(pinned);
    expect(calls.every((c) => c.blockNumber === pinned)).toBe(true);
  });

  it("does not use multicall — anvil has no Multicall3", async () => {
    // viem's multicall needs a Multicall3 deployment at the canonical address. A stock anvil
    // node has none, so a batched read throws ChainDoesNotSupportContract against a live local
    // chain. A client without a multicall method proves the detail path never reaches for it.
    const {client} = makeClient();
    expect(client.multicall).toBeUndefined();
    await expect(fetchCampaignDetail(client, ADDRESS)).resolves.toBeDefined();
  });

  it("maps the numeric status to its label", async () => {
    const detail = await fetchCampaignDetail(makeClient().client, ADDRESS);
    expect(detail.status).toBe("Ended");

    const active = await fetchCampaignDetail(makeClient({status: 1}).client, ADDRESS);
    expect(active.status).toBe("Active");
  });

  it("decodes each KPI with its own ladder and progress", async () => {
    const detail = await fetchCampaignDetail(makeClient().client, ADDRESS);

    expect(detail.kpis).toHaveLength(2);

    expect(detail.kpis[0].index).toBe(0);
    expect(detail.kpis[0].spec.kind).toBe("Mint");
    expect(detail.kpis[0].spec.aggregate).toBe(false);
    expect(detail.kpis[0].spec.target).toBe(BigInt(500));
    expect(detail.kpis[0].tiers).toEqual(LADDERS[0]);
    expect(detail.kpis[0].totalProgress).toBe(BigInt(275));

    // The second KPI must not inherit the first one's ladder.
    expect(detail.kpis[1].spec.kind).toBe("Tvl");
    expect(detail.kpis[1].spec.aggregate).toBe(true);
    expect(detail.kpis[1].tiers).toEqual(LADDERS[1]);
    expect(detail.kpis[1].totalProgress).toBe(BigInt(9_500));
  });

  it("returns no KPIs when the count is zero, without a second stage", async () => {
    const {client, calls} = makeClient({kpiCount: BigInt(0)});
    const detail = await fetchCampaignDetail(client, ADDRESS);

    expect(detail.kpis).toEqual([]);
    expect(calls.some((c) => c.functionName === "kpi")).toBe(false);
  });

  it("requests exactly the reads the ABI exposes", async () => {
    // Guards against a typo'd functionName that would decode as undefined instead of throwing.
    // Each call is checked against the ABI it was actually issued with, not against Campaign's
    // alone: the escrow balance is read from the vault, so a single-ABI check would either fail
    // on a correct call or have to be loosened into checking nothing.
    const namesOf = (abi: readonly unknown[]) =>
      new Set(
        abi
          .filter((e) => (e as {type: string}).type === "function")
          .map((e) => (e as {name: string}).name),
      );

    const {client, calls} = makeClient();
    await fetchCampaignDetail(client, ADDRESS);

    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.abi, `${c.functionName} was issued without an ABI`).toBeDefined();
      expect(namesOf(c.abi!), `${c.functionName} is not on the ABI it was called with`).toContain(
        c.functionName,
      );
    }

    // And every scalar the record depends on is a real Campaign function.
    const campaignNames = namesOf(CampaignAbi);
    for (const name of Object.keys(SCALARS)) expect(campaignNames).toContain(name);
  });

  it("reads the escrow balance from the vault the campaign names, at the same block", async () => {
    // `activate` (NotFunded) and `reclaimUnspent` (NothingToReclaim) both check vault custody,
    // which is not derivable from any Campaign scalar.
    const {client, calls} = makeClient();
    const detail = await fetchCampaignDetail(client, ADDRESS);

    expect(detail.escrowBalance).toBe(ESCROW_BALANCE);
    // Distinct from the accounting remainder — see ESCROW_BALANCE.
    expect(detail.escrowBalance).not.toBe(detail.remainingPool);

    const balanceCall = calls.find((c) => c.functionName === "balanceOf");
    expect(balanceCall).toBeDefined();
    // Addressed to the vault, asking about the campaign — not the other way round.
    expect(balanceCall!.address).toBe(VAULT);
    expect(balanceCall!.args).toEqual([ADDRESS]);
    expect(balanceCall!.blockNumber).toBe(BLOCK);
  });

  it("resolves the pin block with the cache bypassed", async () => {
    // Regression. viem memoizes `getBlockNumber` for `cacheTime` ms (default: the 4s polling
    // interval). A refetch issued immediately after a write therefore got the *pre-write* block
    // and every pinned read returned pre-write state — funding landed on chain while the panel
    // kept showing "Escrow holds 0" and left `activate` disabled behind a stale NotFunded.
    //
    // The mock has no cache, so this asserts the *call*, not the effect: only a live chain can
    // show the staleness, and only this can stop it silently coming back.
    const {client, blockNumberOpts} = makeClient();
    await fetchCampaignDetail(client, ADDRESS);

    expect(blockNumberOpts.length).toBeGreaterThan(0);
    for (const opts of blockNumberOpts) {
      expect(opts, "getBlockNumber was called without options").toBeDefined();
      expect(opts!.cacheTime, "getBlockNumber must bypass viem's cache").toBe(0);
    }
  });

  it("does not re-resolve the block when the caller pins one", async () => {
    // An explicit block means the caller is composing a record across calls and needs them to
    // agree; asking the node again would defeat that.
    const {client, blockNumberOpts} = makeClient();
    await fetchCampaignDetail(client, ADDRESS, BigInt(999));
    expect(blockNumberOpts).toHaveLength(0);
  });
});

describe("fetchPromoterState", () => {
  it("reports joined with per-KPI progress and settled counts", async () => {
    const state = await fetchPromoterState(makeClient().client, ADDRESS, PROMOTER, 2);

    expect(state.joined).toBe(true);
    expect(state.promoterId).toBe(PROMOTER_ID);
    expect(state.perKpi).toEqual([
      {kpiIndex: 0, progress: BigInt(275), settledTiers: 1},
      {kpiIndex: 1, progress: BigInt(9_500), settledTiers: 0},
    ]);
  });

  it("pins the promoter reads to one block too", async () => {
    const {client, calls} = makeClient();
    await fetchPromoterState(client, ADDRESS, PROMOTER, 2);
    expect(calls.every((c) => c.blockNumber === BLOCK)).toBe(true);
  });

  it("treats a zero promoter id as not joined and skips the progress reads", async () => {
    const {client, calls} = makeClient({promoterIdOf: ZERO_ID});
    const state = await fetchPromoterState(client, ADDRESS, PROMOTER, 2);

    expect(state.joined).toBe(false);
    expect(state.perKpi).toEqual([]);
    expect(calls.some((c) => c.functionName === "progressOf")).toBe(false);
  });

  it("skips the reads when the campaign has no KPIs", async () => {
    const state = await fetchPromoterState(makeClient().client, ADDRESS, PROMOTER, 0);
    expect(state.joined).toBe(true);
    expect(state.perKpi).toEqual([]);
  });
});
