import {MAX_KPIS, MAX_TIERS_PER_KPI, MAX_CAMPAIGN_NAME_LENGTH, type KpiKind} from "./types";
import {MAX_BONEY_SCORE} from "./boneyscore";
import {normalizeTopicValue} from "./kpiSource";

/**
 * Client-side mirrors of `Campaign`'s constructor validation.
 *
 * Every rule here exists in Solidity too — this is not the security boundary, the contract is.
 * The point is failing in the form instead of failing as a reverted transaction the user paid
 * gas for. If these ever drift from the contract, the contract wins.
 *
 * Corresponding Solidity errors: NoKpis, TooManyKpis, TierLengthMismatch, EmptyTiers,
 * TooManyTiers, TiersNotAscending, ZeroTierReward, CustomKpiNeedsVerifier, ZeroRewardPool,
 * InvalidWindow, UnreachableReputation, EmptyName, NameTooLong, InvalidNameChar, NameTaken.
 *
 * Two rules here have no Solidity counterpart, each flagged where it appears. The event-source checks:
 * the chain never reads that blob, so a malformed source deploys fine and then indexes nothing. And
 * tiers on an aggregate KPI: the contract accepts them and no promoter can ever cross one, so the pool
 * escrows real money behind rewards nothing can release.
 *
 * The `minReputation` ceiling used to be in that category and no longer is — `Campaign`'s
 * constructor rejects an unreachable gate itself, which is what covers campaigns created outside
 * this form. The version here differs in one way worth knowing: the contract computes the ceiling
 * from live schema configuration, while this file derives it from the seeded weights. See the note
 * at that check.
 *
 * Name *uniqueness* is the one rule this file cannot decide alone: it is a property of the registry's
 * index, not of the draft. The caller reads `CampaignRegistry.isNameAvailable` and passes the answer
 * in as `opts.nameTaken`, so normalization stays on chain and there is no second implementation of it
 * here to drift.
 */

export type TierDraft = {threshold: string; reward: string};

/**
 * Where a KPI's progress comes from, as form strings.
 *
 * Encoded into `KpiSpec.params` by `campaignArgs.ts` — see `kpiSource.ts` for the wire format and
 * why the encoding lives on chain rather than in an indexer's config file. An empty `source` means
 * the KPI is not event-sourced, which is every campaign created before this existed.
 */
export type EventSourceDraft = {
  /** Contract whose logs are watched. Empty disables event sourcing for this KPI. */
  source: string;
  /** Human-readable event signature, e.g. `Deposit(address,uint256)`. */
  signature: string;
  /** Which indexed topic carries the referral's address, as "1" | "2" | "3". */
  actorTopic: string;
  /** "count" or "dataWord0" — see `AMOUNT_MODE`. */
  amountMode: string;
  /** Divisor applied before crediting, so tier thresholds stay human numbers. */
  scale: string;
  /** Indexed topic that must equal `filterValue`, as "0" (no filter) | "1" | "2" | "3". */
  filterTopic?: string;
  /** Address or 32-byte word `topics[filterTopic]` must equal. */
  filterValue?: string;
};

export type KpiDraft = {
  kind: KpiKind;
  verifier: string;
  target: string;
  aggregate: boolean;
  tiers: TierDraft[];
  /** Absent on KPIs reported manually by the project. */
  eventSource?: EventSourceDraft;
};

