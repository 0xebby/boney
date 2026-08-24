import {describe, it, expect} from "vitest";
import {MAX_SPEC_READS, planSpecReads, summarizeKinds} from "./kpiSummary";
import {AMOUNT_MODE, encodeEventSource, eventTopic} from "./kpiSource";
import type {CampaignView, KpiKind, KpiSpec} from "./types";

const AAVE_POOL = "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27" as const;
const BUSD = "0x2755a4A19B9B4d3B1e9Bd1cDe3B5DB2A0f9AdCc2" as const;
const BASE_SEPOLIA = 84532;

const ZERO = "0x0000000000000000000000000000000000000000" as const;

/** A KPI reported by hand: `params` is `"0x"`, which is every campaign predating event sourcing. */
function reported(kind: KpiKind): KpiSpec {
  return {kind, verifier: ZERO, target: BigInt(100), aggregate: false, params: "0x"};
}

function sourced(
  kind: KpiKind,
  signature: string,
  source: `0x${string}`,
  overrides: {actorTopic?: 1 | 2 | 3} = {},
): KpiSpec {
  return {
    kind,
    verifier: ZERO,
    target: BigInt(100),
    aggregate: false,
    params: encodeEventSource({
      source,
      topic0: eventTopic(signature),
      actorTopic: overrides.actorTopic ?? 1,
      amountMode: AMOUNT_MODE.dataWord0,
      scale: BigInt(1e15),
    }),
  };
}

describe("summarizeKinds", () => {
  it("returns null for a campaign with no KPIs", () => {
    expect(summarizeKinds([])).toBeNull();
  });

  it("labels a single KPI with its kind", () => {
    const summary = summarizeKinds([reported("Deposit")]);

    expect(summary?.label).toBe("Deposits");
    expect(summary?.extra).toBe(0);
    expect(summary?.sortValue).toBe("Deposits");
  });

  it("counts only distinct further kinds", () => {
    const twoOfAKind = summarizeKinds([reported("TokenPurchase"), reported("TokenPurchase")]);
    const mixed = summarizeKinds([reported("TokenPurchase"), reported("signUps")]);

    // Two KPIs, one answer to "what does this measure" — a `+1` would promise a second thing.
    expect(twoOfAKind?.extra).toBe(0);
    expect(twoOfAKind?.title.split("\n")).toHaveLength(2);

    expect(mixed?.label).toBe("Token purchases");
    expect(mixed?.extra).toBe(1);
  });

  it("says which KPIs the project reports itself", () => {
    expect(summarizeKinds([reported("signUps")])?.title).toBe("Sign-ups — reported by the project");
  });

  it("names a catalogued event and a known protocol in the hover text", () => {
    const summary = summarizeKinds(
      [sourced("Deposit", "Supply(address,address,address,uint256,uint16)", AAVE_POOL)],
      {chainId: BASE_SEPOLIA, campaignName: "Aave Supplies"},
    );

    expect(summary?.title).toBe(
      "Deposits — Supply(address,address,address,uint256,uint16) on Aave V3 Pool",
    );
  });

  /*
    The reuse that keeps this free of chain reads: most seeded campaigns watch `Transfer` on the very
    token they escrow, whose symbol the list already loaded for the reward-pool column.
  */
  it("names the escrow token from metadata already loaded", () => {
    const summary = summarizeKinds(
      [sourced("TokenPurchase", "Transfer(address,address,uint256)", BUSD, {actorTopic: 2})],
      {chainId: BASE_SEPOLIA, escrowToken: BUSD.toLowerCase(), tokenSymbol: "bUSD", campaignName: "Aerodrome"},
    );

    expect(summary?.title).toBe("Token purchases — Transfer(address,address,uint256) on bUSD");
  });

  it("does not lend the escrow token's symbol to some other contract", () => {
    const summary = summarizeKinds(
      [sourced("TokenPurchase", "Transfer(address,address,uint256)", AAVE_POOL, {actorTopic: 2})],
      {chainId: BASE_SEPOLIA, escrowToken: BUSD.toLowerCase(), tokenSymbol: "bUSD"},
    );

    expect(summary?.title).toContain("on Aave V3 Pool");
    expect(summary?.title).not.toContain("bUSD");
  });

  it("shows the topic instead of echoing the kind when the event is unknown", () => {
    const summary = summarizeKinds([sourced("Stake", "Mystery(address,uint256,bytes32)", BUSD)], {
      chainId: BASE_SEPOLIA,
      campaignName: "Moonwell",
    });

    expect(summary?.title).toBe(
      `Staking — unrecognised event ${eventTopic("Mystery(address,uint256,bytes32)").slice(0, 10)}… on Moonwell`,
    );
    expect(summary?.title).not.toBe("Staking — Staking on Moonwell");
  });
});

describe("planSpecReads", () => {
  function view(campaign: string, kpiCount: number): Pick<CampaignView, "campaign" | "kpiCount"> {
    return {campaign: campaign as `0x${string}`, kpiCount: BigInt(kpiCount)};
  }

  it("plans one read per KPI", () => {
    const plan = planSpecReads([view("0xaa", 1), view("0xbb", 3)]);

    expect(plan.targets).toEqual([
      {campaign: "0xaa", count: 1},
      {campaign: "0xbb", count: 3},
    ]);
    expect(plan.dropped).toBe(0);
  });

  it("skips campaigns with no KPIs without calling them dropped", () => {
    const plan = planSpecReads([view("0xaa", 0), view("0xbb", 2)]);

    expect(plan.targets).toEqual([{campaign: "0xbb", count: 2}]);
    expect(plan.dropped).toBe(0);
  });

  /*
    Truncating by campaign rather than by read is the point: half a campaign's kinds would render as
    a confident, wrong answer, while no specs at all falls back to the count.
  */
  it("drops whole campaigns once the budget is spent", () => {
    const plan = planSpecReads([view("0xaa", 3), view("0xbb", 3), view("0xcc", 1)], 4);

    expect(plan.targets).toEqual([
      {campaign: "0xaa", count: 3},
      {campaign: "0xcc", count: 1},
    ]);
    expect(plan.dropped).toBe(1);
  });

  it("keeps a default budget well above a full page of ordinary campaigns", () => {
    const page = Array.from({length: 100}, (_, i) => view(`0x${i}`, 2));

    expect(planSpecReads(page).dropped).toBe(0);
    expect(MAX_SPEC_READS).toBeGreaterThanOrEqual(200);
  });
});
