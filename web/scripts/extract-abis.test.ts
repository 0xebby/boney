import {describe, it, expect} from "vitest";
import {readAbi, CONTRACTS, type AbiEntry} from "./extract-abis";

/**
 * Lists named functions in an ABI.
 *
 * @param abi ABI entries to inspect.
 * @returns Function names in ABI order.
 */
function fnNames(abi: AbiEntry[]): string[] {
  return abi.flatMap((entry) =>
    entry.type === "function" && entry.name ? [entry.name] : [],
  );
}

/**
 * Finds a named function in an ABI.
 *
 * @param abi ABI entries to inspect.
 * @param name Function name to find.
 * @returns The matching entry, if present.
 */
function fn(abi: AbiEntry[], name: string): AbiEntry | undefined {
  return abi.find((entry) => entry.type === "function" && entry.name === name);
}

describe("ABI extraction", () => {
  it("every configured artifact exists and parses", () => {
    for (const {name, artifact} of CONTRACTS) {
      const abi = readAbi(artifact);
      expect(abi.length, `${name} has no ABI entries`).toBeGreaterThan(0);
    }
  });

  describe("Boney facade", () => {
    const abi = readAbi("Boney.sol/Boney.json");

    it("exposes the functions the UI calls", () => {
      const names = fnNames(abi);
      for (const required of [
        "createCampaign",
        "fundCampaign",
        "registerAttribution",
        "claimRewards",
        "campaignView",
        "browseCampaigns",
        "campaignCount",
        "reputationOf",
        "promoterProgress",
        "campaignAddress",
      ]) {
        expect(names, `Boney.${required} missing`).toContain(required);
      }
    });

    it("browseCampaigns takes (offset, limit) and returns a list", () => {
      const f = fn(abi, "browseCampaigns");
      expect(f?.inputs).toHaveLength(2);
      expect(f?.stateMutability).toBe("view");
      expect(f?.outputs).toHaveLength(1);
    });

    it("does not expose joinAsKOL", () => {
      expect(fnNames(abi)).not.toContain("joinAsKOL");
    });
  });

  describe("Campaign", () => {
    const abi = readAbi("Campaign.sol/Campaign.json");

    it("exposes lifecycle and settlement functions", () => {
      const names = fnNames(abi);
      for (const required of [
        "activate",
        "pause",
        "unpause",
        "end",
        "cancel",
        "join",
        "reportUserAction",
        "applyAggregateUpdate",
        "settle",
        "reclaimUnspent",
      ]) {
        expect(names, `Campaign.${required} missing`).toContain(required);
      }
    });

    it("exposes the views the detail page renders", () => {
      const names = fnNames(abi);
      for (const required of [
        "status",
        "config",
        "kpiCount",
        "kpi",
        "tiers",
        "promoterIdOf",
        "promoterOf",
        "progressOf",
        "totalProgress",
        "paidOut",
        "remainingPool",
        "settledTiersOf",
        "userCreditedOf",
      ]) {
        expect(names, `Campaign.${required} missing`).toContain(required);
      }
    });

    it("exposes the shape caps the create form validates against", () => {
      const names = fnNames(abi);
      expect(names).toContain("MAX_KPIS");
      expect(names).toContain("MAX_TIERS_PER_KPI");
      expect(names).toContain("CLAIM_GRACE");
    });
  });

  describe("AttributionRegistry", () => {
    const abi = readAbi("AttributionRegistry.sol/AttributionRegistry.json");

    it("exposes the EIP-712 pieces the signing flow needs", () => {
      const names = fnNames(abi);
      expect(names).toContain("TOUCH_TYPEHASH");
      expect(names).toContain("DOMAIN_SEPARATOR");
      expect(names).toContain("storeTouch");
      expect(names).toContain("activePromoter");
      expect(names).toContain("maxTouchDuration");
    });

    it("storeTouch takes (user, touch, signature, relayer)", () => {
      const f = fn(abi, "storeTouch");
      expect(f?.inputs).toHaveLength(4);
    });
  });

  describe("ReputationRegistry", () => {
    const abi = readAbi("ReputationRegistry.sol/ReputationRegistry.json");

    it("exposes scoring and schema views", () => {
      const names = fnNames(abi);
      for (const required of [
        "scoreOf",
        "qualifies",
        "valueOf",
        "schemaCount",
        "schemaIdAt",
        "schemaInfo",
        "MAX_SCHEMAS",
      ]) {
        expect(names, `ReputationRegistry.${required} missing`).toContain(required);
      }
    });
  });

  describe("EscrowVault", () => {
    const abi = readAbi("EscrowVault.sol/EscrowVault.json");

    it("deposit takes campaign and amount", () => {
      const f = fn(abi, "deposit");
      expect(f?.inputs).toHaveLength(2);
    });

    it("exposes balance and token views", () => {
      const names = fnNames(abi);
      expect(names).toContain("balanceOf");
      expect(names).toContain("tokenOf");
    });
  });
});
