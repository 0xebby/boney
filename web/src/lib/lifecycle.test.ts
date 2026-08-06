import {describe, it, expect} from "vitest";
import {
  lifecycleAvailability,
  availableActions,
  fundingShortfall,
  isFullyFunded,
  actionLabel,
  type LifecycleContext,
} from "./lifecycle";
import {CLAIM_GRACE_SECONDS} from "./types";

/**
 * Lifecycle guard tests.
 *
 * These assert the same branches `Campaign.sol` takes. The value is in the *negative* cases: an
 * over-permissive mirror renders a button that costs the user gas to discover is invalid, and a
 * revert is the only feedback they get. Each test names the Solidity error it is standing in for.
 */

const NOW = 1_800_000_000;

function ctx(overrides: Partial<LifecycleContext> = {}): LifecycleContext {
  return {
    status: "Pending",
    isProject: true,
    escrowBalance: BigInt(1000),
    rewardPool: BigInt(1000),
    startTime: NOW - 3600,
    endTime: NOW + 86_400,
    endedAtSeconds: 0,
    claimGraceSeconds: CLAIM_GRACE_SECONDS,
    nowSeconds: NOW,
    remainingPool: BigInt(1000),
    ...overrides,
  };
}

function reasonFor(c: LifecycleContext, action: string): string | undefined {
  return lifecycleAvailability(c).find((a) => a.action === action)?.reason;
}

describe("activate", () => {
  it("is available on a funded pending campaign", () => {
    expect(availableActions(ctx())).toContain("activate");
  });

  it("is blocked when escrow is short — Solidity: NotFunded", () => {
    const c = ctx({escrowBalance: BigInt(999), rewardPool: BigInt(1000)});
    expect(availableActions(c)).not.toContain("activate");
    expect(reasonFor(c, "activate")).toMatch(/full reward pool/i);
  });

  it("accepts an over-funded campaign — the contract checks balance >= rewardPool", () => {
    expect(availableActions(ctx({escrowBalance: BigInt(5000)}))).toContain("activate");
  });

  it("is blocked once the window has closed — Solidity: OutsideWindow", () => {
    // The contract reverts on `block.timestamp >= endTime`, so the boundary second is closed.
    expect(availableActions(ctx({endTime: NOW}))).not.toContain("activate");
    expect(availableActions(ctx({endTime: NOW + 1}))).toContain("activate");
  });

  it("allows activation before the start time — only endTime is checked", () => {
    // A campaign activated early simply waits for its window; the contract has no start guard.
    expect(availableActions(ctx({startTime: NOW + 10_000}))).toContain("activate");
  });

  it("is blocked from any non-pending status — Solidity: WrongStatus", () => {
    for (const status of ["Active", "Paused", "Ended", "Cancelled"] as const) {
      expect(availableActions(ctx({status}))).not.toContain("activate");
    }
  });

  it("is blocked for a non-project caller — Solidity: onlyProject", () => {
    expect(availableActions(ctx({isProject: false}))).not.toContain("activate");
  });
});

describe("pause / unpause", () => {
  it("pauses only from Active", () => {
    expect(availableActions(ctx({status: "Active"}))).toContain("pause");
    for (const status of ["Pending", "Paused", "Ended", "Cancelled"] as const) {
      expect(availableActions(ctx({status}))).not.toContain("pause");
    }
  });

  it("resumes only from Paused", () => {
    expect(availableActions(ctx({status: "Paused"}))).toContain("unpause");
    for (const status of ["Pending", "Active", "Ended", "Cancelled"] as const) {
      expect(availableActions(ctx({status}))).not.toContain("unpause");
    }
  });

  it("never offers both at once", () => {
    for (const status of ["Pending", "Active", "Paused", "Ended", "Cancelled"] as const) {
      const actions = availableActions(ctx({status}));
      expect(actions.includes("pause") && actions.includes("unpause")).toBe(false);
    }
  });

  it("requires the project", () => {
    expect(availableActions(ctx({status: "Active", isProject: false}))).not.toContain("pause");
    expect(availableActions(ctx({status: "Paused", isProject: false}))).not.toContain("unpause");
  });
});

