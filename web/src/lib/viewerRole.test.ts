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
  it("gives the ladders to the two roles with progress in them", () => {
    const promoter = visibleSections("promoter");
    const project = visibleSections("project");

    expect(promoter.kpis).toBe(true);
    expect(promoter.promoterTable).toBe(false);
    expect(project.kpis).toBe(true);
    expect(project.promoterTable).toBe(true);

    // A visitor has no position in the campaign, so there is no progress to draw against a tier.
    for (const role of ["disconnected", "referral", "visitor"] as const) {
      expect(visibleSections(role).kpis, role).toBe(false);
    }
  });

  it("shows the escrow return only to the project wallet", () => {
    // Reclaiming is a project-only action; nobody else can act on when it unlocks.
    expect(visibleSections("project").escrowReturn).toBe(true);
    for (const role of ["disconnected", "promoter", "referral", "visitor"] as const) {
      expect(visibleSections(role).escrowReturn, role).toBe(false);
    }
  });

  it("differs from a joined promoter only in the ladders", () => {
    // Everything a prospective promoter needs to evaluate the campaign stays visible; only the
    // tiers, which measure progress they do not have yet, wait for the join.
    expect(visibleSections("visitor")).toEqual({...visibleSections("promoter"), kpis: false});
  });

  it("keeps the escrow accounting away from referrals", () => {
    expect(visibleSections("referral")).toEqual({
      kpis: false,
      guide: true,
      promoterTable: false,
      poolUtilization: false,
      escrowReturn: false,
      escrowTiles: false,
    });
  });

  /*
    The one section with no per-role argument against it — it carries no payout figure and no accounting
    ratio, only what each KPI asks for and where. A referral in particular has nothing else on the page:
    every other section above is false for them.
  */
  it("shows the guide to every role", () => {
    for (const role of ["disconnected", "project", "promoter", "referral", "visitor"] as const) {
      expect(visibleSections(role).guide, role).toBe(true);
    }
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
