import {describe, it, expect} from "vitest";
import {
  buildCreateCampaignArgs,
  toWireKpis,
  kpiKindToIndex,
  requiredFunding,
  DraftEncodingError,
  ZERO_ADDRESS,
} from "./campaignArgs";
import {KPI_KIND} from "./types";
import type {CampaignDraft} from "./validation";

/**
 * Encoder tests.
 *
 * The encoder sits between a validated form and `writeContract`, which means its mistakes are
 * silent: a reward parsed as `1` instead of `1e18`, or a KPI kind off by one, produces a campaign
 * that deploys successfully and pays the wrong thing. Nothing downstream can catch that, so the
 * unit conversion and the enum mapping are asserted exactly.
 */

const PROJECT = "0x1111111111111111111111111111111111111111" as const;
const TOKEN = "0x2222222222222222222222222222222222222222" as const;
const VERIFIER = "0x3333333333333333333333333333333333333333" as const;

function draft(overrides: Partial<CampaignDraft> = {}): CampaignDraft {
  return {
    token: TOKEN,
    rewardPool: "1000",
    startTime: 1_800_000_000,
    endTime: 1_800_086_400,
    attributionWindow: 604_800,
    minReputation: "0",
    kpis: [
      {
        kind: "Mint",
        verifier: "",
        target: "500",
        aggregate: false,
        tiers: [
          {threshold: "10", reward: "50"},
          {threshold: "50", reward: "100"},
        ],
      },
    ],
    ...overrides,
  };
}

describe("kpiKindToIndex", () => {
  it("maps every kind to its Solidity enum index", () => {
    // The contract stores a uint8; these indices are the enum order in Types.sol.
    KPI_KIND.forEach((kind, expected) => {
      expect(kpiKindToIndex(kind)).toBe(expected);
    });
  });

  it("puts Custom at 0 and ActiveUser last", () => {
    // Pinned explicitly: a reordering of KPI_KIND would keep the loop above passing while
    // silently changing what every existing campaign's KPIs mean.
    expect(kpiKindToIndex("Custom")).toBe(0);
    expect(kpiKindToIndex("Mint")).toBe(1);
    expect(kpiKindToIndex("ActiveUser")).toBe(9);
  });

  it("throws on an unknown kind rather than encoding -1", () => {
    expect(() => kpiKindToIndex("Nonsense" as never)).toThrow(DraftEncodingError);
  });
});

