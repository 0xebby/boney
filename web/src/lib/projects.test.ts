import {describe, it, expect} from "vitest";
import {projectName, hasProjectName} from "./projects";

/**
 * The map is placeholder data, so these tests deliberately assert *behavior* rather than the
 * specific names: which campaign is called "Aave" is arbitrary and will change, but "a covered id
 * yields a name, an uncovered one yields a readable address, neither yields empty" is the contract
 * every caller depends on.
 */

const PROJECT = "0xba954E89cE301415964E9405f09F4Cc7c668976A" as const;

const view = (campaignId: bigint, project: `0x${string}` = PROJECT) => ({campaignId, project});

describe("projectName", () => {
  it("names every seeded campaign id", () => {
    for (let id = 0n; id <= 11n; id++) {
      expect(hasProjectName(view(id))).toBe(true);
      expect(projectName(view(id))).not.toMatch(/^0x/);
    }
  });

  it("gives distinct names to campaigns sharing one project address", () => {
    // The whole reason the map is keyed by id: every seeded campaign has the same `project`, so
    // an address-keyed map would collapse the column to one repeated value.
    const names = new Set(Array.from({length: 12}, (_, i) => projectName(view(BigInt(i)))));
    expect(names.size).toBe(12);
  });

  it("falls back to the shortened address for an uncovered id", () => {
    expect(hasProjectName(view(12n))).toBe(false);
    expect(projectName(view(12n))).toBe("0xba95…976A");
  });

  it("never returns an empty string", () => {
    for (const id of [0n, 5n, 11n, 12n, 9999n]) {
      expect(projectName(view(id)).length).toBeGreaterThan(0);
    }
  });

  it("ignores the project address when the id is covered", () => {
    // Covered ids resolve by id alone — changing the address must not change the name, which is
    // what makes this a placeholder rather than a lookup.
    const other = "0x98405c5776a63547E7Cb16000bA04cA53D9Fb2f8" as const;
    expect(projectName(view(3n, other))).toBe(projectName(view(3n)));
  });

  it("uses the address of the row it was handed for uncovered ids", () => {
    const other = "0x98405c5776a63547E7Cb16000bA04cA53D9Fb2f8" as const;
    expect(projectName(view(12n, other))).toBe("0x9840…b2f8");
  });
});