export type CampaignDraft = {
  name: string;
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

/**
 * Whether every character is printable ASCII (0x20–0x7E), matching `Names.validate`.
 *
 * Deliberately not a Unicode-aware check: the contract's rule *is* "ASCII only", so a laxer test
 * here would let a name through the form that reverts on submit, and a stricter one would refuse a
 * name the chain accepts. Iterates code points rather than UTF-16 units so an astral character (an
 * emoji) is rejected once rather than twice.
 */
export function isPrintableAscii(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
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

/**
 * Whether a ceiling is a number worth comparing against.
 *
 * `ReputationRegistry.maxScore` returns `type(uint256).max` when a weighted schema carries no value
 * cap — an unbounded score, not an astronomically large one. Comparing a gate against it would pass
 * everything, which is correct, but saying "no wallet can score above 1.15e77" on the way there would
 * not be. Anything past a real BoneyScore's range is treated as unbounded rather than testing for the
 * exact sentinel, since a second uncapped schema saturates to the same meaning at a different value.
 *
 * Exported so the form's hint and this check agree on what "unbounded" means.
 */
export function isBoundedScoreCeiling(ceiling: bigint): boolean {
  return ceiling <= BigInt(Number.MAX_SAFE_INTEGER);
}

export function validateCampaignDraft(
  draft: CampaignDraft,
  opts: {
    tokenDecimals: number;
    nowSeconds: number;
    nameTaken?: boolean;
    /**
     * `ReputationRegistry.maxScore()`, read by the caller.
     *
     * Omit it and the check falls back to `MAX_BONEY_SCORE`, which is the same arithmetic against the
     * seeded schema configuration. Pass it and the form checks the gate against the ceiling the
     * constructor will actually compare it to. See the note at the eligibility check.
     */
    scoreCeiling?: bigint;
  },
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const {tokenDecimals, nowSeconds, nameTaken, scoreCeiling} = opts;

  // ── name ──────────────────────────────────────────────────────
  // Solidity: EmptyName, NameTooLong, InvalidNameChar (Names.validate), NameTaken (the registry).
  //
  // Length is checked against the *raw* string and the charset check is what makes that sound: the
  // contract's limit is 32 bytes, and rejecting every non-ASCII byte means one character is one byte.
  // Without the charset rule, "café" would count as 4 here and 5 on chain.
  const name = draft.name.trim();
  if (!name) {
    issues.push({path: "name", message: "Give the campaign a name."});
  } else if (draft.name.length > MAX_CAMPAIGN_NAME_LENGTH) {
    issues.push({
      path: "name",
      message: `Keep the name to ${MAX_CAMPAIGN_NAME_LENGTH} characters or fewer.`,
    });
  } else if (!isPrintableAscii(draft.name)) {
    issues.push({
      path: "name",
      message:
        "Names use plain letters, digits, spaces and punctuation only — no emoji or accented " +
        "characters. Lookalike characters would let one campaign impersonate another.",
    });
  } else if (nameTaken) {
    // Read from the chain by the caller, because the registry normalizes before comparing: "Aave",
    // "aave" and "Aave " are the same name to it.
    issues.push({path: "name", message: "Another campaign already uses that name."});
  }

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

  // ── eligibility gate ──────────────────────────────────────────
  // Solidity: UnreachableReputation. A gate above the highest attainable BoneyScore produces a
  // campaign that deploys cleanly, accepts funding, renders as Active and can never be joined by
  // anyone — and `minReputation` is immutable, so there is no correcting it after the fact. The
  // constructor now rejects this outright, which is what protects campaigns created by a script or
  // a direct contract call; this check exists so the form catches it before the user pays gas.
  //
  // The ceiling is a property of the registered schemas rather than a constant of the protocol: the
  // contract derives it from live schema weights and per-schema value caps
  // (`ReputationRegistry.maxScore`). `opts.scoreCeiling` is that number, read by the caller
  // (`useScoreCeiling`); `MAX_BONEY_SCORE` is the same arithmetic against the *seeded* configuration
  // and is the fallback when the read is unavailable.
  //
  // Preferring the live value is not a refinement, it is the whole point. A registry with no schemas
  // registered reports a ceiling of 0 — `DeployBoney` registers none, and a redeploy that skips
  // `SeedDevRep` leaves it that way — so the local constant said 28,000, the chain said 0, and the
  // disagreement surfaced as `UnreachableReputation(15000, 0)` after the gas was spent.
  const minReputationRaw = draft.minReputation.trim();
  if (minReputationRaw) {
    const minReputation = parseCount(minReputationRaw);
    if (minReputation === null) {
      // Otherwise this surfaces much later as a DraftEncodingError from `campaignArgs`, which is
      // thrown at submit time and not attached to any field.
      issues.push({path: "minReputation", message: "Enter a whole number."});
    } else {
      const ceiling = scoreCeiling ?? BigInt(MAX_BONEY_SCORE);

      if (ceiling === BigInt(0) && minReputation > BigInt(0)) {
        // Not "your number is too high" — no number above zero is possible here, so the advice has to
        // name the actual fix rather than send someone hunting for a value that works.
        issues.push({
          path: "minReputation",
          message:
            "No wallet can hold any BoneyScore on this network yet: the reputation registry has no " +
            "weighted schemas, so every gate above 0 locks everyone out. Leave this empty until the " +
            "schemas are registered (script/SeedDevRep.s.sol).",
        });
      } else if (isBoundedScoreCeiling(ceiling) && minReputation > ceiling) {
        issues.push({
          path: "minReputation",
          message:
            `No wallet can score above ${ceiling.toLocaleString("en-US")} on this network, so nobody ` +
            `could ever join this campaign. BoneyScore is 7 × Ethos + 3 × reach, and both inputs cap ` +
            `at 2,800.`,
        });
      }
    }
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
    /*
      The reverse rule, which has NO Solidity counterpart — the contract accepts an aggregate KPI
      carrying a full reward ladder, and that combination can never pay anybody.

      `reportUserAction` reverts `AggregateKpi` before it does attribution or verification, and the only
      writable path for an aggregate, `applyAggregateUpdate`, moves `_totalProgress` and never
      `_progress[promoter]`. So no promoter can hold progress on one, no tier threshold can be crossed,
      and every tier below is unreachable by construction rather than merely unlikely.

      This is not hypothetical: on 2026-08-25, campaign 8 "Gyndore" escrowed 350,000 bUSD against a
      three-tier, 27,000 bUSD ladder on a single aggregate Swap KPI, and was ended three hours later with
      `totalProgress` 0. The escrow is real money locked behind rewards nothing can release, so this
      blocks rather than warns — and unlike the checks above it is a rule about *what the campaign can
      do*, not a mirror of the constructor.
    */
    if (kpi.aggregate && kpi.tiers.length > 0) {
      issues.push({
        path: `kpis.${i}.tiers`,
        message:
          "An aggregate KPI tracks a campaign-wide total, so no promoter can be credited on it and " +
          "these tiers can never pay out. Remove the tiers, or untick aggregate.",
      });
    }
    // Solidity: TooManyTiers
    if (kpi.tiers.length > MAX_TIERS_PER_KPI) {
      issues.push({
        path: `kpis.${i}.tiers`,
        message: `A KPI can have at most ${MAX_TIERS_PER_KPI} tiers.`,
      });
    }

    // ── event source (optional; not a contract rule) ─────────────
    // The chain never reads this blob — `Campaign` forwards `params` to the verifier and otherwise
    // ignores it. These checks exist because a malformed source produces a campaign that deploys
    // fine and then silently indexes nothing.
    const src = kpi.eventSource;
    if (src && src.source.trim()) {
      if (!isAddress(src.source.trim())) {
        issues.push({path: `kpis.${i}.eventSource.source`, message: "Enter a valid address."});
      }
      if (!src.signature.trim()) {
        issues.push({
          path: `kpis.${i}.eventSource.signature`,
          message: "Enter the event signature, e.g. Deposit(address,uint256).",
        });
      } else if (!/^[A-Za-z_]\w*\([^)]*\)$/.test(src.signature.trim())) {
        // The topic hash is keccak of this exact string, so a stray space or a named argument
        // hashes to something no log will ever carry.
        issues.push({
          path: `kpis.${i}.eventSource.signature`,
          message: "Use types only, no spaces or names: Deposit(address,uint256).",
        });
      }

      const topic = Number(src.actorTopic);
      if (!Number.isInteger(topic) || topic < 1 || topic > 3) {
        // topics[0] is always the signature, so an actor can never live there.
        issues.push({
          path: `kpis.${i}.eventSource.actorTopic`,
          message: "The actor topic must be 1, 2, or 3.",
        });
      }

      if (src.scale.trim() && parseCount(src.scale) === null) {
        issues.push({path: `kpis.${i}.eventSource.scale`, message: "Enter a whole number."});
      }

      const filterTopic = Number(src.filterTopic?.trim() || "0");
      const filterValue = src.filterValue?.trim() ?? "";
      if (!Number.isInteger(filterTopic) || filterTopic < 0 || filterTopic > 3) {
        issues.push({
          path: `kpis.${i}.eventSource.filterTopic`,
          message: "The filter topic must be 1, 2, or 3, or none.",
        });
      } else if (filterTopic !== 0) {
        if (filterTopic === topic) {
          // One topic cannot both carry the credited wallet and be pinned to a literal.
          issues.push({
            path: `kpis.${i}.eventSource.filterTopic`,
            message: "The filter topic must differ from the actor topic.",
          });
        }
        if (!filterValue) {
          // A zero value is a real filter — a mint's `from` — so it cannot stand in for "unset".
          issues.push({
            path: `kpis.${i}.eventSource.filterValue`,
            message: "Enter the value this topic must equal.",
          });
        } else if (normalizeTopicValue(filterValue) === null) {
          issues.push({
            path: `kpis.${i}.eventSource.filterValue`,
            message: "Enter an address or a 32-byte hex word.",
          });
        }
      }

      // TouchWindowVerifier reads params as a bare uint64 and returns lookback 0 unless the blob
      // is exactly 32 bytes (TouchWindowVerifier.sol:113). An event blob is 160. The result is
      // fail-safe — strict crediting, never over-crediting — but it is silently not the lookback
      // that was configured, so say so rather than letting it pass.
      if (kpi.verifier.trim() && kpi.verifier.trim() !== ZERO_ADDRESS) {
        issues.push({
          path: `kpis.${i}.eventSource.source`,
          message:
            "A verifier and an event source share the params field. TouchWindowVerifier will read a lookback of 0.",
        });
      }
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
