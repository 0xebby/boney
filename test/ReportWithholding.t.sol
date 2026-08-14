// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Campaign} from "../src/campaign/Campaign.sol";
import {CampaignRegistry} from "../src/campaign/CampaignRegistry.sol";
import {EscrowVault} from "../src/escrow/EscrowVault.sol";
import {AttributionRegistry} from "../src/attribution/AttributionRegistry.sol";
import {AttestationVerifier} from "../src/reputation/AttestationVerifier.sol";
import {ReputationRegistry} from "../src/reputation/ReputationRegistry.sol";
import {OracleCoordinator} from "../src/oracle/OracleCoordinator.sol";
import {IAttributionRegistry} from "../src/interfaces/IAttributionRegistry.sol";
import {IOracleCoordinator} from "../src/interfaces/IOracleCoordinator.sol";
import {Types} from "../src/libraries/Types.sol";

contract MockToken is ERC20 {
    constructor() ERC20("Mock", "MOCK") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @title Report-withholding grief — closed
/// @notice A project used to keep the whole escrow by simply never reporting, even though promoters
///         delivered attributed users who cleared tier thresholds.
///
///         `reportUserAction` is the only function that credits `_progress` and pays, and it admits
///         only `project` or `oracleCoordinator`. It used to carry two cutoffs — `onlyActive` and
///         `_requireWindow()` — so ending the campaign (which the project may do at any time) made
///         every remaining report impossible. Withheld progress was not merely unsettled but
///         unrecorded, so `settle` had nothing to pay and `reclaimUnspent` returned 100% of the pool.
///
///         The oracle was no fallback: `OracleCoordinator` only ever reached `applyAggregateUpdate`,
///         which reverts on a per-user KPI and credits no promoter even when it succeeds. The
///         `oracleCoordinator` authorization on `reportUserAction` was unreachable, leaving the
///         project key as the only account that could pay anyone — so an offline project stranded
///         promoters exactly as a hostile one did.
///
///         Two changes close it, and these tests hold both open:
///          1. `Campaign` accepts reports for `CLAIM_GRACE` after `end()`, closing on the same
///             second `reclaimUnspent` opens — escrow is never reclaimable while credit is owed.
///          2. `OracleCoordinator.submitUserReport` / `applyUserReport` route to `reportUserAction`
///             under the existing stake, dispute and slashing rules, so a stiffed promoter can pay
///             themselves without the project's cooperation.
contract ReportWithholdingTest is Test {
    uint256 internal constant POOL = 10_000 ether;
    uint64 internal constant MAX_TOUCH = 30 days;
    uint256 internal constant MIN_STAKE = 100 ether;
    /// @dev Must stay well inside `Campaign.CLAIM_GRACE`: the grace-window tests push an oracle
    ///      report *after* `end()`, and that push has to clear its dispute window while the
    ///      campaign is still reportable. Scaled off CLAIM_GRACE so shortening the constant for
    ///      testing cannot silently invert the two.
    uint256 internal constant DISPUTE_WINDOW = 1 minutes;
    uint256 internal constant UNSTAKE_DELAY = 2 minutes;

    /// @dev Tier 0 pays at 10 units; the referral below delivers 50, clearing it five times over.
    uint256 internal constant THRESHOLD = 10;
    uint256 internal constant TIER_REWARD = 1_000 ether;
    uint256 internal constant DELIVERED = 50;

    MockToken internal token;
    EscrowVault internal vault;
    CampaignRegistry internal registry;
    AttributionRegistry internal attribution;
    AttestationVerifier internal attestation;
    ReputationRegistry internal reputation;
    OracleCoordinator internal coordinator;
    Campaign internal campaign;

    address internal admin = address(0xA11CE);
    address internal governor = address(0x60B);
    address internal project = address(0xC0DE);
    address internal promoter = address(0xC01);
    address internal reporter = address(0x0BAC);

    uint256 internal userPk = 0x5EED;
    address internal user;

    uint64 internal startTime;
    uint64 internal endTime;

    function setUp() public {
        user = vm.addr(userPk);
        vm.warp(1_000_000);
        startTime = uint64(block.timestamp);
        endTime = uint64(block.timestamp + 30 days);

        token = new MockToken();
        attribution = new AttributionRegistry(MAX_TOUCH);
        attestation = new AttestationVerifier(admin, admin);
        reputation = new ReputationRegistry(admin, address(attestation));

        // Wire the real coordinator as the campaign's oracle, so "the oracle cannot help" is a
        // fact about the deployed contract rather than about an EOA placeholder.
        coordinator = new OracleCoordinator(governor, MIN_STAKE, DISPUTE_WINDOW, UNSTAKE_DELAY);
        vault = new EscrowVault(address(this));
        registry = new CampaignRegistry(
            address(vault), address(reputation), address(attribution), address(coordinator)
        );
        vault.setRegistrar(address(registry));
        vm.prank(governor);
        coordinator.setCampaignRegistry(address(registry));

        campaign = _createCampaign();
        _activate();
    }

    // ── fixtures ─────────────────────────────────────────────────

    function _createCampaign() internal returns (Campaign) {
        Types.CampaignConfig memory cfg = Types.CampaignConfig({
            project: project,
            name: "Report Withholding",
            token: address(token),
            rewardPool: POOL,
            startTime: startTime,
            endTime: endTime,
            attributionWindow: 7 days,
            minReputation: 0
        });

        Types.KpiSpec[] memory kpis = new Types.KpiSpec[](1);
        kpis[0] = Types.KpiSpec({
            kind: Types.KpiKind.Mint,
            verifier: address(0),
            target: 100,
            aggregate: false,
            params: ""
        });

        Types.RewardTier[][] memory tiers = new Types.RewardTier[][](1);
        tiers[0] = new Types.RewardTier[](1);
        tiers[0][0] = Types.RewardTier({threshold: THRESHOLD, reward: TIER_REWARD});

        vm.prank(project);
        (, address addr) = registry.createCampaign(cfg, kpis, tiers);
        return Campaign(addr);
    }

    function _activate() internal {
        token.mint(project, POOL);
        vm.startPrank(project);
        token.approve(address(vault), POOL);
        vault.deposit(address(campaign), POOL);
        campaign.activate();
        vm.stopPrank();
    }

    function _signNow(uint256 pk, bytes32 promoterId, uint64 ttl)
        internal
        view
        returns (IAttributionRegistry.Touch memory t, bytes memory sig)
    {
        t = IAttributionRegistry.Touch({
            campaign: address(campaign),
            promoterId: promoterId,
            signedAt: uint64(block.timestamp),
            expiresAt: uint64(block.timestamp) + ttl
        });
        bytes32 structHash = keccak256(
            abi.encode(attribution.TOUCH_TYPEHASH(), t.campaign, t.promoterId, t.signedAt, t.expiresAt)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", attribution.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        sig = abi.encodePacked(r, s, v);
    }

    /// @dev The honest setup every test here starts from: promoter joins, referral consents.
    function _joinAndTouch() internal returns (bytes32 promoterId) {
        vm.prank(promoter);
        promoterId = campaign.join();

        (IAttributionRegistry.Touch memory t, bytes memory sig) = _signNow(userPk, promoterId, 7 days);
        attribution.storeTouch(user, t, sig, promoter);

        assertEq(attribution.activePromoter(address(campaign), user), promoterId, "referral is attributed");
    }
    // ── the grief, now closed ────────────────────────────────────

    /// @dev The original vector, end to end. A promoter whose referral was attributed and delivered
    ///      5x the tier threshold used to walk away with nothing while the project reclaimed the
    ///      whole pool. The recovery is entirely promoter-side: they end the campaign once its
    ///      window closes (permissionless), stake a reporter, and push the report through the
    ///      dispute window. The project signs nothing.
    function test_PromoterRecoversRewardsWithoutTheProject() public {
        _joinAndTouch();

        // The project reports nothing for the whole campaign, then the window closes.
        vm.warp(endTime + 1);
        campaign.end(); // permissionless once endTime has passed

        assertEq(campaign.progressOf(promoter, 0), 0, "nothing credited while the project stalled");

        // The report push must clear its dispute window before the campaign leaves the grace
        // period: the oracle's window runs from submission, not from the campaign end, so it
        // cannot be interleaved with the reclaim warp below. This is why DISPUTE_WINDOW has to
        // stay comfortably shorter than CLAIM_GRACE.
        _stakeAndPushUserReport(DELIVERED);

        assertEq(campaign.progressOf(promoter, 0), DELIVERED, "credited after the campaign ended");
        assertEq(token.balanceOf(promoter), TIER_REWARD, "and paid, inline");

        // The project's reclaim now only reaches what the promoters did not earn.
        vm.warp(uint256(campaign.endedAt()) + campaign.CLAIM_GRACE() + 1);
        vm.prank(project);
        campaign.reclaimUnspent();
        assertEq(token.balanceOf(project), POOL - TIER_REWARD, "reclaim is net of what was owed");
    }

    /// @dev Ending early no longer cuts reporting off — it starts the grace clock instead. This is
    ///      the guard that used to make the grief cheap: the project could end on day one and
    ///      strand every referral attributed up to that point.
    function test_EndingEarlyNoLongerBlocksReporting() public {
        _joinAndTouch();

        vm.prank(project);
        campaign.end();
        assertLt(block.timestamp, endTime, "ended well inside the window");

        vm.prank(project);
        campaign.reportUserAction(0, user, DELIVERED, "");

        assertEq(campaign.progressOf(promoter, 0), DELIVERED, "post-end report lands");
        assertEq(token.balanceOf(promoter), TIER_REWARD, "and settles inline");
    }

    /// @dev The grace window is the boundary, and it is inclusive — matching `settle` and the
    ///      complement of `reclaimUnspent`.
    function test_ReportAcceptedOnTheFinalGraceSecond() public {
        _joinAndTouch();

        vm.warp(endTime + 1);
        campaign.end();

        vm.warp(uint256(campaign.endedAt()) + campaign.CLAIM_GRACE());
        vm.prank(project);
        campaign.reportUserAction(0, user, DELIVERED, "");

        assertEq(campaign.progressOf(promoter, 0), DELIVERED, "the boundary second still credits");
    }

    /// @dev One second later the window is shut, so a report cannot land against escrow the
    ///      project is now entitled to reclaim.
    function test_ReportRejectedOnceGraceExpires() public {
        _joinAndTouch();

        vm.warp(endTime + 1);
        campaign.end();

        vm.warp(uint256(campaign.endedAt()) + campaign.CLAIM_GRACE() + 1);
        vm.prank(project);
        vm.expectRevert(abi.encodeWithSelector(Campaign.WrongStatus.selector, Types.CampaignStatus.Ended));
        campaign.reportUserAction(0, user, DELIVERED, "");
    }

    /// @dev The property that keeps the fix safe: reporting and reclaiming are never both open.
    ///      If they overlapped, a project could reclaim escrow a pending report was about to spend
    ///      and `_settle` would pay out of an empty pool.
    function test_ReportingAndReclaimAreMutuallyExclusive() public {
        _joinAndTouch();
        vm.warp(endTime + 1);
        campaign.end();

        uint256 endedAt = campaign.endedAt();
        uint256 grace = campaign.CLAIM_GRACE();

        for (uint256 i = 0; i < 5; i++) {
            uint256 t = endedAt + grace - 2 + i;
            vm.warp(t);

            bool reportOpen = t <= endedAt + grace;

            vm.prank(project);
            try campaign.reclaimUnspent() {
                assertFalse(reportOpen, "reclaim opened while reporting was still allowed");
                return; // escrow is gone; nothing left to assert
            } catch {
                assertTrue(reportOpen, "both windows shut at once");
            }
        }
    }

    /// @dev Paused still blocks reporting, and cannot be used to strand anyone: `end()` is
    ///      permissionless past `endTime`, which converts a parked campaign into an Ended one and
    ///      opens the grace window.
    function test_PausedBlocksReportingButIsEscapable() public {
        _joinAndTouch();

        vm.prank(project);
        campaign.pause();

        vm.prank(project);
        vm.expectRevert(abi.encodeWithSelector(Campaign.WrongStatus.selector, Types.CampaignStatus.Paused));
        campaign.reportUserAction(0, user, DELIVERED, "");

        // A promoter waits out the window and ends it themselves.
        vm.warp(endTime + 1);
        vm.prank(promoter);
        campaign.end();

        // The push is bound by the grace window, so with the shortened CLAIM_GRACE the dispute
        // window (1 minute) is the constraining one — a hardcoded multi-day skip would land the
        // report after the campaign stopped being reportable.
        _stakeAndPushUserReport(DELIVERED);
        assertEq(token.balanceOf(promoter), TIER_REWARD, "paid despite the pause");
    }

    // ── the oracle can now credit a promoter ─────────────────────

    /// @dev The gap this fix closes. `applyReport` routes to `applyAggregateUpdate`, which reverts
    ///      on a per-user KPI — so before `submitUserReport` existed, a fully staked honest oracle
    ///      could not pay anyone. That failure is still the correct behaviour for the aggregate
    ///      entry point, and is pinned here so the two paths cannot be conflated.
    function test_AggregateReportStillRejectsPerUserKpi() public {
        _joinAndTouch();
        _stake(reporter);

        vm.prank(reporter);
        bytes32 reportId = coordinator.submitReport(
            IOracleCoordinator.Report({
                campaign: address(campaign),
                kpiIndex: 0,
                amount: DELIVERED,
                evidence: ""
            })
        );

        vm.warp(block.timestamp + DISPUTE_WINDOW + 1);
        vm.expectRevert(abi.encodeWithSelector(Campaign.NotAggregateKpi.selector, 0));
        coordinator.applyReport(reportId);
    }

    /// @dev The two kinds cannot be applied through each other's entry point, so a report can never
    ///      be replayed into the wrong campaign function.
    function test_ReportKindsAreNotInterchangeable() public {
        _joinAndTouch();
        _stake(reporter);

        vm.prank(reporter);
        bytes32 userReport = coordinator.submitUserReport(
            IOracleCoordinator.UserReport({
                campaign: address(campaign),
                kpiIndex: 0,
                user: user,
                newTotal: DELIVERED,
                evidence: ""
            })
        );
        vm.prank(reporter);
        bytes32 aggReport = coordinator.submitReport(
            IOracleCoordinator.Report({
                campaign: address(campaign),
                kpiIndex: 0,
                amount: DELIVERED,
                evidence: ""
            })
        );

        assertTrue(userReport != aggReport, "ids are domain-separated");

        vm.warp(block.timestamp + DISPUTE_WINDOW + 1);

        vm.expectRevert(abi.encodeWithSelector(OracleCoordinator.NotAggregateReport.selector, userReport));
        coordinator.applyReport(userReport);

        vm.expectRevert(abi.encodeWithSelector(OracleCoordinator.NotUserReport.selector, aggReport));
        coordinator.applyUserReport(aggReport);
    }

    /// @dev A disputed user report is slashed and never applied, exactly like an aggregate one —
    ///      the new path inherits the anti-fraud lever rather than bypassing it.
    function test_DisputedUserReportIsSlashedAndNeverApplied() public {
        _joinAndTouch();
        _stake(reporter);

        vm.prank(reporter);
        bytes32 reportId = coordinator.submitUserReport(
            IOracleCoordinator.UserReport({
                campaign: address(campaign),
                kpiIndex: 0,
                user: user,
                newTotal: DELIVERED,
                evidence: ""
            })
        );

        vm.prank(governor);
        coordinator.disputeReport(reportId);

        assertEq(coordinator.stakeOf(reporter), 0, "reporter slashed");

        vm.warp(block.timestamp + DISPUTE_WINDOW + 1);
        vm.expectRevert(abi.encodeWithSelector(OracleCoordinator.ReportIsDisputed.selector, reportId));
        coordinator.applyUserReport(reportId);

        assertEq(campaign.progressOf(promoter, 0), 0, "nothing credited");
    }

    /// @dev A user report cannot be applied before its dispute window closes, so the project (or
    ///      governance) always has the full window to challenge a fabricated claim.
    function test_UserReportCannotSkipTheDisputeWindow() public {
        _joinAndTouch();
        _stake(reporter);

        vm.prank(reporter);
        bytes32 reportId = coordinator.submitUserReport(
            IOracleCoordinator.UserReport({
                campaign: address(campaign),
                kpiIndex: 0,
                user: user,
                newTotal: DELIVERED,
                evidence: ""
            })
        );

        vm.expectRevert(
            abi.encodeWithSelector(
                OracleCoordinator.DisputeWindowOpen.selector, coordinator.reportDeadline(reportId)
            )
        );
        coordinator.applyUserReport(reportId);
    }

    /// @dev Staking is still the gate — an unstaked account cannot file per-user reports either.
    function test_UnstakedAccountCannotSubmitUserReport() public {
        _joinAndTouch();

        vm.prank(reporter);
        vm.expectRevert(abi.encodeWithSelector(OracleCoordinator.NotAReporter.selector, reporter));
        coordinator.submitUserReport(
            IOracleCoordinator.UserReport({
                campaign: address(campaign),
                kpiIndex: 0,
                user: user,
                newTotal: DELIVERED,
                evidence: ""
            })
        );
    }

    /// @dev A zero user would be stored as an aggregate report and applied through the wrong
    ///      branch, so it is rejected at submission.
    function test_UserReportRejectsZeroUser() public {
        _stake(reporter);

        vm.prank(reporter);
        vm.expectRevert(OracleCoordinator.ZeroAddress.selector);
        coordinator.submitUserReport(
            IOracleCoordinator.UserReport({
                campaign: address(campaign),
                kpiIndex: 0,
                user: address(0),
                newTotal: DELIVERED,
                evidence: ""
            })
        );
    }

    /// @dev The oracle cannot invent a payee. An unattributed user has no promoter, so the campaign
    ///      rejects the report rather than crediting anyone — a staked reporter cannot drain escrow
    ///      to an address of their choosing.
    function test_OracleCannotCreditAnUnattributedUser() public {
        _joinAndTouch();
        _stake(reporter);

        address stranger = address(0xDEAD);
        vm.prank(reporter);
        bytes32 reportId = coordinator.submitUserReport(
            IOracleCoordinator.UserReport({
                campaign: address(campaign),
                kpiIndex: 0,
                user: stranger,
                newTotal: DELIVERED,
                evidence: ""
            })
        );

        vm.warp(block.timestamp + DISPUTE_WINDOW + 1);
        vm.expectRevert(abi.encodeWithSelector(Campaign.NoAttribution.selector, stranger));
        coordinator.applyUserReport(reportId);
    }

    // ── the honest baseline, for contrast ────────────────────────

    /// @dev Identical setup, one report from a cooperative project: unchanged by the fix.
    function test_HonestProjectPaysTheSamePromoter() public {
        _joinAndTouch();

        vm.prank(project);
        campaign.reportUserAction(0, user, DELIVERED, "");

        vm.warp(endTime + 1);
        campaign.end();

        assertEq(campaign.progressOf(promoter, 0), DELIVERED, "progress credited");
        assertEq(campaign.settledTiersOf(promoter, 0), 1, "tier cleared and settled inline");
        assertEq(token.balanceOf(promoter), TIER_REWARD, "promoter is paid");
    }

    // ── attribution fallback is bounded to post-end ──────────────

    /// @dev The relaxation that makes the grace window usable is scoped to Ended only. While the
    ///      campaign is live an expired touch still credits nobody, so the consent model holds and
    ///      `test_Report_recoverableAfterAttributionExpires` in Campaign.t.sol stays true.
    function test_ExpiredTouchStillRevertsWhileActive() public {
        vm.prank(promoter);
        bytes32 promoterId = campaign.join();
        (IAttributionRegistry.Touch memory t, bytes memory sig) = _signNow(userPk, promoterId, 1 days);
        attribution.storeTouch(user, t, sig, promoter);

        skip(1 days + 1);

        vm.prank(project);
        vm.expectRevert(abi.encodeWithSelector(Campaign.NoAttribution.selector, user));
        campaign.reportUserAction(0, user, DELIVERED, "");
    }

    /// @dev The same expired touch pays once the campaign has ended — which is the whole point.
    ///      Without this, every withheld report filed during the grace window would revert
    ///      `NoAttribution` and hand the project back the escrow the window exists to protect.
    function test_ExpiredTouchPaysAfterEnd() public {
        vm.prank(promoter);
        bytes32 promoterId = campaign.join();
        (IAttributionRegistry.Touch memory t, bytes memory sig) = _signNow(userPk, promoterId, 1 days);
        attribution.storeTouch(user, t, sig, promoter);

        vm.warp(endTime + 1);
        campaign.end();
        assertEq(attribution.activePromoter(address(campaign), user), bytes32(0), "touch long expired");

        vm.prank(project);
        campaign.reportUserAction(0, user, DELIVERED, "");
        assertEq(token.balanceOf(promoter), TIER_REWARD, "the promoter who earned it is paid");
    }

    /// @dev The fallback reads the *stored* touch, which `storeTouch` only ever overwrites with a
    ///      strictly newer `signedAt`. So a displaced promoter cannot reclaim a user post-end: the
    ///      newer touch is what is stored, and it is the newer promoter who gets paid.
    function test_FallbackCannotResurrectADisplacedPromoter() public {
        vm.prank(promoter);
        bytes32 id1 = campaign.join();
        address promoter2 = address(0xC02);
        vm.prank(promoter2);
        bytes32 id2 = campaign.join();

        (IAttributionRegistry.Touch memory t1, bytes memory s1) = _signNow(userPk, id1, 1 days);
        attribution.storeTouch(user, t1, s1, promoter);

        // The user re-engages through a second promoter, then that touch lapses too.
        skip(2 days);
        (IAttributionRegistry.Touch memory t2, bytes memory s2) = _signNow(userPk, id2, 1 days);
        attribution.storeTouch(user, t2, s2, promoter2);

        vm.warp(endTime + 1);
        campaign.end();

        vm.prank(project);
        campaign.reportUserAction(0, user, DELIVERED, "");

        assertEq(token.balanceOf(promoter), 0, "the displaced promoter gets nothing");
        assertEq(token.balanceOf(promoter2), TIER_REWARD, "the user's latest intent is paid");
    }

    // ── helpers ──────────────────────────────────────────────────

    function _stake(address who) internal {
        vm.deal(who, MIN_STAKE);
        vm.prank(who);
        coordinator.stake{value: MIN_STAKE}();
    }

    /// @dev The full promoter-side recovery: stake, file, wait out the dispute window, apply.
    function _stakeAndPushUserReport(uint256 newTotal) internal {
        _stake(reporter);

        vm.prank(reporter);
        bytes32 reportId = coordinator.submitUserReport(
            IOracleCoordinator.UserReport({
                campaign: address(campaign),
                kpiIndex: 0,
                user: user,
                newTotal: newTotal,
                evidence: ""
            })
        );

        vm.warp(block.timestamp + DISPUTE_WINDOW + 1);
        coordinator.applyUserReport(reportId);
    }
}
