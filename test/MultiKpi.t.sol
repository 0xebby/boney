// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test, console} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Campaign} from "../src/campaign/Campaign.sol";
import {CampaignRegistry} from "../src/campaign/CampaignRegistry.sol";
import {EscrowVault} from "../src/escrow/EscrowVault.sol";
import {AttributionRegistry} from "../src/attribution/AttributionRegistry.sol";
import {AttestationVerifier} from "../src/reputation/AttestationVerifier.sol";
import {ReputationRegistry} from "../src/reputation/ReputationRegistry.sol";
import {IAttributionRegistry} from "../src/interfaces/IAttributionRegistry.sol";
import {ICampaign} from "../src/interfaces/ICampaign.sol";
import {Types} from "../src/libraries/Types.sol";

contract MultiKpiMockToken is ERC20 {
    constructor() ERC20("Mock", "MOCK") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/**
 * Campaigns carrying several KPIs at once.
 *
 * Every other suite builds a one-KPI campaign, so the per-index keying that the whole multi-KPI
 * design rests on was never exercised: `_progress`, `_userCredited`, `_totalProgress` and
 * `_settledTiers` are all `mapping(... => mapping(uint256 => uint256))`, and nothing proved that a
 * report against one index leaves the others alone. `SeedLocal` deploys a three-KPI campaign
 * Two things are deliberately *not* isolated, and are pinned here so the asymmetry is on record:
 *
 *  - `kind` never reaches settlement (`Types.sol`), so a new enum member cannot change payout
 *    behaviour. `signUps` and `downloads` are exercised alongside `Mint` to hold that line.
 *  - `rewardPool` and `paidOut` are campaign-wide (D3), so KPIs compete for one pool. A tier
 *    crossed on a later KPI can therefore pay short — permanently, because `_settledTiers` advances
 *    whether or not the pool covered it.
 */
contract MultiKpiTest is Test {
    uint256 internal constant POOL = 10_000 ether;
    uint64 internal constant MAX_TOUCH = 30 days;

    /// Indices into the campaign's KPI array, which are not the `KpiKind` enum values.
    uint256 internal constant MINT_KPI = 0;
    uint256 internal constant TVL_KPI = 1;
    uint256 internal constant SIGNUPS_KPI = 2;
    uint256 internal constant DOWNLOADS_KPI = 3;

    MultiKpiMockToken internal token;
    EscrowVault internal vault;
    CampaignRegistry internal registry;
    AttributionRegistry internal attribution;
    AttestationVerifier internal verifier;
    ReputationRegistry internal reputation;
    Campaign internal campaign;

    address internal admin = address(0xA11CE);
    address internal project = address(0xC0DE);
    address internal oracle = address(0x0BAC);
    address internal kol = address(0xC01);

    uint256 internal userPk = 0x5EED;
    address internal user;

    function setUp() public {
        user = vm.addr(userPk);
        vm.warp(1_000_000);

        token = new MultiKpiMockToken();
        attribution = new AttributionRegistry(MAX_TOUCH);
        verifier = new AttestationVerifier(admin, admin);
        reputation = new ReputationRegistry(admin, address(verifier));

        vault = new EscrowVault(address(this));
        registry = new CampaignRegistry(address(vault), address(reputation), address(attribution), oracle);
        vault.setRegistrar(address(registry));

        campaign = _createCampaign(POOL);
        _activate(campaign, POOL);
    }

    // ── fixtures ─────────────────────────────────────────────────

    /// @dev Names are unique per registry, so each fixture campaign needs its own. A storage counter
    ///      rather than an external read: an external call in an argument list would consume the
    ///      pending `vm.prank`/`vm.expectRevert` before the call under test.
    uint256 private _nameNonce;

    function _config(uint256 pool) internal returns (Types.CampaignConfig memory) {
        return Types.CampaignConfig({
            project: project,
            name: string.concat("Multi KPI Test ", vm.toString(_nameNonce++)),
            token: address(token),
            rewardPool: pool,
            startTime: uint64(block.timestamp),
            endTime: uint64(block.timestamp + 30 days),
            attributionWindow: 7 days,
            minReputation: 0 // open to all
        });
    }

    /// @dev Four KPIs spanning the axes that matter: two enum members that predate the frontend,
    ///      two that postdate it, one aggregate among them, and ladders of differing depth.
    function _kpis() internal pure returns (Types.KpiSpec[] memory k) {
        k = new Types.KpiSpec[](4);
        k[MINT_KPI] = Types.KpiSpec({
            kind: Types.KpiKind.Mint,
            verifier: address(0),
            target: 100,
            aggregate: false,
            params: ""
        });
        k[TVL_KPI] = Types.KpiSpec({
            kind: Types.KpiKind.Tvl,
            verifier: address(0),
            target: 1_000_000,
            aggregate: true,
            params: ""
        });
        k[SIGNUPS_KPI] = Types.KpiSpec({
            kind: Types.KpiKind.signUps,
            verifier: address(0),
            target: 50,
            aggregate: false,
            params: ""
        });
        k[DOWNLOADS_KPI] = Types.KpiSpec({
            kind: Types.KpiKind.downloads,
            verifier: address(0),
            target: 50,
            aggregate: false,
            params: ""
        });
    }

    function _tiers() internal pure returns (Types.RewardTier[][] memory t) {
        t = new Types.RewardTier[][](4);

        t[MINT_KPI] = new Types.RewardTier[](2);
        t[MINT_KPI][0] = Types.RewardTier({threshold: 10, reward: 1_000 ether});
        t[MINT_KPI][1] = Types.RewardTier({threshold: 50, reward: 2_000 ether});

        t[TVL_KPI] = new Types.RewardTier[](1);
        t[TVL_KPI][0] = Types.RewardTier({threshold: 500_000, reward: 500 ether});

        t[SIGNUPS_KPI] = new Types.RewardTier[](1);
        t[SIGNUPS_KPI][0] = Types.RewardTier({threshold: 5, reward: 1_500 ether});

        t[DOWNLOADS_KPI] = new Types.RewardTier[](1);
        t[DOWNLOADS_KPI][0] = Types.RewardTier({threshold: 5, reward: 1_500 ether});
    }

    function _createCampaign(uint256 pool) internal returns (Campaign) {
        vm.prank(project);
        (, address addr) = registry.createCampaign(_config(pool), _kpis(), _tiers());
        return Campaign(addr);
    }

    function _activate(Campaign c, uint256 pool) internal {
        token.mint(project, pool);
        vm.startPrank(project);
        token.approve(address(vault), pool);
        vault.deposit(address(c), pool);
        c.activate();
        vm.stopPrank();
    }

    function _joinAndAttribute(Campaign c) internal returns (bytes32 promoterId) {
        vm.prank(kol);
        promoterId = c.join();

        IAttributionRegistry.Touch memory t = IAttributionRegistry.Touch({
            campaign: address(c),
            promoterId: promoterId,
            signedAt: uint64(block.timestamp),
            expiresAt: uint64(block.timestamp) + 7 days
        });
        bytes32 structHash = keccak256(
            abi.encode(attribution.TOUCH_TYPEHASH(), t.campaign, t.promoterId, t.signedAt, t.expiresAt)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", attribution.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userPk, digest);
        attribution.storeTouch(user, t, abi.encodePacked(r, s, v), user);
    }

    function _report(Campaign c, uint256 kpiIndex, uint256 newTotal) internal {
        vm.prank(project);
        c.reportUserAction(kpiIndex, user, newTotal, "");
    }

    // ── the specs are stored per index ───────────────────────────

    /**
     * The enum values the frontend has to mirror. `kind` is stored as a `uint8` and read back by
     * `web/src/lib/types.ts::kpiKindFromIndex`, so these numbers are an interface, not an internal
     * detail — asserting the raw integer is the point.
     */
    function test_EachKpiKeepsItsOwnKindAtItsOwnIndex() public view {
        assertEq(campaign.kpiCount(), 4);

        assertEq(uint8(campaign.kpi(MINT_KPI).kind), 1, "Mint");
        assertEq(uint8(campaign.kpi(TVL_KPI).kind), 7, "Tvl");
        assertEq(uint8(campaign.kpi(SIGNUPS_KPI).kind), 10, "signUps");
        assertEq(uint8(campaign.kpi(DOWNLOADS_KPI).kind), 11, "downloads");
    }

    /// Ladders of different depths sit side by side without bleeding into each other.
    function test_EachKpiKeepsItsOwnLadder() public view {
        assertEq(campaign.tiers(MINT_KPI).length, 2);
        assertEq(campaign.tiers(TVL_KPI).length, 1);
        assertEq(campaign.tiers(SIGNUPS_KPI).length, 1);

        assertEq(campaign.tiers(MINT_KPI)[1].threshold, 50);
        assertEq(campaign.tiers(SIGNUPS_KPI)[0].threshold, 5);
    }

    /// An aggregate KPI can legitimately sit between two attributed ones.
    function test_AggregateFlagIsPerKpi() public view {
        assertFalse(campaign.kpi(MINT_KPI).aggregate);
        assertTrue(campaign.kpi(TVL_KPI).aggregate);
        assertFalse(campaign.kpi(SIGNUPS_KPI).aggregate);
    }

    // ── progress is isolated per index ───────────────────────────

    function test_Progress_isIsolatedPerKpi() public {
        _joinAndAttribute(campaign);
        _report(campaign, MINT_KPI, 10);

        assertEq(campaign.totalProgress(MINT_KPI), 10);
        assertEq(campaign.progressOf(kol, MINT_KPI), 10);

        assertEq(campaign.totalProgress(SIGNUPS_KPI), 0, "an untouched KPI stays at zero");
        assertEq(campaign.progressOf(kol, SIGNUPS_KPI), 0);
        assertEq(campaign.totalProgress(DOWNLOADS_KPI), 0);
    }

    /**
     * `_userCredited` is keyed by `(user, kpiIndex)`. If it were keyed by user alone, reporting a
     * *smaller* cumulative total against a second KPI would trip `NonMonotonic` — so this passing
     * is what proves the second dimension is really there.
     */
    function test_UserCredited_isPerKpi_soASmallerSecondTotalIsFine() public {
        _joinAndAttribute(campaign);
        _report(campaign, MINT_KPI, 50);
        _report(campaign, SIGNUPS_KPI, 5);

        assertEq(campaign.userCreditedOf(user, MINT_KPI), 50);
        assertEq(campaign.userCreditedOf(user, SIGNUPS_KPI), 5);
    }

    /// Each ladder is walked on its own counter, to its own depth.
    function test_SettledTiers_advanceIndependently() public {
        _joinAndAttribute(campaign);
        _report(campaign, MINT_KPI, 50); // crosses both mint rungs
        _report(campaign, SIGNUPS_KPI, 5); // crosses the single signUps rung

        assertEq(campaign.settledTiersOf(kol, MINT_KPI), 2);
        assertEq(campaign.settledTiersOf(kol, SIGNUPS_KPI), 1);
        assertEq(campaign.settledTiersOf(kol, DOWNLOADS_KPI), 0, "never reported, never settled");
    }

    /**
     * The claim in `Types.sol` that settlement never branches on `kind`, made falsifiable: the two
     * enum members added after the frontend was written pay exactly like `Mint` does. If a future
     * change ever special-cased a kind, this is what would catch it.
     */
    function test_NewEnumMembers_creditAndPayLikeAnyOtherKind() public {
        _joinAndAttribute(campaign);

        _report(campaign, SIGNUPS_KPI, 5);
        assertEq(token.balanceOf(kol), 1_500 ether, "signUps paid its rung");

        _report(campaign, DOWNLOADS_KPI, 5);
        assertEq(token.balanceOf(kol), 3_000 ether, "downloads paid its own rung on top");

        assertEq(campaign.settledTiersOf(kol, SIGNUPS_KPI), 1);
        assertEq(campaign.settledTiersOf(kol, DOWNLOADS_KPI), 1);
        assertEq(campaign.paidOut(), 3_000 ether);
    }

    /// A single report emits against its own index, so an indexer keying by KPI stays correct.
    function test_ProgressCredited_carriesTheReportedIndex() public {
        bytes32 promoterId = _joinAndAttribute(campaign);

        vm.expectEmit(true, true, true, true, address(campaign));
        emit ICampaign.ProgressCredited(DOWNLOADS_KPI, promoterId, user, 5);
        _report(campaign, DOWNLOADS_KPI, 5);
    }

    // ── the two reporting paths do not cross ─────────────────────

    function test_AggregateKpi_refusesAUserReport() public {
        _joinAndAttribute(campaign);

        vm.prank(project);
        vm.expectRevert(abi.encodeWithSelector(Campaign.AggregateKpi.selector, TVL_KPI));
        campaign.reportUserAction(TVL_KPI, user, 500_000, "");
    }

    function test_AttributedKpi_refusesAnAggregateUpdate() public {
        vm.prank(oracle);
        vm.expectRevert(abi.encodeWithSelector(Campaign.NotAggregateKpi.selector, MINT_KPI));
        campaign.applyAggregateUpdate(MINT_KPI, 100);
    }

    /**
     * D7: an aggregate KPI advances the campaign total for display and credits nobody. Worth
     * pinning in a mixed campaign specifically, because here there *is* a joined promoter with
     * live attribution — the thing that would make an accidental credit plausible.
     */
    function test_AggregateUpdate_movesOnlyItsOwnTotal_andCreditsNobody() public {
        _joinAndAttribute(campaign);

        vm.prank(oracle);
        campaign.applyAggregateUpdate(TVL_KPI, 750_000);

        assertEq(campaign.totalProgress(TVL_KPI), 750_000);
        assertEq(campaign.progressOf(kol, TVL_KPI), 0, "no promoter is credited");
        assertEq(campaign.settledTiersOf(kol, TVL_KPI), 0, "and no tier settles");
        assertEq(campaign.paidOut(), 0);

        assertEq(campaign.totalProgress(MINT_KPI), 0, "neighbouring KPIs untouched");
        assertEq(campaign.totalProgress(SIGNUPS_KPI), 0);
    }

    // ── one pool, several KPIs ───────────────────────────────────

    /**
     * The asymmetry worth knowing about. Progress is per-KPI but the pool is not, so a promoter can
     * cross a rung on a later KPI and be paid less than its face value because an earlier KPI spent
     * the pool. `_settledTiers` still advances, so the shortfall is permanent — the rung cannot be
     * re-earned once the pool is topped up, because it is already marked settled.
     *
     * 1,200 pool: mint rung 0 takes 1,000, leaving 200 against a 1,500 signUps rung.
     */
    function test_SharedPool_meansALaterKpiCanPayShort_permanently() public {
        Campaign small = _createCampaign(1_200 ether);
        _activate(small, 1_200 ether);
        _joinAndAttribute(small);

        vm.prank(project);
        small.reportUserAction(MINT_KPI, user, 10, "");
        assertEq(small.paidOut(), 1_000 ether);
        assertEq(small.remainingPool(), 200 ether);

        vm.expectEmit(false, false, false, true, address(small));
        emit ICampaign.PoolExhausted(1_300 ether);
        vm.prank(project);
        small.reportUserAction(SIGNUPS_KPI, user, 5, "");

        assertEq(token.balanceOf(kol), 1_200 ether, "paid what was left, not the rung's face value");
        assertEq(small.remainingPool(), 0);
        assertEq(small.settledTiersOf(kol, SIGNUPS_KPI), 1, "settled anyway - the 1,300 is gone");
    }

    /// Progress itself is unaffected by an exhausted pool: the ladder keeps its books straight even
    /// when it cannot pay, so a top-up campaign can be reconciled against real numbers.
    function test_ExhaustedPool_stillRecordsProgressOnEveryKpi() public {
        Campaign small = _createCampaign(1_200 ether);
        _activate(small, 1_200 ether);
        _joinAndAttribute(small);

        vm.startPrank(project);
        small.reportUserAction(MINT_KPI, user, 10, "");
        small.reportUserAction(SIGNUPS_KPI, user, 5, "");
        small.reportUserAction(DOWNLOADS_KPI, user, 5, "");
        vm.stopPrank();

        assertEq(small.totalProgress(MINT_KPI), 10);
        assertEq(small.totalProgress(SIGNUPS_KPI), 5);
        assertEq(small.totalProgress(DOWNLOADS_KPI), 5);
        assertEq(small.settledTiersOf(kol, DOWNLOADS_KPI), 1, "settled for zero");
        assertEq(token.balanceOf(kol), 1_200 ether, "and paid nothing further");
    }

    // ── the whole set moves together ─────────────────────────────

    /// A campaign-wide sweep: every attributed KPI reported, every ladder walked, totals and payout
    /// reconciled against the pool in one place.
    function testFuzz_EveryAttributedKpiTracksItsOwnTotal(uint256 mint, uint256 signUps, uint256 dl) public {
        mint = bound(mint, 0, 1_000);
        signUps = bound(signUps, 0, 1_000);
        dl = bound(dl, 0, 1_000);

        _joinAndAttribute(campaign);
        uint256 initialPoolBal = token.balanceOf(address(vault));

        vm.startPrank(project);
        if (mint != 0) campaign.reportUserAction(MINT_KPI, user, mint, "");
        if (signUps != 0) campaign.reportUserAction(SIGNUPS_KPI, user, signUps, "");
        if (dl != 0) campaign.reportUserAction(DOWNLOADS_KPI, user, dl, "");
        vm.stopPrank();

        assertEq(campaign.totalProgress(MINT_KPI), mint);
        assertEq(campaign.totalProgress(SIGNUPS_KPI), signUps);
        assertEq(campaign.totalProgress(DOWNLOADS_KPI), dl);
        assertEq(campaign.totalProgress(TVL_KPI), 0, "aggregate KPI is untouched by user reports");

        // `uint256(...)` on each branch is load-bearing. A ternary over two number literals takes
        // its type from the literals, not from the variable it lands in: `1_000 ether` alone infers
        // uint72, and the running sum then overflows at 6,000 ether — a panic in the *test*, with
        // the contract having paid out correctly. Only trips when all four ladders pay at once.
        uint256 expectedPay = (mint >= 10 ? uint256(1_000 ether) : 0)
            + (mint >= 50 ? uint256(2_000 ether) : 0) + (signUps >= 5 ? uint256(1_500 ether) : 0)
            + (dl >= 5 ? uint256(1_500 ether) : 0);
        assertEq(campaign.paidOut(), expectedPay, "each ladder contributes to one shared pool");
        assertEq(token.balanceOf(kol), expectedPay);
        uint256 poolBalNow = token.balanceOf(address(vault));
        assertEq((initialPoolBal - poolBalNow), campaign.paidOut());
    }
}