describe("buildCreateCampaignArgs", () => {
  it("scales the reward pool by the token's decimals", () => {
    const [cfg] = buildCreateCampaignArgs(draft({rewardPool: "1000"}), {
      project: PROJECT,
      tokenDecimals: 18,
    });
    expect(cfg.rewardPool).toBe(BigInt("1000000000000000000000"));
  });

  it("honors a non-18-decimal token", () => {
    // USDC-style 6 decimals — the classic source of a 10^12 error.
    const [cfg] = buildCreateCampaignArgs(draft({rewardPool: "1000"}), {
      project: PROJECT,
      tokenDecimals: 6,
    });
    expect(cfg.rewardPool).toBe(BigInt("1000000000"));
  });

  it("keeps fractional amounts exact", () => {
    const [cfg] = buildCreateCampaignArgs(draft({rewardPool: "0.5"}), {
      project: PROJECT,
      tokenDecimals: 18,
    });
    expect(cfg.rewardPool).toBe(BigInt("500000000000000000"));
  });

  it("takes the project from the connected wallet, never the draft", () => {
    const [cfg] = buildCreateCampaignArgs(draft(), {project: PROJECT, tokenDecimals: 18});
    // Boney.createCampaign reverts with NotProject unless cfg.project == msg.sender.
    expect(cfg.project).toBe(PROJECT);
  });

  it("passes the window through unscaled — these are seconds, not token units", () => {
    const [cfg] = buildCreateCampaignArgs(draft(), {project: PROJECT, tokenDecimals: 18});
    expect(cfg.startTime).toBe(BigInt(1_800_000_000));
    expect(cfg.endTime).toBe(BigInt(1_800_086_400));
    expect(cfg.attributionWindow).toBe(BigInt(604_800));
  });

  it("treats KPI thresholds as counts, not token amounts", () => {
    const [, , tiers] = buildCreateCampaignArgs(draft(), {project: PROJECT, tokenDecimals: 18});
    // A threshold of 10 mints is 10, not 10e18 — the single most damaging unit confusion here,
    // since it would make every tier unreachable.
    expect(tiers[0][0].threshold).toBe(BigInt(10));
    expect(tiers[0][1].threshold).toBe(BigInt(50));
  });

  it("scales tier rewards by decimals while leaving thresholds alone", () => {
    const [, , tiers] = buildCreateCampaignArgs(draft(), {project: PROJECT, tokenDecimals: 18});
    expect(tiers[0][0].reward).toBe(BigInt("50000000000000000000"));
    expect(tiers[0][1].reward).toBe(BigInt("100000000000000000000"));
  });

  it("preserves the ladder order the validator checked", () => {
    const [, , tiers] = buildCreateCampaignArgs(draft(), {project: PROJECT, tokenDecimals: 18});
    const thresholds = tiers[0].map((t) => Number(t.threshold));
    expect(thresholds).toEqual([...thresholds].sort((a, b) => a - b));
  });

  it("aligns the tiers array to the kpis array index-for-index", () => {
    // TierLengthMismatch: the contract requires kpis.length == tiers.length, and pairs them
    // positionally. A filter or flatten anywhere in the encoder would desynchronize them.
    const d = draft({
      kpis: [
        {kind: "Mint", verifier: "", target: "", aggregate: false, tiers: [{threshold: "1", reward: "1"}]},
        {kind: "Tvl", verifier: "", target: "", aggregate: true, tiers: []},
        {
          kind: "Swap",
          verifier: "",
          target: "",
          aggregate: false,
          tiers: [
            {threshold: "5", reward: "2"},
            {threshold: "9", reward: "3"},
          ],
        },
      ],
    });

    const [, kpis, tiers] = buildCreateCampaignArgs(d, {project: PROJECT, tokenDecimals: 18});

    expect(kpis).toHaveLength(3);
    expect(tiers).toHaveLength(3);
    expect(tiers.map((t) => t.length)).toEqual([1, 0, 2]);
    expect(kpis.map((k) => k.kind)).toEqual(["Mint", "Tvl", "Swap"]);
  });

  it("keeps an aggregate KPI's empty ladder as an empty array, not a dropped row", () => {
    const d = draft({
      kpis: [{kind: "Tvl", verifier: "", target: "1000", aggregate: true, tiers: []}],
    });
    const [, kpis, tiers] = buildCreateCampaignArgs(d, {project: PROJECT, tokenDecimals: 18});
    expect(kpis).toHaveLength(1);
    expect(tiers).toEqual([[]]);
  });

  it("defaults a blank verifier to the zero address", () => {
    const [, kpis] = buildCreateCampaignArgs(draft(), {project: PROJECT, tokenDecimals: 18});
    expect(kpis[0].verifier).toBe(ZERO_ADDRESS);
  });

  it("passes a Custom KPI's verifier through", () => {
    const d = draft({
      kpis: [
        {
          kind: "Custom",
          verifier: VERIFIER,
          target: "",
          aggregate: false,
          tiers: [{threshold: "1", reward: "1"}],
        },
      ],
    });
    const [, kpis] = buildCreateCampaignArgs(d, {project: PROJECT, tokenDecimals: 18});
    expect(kpis[0].verifier).toBe(VERIFIER);
  });

  it("defaults blank optional counts to zero", () => {
    const d = draft({minReputation: "", kpis: [
      {kind: "Mint", verifier: "", target: "", aggregate: false, tiers: [{threshold: "1", reward: "1"}]},
    ]});
    const [cfg, kpis] = buildCreateCampaignArgs(d, {project: PROJECT, tokenDecimals: 18});
    expect(cfg.minReputation).toBe(BigInt(0));
    expect(kpis[0].target).toBe(BigInt(0));
  });

  it("emits empty params — no MVP KPI kind consumes them", () => {
    const [, kpis] = buildCreateCampaignArgs(draft(), {project: PROJECT, tokenDecimals: 18});
    expect(kpis[0].params).toBe("0x");
  });

  it("throws with the offending path rather than encoding garbage", () => {
    const bad = draft({rewardPool: "not-a-number"});
    expect(() => buildCreateCampaignArgs(bad, {project: PROJECT, tokenDecimals: 18})).toThrow(
      DraftEncodingError,
    );

    try {
      buildCreateCampaignArgs(bad, {project: PROJECT, tokenDecimals: 18});
    } catch (err) {
      expect((err as DraftEncodingError).path).toBe("rewardPool");
    }
  });

  it("names the exact tier that failed to parse", () => {
    const d = draft({
      kpis: [
        {
          kind: "Mint",
          verifier: "",
          target: "",
          aggregate: false,
          tiers: [
            {threshold: "10", reward: "5"},
            {threshold: "oops", reward: "5"},
          ],
        },
      ],
    });

    try {
      buildCreateCampaignArgs(d, {project: PROJECT, tokenDecimals: 18});
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as DraftEncodingError).path).toBe("kpis.0.tiers.1.threshold");
    }
  });

  it("rejects an invalid token address", () => {
    expect(() =>
      buildCreateCampaignArgs(draft({token: "0xnope"}), {project: PROJECT, tokenDecimals: 18}),
    ).toThrow(DraftEncodingError);
  });

  it("rejects a verifier that is present but malformed", () => {
    const d = draft({
      kpis: [
        {kind: "Mint", verifier: "0x123", target: "", aggregate: false, tiers: [{threshold: "1", reward: "1"}]},
      ],
    });
    expect(() => buildCreateCampaignArgs(d, {project: PROJECT, tokenDecimals: 18})).toThrow(
      DraftEncodingError,
    );
  });

  it("rejects an amount with more precision than the token has", () => {
    // 0.0000001 has 7 decimals; a 6-decimal token cannot represent it, and silently truncating
    // would under-fund the tier.
    expect(() =>
      buildCreateCampaignArgs(draft({rewardPool: "0.0000001"}), {
        project: PROJECT,
        tokenDecimals: 6,
      }),
    ).toThrow(DraftEncodingError);
  });
});

