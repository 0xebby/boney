import {describe, it, expect} from "vitest";
import {
  validateCampaignDraft,
  parseAmount,
  parseCount,
  isAddress,
  maxSinglePromoterPayout,
  type CampaignDraft,
} from "./validation";
import {MAX_TIERS_PER_KPI} from "./types";
import {MAX_BONEY_SCORE} from "./boneyscore";

const TOKEN = "0x1234567890abcdef1234567890abcdef12345678";
const NOW = 1_000_000;

function draft(overrides: Partial<CampaignDraft> = {}): CampaignDraft {
  return {
    token: TOKEN,
    rewardPool: "10000",
    startTime: NOW,
    endTime: NOW + 30 * 86_400,
    attributionWindow: 7 * 86_400,
    minReputation: "0",
    kpis: [
      {
        kind: "Mint",
        verifier: "",
        target: "100",
        aggregate: false,
        tiers: [
          {threshold: "10", reward: "1000"},
          {threshold: "50", reward: "2000"},
        ],
      },
    ],
    ...overrides,
  };
}

function paths(d: CampaignDraft): string[] {
  return validateCampaignDraft(d, {tokenDecimals: 18, nowSeconds: NOW}).map((i) => i.path);
}

describe("minReputation", () => {
  it("accepts 0, an empty gate, and anything up to the ceiling", () => {
    expect(paths(draft({minReputation: "0"}))).not.toContain("minReputation");
    expect(paths(draft({minReputation: ""}))).not.toContain("minReputation");
    expect(paths(draft({minReputation: "26000"}))).not.toContain("minReputation");
    expect(paths(draft({minReputation: String(MAX_BONEY_SCORE)}))).not.toContain("minReputation");
  });

  it("rejects a gate no wallet could ever clear", () => {
    expect(paths(draft({minReputation: String(MAX_BONEY_SCORE + 1)}))).toContain("minReputation");
    // The uint256 ceiling deploys fine on chain, which is the whole problem.
    expect(paths(draft({minReputation: (BigInt(2) ** BigInt(256) - BigInt(1)).toString()}))).toContain(
      "minReputation",
    );
  });

  it("names the ceiling in the message, so the creator knows what to lower it to", () => {
    const issue = validateCampaignDraft(draft({minReputation: "40000"}), {
      tokenDecimals: 18,
      nowSeconds: NOW,
    }).find((i) => i.path === "minReputation");
    expect(issue?.message).toContain(MAX_BONEY_SCORE.toLocaleString());
  });

  it("catches an unparseable gate in the form rather than at encode time", () => {
    expect(paths(draft({minReputation: "20k"}))).toContain("minReputation");
    expect(paths(draft({minReputation: "-1"}))).toContain("minReputation");
    expect(paths(draft({minReputation: "1.5"}))).toContain("minReputation");
  });
});

describe("parseAmount", () => {
  it("parses decimals to base units", () => {
    expect(parseAmount("1", 18)).toBe(BigInt("1000000000000000000"));
    expect(parseAmount("1.5", 18)).toBe(BigInt("1500000000000000000"));
    expect(parseAmount("0.000001", 6)).toBe(BigInt(1));
  });

  it("rejects more precision than the token has", () => {
    expect(parseAmount("1.1234567", 6)).toBeNull();
  });

  it("rejects junk", () => {
    expect(parseAmount("abc", 18)).toBeNull();
    expect(parseAmount("", 18)).toBeNull();
    expect(parseAmount("1.2.3", 18)).toBeNull();
    expect(parseAmount("-5", 18)).toBeNull();
  });
});

describe("parseCount", () => {
  it("accepts whole numbers only", () => {
    expect(parseCount("100")).toBe(BigInt(100));
    expect(parseCount("0")).toBe(BigInt(0));
    expect(parseCount("1.5")).toBeNull();
    expect(parseCount("-1")).toBeNull();
    expect(parseCount("")).toBeNull();
  });
});

describe("isAddress", () => {
  it("validates 20-byte hex addresses", () => {
    expect(isAddress(TOKEN)).toBe(true);
    expect(isAddress("0x123")).toBe(false);
    expect(isAddress("not an address")).toBe(false);
  });
});

