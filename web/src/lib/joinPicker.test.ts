import {describe, it, expect} from "vitest";
import {joinOptions, joinableCount, type JoinPickerContext} from "./joinPicker";
import type {CampaignView} from "./types";

function view(overrides: Partial<CampaignView> = {}): CampaignView {
  return {
    campaignId: BigInt(0),
    campaign: "0x1111111111111111111111111111111111111111",
    project: "0x2222222222222222222222222222222222222222",
    token: "0x3333333333333333333333333333333333333333",
    rewardPool: BigInt(10_000),
    paidOut: BigInt(0),
    startTime: BigInt(1_000),
    endTime: BigInt(2_000),
    minReputation: BigInt(0),
    status: "Active",
    kpiCount: BigInt(1),
    ...overrides,
  };
}

function ctx(overrides: Partial<JoinPickerContext> = {}): JoinPickerContext {
  return {
    reputation: BigInt(10_000),
    joinedAddresses: new Set<string>(),
    connected: true,
    ...overrides,
  };
}

function ids(options: ReturnType<typeof joinOptions>): number[] {
  return options.map((option) => Number(option.view.campaignId));
}

describe("joinOptions", () => {
  it("returns nothing for an empty marketplace", () => {
    expect(joinOptions([], ctx())).toEqual([]);
  });

  it("omits statuses join() rejects", () => {
    const rows = [
      view({campaignId: BigInt(0), status: "Active"}),
      view({campaignId: BigInt(1), status: "Pending"}),
      view({campaignId: BigInt(2), status: "Paused"}),
      view({campaignId: BigInt(3), status: "Ended"}),
      view({campaignId: BigInt(4), status: "Cancelled"}),
    ];
    expect(ids(joinOptions(rows, ctx()))).toEqual([0, 1]);
  });

  it("keeps an already-joined campaign, disabled with its reason", () => {
    const joined = "0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa";
    const rows = [view({campaign: joined})];
    const [option] = joinOptions(rows, ctx({joinedAddresses: new Set([joined.toLowerCase()])}));

    expect(option.eligibility.ok).toBe(false);
    expect(option.eligibility.reason).toBe("You have already joined this campaign.");
  });

  it("matches the joined set case-insensitively", () => {
    const rows = [view({campaign: "0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa"})];
    const joined = new Set(["0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]);
    expect(joinOptions(rows, ctx({joinedAddresses: joined}))[0].eligibility.ok).toBe(false);
  });

  it("keeps a campaign above the wallet's score, marked attestable", () => {
    const rows = [view({minReputation: BigInt(20_000)})];
    const [option] = joinOptions(rows, ctx({reputation: BigInt(12_816)}));

    expect(option.eligibility.ok).toBe(false);
    expect(option.eligibility.actionable).toBe("attest");
  });

  it("offers an open campaign to a wallet with no score", () => {
    const rows = [view({minReputation: BigInt(0)})];
    expect(joinOptions(rows, ctx({reputation: BigInt(0)}))[0].eligibility.ok).toBe(true);
  });

  it("orders joinable first, then Active before Pending, then newest", () => {
    const rows = [
      view({campaignId: BigInt(1), status: "Pending"}),
      view({campaignId: BigInt(2), status: "Active", minReputation: BigInt(99_000)}),
      view({campaignId: BigInt(3), status: "Active"}),
      view({campaignId: BigInt(4), status: "Pending"}),
      view({campaignId: BigInt(5), status: "Active"}),
    ];
    expect(ids(joinOptions(rows, ctx()))).toEqual([5, 3, 4, 1, 2]);
  });

  it("disables everything when no wallet is connected", () => {
    const rows = [view({campaignId: BigInt(0)}), view({campaignId: BigInt(1), status: "Pending"})];
    const options = joinOptions(rows, ctx({connected: false}));

    expect(options).toHaveLength(2);
    for (const option of options) {
      expect(option.eligibility.reason).toBe("Connect a wallet to join this campaign.");
      expect(option.eligibility.actionable).toBeUndefined();
    }
  });
});

describe("joinableCount", () => {
  it("counts only the enabled options", () => {
    const rows = [
      view({campaignId: BigInt(0)}),
      view({campaignId: BigInt(1), minReputation: BigInt(99_000)}),
      view({campaignId: BigInt(2), status: "Pending"}),
    ];
    expect(joinableCount(joinOptions(rows, ctx()))).toBe(2);
  });

  it("is zero for an empty picker", () => {
    expect(joinableCount([])).toBe(0);
  });
});
