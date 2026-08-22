import {describe, it, expect} from "vitest";
import {
  isProjectWallet,
  viewerRole,
  visibleSections,
  type RoleInput,
  type ViewerRole,
} from "./viewerRole";

const PROJECT = "0xbA95a1b0b52c4C7d0C8f9E4dE1cE7fB8A6D31C22" as const;
const WALLET = "0x98405c00e5FCb8Aa1a9C6e4d0aD9dD59A4c1E1cB" as const;

function input(overrides: Partial<RoleInput> = {}): RoleInput {
  return {connected: true, wallet: WALLET, project: PROJECT, joined: false, referred: false, ...overrides};
}

describe("viewerRole", () => {
  it("reads no wallet as disconnected", () => {
    expect(viewerRole(input({connected: false}))).toBe("disconnected");
    expect(viewerRole(input({wallet: undefined}))).toBe("disconnected");
  });

  it("identifies the owner whatever the casing", () => {
    expect(viewerRole(input({wallet: PROJECT}))).toBe("project");
    expect(viewerRole(input({wallet: PROJECT.toLowerCase()}))).toBe("project");
    expect(viewerRole(input({wallet: PROJECT, project: PROJECT.toLowerCase()}))).toBe("project");
  });

  it("names a joined wallet a promoter and an attributed one a referral", () => {
    expect(viewerRole(input({joined: true}))).toBe("promoter");
    expect(viewerRole(input({referred: true}))).toBe("referral");
    expect(viewerRole(input())).toBe("visitor");
  });

  /*
    A wallet really can hold several roles at once — a project may join its own campaign, and a
    promoter may be someone else's referral — so the order is part of the behaviour, not a detail.
  */
  it("resolves overlapping roles most-invested first", () => {
    expect(viewerRole(input({wallet: PROJECT, joined: true, referred: true}))).toBe("project");
    expect(viewerRole(input({joined: true, referred: true}))).toBe("promoter");
  });
});

describe("isProjectWallet", () => {
  it("matches case-insensitively and rejects an absent wallet", () => {
    expect(isProjectWallet(PROJECT.toLowerCase(), PROJECT)).toBe(true);
    expect(isProjectWallet(WALLET, PROJECT)).toBe(false);
    expect(isProjectWallet(undefined, PROJECT)).toBe(false);
  });
});

describe("visibleSections", () => {
  it("gives a promoter the ladders and a project the promoter table, never both", () => {
    const promoter = visibleSections("promoter");
    const project = visibleSections("project");

    expect(promoter.kpis).toBe(true);
    expect(promoter.promoterTable).toBe(false);
    expect(project.promoterTable).toBe(true);
    expect(project.kpis).toBe(false);
  });

  it("shows a prospective promoter the same sections as a joined one", () => {
    // Otherwise nobody could read the reward ladder before deciding to join.
    expect(visibleSections("visitor")).toEqual(visibleSections("promoter"));
  });

  it("keeps the escrow accounting away from referrals", () => {
    expect(visibleSections("referral")).toEqual({
      kpis: false,
      promoterTable: false,
      poolUtilization: false,
      escrowReturn: false,
      escrowTiles: false,
    });
  });

  /*
    The tile reads "Paid out — of 50K", which is the ratio the utilization meter draws. Hiding one and
    keeping the other would publish the same figure through a different control.
  */
  it("moves the payout tiles with the utilization meter", () => {
    for (const role of ["disconnected", "project", "promoter", "referral", "visitor"] as const) {
      expect(visibleSections(role).escrowTiles).toBe(visibleSections(role).poolUtilization);
    }
  });

  it("does not render the ladders to nobody in particular", () => {
    expect(visibleSections("disconnected").kpis).toBe(false);
    expect(visibleSections("disconnected").poolUtilization).toBe(true);
  });

  it("covers every role", () => {
    const roles: ViewerRole[] = ["disconnected", "project", "promoter", "referral", "visitor"];
    for (const role of roles) expect(visibleSections(role)).toBeTypeOf("object");
  });
});
