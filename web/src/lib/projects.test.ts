import {describe, it, expect} from "vitest";
import {projectName, hasProjectName} from "./projects";

/**
 * These assert *behaviour*, not specific names: which campaign is called what is now supplied by
 * whoever created it, so the contract every caller depends on is "a named campaign yields its name,
 * an unnamed one yields a readable address, neither yields empty".
 *
 * The map this file used to test is gone — `Types.CampaignConfig` carries a `name`, so there is
 * nothing left to fake. What remains worth pinning is the fallback, because an empty cell in the
 * marketplace's name column reads as a broken row rather than as missing metadata.
 */

const PROJECT = "0xba954E89cE301415964E9405f09F4Cc7c668976A" as const;

const view = (name: string, project: `0x${string}` = PROJECT) => ({name, project});

describe("projectName", () => {
  it("returns the campaign's own name", () => {
    expect(projectName(view("Aerodrome"))).toBe("Aerodrome");
    expect(hasProjectName(view("Aerodrome"))).toBe(true);
  });

  it("keeps the capitalisation and spacing the creator chose", () => {
    // The chain normalizes only to *compare* names; the stored string is verbatim.
    expect(projectName(view("aAvE v3"))).toBe("aAvE v3");
  });

  it("falls back to the shortened address for an unnamed campaign", () => {
    expect(projectName(view(""))).toBe("0xba95…976A");
    expect(hasProjectName(view(""))).toBe(false);
  });

  it("treats a whitespace-only name as unnamed", () => {
    // `Names.validate` rejects this on chain, so it should be unreachable — but rendering a row of
    // blank space would be indistinguishable from a rendering bug if it ever arrived.
    expect(projectName(view("   "))).toBe("0xba95…976A");
    expect(hasProjectName(view("   "))).toBe(false);
  });

  it("never returns an empty string", () => {
    for (const name of ["Aerodrome", "", "   ", "a"]) {
      expect(projectName(view(name)).length).toBeGreaterThan(0);
    }
  });

  it("uses the address of the row it was handed when falling back", () => {
    const other = "0x98405c5776a63547E7Cb16000bA04cA53D9Fb2f8" as const;
    expect(projectName(view("", other))).toBe("0x9840…b2f8");
    // A named campaign resolves by name alone, so the address is irrelevant to the result.
    expect(projectName(view("Moonwell", other))).toBe("Moonwell");
  });

  it("gives campaigns from one project their own names", () => {
    // The old placeholder keyed by campaign id, which made this true by accident. It is now true by
    // design: a name belongs to a campaign, not to the wallet behind it.
    const names = ["Aerodrome", "Velodrome", "Moonwell"].map((n) => projectName(view(n, PROJECT)));
    expect(new Set(names).size).toBe(3);
  });
});
