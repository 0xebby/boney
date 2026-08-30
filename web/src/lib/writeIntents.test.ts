import {describe, it, expect} from "vitest";
import {
  attestationIntent,
  createCampaignIntent,
  fundCampaignIntent,
  joinCampaignIntent,
  lifecycleIntent,
  publishGuideIntent,
  reportIntent,
  settleIntent,
  storeTouchIntent,
  stubAllowlistIntent,
  type ReportedCall,
} from "./writeIntents";
import type {CampaignDraft} from "./validation";
import {shortAddress} from "./format";

const CAMPAIGN = "0x3e0a2fc4bB1eD3d3A0d5eE0F0dE1a2b3C4d5E6f7" as const;
const PROMOTER = "0x98405c5776a63547E7cB16000ba04Ca53d9fb2F8" as const;
const BUSD = "0x2755a4A19B9B4d3B1e9Bd1cDe3B5DB2A0f9AdCc2" as const;

const draft: CampaignDraft = {
  name: "Venus",
  token: BUSD,
  rewardPool: "1500",
  startTime: 1_756_000_000,
  endTime: 1_757_000_000,
  attributionWindow: 604_800,
  minReputation: "19500",
  kpis: [],
};

/**
 * `count` planned calls, each crediting the reported promoter in full.
 *
 * @param count How many referrals the plan covers.
 * @param over Fields to override on every call, for the split cases.
 * @returns The calls `reportIntent` takes.
 */
function reportCalls(count: number, over: Partial<ReportedCall> = {}): ReportedCall[] {
  return Array.from({length: count}, (_, i) => ({
    referral: `0x${String(i).padStart(40, "d")}` as `0x${string}`,
    newTotal: BigInt(12),
    delta: BigInt(12),
    elsewhere: BigInt(0),
    ...over,
  }));
}

/** Every builder produces a dialog that can actually be rendered and acted on. */
const ALL = [
  createCampaignIntent(draft),
  fundCampaignIntent(BigInt(3), BigInt(1500) * BigInt(10) ** BigInt(18), BUSD, 18),
  lifecycleIntent("cancel", CAMPAIGN),
  joinCampaignIntent(CAMPAIGN),
  settleIntent(CAMPAIGN, PROMOTER, 0),
  storeTouchIntent(CAMPAIGN, PROMOTER),
  reportIntent(CAMPAIGN, 1, PROMOTER, reportCalls(3)),
  attestationIntent(["X_REACH", "X_FOLLOWERS"]),
  publishGuideIntent(CAMPAIGN, false),
  stubAllowlistIntent(PROMOTER, "add"),
];

describe("every intent", () => {
  it("has a title, a summary, a confirm label and at least one prompt", () => {
    for (const intent of ALL) {
      expect(intent.title).not.toBe("");
      expect(intent.summary).not.toBe("");
      expect(intent.confirmLabel).not.toBe("");
      expect(intent.prompts.length).toBeGreaterThan(0);
    }
  });

  it("never leaves a row without a value", () => {
    for (const intent of ALL) {
      for (const row of intent.rows) {
        expect(row.label).not.toBe("");
        expect(row.value).not.toBe("");
      }
    }
  });
});

describe("createCampaignIntent", () => {
  it("names the token only when the symbol is known", () => {
    const bare = createCampaignIntent(draft).rows.find((r) => r.label === "Reward pool");
    const named = createCampaignIntent(draft, {symbol: "bUSD"}).rows.find(
      (r) => r.label === "Reward pool",
    );
    expect(bare?.value).toBe("1500");
    expect(named?.value).toBe("1500 bUSD");
  });

  it("warns that the terms are final", () => {
    expect(createCampaignIntent(draft).tone).toBe("warning");
    expect(createCampaignIntent(draft).important).toContain("fixed");
  });
});

describe("fundCampaignIntent", () => {
  it("reads the amount in the token's own decimals", () => {
    const row = fundCampaignIntent(BigInt(3), BigInt(2_500_000), BUSD, 6, {symbol: "USDC"}).rows.find(
      (r) => r.label === "Amount",
    );
    expect(row?.value).toBe("2.5 USDC");
  });

  it("falls back to the registry id when the campaign has no name", () => {
    const rows = fundCampaignIntent(BigInt(3), BigInt(1), BUSD, 18).rows;
    expect(rows.find((r) => r.label === "Campaign")?.value).toBe("#3");
    const named = fundCampaignIntent(BigInt(3), BigInt(1), BUSD, 18, {campaignName: "Venus"}).rows;
    expect(named.find((r) => r.label === "Campaign")?.value).toBe("Venus");
  });
});