describe("end", () => {
  it("lets the project end early from Active or Paused", () => {
    expect(availableActions(ctx({status: "Active"}))).toContain("end");
    expect(availableActions(ctx({status: "Paused"}))).toContain("end");
  });

  it("is the one action a non-project caller can take — once the window closes", () => {
    // Campaign.end() is deliberately not onlyProject: anyone may end it past endTime so a
    // project cannot stall the claim grace window by leaving a finished campaign in limbo.
    const closed = ctx({status: "Active", isProject: false, endTime: NOW - 1});
    expect(availableActions(closed)).toContain("end");
  });

  it("blocks a non-project caller while the window is still open — Solidity: OutsideWindow", () => {
    const open = ctx({status: "Active", isProject: false, endTime: NOW + 3600});
    expect(availableActions(open)).not.toContain("end");
    expect(reasonFor(open, "end")).toMatch(/once its window closes/i);
  });

  it("is blocked from Pending, Ended and Cancelled — Solidity: WrongStatus", () => {
    for (const status of ["Pending", "Ended", "Cancelled"] as const) {
      expect(availableActions(ctx({status}))).not.toContain("end");
    }
  });
});

describe("cancel", () => {
  it("is available only from Pending", () => {
    expect(availableActions(ctx({status: "Pending"}))).toContain("cancel");
    for (const status of ["Active", "Paused", "Ended", "Cancelled"] as const) {
      expect(availableActions(ctx({status}))).not.toContain("cancel");
    }
  });

  it("explains that cancelling after activation would be a rug", () => {
    expect(reasonFor(ctx({status: "Active"}), "cancel")).toMatch(/before it is activated/i);
  });

  it("requires the project", () => {
    expect(availableActions(ctx({isProject: false}))).not.toContain("cancel");
  });
});

describe("reclaimUnspent", () => {
  it("is immediate for a cancelled campaign — nobody earned anything", () => {
    const c = ctx({status: "Cancelled", endedAtSeconds: NOW - 10, remainingPool: BigInt(500)});
    expect(availableActions(c)).toContain("reclaimUnspent");
  });

  it("waits out the grace window after Ended — Solidity: ClaimWindowOpen", () => {
    const justEnded = ctx({
      status: "Ended",
      endedAtSeconds: NOW - 10,
      remainingPool: BigInt(500),
    });
    expect(availableActions(justEnded)).not.toContain("reclaimUnspent");
    expect(reasonFor(justEnded, "reclaimUnspent")).toMatch(/claim window/i);
  });

  it("opens strictly after endedAt + grace, not on the boundary second", () => {
    // The contract reverts while `block.timestamp <= endedAt + CLAIM_GRACE`.
    const endedAt = NOW - CLAIM_GRACE_SECONDS;
    const onBoundary = ctx({
      status: "Ended",
      endedAtSeconds: endedAt,
      nowSeconds: endedAt + CLAIM_GRACE_SECONDS,
      remainingPool: BigInt(500),
    });
    expect(availableActions(onBoundary)).not.toContain("reclaimUnspent");

    const oneSecondLater = {...onBoundary, nowSeconds: endedAt + CLAIM_GRACE_SECONDS + 1};
    expect(availableActions(oneSecondLater)).toContain("reclaimUnspent");
  });

  it("is blocked when nothing remains — Solidity: NothingToReclaim", () => {
    const drained = ctx({
      status: "Cancelled",
      endedAtSeconds: NOW - 10,
      escrowBalance: BigInt(0),
      remainingPool: BigInt(0),
    });
    expect(availableActions(drained)).not.toContain("reclaimUnspent");
    expect(reasonFor(drained, "reclaimUnspent")).toMatch(/no unspent escrow/i);
  });

  it("keys NothingToReclaim off the escrow balance, not remainingPool()", () => {
    // These two genuinely differ. `Campaign.remainingPool()` is the accounting figure
    // `rewardPool - paidOut`, so a campaign cancelled before it was ever funded reports the full
    // pool as "remaining" while the vault holds nothing. Using remainingPool here would offer a
    // Reclaim button that reverts with NothingToReclaim.
    const neverFunded = ctx({
      status: "Cancelled",
      endedAtSeconds: NOW - 10,
      escrowBalance: BigInt(0),
      remainingPool: BigInt(1000),
    });
    expect(availableActions(neverFunded)).not.toContain("reclaimUnspent");

    // And the converse: escrow still holds funds, so reclaim is live even though every tier
    // was paid and the accounting remainder is zero.
    const paidOutButFunded = ctx({
      status: "Cancelled",
      endedAtSeconds: NOW - 10,
      escrowBalance: BigInt(250),
      remainingPool: BigInt(0),
    });
    expect(availableActions(paidOutButFunded)).toContain("reclaimUnspent");
  });

  it("is blocked while the campaign is still running — Solidity: WrongStatus", () => {
    for (const status of ["Pending", "Active", "Paused"] as const) {
      expect(availableActions(ctx({status}))).not.toContain("reclaimUnspent");
    }
  });

  it("requires the project", () => {
    const c = ctx({
      status: "Cancelled",
      isProject: false,
      endedAtSeconds: NOW - 10,
      remainingPool: BigInt(500),
    });
    expect(availableActions(c)).not.toContain("reclaimUnspent");
  });
});

