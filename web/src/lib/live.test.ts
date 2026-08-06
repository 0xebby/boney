import {describe, it, expect, beforeAll} from "vitest";
import {createPublicClient, createWalletClient, http, keccak256, toHex} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {anvil} from "viem/chains";
import {fetchBrowseCampaigns, fetchCampaignCount} from "./contracts";
import {fetchCampaignDetail, fetchPromoterState} from "./campaignDetail";
import {summarize, filterCampaigns, EMPTY_FILTERS} from "./filters";
import {
  utilization,
  claimableRewards,
  crossedTierCount,
  unsettledRewards,
  isReclaimable,
  settledRewards,
  settlementPayout,
} from "./campaign";
import {
  derivePromoterId,
  hasJoined,
  canJoin,
  canSettle,
  trackingLink,
  parseTrackingLink,
} from "./kol";
import {DEPLOYMENTS} from "./chains";
import {ReputationRegistryAbi, IERC20Abi, AttributionRegistryAbi, CampaignAbi} from "./abis";
import {
  TOUCH_TYPEHASH,
  attributionDomain,
  buildTouch,
  fetchMaxTouchDuration,
  TOUCH_EIP712_TYPES,
} from "./attribution";
import {formatTokenAmount} from "./format";
import {availableActions, fundingShortfall} from "./lifecycle";
import {KPI_KIND, CLAIM_GRACE_SECONDS} from "./types";

/** Anvil account #2 — `KOL_PK` in `script/SeedLocal.s.sol`, the KOL seeded with progress. */
const SEEDED_KOL = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;

/** Anvil account #6 — untouched by the seed, so it has joined nothing and has no reputation. */
const NEVER_JOINED = "0x976EA74026E726554dB657fA54763abd0C3a0aa9" as const;

/**
 * Live-chain integration test (decision F7).
 *
 * This runs the app's *own* read path against a real anvil deployment. It exists because the
 * contract phase proved compile-only checks miss real bugs: the deploy script shipped a vault
 * whose registrar could never register campaigns, and that only surfaced when the script was
 * executed. Mocking these reads would re-introduce exactly that blind spot — a mock cannot
 * disagree with the chain, so it cannot catch an ABI or decoding mismatch.
 *
 * Skips itself when anvil is not running, so `pnpm test` stays green without a chain:
 *   anvil --port 8545 --chain-id 31337
 *   forge script script/DeployBoney.s.sol:DeployBoney --rpc-url … --broadcast
 *   forge script script/SeedLocal.s.sol:SeedLocal    --rpc-url … --broadcast
 */

const client = createPublicClient({chain: anvil, transport: http("http://127.0.0.1:8545")});

let chainUp = false;

beforeAll(async () => {
  try {
    await client.getBlockNumber();
    chainUp = true;
  } catch {
    chainUp = false;
  }
});