describe("lifecycleIntent", () => {
  it("marks cancel as the critical one", () => {
    expect(lifecycleIntent("cancel", CAMPAIGN).tone).toBe("critical");
    expect(lifecycleIntent("pause", CAMPAIGN).tone).toBe("info");
  });

  it("titles itself with the action's own label", () => {
    expect(lifecycleIntent("reclaimUnspent", CAMPAIGN).title).toBe(
      lifecycleIntent("reclaimUnspent", CAMPAIGN).confirmLabel,
    );
  });
});

describe("settleIntent", () => {
  it("names the KPI by label when the caller knows it", () => {
    expect(settleIntent(CAMPAIGN, PROMOTER, 2).rows.find((r) => r.label === "KPI")?.value).toBe("#2");
    expect(
      settleIntent(CAMPAIGN, PROMOTER, 2, {kpiLabel: "Swap volume"}).rows.find(
        (r) => r.label === "KPI",
      )?.value,
    ).toBe("Swap volume");
  });
});

describe("storeTouchIntent", () => {
  it("opens a signature before the transaction", () => {
    expect(storeTouchIntent(CAMPAIGN, PROMOTER).prompts).toEqual(["signature", "transaction"]);
  });
});

describe("reportIntent", () => {
  const report = (count: number, over?: Partial<ReportedCall>, ctx?: {kpiLabel?: string}) =>
    reportIntent(CAMPAIGN, 0, PROMOTER, reportCalls(count, over), ctx);

  it("opens one transaction per referral", () => {
    expect(report(3).prompts).toEqual(["transaction", "transaction", "transaction"]);
    expect(report(3).confirmLabel).toBe("Send 3 reports");
    expect(report(1).confirmLabel).toBe("Send report");
  });

  it("says that a partial run has already paid out", () => {
    expect(report(3).important).toContain("already moved money");
  });

  /** The question the old copy left open: it said the credit went "to the referrals". */
  it("names the promoter as the one credited, not the referrals", () => {
    const intent = report(2);
    const row = intent.rows.find((r) => r.label === "Credited to");

    expect(row?.value).toBe(shortAddress(PROMOTER));
    expect(row?.hint).toContain("Nothing is credited to the referrals");
    expect(intent.summary).toContain(shortAddress(PROMOTER));
  });

  it("states the units the promoter gains, in the KPI's own words", () => {
    expect(report(2, undefined, {kpiLabel: "Deposits"}).rows.map((r) => r.value)).toContain(
      "24 deposits",
    );
    // Unlabelled KPI: "24 #0" would be nonsense, so the generic unit is used instead.
    expect(report(2).rows.map((r) => r.value)).toContain("24 KPI units");
  });

  it("separates the part that credits an earlier promoter", () => {
    const intent = report(1, {newTotal: BigInt(12), delta: BigInt(5), elsewhere: BigInt(7)});

    expect(intent.rows.find((r) => r.label.endsWith("gains"))?.value).toBe("5 KPI units");
    expect(intent.rows.find((r) => r.label === "Other promoters gain")?.value).toBe("7 KPI units");
  });

  it("says nothing about other promoters when nothing lands on them", () => {
    expect(report(2).rows.some((r) => r.label === "Other promoters gain")).toBe(false);
  });

  it("lists each referral's figures and collapses a long plan", () => {
    const one = report(1).rows.find((r) => r.value.startsWith("+"));
    expect(one?.value).toBe("+12, total 12");

    const many = report(9);
    expect(many.rows.filter((r) => r.value.startsWith("+"))).toHaveLength(5);
    expect(many.rows.find((r) => r.label === "And")?.value).toBe("4 more referrals");
  });
});

describe("attestationIntent", () => {
  it("opens one transaction per schema and names them", () => {
    const intent = attestationIntent(["X_REACH", "X_FOLLOWERS"]);
    expect(intent.prompts).toEqual(["transaction", "transaction"]);
    expect(intent.rows.find((r) => r.label === "Schemas")?.value).toBe("X_REACH, X_FOLLOWERS");
    expect(intent.confirmLabel).toBe("Submit 2 attestations");
  });
});

describe("publishGuideIntent", () => {
  it("distinguishes withdrawal from publication", () => {
    expect(publishGuideIntent(CAMPAIGN, false).title).toBe("Publish campaign guide");
    expect(publishGuideIntent(CAMPAIGN, true).title).toBe("Withdraw campaign guide");
  });

  it("costs a signature and no gas", () => {
    expect(publishGuideIntent(CAMPAIGN, false).prompts).toEqual(["signature"]);
  });
});

describe("stubAllowlistIntent", () => {
  it("says which way the change goes", () => {
    expect(stubAllowlistIntent(PROMOTER, "remove").title).toBe("Remove from stub allowlist");
    expect(stubAllowlistIntent(PROMOTER, "add").rows.find((r) => r.label === "Change")?.value).toBe(
      "add",
    );
  });
});
