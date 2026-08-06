import {MAX_KPIS, MAX_TIERS_PER_KPI, type KpiKind} from "./types";

/**
 * Client-side mirrors of `Campaign`'s constructor validation.
 *
 * Every rule here exists in Solidity too — this is not the security boundary, the contract is.
 * The point is failing in the form instead of failing as a reverted transaction the user paid
 * gas for. If these ever drift from the contract, the contract wins.
 *
 * Corresponding Solidity errors: NoKpis, TooManyKpis, TierLengthMismatch, EmptyTiers,
 * TooManyTiers, TiersNotAscending, ZeroTierReward, CustomKpiNeedsVerifier, ZeroRewardPool,
 * InvalidWindow.
 */

export type TierDraft = {threshold: string; reward: string};

export type KpiDraft = {
  kind: KpiKind;
  verifier: string;
  target: string;
  aggregate: boolean;
  tiers: TierDraft[];
};

export type CampaignDraft = {
  token: string;
  rewardPool: string;
  startTime: number;
  endTime: number;
  attributionWindow: number;
  minReputation: string;
  kpis: KpiDraft[];
};

export type ValidationIssue = {
  /** Dotted path to the offending field, e.g. "kpis.0.tiers.2.threshold". */
  path: string;
  message: string;
};

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export function isAddress(value: string): boolean {
  return ADDRESS_RE.test(value);
}

/** Parses a decimal string to bigint base units. Returns null when unparseable. */
export function parseAmount(value: string, decimals: number): bigint | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^\d*\.?\d*$/.test(trimmed)) return null;

  const [whole = "0", frac = ""] = trimmed.split(".");
  if (frac.length > decimals) return null;

  const padded = frac.padEnd(decimals, "0");
  try {
    return BigInt(whole || "0") * BigInt(10) ** BigInt(decimals) + BigInt(padded || "0");
  } catch {
    return null;
  }
}

/** Parses a plain integer string (KPI thresholds are counts, not token amounts). */
export function parseCount(value: string): bigint | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  try {
    return BigInt(trimmed);
  } catch {
    return null;
  }
}

export function validateCampaignDraft(
  draft: CampaignDraft,
  opts: {tokenDecimals: number; nowSeconds: number},
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const {tokenDecimals, nowSeconds} = opts;

  // ── token & pool ──────────────────────────────────────────────
  if (!isAddress(draft.token)) {
    issues.push({path: "token", message: "Enter a valid ERC-20 address."});
  } else if (draft.token === ZERO_ADDRESS) {
    issues.push({path: "token", message: "Token cannot be the zero address."});
  }

  const pool = parseAmount(draft.rewardPool, tokenDecimals);
  if (pool === null) {
    issues.push({path: "rewardPool", message: "Enter a valid amount."});
  } else if (pool === BigInt(0)) {
    // Solidity: ZeroRewardPool
    issues.push({path: "rewardPool", message: "Reward pool must be greater than zero."});
  }

  // ── window ────────────────────────────────────────────────────
  // Solidity: InvalidWindow
  if (draft.endTime <= draft.startTime) {
    issues.push({path: "endTime", message: "End time must be after the start time."});
  }
  if (draft.endTime <= nowSeconds) {
    issues.push({path: "endTime", message: "End time must be in the future."});
  }
  if (draft.attributionWindow <= 0) {
    issues.push({
      path: "attributionWindow",
      message: "Attribution window must be greater than zero.",
    });
  }

  // ── KPIs ──────────────────────────────────────────────────────
  if (draft.kpis.length === 0) {
    // Solidity: NoKpis
    issues.push({path: "kpis", message: "Add at least one KPI."});
  }
  if (draft.kpis.length > MAX_KPIS) {
    // Solidity: TooManyKpis
    issues.push({path: "kpis", message: `A campaign can have at most ${MAX_KPIS} KPIs.`});
  }

  draft.kpis.forEach((kpi, i) => {
    // Solidity: CustomKpiNeedsVerifier — a Custom KPI has no protocol meaning without an adapter.
    if (kpi.kind === "Custom" && (!isAddress(kpi.verifier) || kpi.verifier === ZERO_ADDRESS)) {
      issues.push({
        path: `kpis.${i}.verifier`,
        message: "A Custom KPI needs a verifier adapter address.",
      });
    }
    if (kpi.verifier && kpi.verifier !== ZERO_ADDRESS && !isAddress(kpi.verifier)) {
      issues.push({path: `kpis.${i}.verifier`, message: "Enter a valid address."});
    }

    // Solidity: EmptyTiers — aggregate KPIs are analytics-only and may legitimately have none.
    if (kpi.tiers.length === 0 && !kpi.aggregate) {
      issues.push({
        path: `kpis.${i}.tiers`,
        message: "Add at least one reward tier, or mark this KPI as aggregate.",
      });
    }
    // Solidity: TooManyTiers
    if (kpi.tiers.length > MAX_TIERS_PER_KPI) {
      issues.push({
        path: `kpis.${i}.tiers`,
        message: `A KPI can have at most ${MAX_TIERS_PER_KPI} tiers.`,
      });
    }

    let previous: bigint | null = null;
    kpi.tiers.forEach((tier, j) => {
      const threshold = parseCount(tier.threshold);
      const reward = parseAmount(tier.reward, tokenDecimals);

      if (threshold === null) {
        issues.push({
          path: `kpis.${i}.tiers.${j}.threshold`,
          message: "Enter a whole number.",
        });
      }
      if (reward === null) {
        issues.push({path: `kpis.${i}.tiers.${j}.reward`, message: "Enter a valid amount."});
      } else if (reward === BigInt(0)) {
        // Solidity: ZeroTierReward
        issues.push({
          path: `kpis.${i}.tiers.${j}.reward`,
          message: "Tier reward must be greater than zero.",
        });
      }

      // Solidity: TiersNotAscending — strictly ascending lets settlement walk the ladder once.
      if (threshold !== null) {
        if (previous !== null && threshold <= previous) {
          issues.push({
            path: `kpis.${i}.tiers.${j}.threshold`,
            message: "Thresholds must increase from one tier to the next.",
          });
        }
        previous = threshold;
      }
    });
  });

  // ── pool coverage (advisory, not a contract rule) ──────────────
  // The contract lets the pool run dry and pays partial (PoolExhausted), so this is a warning
  // about campaign design rather than a validation failure.
  return issues;
}

/**
 * Total rewards if a single promoter completed every ladder. Not a contract constraint —
 * the pool is shared and first-come — but worth surfacing so a project sees the exposure.
 */
export function maxSinglePromoterPayout(
  draft: CampaignDraft,
  tokenDecimals: number,
): bigint {
  let total = BigInt(0);
  for (const kpi of draft.kpis) {
    for (const tier of kpi.tiers) {
      const reward = parseAmount(tier.reward, tokenDecimals);
      if (reward !== null) total += reward;
    }
  }
  return total;
}
