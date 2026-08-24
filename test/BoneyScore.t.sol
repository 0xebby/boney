// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ReputationRegistry} from "../src/reputation/ReputationRegistry.sol";
import {AttestationVerifier} from "../src/reputation/AttestationVerifier.sol";
import {AttributionRegistry} from "../src/attribution/AttributionRegistry.sol";
import {Campaign} from "../src/campaign/Campaign.sol";
import {CampaignRegistry} from "../src/campaign/CampaignRegistry.sol";
import {EscrowVault} from "../src/escrow/EscrowVault.sol";
import {Types} from "../src/libraries/Types.sol";
import {ICampaign} from "../src/interfaces/ICampaign.sol";

/// @dev The gate tests never move this token; a campaign simply cannot be built without one.
contract GateMockToken is ERC20 {
    constructor() ERC20("Mock", "MOCK") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/**
 * BoneyScore — the composite the campaign join gate reads.
 *
 *     BoneyScore = 7 * ETHOS_SCORE + 3 * REACH
 *
 * `scoreOf` is a weighted sum that multiplies and never divides, and its smallest non-zero weight
 * is 1, so a raw follower count would enter the sum at full magnitude and swamp Ethos (24,000
 * followers against a score of ~2,000 is roughly 92% followers however the weights are set).
 * Normalisation therefore happens off-chain: the attestor maps followers onto the same 0–2800 range
 * Ethos uses and attests *that*, while `FOLLOWERS` stays registered at weight 0 so the honest raw
 * count remains readable without contributing.
 *
 * These tests pin the arithmetic the off-chain module (`web/src/lib/boneyscore.ts`) assumes, and
 * the weight-0 behaviour the whole scheme rests on. They are the on-chain half of the same
 * contract the Vitest suite checks from the other side.
 *
 * The final section then drives `Campaign.join()` itself, because the arithmetic being right is a
 * weaker claim than the gate enforcing it: `qualifies()` is a view nothing is obliged to consult,
 * while `join()` is what decides whether a promoter exists at all.
 */
contract BoneyScoreTest is Test {
    AttestationVerifier internal verifier;
    ReputationRegistry internal registry;

    address internal admin = address(0xA11CE);
    address internal attestor = address(0xA77E5);

    /// Mirrors `SeedLocal.s.sol`: ETHOS_WEIGHT / REACH_WEIGHT, and FOLLOWERS retired at 0.
    uint256 internal constant ETHOS_WEIGHT = 7;
    uint256 internal constant REACH_WEIGHT = 3;
    uint256 internal constant GATED_MIN_REPUTATION = 16_000;

    /// The freshness window the freshness tests exercise. Mirrors `SeedLocal.s.sol`.
    uint64 internal constant ETHOS_MAX_AGE = 180 days;

    /// The seeded KOLs. KOL 1 clears the gate, KOL 2 does not — see `_seedReputation`.
    uint256 internal constant KOL1_ETHOS = 2034;
    uint256 internal constant KOL1_FOLLOWERS = 24_000;
    uint256 internal constant KOL1_REACH = 1752;
    uint256 internal constant KOL2_ETHOS = 1450;
    uint256 internal constant KOL2_FOLLOWERS = 8_500;
    uint256 internal constant KOL2_REACH = 1571;

    address internal kol1 = address(0xC0FFEE);
    address internal kol2 = address(0xDECAF);
    address internal fresh = address(0xF00D);

    bytes32 internal ethosId;
    bytes32 internal reachId;
    bytes32 internal followersId;

    /// Campaign stack, built only so the join gate can be exercised against a real `Campaign`.
    GateMockToken internal token;
    EscrowVault internal vault;
    CampaignRegistry internal campaignRegistry;
    AttributionRegistry internal attribution;

    address internal project = address(0xC0DE);
    address internal oracle = address(0x0BAC);
    uint256 internal constant POOL = 10_000 ether;

    /// Mirrors `SeedLocal.s.sol`: both scoring inputs live on Ethos's 0–2800 scale.
    uint256 internal constant SCHEMA_MAX_VALUE = 2_800;
    uint256 internal constant MAX_BONEY_SCORE = 28_000;

    function setUp() public {
        verifier = new AttestationVerifier(admin, attestor);
        registry = new ReputationRegistry(admin, address(verifier));
        vm.warp(1_000_000);

        vm.startPrank(admin);
        registry.registerSchema("ETHOS_SCORE", ETHOS_WEIGHT);
        registry.registerSchema("REACH", REACH_WEIGHT);
        // Registered so the raw count is still attested and readable, but scored at 0.
        registry.registerSchema("FOLLOWERS", 0);
        vm.stopPrank();

        ethosId = registry.schemaId("ETHOS_SCORE");
        reachId = registry.schemaId("REACH");
        followersId = registry.schemaId("FOLLOWERS");

        token = new GateMockToken();
        vault = new EscrowVault(address(this));
        attribution = new AttributionRegistry(30 days);
        campaignRegistry =
            new CampaignRegistry(address(vault), address(registry), address(attribution), oracle);
        vault.setRegistrar(address(campaignRegistry));
    }

    // ── helpers ──────────────────────────────────────────────────

    /// Owner-side write, matching how `SeedLocal` populates records without running the attestor.
    function _store(address subject, bytes32 id, uint256 value) internal {
        vm.prank(admin);
        registry.storeAttestation(subject, id, value, keccak256(abi.encode(subject, id, value)));
    }

    function _seed(address subject, uint256 ethos, uint256 followers, uint256 reach) internal {
        _store(subject, ethosId, ethos);
        _store(subject, reachId, reach);
        _store(subject, followersId, followers);
    }

    function _expected(uint256 ethos, uint256 reach) internal pure returns (uint256) {
        return ETHOS_WEIGHT * ethos + REACH_WEIGHT * reach;
    }

    // ── campaign fixtures ────────────────────────────────────────

    /// Applies SeedLocal's value ceilings, which is what makes `maxScore()` answerable at 28,000.
    /// Idempotent, so helpers may call it without coordinating.
    function _capSchemasLikeSeed() internal {
        vm.startPrank(admin);
        registry.setSchemaMaxValue(ethosId, SCHEMA_MAX_VALUE);
        registry.setSchemaMaxValue(reachId, SCHEMA_MAX_VALUE);
        vm.stopPrank();
    }

    /// Times are read from the clock at call time, so a campaign created after a `skip()` still
    /// opens a live window.
    /// @dev Names are unique per registry, so each fixture campaign needs its own. A storage counter
    ///      rather than an external read: an external call in an argument list would consume the
    ///      pending `vm.prank`/`vm.expectRevert` before the call under test.
    uint256 private _nameNonce;

    function _gateConfig(uint256 minReputation) internal returns (Types.CampaignConfig memory) {
        return Types.CampaignConfig({
            project: project,
            name: string.concat("Gate Test ", vm.toString(_nameNonce++)),
            token: address(token),
            rewardPool: POOL,
            startTime: uint64(block.timestamp),
            endTime: uint64(block.timestamp + 30 days),
            attributionWindow: 7 days,
            minReputation: minReputation
        });
    }

    function _kpis() internal pure returns (Types.KpiSpec[] memory k) {
        k = new Types.KpiSpec[](1);
        k[0] = Types.KpiSpec({
            kind: Types.KpiKind.Mint,
            verifier: address(0),
            target: 100,
            aggregate: false,
            params: ""
        });
    }

    function _tiers() internal pure returns (Types.RewardTier[][] memory t) {
        t = new Types.RewardTier[][](1);
        t[0] = new Types.RewardTier[](1);
        t[0][0] = Types.RewardTier({threshold: 10, reward: 1_000 ether});
    }

    function _gatedCampaign(uint256 minReputation) internal returns (Campaign) {
        _capSchemasLikeSeed();
        vm.prank(project);
        (, address addr) = campaignRegistry.createCampaign(_gateConfig(minReputation), _kpis(), _tiers());
        return Campaign(addr);
    }

    /// `join()` also admits a Pending campaign, but the gate is worth proving in the state
    /// promoters actually meet it in.
    function _activeGatedCampaign(uint256 minReputation) internal returns (Campaign c) {
        c = _gatedCampaign(minReputation);
        token.mint(project, POOL);
        vm.startPrank(project);
        token.approve(address(vault), POOL);
        vault.deposit(address(c), POOL);
        c.activate();
        vm.stopPrank();
    }

    // ── the formula ──────────────────────────────────────────────

    function test_ScoreOf_isSevenEthosPlusThreeReach() public {
        _seed(kol1, KOL1_ETHOS, KOL1_FOLLOWERS, KOL1_REACH);
        assertEq(registry.scoreOf(kol1), _expected(KOL1_ETHOS, KOL1_REACH));
    }

    /// The exact figures the seed script and the docs quote, so a drift in either is caught here.
    function test_ScoreOf_matchesSeededFigures() public {
        _seed(kol1, KOL1_ETHOS, KOL1_FOLLOWERS, KOL1_REACH);
        _seed(kol2, KOL2_ETHOS, KOL2_FOLLOWERS, KOL2_REACH);

        assertEq(registry.scoreOf(kol1), 19_494);
        assertEq(registry.scoreOf(kol2), 14_863);
    }

    /// The seed data is chosen to straddle the gate, so local testing exercises both branches.
    function test_SeededScores_straddleTheGate() public {
        _seed(kol1, KOL1_ETHOS, KOL1_FOLLOWERS, KOL1_REACH);
        _seed(kol2, KOL2_ETHOS, KOL2_FOLLOWERS, KOL2_REACH);

        assertTrue(registry.qualifies(kol1, GATED_MIN_REPUTATION));
        assertFalse(registry.qualifies(kol2, GATED_MIN_REPUTATION));
    }

    /// An unattested wallet scores 0, which is what makes the join panel offer "verify" not "denied".
    function test_ScoreOf_unattestedWalletIsZero() public view {
        assertEq(registry.scoreOf(fresh), 0);
        assertFalse(registry.qualifies(fresh, GATED_MIN_REPUTATION));
    }

    /// A refused Ethos profile leaves no record at all, so reach alone cannot clear a gate.
    function test_ReachAloneCannotClearTheGate() public {
        _store(kol1, reachId, 2800);
        assertEq(registry.scoreOf(kol1), REACH_WEIGHT * 2800);
        assertFalse(registry.qualifies(kol1, GATED_MIN_REPUTATION));
    }

    /// Even a maxed-out score stays inside the documented 0–28,000 range.
    function test_ScoreOf_maxIsTwentyEightThousand() public {
        _seed(kol1, 2800, 10_000_000, 2800);
        assertEq(registry.scoreOf(kol1), 28_000);
    }

    // ── FOLLOWERS at weight 0 ──────────────────────────────────

    /**
     * The load-bearing property: the raw follower count is stored, readable, and contributes
     * nothing. Without this the normalisation is pointless, because the un-normalised value would
     * still dominate the sum.
     */
    function test_Followers_atWeightZero_contributeNothing() public {
        _store(kol1, ethosId, KOL1_ETHOS);
        _store(kol1, reachId, KOL1_REACH);
        uint256 withoutFollowers = registry.scoreOf(kol1);

        _store(kol1, followersId, KOL1_FOLLOWERS);
        assertEq(registry.scoreOf(kol1), withoutFollowers);
    }

    /// A stale record large enough to swamp everything else must still contribute zero.
    function test_Followers_staleWhaleRecordContributesNothing() public {
        _seed(kol1, KOL1_ETHOS, 50_000_000, KOL1_REACH);

        assertEq(registry.scoreOf(kol1), _expected(KOL1_ETHOS, KOL1_REACH));
        // Stored and readable for display, just not scored.
        assertEq(registry.valueOf(kol1, followersId), 50_000_000);
    }

    /// Retiring a live schema reprices existing scores without erasing data — the migration path.
    function test_SetSchemaWeight_toZero_retiresWithoutErasing() public {
        vm.prank(admin);
        registry.setSchemaWeight(followersId, 1);
        _seed(kol1, KOL1_ETHOS, KOL1_FOLLOWERS, KOL1_REACH);

        assertEq(registry.scoreOf(kol1), _expected(KOL1_ETHOS, KOL1_REACH) + KOL1_FOLLOWERS);

        vm.prank(admin);
        registry.setSchemaWeight(followersId, 0);

        assertEq(registry.scoreOf(kol1), _expected(KOL1_ETHOS, KOL1_REACH));
        assertEq(registry.valueOf(kol1, followersId), KOL1_FOLLOWERS);
    }

    // ── freshness ────────────────────────────────────────────────

    /**
     * Credibility is not constant, so a BoneyScore is only as good as the date on it. KOL 1 clears
     * a 16,000 gate on 7*2034 + 3*1752 = 19,494, but 14,238 of that is Ethos. Once the Ethos
     * attestation ages out, the composite falls to reach alone (5,256) and the gate closes — the
     * same conclusion as `test_ReachAloneCannotClearTheGate`, reached by expiry rather than refusal.
     */
    function test_ExpiredEthos_closesAGateItPreviouslyCleared() public {
        vm.prank(admin);
        registry.setSchemaMaxAge(ethosId, ETHOS_MAX_AGE);
        _seed(kol1, KOL1_ETHOS, KOL1_FOLLOWERS, KOL1_REACH);

        assertTrue(registry.qualifies(kol1, GATED_MIN_REPUTATION), "fresh: clears the gate");

        skip(ETHOS_MAX_AGE + 1);

        assertEq(registry.scoreOf(kol1), REACH_WEIGHT * KOL1_REACH, "only reach survives");
        assertFalse(registry.qualifies(kol1, GATED_MIN_REPUTATION), "expired: gate closes");
        assertEq(registry.valueOf(kol1, ethosId), KOL1_ETHOS, "the old figure is still readable");
        assertFalse(registry.isValueFresh(kol1, ethosId), "but it is flagged stale");
    }

    /// Re-attesting at a *lower* Ethos keeps the gate shut. Refreshing is not a way to reinstate an
    /// old score; it republishes whatever the metric says today.
    function test_Reattesting_atALowerEthos_keepsTheGateShut() public {
        vm.prank(admin);
        registry.setSchemaMaxAge(ethosId, ETHOS_MAX_AGE);
        _seed(kol1, KOL1_ETHOS, KOL1_FOLLOWERS, KOL1_REACH);
        skip(ETHOS_MAX_AGE + 1);

        _store(kol1, ethosId, 400); // credibility cratered while the record sat there

        assertTrue(registry.isValueFresh(kol1, ethosId), "fresh again");
        assertEq(registry.scoreOf(kol1), _expected(400, KOL1_REACH));
        assertFalse(registry.qualifies(kol1, GATED_MIN_REPUTATION), "fresh but no longer enough");
    }

    /// Windows are per-schema: reach can age out on its own cadence without touching Ethos.
    function test_SchemaWindows_areIndependent() public {
        vm.startPrank(admin);
        registry.setSchemaMaxAge(ethosId, 180 days);
        registry.setSchemaMaxAge(reachId, 30 days);
        vm.stopPrank();

        _seed(kol1, KOL1_ETHOS, KOL1_FOLLOWERS, KOL1_REACH);
        skip(31 days);

        assertEq(registry.scoreOf(kol1), ETHOS_WEIGHT * KOL1_ETHOS, "reach expired, Ethos did not");
        assertTrue(registry.isValueFresh(kol1, ethosId));
        assertFalse(registry.isValueFresh(kol1, reachId));
    }

    /// The whole 0–28,000 range decays to 0, so no wallet keeps a residual score on expiry alone.
    function testFuzz_EverySchemaExpired_scoresZero(uint256 ethos, uint256 reach) public {
        ethos = bound(ethos, 0, 2800);
        reach = bound(reach, 0, 2800);

        vm.startPrank(admin);
        registry.setSchemaMaxAge(ethosId, ETHOS_MAX_AGE);
        registry.setSchemaMaxAge(reachId, ETHOS_MAX_AGE);
        vm.stopPrank();

        _seed(kol1, ethos, KOL1_FOLLOWERS, reach);
        skip(ETHOS_MAX_AGE + 1);

        assertEq(registry.scoreOf(kol1), 0);
        assertFalse(registry.qualifies(kol1, GATED_MIN_REPUTATION));
    }

    // ── the off-chain contract ───────────────────────────────────

    /**
     * `scoreOf` must equal `7*ethos + 3*reach` for every input the attestor can produce, because
     * the UI computes a prospective BoneyScore locally (`boneyscore.ts`) and compares it against a
     * campaign's `minReputation` without a round trip. If the two ever disagree the frontend offers
     * a Join button that reverts, or hides one the contract would have allowed.
     *
     * Bounded to the attestable range: both values are normalised to 0–2800 before signing.
     */
    function testFuzz_ScoreOf_matchesOffChainFormula(uint256 ethos, uint256 reach, uint256 followers)
        public
    {
        ethos = bound(ethos, 0, 2800);
        reach = bound(reach, 0, 2800);
        followers = bound(followers, 0, 100_000_000);

        _seed(kol1, ethos, followers, reach);

        assertEq(registry.scoreOf(kol1), _expected(ethos, reach));
        assertLe(registry.scoreOf(kol1), 28_000);
    }

    /// Weight 0 must hold for *any* follower count, not just the ones the seed happens to use.
    function testFuzz_Followers_neverContribute(uint256 followers) public {
        _store(kol1, ethosId, KOL1_ETHOS);
        _store(kol1, reachId, KOL1_REACH);
        _store(kol1, followersId, followers);

        assertEq(registry.scoreOf(kol1), _expected(KOL1_ETHOS, KOL1_REACH));
    }

    // ── the gate ─────────────────────────────────────────────────

    /**
     * Everything above ends at `scoreOf` and `qualifies`. Neither is the gate: `qualifies` is a view
     * that nothing is obliged to consult, and a campaign could read reputation any way it liked.
     * `Campaign.join()` (`Campaign.sol:315`) is what actually decides whether a promoter exists, so
     * these drive it directly and assert on `InsufficientReputation`'s arguments — which carry the
     * computed BoneyScore, making the revert itself a statement about the formula.
     */

    /// KOL 1's 19,494 clears a 16,000 gate, at the contract rather than beside it.
    function test_Join_atSeededScore_clearsTheGate() public {
        _seed(kol1, KOL1_ETHOS, KOL1_FOLLOWERS, KOL1_REACH);
        Campaign gated = _activeGatedCampaign(GATED_MIN_REPUTATION);

        vm.prank(kol1);
        bytes32 promoterId = gated.join();

        assertTrue(promoterId != bytes32(0), "19,494 clears a 16,000 gate");
        assertEq(gated.promoterOf(promoterId), kol1);
        assertEq(gated.promoterIdOf(kol1), promoterId);
    }

    /// The other half of `test_SeededScores_straddleTheGate`, proven where it matters. The revert
    /// carries 14,863 — the same figure `test_ScoreOf_matchesSeededFigures` pins.
    function test_Join_belowSeededScore_revertsInsufficientReputation() public {
        _seed(kol2, KOL2_ETHOS, KOL2_FOLLOWERS, KOL2_REACH);
        Campaign gated = _activeGatedCampaign(GATED_MIN_REPUTATION);

        vm.prank(kol2);
        vm.expectRevert(
            abi.encodeWithSelector(ICampaign.InsufficientReputation.selector, 14_863, GATED_MIN_REPUTATION)
        );
        gated.join();
    }

    /// An unattested wallet is refused with a score of 0 rather than an opaque failure, which is
    /// what lets the join panel offer "verify" instead of "denied".
    function test_Join_unattestedWallet_revertsWithZeroScore() public {
        Campaign gated = _activeGatedCampaign(GATED_MIN_REPUTATION);

        vm.prank(fresh);
        vm.expectRevert(
            abi.encodeWithSelector(ICampaign.InsufficientReputation.selector, 0, GATED_MIN_REPUTATION)
        );
        gated.join();
    }

    /// Reach is capped at 2800, so at weight 3 it tops out at 8,400 — a wallet with a refused Ethos
    /// profile cannot reach a 16,000 gate however large its audience.
    function test_Join_reachAlone_revertsAtTheGate() public {
        _store(kol1, reachId, SCHEMA_MAX_VALUE);
        Campaign gated = _activeGatedCampaign(GATED_MIN_REPUTATION);

        vm.prank(kol1);
        vm.expectRevert(
            abi.encodeWithSelector(
                ICampaign.InsufficientReputation.selector,
                REACH_WEIGHT * SCHEMA_MAX_VALUE,
                GATED_MIN_REPUTATION
            )
        );
        gated.join();
    }

    /**
     * The weight-0 property where it is load-bearing. A wallet one point short of the gate, with
     * fifty million followers attested against it, is still refused — so the un-normalised count
     * cannot buy entry even though it is stored and readable.
     */
    function test_Join_followersCannotOpenTheGate() public {
        _store(kol1, ethosId, KOL1_ETHOS);
        _store(kol1, reachId, KOL1_REACH);
        _store(kol1, followersId, 50_000_000);

        uint256 score = _expected(KOL1_ETHOS, KOL1_REACH);
        Campaign gated = _activeGatedCampaign(score + 1);

        vm.prank(kol1);
        vm.expectRevert(abi.encodeWithSelector(ICampaign.InsufficientReputation.selector, score, score + 1));
        gated.join();

        assertEq(registry.valueOf(kol1, followersId), 50_000_000, "stored, readable, and inert");
    }

    /**
     * `test_ExpiredEthos_closesAGateItPreviouslyCleared` reaches this conclusion through
     * `qualifies`. This reaches it through `join()`: the same wallet is admitted while the Ethos
     * attestation is fresh and refused once it ages out, with the revert reporting reach alone.
     *
     * Two campaigns because `AlreadyJoined` is permanent — the second is deployed after the skip so
     * its own window is live, which also shows the gate is re-read per campaign rather than
     * snapshotted at first join.
     */
    function test_Join_expiredEthos_closesTheGateAtTheContract() public {
        vm.prank(admin);
        registry.setSchemaMaxAge(ethosId, ETHOS_MAX_AGE);
        _seed(kol1, KOL1_ETHOS, KOL1_FOLLOWERS, KOL1_REACH);

        Campaign whileFresh = _activeGatedCampaign(GATED_MIN_REPUTATION);
        vm.prank(kol1);
        assertTrue(whileFresh.join() != bytes32(0), "fresh: admitted");

        skip(ETHOS_MAX_AGE + 1);

        Campaign afterExpiry = _activeGatedCampaign(GATED_MIN_REPUTATION);
        vm.prank(kol1);
        vm.expectRevert(
            abi.encodeWithSelector(
                ICampaign.InsufficientReputation.selector, REACH_WEIGHT * KOL1_REACH, GATED_MIN_REPUTATION
            )
        );
        afterExpiry.join();
    }

    // ── the ceiling ──────────────────────────────────────────────

    /**
     * The BoneyScore maximum and the largest legal gate are the same number. `Campaign`'s
     * constructor rejects `minReputation > maxScore()` (`Campaign.sol:185`), and with SeedLocal's
     * 0–2800 ceilings on both scoring schemas that bound is exactly the documented 28,000 — so a
     * drift in the weights or the caps breaks campaign *creation*, not merely display.
     */
    function test_Create_gateAboveBoneyScoreCeiling_reverts() public {
        _capSchemasLikeSeed();
        assertEq(registry.maxScore(), MAX_BONEY_SCORE, "7*2800 + 3*2800");

        vm.prank(project);
        vm.expectRevert(
            abi.encodeWithSelector(
                ICampaign.UnreachableReputation.selector, MAX_BONEY_SCORE + 1, MAX_BONEY_SCORE
            )
        );
        campaignRegistry.createCampaign(_gateConfig(MAX_BONEY_SCORE + 1), _kpis(), _tiers());
    }

    /// The ceiling itself is a legal gate — clearable only by a wallet maxed on both inputs.
    function test_Create_gateExactlyAtBoneyScoreCeiling_isLegal() public {
        Campaign atCap = _activeGatedCampaign(MAX_BONEY_SCORE);
        assertEq(atCap.minReputation(), MAX_BONEY_SCORE);

        _seed(kol1, SCHEMA_MAX_VALUE, KOL1_FOLLOWERS, SCHEMA_MAX_VALUE);
        vm.prank(kol1);
        assertTrue(atCap.join() != bytes32(0), "a perfect score clears the highest legal gate");
    }

    // ── the off-chain contract, at the gate ──────────────────────

    /**
     * The strongest form of the claim `testFuzz_ScoreOf_matchesOffChainFormula` makes. That one
     * proves the two formulas agree; this proves the agreement reaches the decision the user sees:
     * `join()` succeeds exactly when the locally-computed BoneyScore reaches the gate. If these ever
     * diverge the frontend offers a Join button that reverts, or hides one the contract allows.
     */
    function testFuzz_JoinGate_agreesWithTheOffChainFormula(uint256 ethos, uint256 reach) public {
        ethos = bound(ethos, 0, SCHEMA_MAX_VALUE);
        reach = bound(reach, 0, SCHEMA_MAX_VALUE);

        _seed(kol1, ethos, KOL1_FOLLOWERS, reach);
        uint256 predicted = _expected(ethos, reach);
        Campaign gated = _activeGatedCampaign(GATED_MIN_REPUTATION);

        if (predicted >= GATED_MIN_REPUTATION) {
            vm.prank(kol1);
            assertTrue(gated.join() != bytes32(0), "predicted clear, contract admitted");
        } else {
            vm.prank(kol1);
            vm.expectRevert(
                abi.encodeWithSelector(
                    ICampaign.InsufficientReputation.selector, predicted, GATED_MIN_REPUTATION
                )
            );
            gated.join();
        }
    }
}