describe("validateCampaignDraft", () => {
  it("accepts a well-formed draft", () => {
    expect(paths(draft())).toEqual([]);
  });

  // ── mirrors Solidity: ZeroRewardPool ──
  it("rejects a zero reward pool", () => {
    expect(paths(draft({rewardPool: "0"}))).toContain("rewardPool");
  });

  it("rejects a malformed token address", () => {
    expect(paths(draft({token: "0xnope"}))).toContain("token");
  });

  // ── mirrors Solidity: InvalidWindow ──
  it("rejects an end time at or before the start", () => {
    expect(paths(draft({endTime: NOW}))).toContain("endTime");
    expect(paths(draft({startTime: NOW + 100, endTime: NOW + 50}))).toContain("endTime");
  });

  it("rejects an end time in the past", () => {
    expect(paths(draft({startTime: NOW - 200, endTime: NOW - 100}))).toContain("endTime");
  });

  it("rejects a zero attribution window", () => {
    expect(paths(draft({attributionWindow: 0}))).toContain("attributionWindow");
  });

  // ── mirrors Solidity: NoKpis ──
  it("requires at least one KPI", () => {
    expect(paths(draft({kpis: []}))).toContain("kpis");
  });

  // ── mirrors Solidity: CustomKpiNeedsVerifier ──
  it("requires a verifier for a Custom KPI", () => {
    const d = draft();
    d.kpis[0].kind = "Custom";
    d.kpis[0].verifier = "";
    expect(paths(d)).toContain("kpis.0.verifier");
  });

  it("accepts a Custom KPI that has a verifier", () => {
    const d = draft();
    d.kpis[0].kind = "Custom";
    d.kpis[0].verifier = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
    expect(paths(d)).toEqual([]);
  });

  // ── mirrors Solidity: TiersNotAscending ──
  it("requires strictly ascending thresholds", () => {
    const d = draft();
    d.kpis[0].tiers = [
      {threshold: "50", reward: "1000"},
      {threshold: "10", reward: "2000"},
    ];
    expect(paths(d)).toContain("kpis.0.tiers.1.threshold");
  });

  it("rejects equal thresholds", () => {
    const d = draft();
    d.kpis[0].tiers = [
      {threshold: "10", reward: "1000"},
      {threshold: "10", reward: "2000"},
    ];
    expect(paths(d)).toContain("kpis.0.tiers.1.threshold");
  });

  // ── mirrors Solidity: ZeroTierReward ──
  it("rejects a zero tier reward", () => {
    const d = draft();
    d.kpis[0].tiers = [{threshold: "10", reward: "0"}];
    expect(paths(d)).toContain("kpis.0.tiers.0.reward");
  });

  // ── mirrors Solidity: EmptyTiers ──
  it("requires tiers on a non-aggregate KPI", () => {
    const d = draft();
    d.kpis[0].tiers = [];
    expect(paths(d)).toContain("kpis.0.tiers");
  });

  it("allows an aggregate KPI to have no tiers", () => {
    const d = draft();
    d.kpis[0].aggregate = true;
    d.kpis[0].tiers = [];
    d.kpis[0].kind = "Tvl";
    expect(paths(d)).toEqual([]);
  });

  // ── mirrors Solidity: TooManyTiers ──
  it("rejects more tiers than the contract cap", () => {
    const d = draft();
    d.kpis[0].tiers = Array.from({length: MAX_TIERS_PER_KPI + 1}, (_, i) => ({
      threshold: String(i + 1),
      reward: "1",
    }));
    expect(paths(d)).toContain("kpis.0.tiers");
  });

  it("accepts exactly the cap", () => {
    const d = draft();
    d.kpis[0].tiers = Array.from({length: MAX_TIERS_PER_KPI}, (_, i) => ({
      threshold: String(i + 1),
      reward: "1",
    }));
    expect(paths(d)).toEqual([]);
  });

  it("reports issues for the right KPI index", () => {
    const d = draft();
    d.kpis.push({
      kind: "Custom",
      verifier: "",
      target: "10",
      aggregate: false,
      tiers: [{threshold: "5", reward: "10"}],
    });
    expect(paths(d)).toContain("kpis.1.verifier");
    expect(paths(d)).not.toContain("kpis.0.verifier");
  });
});

describe("maxSinglePromoterPayout", () => {
  it("sums every tier across every KPI", () => {
    // 1000 + 2000 with 18 decimals
    expect(maxSinglePromoterPayout(draft(), 18)).toBe(BigInt("3000000000000000000000"));
  });
});