describe("availability shape", () => {
  it("always reports all six actions, available or not", () => {
    const all = lifecycleAvailability(ctx());
    expect(all).toHaveLength(6);
    expect(all.map((a) => a.action)).toEqual([
      "activate",
      "pause",
      "unpause",
      "end",
      "cancel",
      "reclaimUnspent",
    ]);
  });

  it("gives a reason for every blocked action and none for available ones", () => {
    for (const status of ["Pending", "Active", "Paused", "Ended", "Cancelled"] as const) {
      for (const a of lifecycleAvailability(ctx({status}))) {
        if (a.available) expect(a.reason).toBeUndefined();
        else expect(a.reason).toBeTruthy();
      }
    }
  });

  it("offers a non-project viewer nothing but end-after-window", () => {
    // The read-only case: a KOL browsing someone else's campaign gets no project actions at all,
    // so the Project Dashboard panel hides itself rather than rendering six disabled buttons.
    const viewer = ctx({status: "Active", isProject: false, endTime: NOW + 3600});
    expect(availableActions(viewer)).toEqual([]);
  });

  it("labels every action", () => {
    for (const a of lifecycleAvailability(ctx())) {
      expect(actionLabel(a.action)).toBeTruthy();
    }
  });
});

describe("funding", () => {
  it("reports the exact shortfall", () => {
    expect(fundingShortfall(BigInt(400), BigInt(1000))).toBe(BigInt(600));
  });

  it("clamps an over-funded campaign to zero rather than going negative", () => {
    expect(fundingShortfall(BigInt(5000), BigInt(1000))).toBe(BigInt(0));
  });

  it("treats an exactly-funded campaign as funded", () => {
    expect(isFullyFunded(BigInt(1000), BigInt(1000))).toBe(true);
    expect(fundingShortfall(BigInt(1000), BigInt(1000))).toBe(BigInt(0));
  });

  it("stays exact beyond Number.MAX_SAFE_INTEGER", () => {
    // Token amounts are 18-decimal bigints; a float round-trip here would lose the shortfall.
    const pool = BigInt("1000000000000000000000000");
    const balance = BigInt("999999999999999999999999");
    expect(fundingShortfall(balance, pool)).toBe(BigInt(1));
    expect(isFullyFunded(balance, pool)).toBe(false);
  });
});