describe.skipIf(!process.env.LIVE_CHAIN)("live chain reads", () => {
  it("connects to anvil", async () => {
    expect(chainUp, "anvil is not reachable on 127.0.0.1:8545").toBe(true);
  });

  it("reads the seeded campaign count", async () => {
    const count = await fetchCampaignCount(client);
    expect(count).toBeGreaterThanOrEqual(BigInt(4));
  });

  it("decodes campaign views with the right shape and enum mapping", async () => {
    const views = await fetchBrowseCampaigns(client, BigInt(0), BigInt(100));
    expect(views.length).toBeGreaterThanOrEqual(4);

    const first = views[0];
    // Status must decode to a label, never a raw uint8 leaking through.
    expect(["Pending", "Active", "Paused", "Ended", "Cancelled"]).toContain(first.status);
    expect(first.campaign).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(first.project).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(typeof first.rewardPool).toBe("bigint");
    expect(first.kpiCount).toBeGreaterThan(BigInt(0));
  });

  it("sees every seeded lifecycle state", async () => {
    const views = await fetchBrowseCampaigns(client, BigInt(0), BigInt(100));
    const statuses = new Set(views.map((v) => v.status));

    // SeedLocal creates active-with-progress, active-empty, pending, and ended campaigns.
    expect(statuses.has("Active")).toBe(true);
    expect(statuses.has("Pending")).toBe(true);
    expect(statuses.has("Ended")).toBe(true);
  });

  it("agrees with on-chain settlement: paid out never exceeds the pool", async () => {
    const views = await fetchBrowseCampaigns(client, BigInt(0), BigInt(100));
    for (const v of views) {
      expect(v.paidOut <= v.rewardPool, `campaign ${v.campaignId} overpaid`).toBe(true);
      expect(utilization(v)).toBeGreaterThanOrEqual(0);
      expect(utilization(v)).toBeLessThanOrEqual(1);
    }
  });

  it("summarizes the live list without float drift", async () => {
    const views = await fetchBrowseCampaigns(client, BigInt(0), BigInt(100));
    const summary = summarize(views);

    expect(summary.count).toBe(views.length);
    expect(summary.totalPool).toBe(views.reduce((a, v) => a + v.rewardPool, BigInt(0)));
    expect(summary.totalPaidOut).toBe(views.reduce((a, v) => a + v.paidOut, BigInt(0)));
  });

  it("filters live data by status", async () => {
    const views = await fetchBrowseCampaigns(client, BigInt(0), BigInt(100));
    const active = filterCampaigns(views, {...EMPTY_FILTERS, status: "Active"}, BigInt(0));

    expect(active.length).toBeGreaterThan(0);
    expect(active.every((v) => v.status === "Active")).toBe(true);
  });

  /**
   * Cross-checks the frontend's tier math against what the chain actually paid. The seeded KOL
   * reached 62 mints on a 10/50/100 ladder, so tiers 0 and 1 are settled.
   */
  it("tier math matches the chain's actual payout", async () => {
    const views = await fetchBrowseCampaigns(client, BigInt(0), BigInt(100));
    const withProgress = views.find((v) => v.paidOut > BigInt(0));
    expect(withProgress, "no seeded campaign has progress").toBeDefined();

    const pool = withProgress!.rewardPool;
    // SeedLocal builds tiers as pool/20, pool/10, pool/5 at thresholds 10, 50, 100.
    const tiers = [
      {threshold: BigInt(10), reward: pool / BigInt(20)},
      {threshold: BigInt(50), reward: pool / BigInt(10)},
      {threshold: BigInt(100), reward: pool / BigInt(5)},
    ];

    // KOL 1 at 62 → tiers 0+1; KOL 2 at 14 → tier 0 only.
    const expected =
      claimableRewards(BigInt(62), tiers) + claimableRewards(BigInt(14), tiers);

    expect(withProgress!.paidOut).toBe(expected);
  });

  it("formats live token amounts without precision loss", async () => {
    const views = await fetchBrowseCampaigns(client, BigInt(0), BigInt(100));
    const big = views.find((v) => v.rewardPool >= BigInt("50000000000000000000000"));
    expect(big).toBeDefined();
    // 50,000 * 10^18 — well beyond Number.MAX_SAFE_INTEGER.
    expect(formatTokenAmount(big!.rewardPool, 18, {maxFractionDigits: 0})).toBe("50,000");
  });

  /**
   * The detail path reads the `Campaign` contract directly (the facade has no KPI accessors) and
   * decodes a heterogeneous multicall positionally. A unit test with a fake client can prove the
   * slot stride is self-consistent, but only a real ABI round trip proves the slots hold what the
   * contract actually returns.
   */
  describe("campaign detail", () => {
    it("decodes the detail record against the real ABI", async () => {
      const views = await fetchBrowseCampaigns(client, BigInt(0), BigInt(100));
      const target = views.find((v) => v.kpiCount > BigInt(0));
      expect(target, "no seeded campaign has KPIs").toBeDefined();

      const detail = await fetchCampaignDetail(client, target!.campaign);

      // Cross-check the fields the facade also reports: two independent read paths agreeing is
      // stronger evidence than either alone.
      expect(detail.project.toLowerCase()).toBe(target!.project.toLowerCase());
      expect(detail.token.toLowerCase()).toBe(target!.token.toLowerCase());
      expect(detail.rewardPool).toBe(target!.rewardPool);
      expect(detail.paidOut).toBe(target!.paidOut);
      expect(detail.startTime).toBe(target!.startTime);
      expect(detail.endTime).toBe(target!.endTime);
      expect(detail.minReputation).toBe(target!.minReputation);
      expect(detail.status).toBe(target!.status);

      // CLAIM_GRACE is a contract constant — a wrong slot would surface as a nonsense duration.
      expect(detail.claimGrace).toBe(BigInt(CLAIM_GRACE_SECONDS));
      expect(detail.remainingPool).toBe(detail.rewardPool - detail.paidOut);
      expect(detail.kpis).toHaveLength(Number(target!.kpiCount));
    });

    it("reads each KPI's own ladder, not the first one repeated", async () => {
      const views = await fetchBrowseCampaigns(client, BigInt(0), BigInt(100));
      const multi = views.find((v) => v.kpiCount > BigInt(1));
      expect(multi, "no seeded campaign has multiple KPIs").toBeDefined();

      const detail = await fetchCampaignDetail(client, multi!.campaign);

      for (const kpi of detail.kpis) {
        expect(KPI_KIND).toContain(kpi.spec.kind);
        expect(kpi.spec.verifier).toMatch(/^0x[0-9a-fA-F]{40}$/);
        expect(kpi.tiers.length).toBeGreaterThan(0);

        // The constructor enforces ascending thresholds; the tier math depends on it.
        const thresholds = kpi.tiers.map((t) => Number(t.threshold));
        expect(thresholds).toEqual([...thresholds].sort((a, b) => a - b));
      }

      // SeedLocal's multi-KPI campaign is Swap/Tvl/ActiveUser with 1, 2, and 3 rungs. Asserting
      // the distinct shapes is what actually proves each index read its own data: if the reads
      // were returning KPI 0 for every index, all three would have one rung and one kind.
      expect(detail.kpis.map((k) => k.spec.kind)).toEqual(["Swap", "Tvl", "ActiveUser"]);
      expect(detail.kpis.map((k) => k.tiers.length)).toEqual([1, 2, 3]);
      expect(detail.kpis.map((k) => k.spec.aggregate)).toEqual([false, true, false]);
      expect(detail.kpis.map((k) => Number(k.spec.target))).toEqual([250, 1_000_000, 500]);
    });

    it("endedAt is zero while open and set once ended", async () => {
      const views = await fetchBrowseCampaigns(client, BigInt(0), BigInt(100));

      const open = views.find((v) => v.status === "Active");
      if (open) {
        const detail = await fetchCampaignDetail(client, open.campaign);
        expect(detail.endedAt).toBe(BigInt(0));
        // The reclaim gate must stay shut on a live campaign regardless of the wall clock.
        expect(isReclaimable(detail.status, Number(detail.endedAt), 2_000_000_000, 604_800)).toBe(
          false,
        );
      }

      const ended = views.find((v) => v.status === "Ended");
      if (ended) {
        const detail = await fetchCampaignDetail(client, ended.campaign);
        expect(detail.endedAt).toBeGreaterThan(BigInt(0));
      }
    });

    it("per-promoter settlement counters match what the chain paid", async () => {
      const views = await fetchBrowseCampaigns(client, BigInt(0), BigInt(100));
      const withProgress = views.find((v) => v.paidOut > BigInt(0));
      expect(withProgress, "no seeded campaign has progress").toBeDefined();

      const detail = await fetchCampaignDetail(client, withProgress!.campaign);
      const state = await fetchPromoterState(client, withProgress!.campaign, SEEDED_KOL,
        detail.kpis.length);

      expect(state.joined, "seeded KOL has not joined").toBe(true);
      expect(state.perKpi.length).toBe(detail.kpis.length);

      // The seeded KOL was settled, so nothing should remain owed on a crossed tier.
      for (const s of state.perKpi) {
        const kpi = detail.kpis[s.kpiIndex];
        expect(s.settledTiers).toBe(crossedTierCount(s.progress, kpi.tiers));
        expect(unsettledRewards(s.progress, kpi.tiers, s.settledTiers)).toBe(BigInt(0));
      }
    });

    it("reads escrow custody from the vault, and it tracks what the chain paid", async () => {
      // The escrow balance drives `activate`'s NotFunded and `reclaimUnspent`'s
      // NothingToReclaim. It comes from a different contract than every other detail field, so
      // a live read is the only thing that proves the vault address and args are right — the
      // mock cannot disagree with the chain (the F7 lesson).
      const views = await fetchBrowseCampaigns(client, BigInt(0), BigInt(100));

      const funded = views.find((v) => v.status === "Active" || v.status === "Ended");
      expect(funded, "no seeded campaign is funded").toBeDefined();

      const detail = await fetchCampaignDetail(client, funded!.campaign);

      // A funded campaign holds real tokens.
      expect(detail.escrowBalance).toBeGreaterThan(BigInt(0));

      // Custody is what the pool started as, less everything settled out of it. This is the
      // invariant that would break if `balanceOf` were called with the wrong address or the
      // wrong argument — a mistake that still returns a plausible-looking bigint.
      expect(detail.escrowBalance).toBe(detail.rewardPool - detail.paidOut);
    });

    it("an unfunded pending campaign has zero custody but a nonzero remainingPool", async () => {
      // The distinction the lifecycle guards depend on: `remainingPool()` is
      // `rewardPool - paidOut` (accounting) and reports the full pool on a campaign nobody has
      // funded, while the vault holds nothing. Keying reclaim or activate off the wrong one
      // offers a button that reverts.
      const views = await fetchBrowseCampaigns(client, BigInt(0), BigInt(100));
      const pending = views.find((v) => v.status === "Pending");

      if (!pending) return; // seed has no unfunded campaign; nothing to assert

      const detail = await fetchCampaignDetail(client, pending.campaign);

      if (detail.escrowBalance < detail.rewardPool) {
        // Underfunded, so activation must be blocked for the real project account.
        expect(
          availableActions({
            status: detail.status,
            isProject: true,
            escrowBalance: detail.escrowBalance,
            rewardPool: detail.rewardPool,
            startTime: Number(detail.startTime),
            endTime: Number(detail.endTime),
            endedAtSeconds: Number(detail.endedAt),
            claimGraceSeconds: Number(detail.claimGrace),
            nowSeconds: Math.floor(Date.now() / 1000),
            remainingPool: detail.remainingPool,
          }),
        ).not.toContain("activate");

        expect(fundingShortfall(detail.escrowBalance, detail.rewardPool)).toBe(
          detail.rewardPool - detail.escrowBalance,
        );
      }
    });

    it("lifecycle guards agree with each live campaign's real status", async () => {
      // Cross-checks the mirror against every status the seed actually produced, using the
      // chain's own numbers rather than a fixture.
      const views = await fetchBrowseCampaigns(client, BigInt(0), BigInt(100));
      const now = Math.floor(Date.now() / 1000);

      for (const view of views) {
        const detail = await fetchCampaignDetail(client, view.campaign);
        const actions = availableActions({
          status: detail.status,
          isProject: true,
          escrowBalance: detail.escrowBalance,
          rewardPool: detail.rewardPool,
          startTime: Number(detail.startTime),
          endTime: Number(detail.endTime),
          endedAtSeconds: Number(detail.endedAt),
          claimGraceSeconds: Number(detail.claimGrace),
          nowSeconds: now,
          remainingPool: detail.remainingPool,
        });

        // Structural invariants that must hold for every real campaign, whatever its state.
        expect(actions.includes("pause") && actions.includes("unpause")).toBe(false);
        expect(actions.includes("activate") && actions.includes("cancel")).toBe(
          detail.status === "Pending" && detail.escrowBalance >= detail.rewardPool,
        );

        if (detail.status === "Active") {
          expect(actions).toContain("pause");
          expect(actions).toContain("end");
          expect(actions).not.toContain("cancel");
        }

        if (detail.status === "Ended") {
          expect(actions).not.toContain("pause");
          expect(actions).not.toContain("activate");
          // Reclaim requires the grace window to have elapsed since endedAt.
          const graceOver = now > Number(detail.endedAt) + Number(detail.claimGrace);
          const hasFunds = detail.escrowBalance > BigInt(0);
          expect(actions.includes("reclaimUnspent")).toBe(graceOver && hasFunds);
        }
      }
    });
  });

  /**
   * Phase 7 (KOL flows) against the real chain.
   *
   * The promoter id is the reason this has to be live. `derivePromoterId` recomputes, in
   * TypeScript, a hash the contract builds as `keccak256(abi.encode(address(this), msg.sender))`.
   * A wrong hash is exactly as plausible-looking as a right one — get the argument order or the
   * padding wrong and the UI still renders a perfectly convincing tracking link, one that no
   * touch will ever match. Nothing but the chain can tell the two apart.
   */
  describe("KOL flows", () => {
    async function campaignWithProgress() {
      const views = await fetchBrowseCampaigns(client, BigInt(0), BigInt(100));
      const view = views.find((v) => v.paidOut > BigInt(0));
      expect(view, "no seeded campaign has progress").toBeDefined();
      return view!;
    }

    it("derivePromoterId reproduces the id the contract stored", async () => {
      const view = await campaignWithProgress();
      const detail = await fetchCampaignDetail(client, view.campaign);
      const state = await fetchPromoterState(client, view.campaign, SEEDED_KOL,
        detail.kpis.length);

      expect(state.joined).toBe(true);
      expect(derivePromoterId(view.campaign, SEEDED_KOL)).toBe(state.promoterId);
      expect(hasJoined(state.promoterId)).toBe(true);
    });

    it("scopes the id per campaign, so one link cannot farm another campaign", async () => {
      const views = await fetchBrowseCampaigns(client, BigInt(0), BigInt(100));
      expect(views.length).toBeGreaterThanOrEqual(2);

      const ids = views.map((v) => derivePromoterId(v.campaign, SEEDED_KOL));
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("reports a never-joined wallet as not joined", async () => {
      const view = await campaignWithProgress();
      const detail = await fetchCampaignDetail(client, view.campaign);
      const state = await fetchPromoterState(client, view.campaign, NEVER_JOINED,
        detail.kpis.length);

      expect(state.joined).toBe(false);
      expect(hasJoined(state.promoterId)).toBe(false);
      expect(state.perKpi).toEqual([]);
    });

    it("builds a tracking link that round-trips to the on-chain id", async () => {
      const view = await campaignWithProgress();
      const detail = await fetchCampaignDetail(client, view.campaign);
      const state = await fetchPromoterState(client, view.campaign, SEEDED_KOL,
        detail.kpis.length);

      const link = trackingLink("https://boney.example", view.campaign, state.promoterId);
      const parsed = parseTrackingLink(link);

      expect(parsed).not.toBeNull();
      expect(parsed!.campaign.toLowerCase()).toBe(view.campaign.toLowerCase());
      expect(parsed!.promoterId).toBe(state.promoterId);
      // An expiry baked into a shared URL would silently stop working; it belongs on the touch.
      expect(link).not.toMatch(/expire|exp=|until/i);
    });

    it("canJoin agrees with the chain's reputation gate", async () => {
      const views = await fetchBrowseCampaigns(client, BigInt(0), BigInt(100));
      const gated = views.find((v) => v.minReputation > BigInt(0));
      expect(gated, "no seeded campaign gates on reputation").toBeDefined();

      const score = await client.readContract({
        address: DEPLOYMENTS[anvil.id]!.reputationRegistry,
        abi: ReputationRegistryAbi,
        functionName: "scoreOf",
        args: [NEVER_JOINED],
      });

      const eligibility = canJoin({
        status: "Active",
        alreadyJoined: false,
        reputation: score as bigint,
        minReputation: gated!.minReputation,
        connected: true,
      });

      expect(score).toBe(BigInt(0));
      expect(eligibility.ok).toBe(false);
      expect(eligibility.reason).toMatch(/reputation/i);
      // The blocked button carries the contract's own numbers, not a generic refusal.
      expect(eligibility.reason).toContain(gated!.minReputation.toString());
    });

    /**
     * 7.2 — earned vs claimable. These are two different questions, and conflating them is what
     * made the panel read as if a promoter had earned nothing: settlement happens *inline* when
     * progress is reported, so a healthy promoter's claimable is legitimately zero while their
     * earned figure is large. The chain settles the argument — a KOL's token balance is what
     * they were actually paid.
     */
    it("earned reconciles with what the chain actually paid the promoter", async () => {
      const views = await fetchBrowseCampaigns(client, BigInt(0), BigInt(100));

      let earnedAcrossCampaigns = BigInt(0);
      let token: `0x${string}` | undefined;

      for (const view of views) {
        const detail = await fetchCampaignDetail(client, view.campaign);
        const state = await fetchPromoterState(client, view.campaign, SEEDED_KOL,
          detail.kpis.length);
        if (!state.joined) continue;

        token ??= detail.token;
        // The seed uses one token throughout; summing across tokens would be meaningless.
        expect(detail.token).toBe(token);

        for (const s of state.perKpi) {
          earnedAcrossCampaigns += settledRewards(detail.kpis[s.kpiIndex].tiers, s.settledTiers);
        }
      }

      expect(token, "seeded KOL has joined nothing").toBeDefined();
      expect(earnedAcrossCampaigns).toBeGreaterThan(BigInt(0));

      const balance = await client.readContract({
        address: token!,
        abi: IERC20Abi,
        functionName: "balanceOf",
        args: [SEEDED_KOL],
      });

      expect(balance).toBe(earnedAcrossCampaigns);
    });

    it("claimable is zero for a settled promoter, and canSettle says why", async () => {
      const view = await campaignWithProgress();
      const detail = await fetchCampaignDetail(client, view.campaign);
      const state = await fetchPromoterState(client, view.campaign, SEEDED_KOL,
        detail.kpis.length);

      for (const s of state.perKpi) {
        const kpi = detail.kpis[s.kpiIndex];
        const {payout, shortfall} = settlementPayout(
          s.progress,
          kpi.tiers,
          s.settledTiers,
          detail.escrowBalance,
        );

        // Inline settlement means a healthy promoter has nothing pending.
        expect(payout).toBe(BigInt(0));
        expect(shortfall).toBe(BigInt(0));

        const eligibility = canSettle({
          status: detail.status,
          joined: true,
          payout,
          endedAt: detail.endedAt,
          claimGrace: detail.claimGrace,
          now: Math.floor(Date.now() / 1000),
        });

        expect(eligibility.ok).toBe(false);
        expect(eligibility.reason).toMatch(/nothing is waiting to be claimed/i);
      }
    });
  });

  /**
   * Phase 8 gate (attribution signing): a frontend-produced EIP-712 signature recovers to the
   * signer on a live chain.
   *
   * This is the highest-risk test in the app. `storeTouch` is the anti-abuse primitive — if a
   * Touch signature is valid, the chain treats it as user consent to attribute that wallet to
   * the named promoter. A domain or typehash mismatch is silent at build time and only surfaces
   * as `InvalidSignature` on chain; nothing but a live recovery can prove alignment.
   */
  describe("attribution signing", () => {
    const ATTR_ACCOUNT_PK =
      "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356" as const;

    async function getRegistryAddress(): Promise<`0x${string}`> {
      const deployments = DEPLOYMENTS[anvil.id];
      expect(deployments).toBeDefined();
      return deployments!.attributionRegistry;
    }

    async function seededKpiCounts() {
      const views = await fetchBrowseCampaigns(client, BigInt(0), BigInt(100));
      const data: {campaign: `0x${string}`; kpiCount: number}[] = [];
      for (const v of views) {
        const detail = await fetchCampaignDetail(client, v.campaign);
        data.push({campaign: v.campaign, kpiCount: detail.kpis.length});
      }
      return data;
    }

    it("matches the contract's EIP-712 domain", async () => {
      const registry = await getRegistryAddress();
      const domain = attributionDomain(anvil.id, registry);

      expect(domain.name).toBe("Boney Attribution");
      expect(domain.version).toBe("1");
    });

    it("matches the contract's Touch typehash", async () => {
      // The string must be identical, byte for byte, to what Solidity's keccak256 hashes.
      const typehash = keccak256(
        toHex("Touch(address campaign,bytes32 promoterId,uint64 signedAt,uint64 expiresAt)"),
      );
      expect(TOUCH_TYPEHASH).toBe(typehash);
    });

    it("a frontend-produced signature recovers to the signer on chain", async () => {
      const registry = await getRegistryAddress();
      const campaigns = await seededKpiCounts();
      const {campaign} = campaigns[0];

      // Use anvil account #7 — funded, no prior touch.
      const account = privateKeyToAccount(ATTR_ACCOUNT_PK);
      const signer = account.address;

      const wallet = createWalletClient({
        account,
        chain: anvil,
        transport: http("http://127.0.0.1:8545"),
      });

      // Read the on-chain window and cap.
      const [attrWindow, maxTouch] = await Promise.all([
        client.readContract({
          address: campaign as `0x${string}`,
          abi: CampaignAbi,
          functionName: "attributionWindow",
        }),
        fetchMaxTouchDuration(client, registry),
      ]);

      // Look up a promoter id the seed registered.
      const state = await fetchPromoterState(client, campaign, SEEDED_KOL, campaigns[0].kpiCount);
      expect(state.joined).toBe(true);

      // Build the touch exactly as the UI would.
      const now = Math.floor(Date.now() / 1000);
      const touch = buildTouch(campaign, state.promoterId, attrWindow as bigint, maxTouch, now);

      // Sign it.
      const domain = attributionDomain(anvil.id, registry);
      const signature = await account.signTypedData({
        domain,
        types: TOUCH_EIP712_TYPES,
        primaryType: "Touch",
        message: {
          campaign: touch.campaign,
          promoterId: touch.promoterId,
          signedAt: touch.signedAt,
          expiresAt: touch.expiresAt,
        },
      });

      // Relay to the chain.
      const txHash = await wallet.writeContract({
        address: registry,
        abi: AttributionRegistryAbi,
        functionName: "storeTouch",
        args: [signer, touch, signature, account.address],
        gas: 500_000n,
      });

      await client.waitForTransactionReceipt({hash: txHash});

      // The contract agrees.
      const stored = await client.readContract({
        address: registry,
        abi: AttributionRegistryAbi,
        functionName: "touchOf",
        args: [campaign, signer],
      });
      expect(stored.promoterId).toBe(state.promoterId, "promoterId must match what the signer endorsed");
      expect(stored.signedAt).toBe(touch.signedAt);
      expect(stored.expiresAt).toBe(touch.expiresAt);
    });
  });
});