describe("toWireKpis", () => {
  it("converts kind labels to numeric indices", () => {
    const [, kpis] = buildCreateCampaignArgs(
      draft({
        kpis: [
          {kind: "Swap", verifier: "", target: "", aggregate: false, tiers: [{threshold: "1", reward: "1"}]},
          {kind: "ActiveUser", verifier: "", target: "", aggregate: true, tiers: []},
        ],
      }),
      {project: PROJECT, tokenDecimals: 18},
    );

    const wire = toWireKpis(kpis);
    expect(wire.map((k) => k.kind)).toEqual([2, 9]);
    expect(wire.map((k) => k.aggregate)).toEqual([false, true]);
  });

  it("leaves every other field untouched", () => {
    const [, kpis] = buildCreateCampaignArgs(draft(), {project: PROJECT, tokenDecimals: 18});
    const wire = toWireKpis(kpis);
    expect(wire[0].target).toBe(kpis[0].target);
    expect(wire[0].verifier).toBe(kpis[0].verifier);
    expect(wire[0].params).toBe(kpis[0].params);
  });
});

describe("requiredFunding", () => {
  it("is the full reward pool", () => {
    // Campaign.activate reverts with NotFunded unless the vault holds rewardPool in full —
    // not merely the sum of the ladders, which can be less.
    const [cfg] = buildCreateCampaignArgs(draft(), {project: PROJECT, tokenDecimals: 18});
    expect(requiredFunding(cfg)).toBe(cfg.rewardPool);
  });
});
