import {describe, it, expect} from "vitest";
import {
  validateCampaignDraft,
  parseAmount,
  parseCount,
  isAddress,
  isPrintableAscii,
  maxSinglePromoterPayout,
  type CampaignDraft,
} from "./validation";
import {MAX_TIERS_PER_KPI, MAX_CAMPAIGN_NAME_LENGTH} from "./types";
import {MAX_BONEY_SCORE} from "./boneyscore";

const TOKEN = "0x1234567890abcdef1234567890abcdef12345678";
const NOW = 1_000_000;

function draft(overrides: Partial<CampaignDraft> = {}): CampaignDraft {
  return {
    name: "Test Campaign",
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

describe("name", () => {
  it("accepts an ordinary name", () => {
    expect(paths(draft({name: "Aave Protocol"}))).not.toContain("name");
    expect(paths(draft({name: "Aave v3 (Base) - 2026!"}))).not.toContain("name");
  });

  it("requires a name", () => {
    expect(paths(draft({name: ""}))).toContain("name");
    // Solidity: EmptyName. All-spaces normalizes to empty on chain, so it is not a name either.
    expect(paths(draft({name: "   "}))).toContain("name");
  });

  it("enforces the contract's length ceiling", () => {
    const atMax = "a".repeat(MAX_CAMPAIGN_NAME_LENGTH);
    expect(paths(draft({name: atMax}))).not.toContain("name");
    // Solidity: NameTooLong
    expect(paths(draft({name: `${atMax}a`}))).toContain("name");
  });

  it("rejects characters the contract cannot store", () => {
    // Solidity: InvalidNameChar. Each of these is a real impersonation route rather than a style
    // preference — the Cyrillic А and the zero-width joiner both render as an existing name.
    expect(paths(draft({name: "Аave"}))).toContain("name"); // U+0410
    expect(paths(draft({name: "Aa‍ve"}))).toContain("name"); // zero-width joiner
    expect(paths(draft({name: "Aave 🚀"}))).toContain("name");
    expect(paths(draft({name: "café"}))).toContain("name");
    expect(paths(draft({name: "Aa\tve"}))).toContain("name");
  });

  it("counts characters the way the contract counts bytes", () => {
    // The charset rule is what makes a character count equal a byte count. An emoji is four bytes
    // on chain but would be one or two characters here, so it is rejected outright rather than
    // measured — otherwise a 32-"character" name could exceed 32 bytes.
    expect(paths(draft({name: "🚀".repeat(8)}))).toContain("name");
  });

  it("reports a taken name only when the caller says the registry holds it", () => {
    // Uniqueness is not a property of the draft: the registry normalizes before comparing, so the
    // answer comes from `isNameAvailable` rather than from anything checkable here.
    const d = draft({name: "Aave"});
    expect(
      validateCampaignDraft(d, {tokenDecimals: 18, nowSeconds: NOW, nameTaken: true}).map((i) => i.path),
    ).toContain("name");
    expect(
      validateCampaignDraft(d, {tokenDecimals: 18, nowSeconds: NOW, nameTaken: false}).map((i) => i.path),
    ).not.toContain("name");
    expect(paths(d)).not.toContain("name");
  });

  it("does not report a name as taken when it is also malformed", () => {
    // One message per field: "too long" is the actionable one, and a malformed name was never
    // checked against the registry anyway.
    const issues = validateCampaignDraft(draft({name: "a".repeat(40)}), {
      tokenDecimals: 18,
      nowSeconds: NOW,
      nameTaken: true,
    });
    expect(issues.filter((i) => i.path === "name")).toHaveLength(1);
    expect(issues.find((i) => i.path === "name")?.message).toMatch(/characters or fewer/);
  });
});

describe("isPrintableAscii", () => {
  it("mirrors the contract's 0x20-0x7E range", () => {
    expect(isPrintableAscii(" ")).toBe(true);
    expect(isPrintableAscii("~")).toBe(true);
    expect(isPrintableAscii("Aa0 !~")).toBe(true);
    expect(isPrintableAscii("ab")).toBe(false); // one below the low bound
    expect(isPrintableAscii("")).toBe(false);
    expect(isPrintableAscii("é")).toBe(false);
    expect(isPrintableAscii("")).toBe(true);
  });
});

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
