// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EventMetricKpiVerifier} from "../src/verifiers/EventMetricKpiVerifier.sol";
import {IEventMetricKpiVerifier} from "../src/interfaces/IEventMetricKpiVerifier.sol";

/// @title EventMetricKpiVerifierTest
/// @notice Unit-tests the verifier in isolation. It holds no campaign references and `verify` reads
///         nothing but its own storage, so a real campaign would add setup without adding coverage —
///         the campaign-side interaction is covered by `Campaign.t.sol` and `GuardedKpiVerifier.t.sol`.
contract EventMetricKpiVerifierTest is Test {
    string internal constant SIG = "Deposit(address indexed user, uint256 amount)";

    EventMetricKpiVerifier internal verifier;

    address internal owner = address(0xA11CE);
    address internal reporter = address(0xBEEF);
    address internal campaign = address(0xCAFE);
    address internal alice = address(0xA1);
    address internal bob = address(0xB0B);

    uint256 internal constant KPI = 0;
    uint256 internal constant WINDOW_START = 100;
    uint256 internal constant WINDOW_END = 1_000;

    function setUp() public {
        verifier = new EventMetricKpiVerifier(owner, reporter);
        _configure(WINDOW_START, WINDOW_END);
    }

    // ── construction and admin ───────────────────────────────────

    function test_Constructor_setsOwnerAndReporter() public view {
        assertEq(verifier.owner(), owner);
        assertEq(verifier.reporter(), reporter);
    }

    function test_Constructor_revertsZeroReporter() public {
        vm.expectRevert(IEventMetricKpiVerifier.ZeroAddress.selector);
        new EventMetricKpiVerifier(owner, address(0));
    }

    function test_SetReporter_rotates() public {
        address next = address(0xD00D);
        vm.prank(owner);
        verifier.setReporter(next);
        assertEq(verifier.reporter(), next);

        // The old key stops working the moment it is replaced, which is the point of rotating.
        vm.prank(reporter);
        vm.expectRevert(abi.encodeWithSelector(IEventMetricKpiVerifier.NotReporter.selector, reporter));
        verifier.advanceCheckpoint(campaign, KPI, WINDOW_START);
    }

    function test_SetReporter_onlyOwner() public {
        vm.prank(reporter);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, reporter));
        verifier.setReporter(address(0xD00D));
    }

    function test_SetReporter_revertsZero() public {
        vm.prank(owner);
        vm.expectRevert(IEventMetricKpiVerifier.ZeroAddress.selector);
        verifier.setReporter(address(0));
    }

    // ── configuration ────────────────────────────────────────────

    function test_SetKpiConfig_stores() public view {
        EventMetricKpiVerifier.KpiConfig memory cfg = verifier.configOf(campaign, KPI);

        assertTrue(cfg.configured);
        assertEq(cfg.targetContract, address(0xDEAD));
        assertEq(cfg.eventSignature, SIG);
        assertEq(cfg.userParamIndex, 0);
        assertEq(cfg.valueParamIndex, 1);
        assertEq(uint8(cfg.aggregation), uint8(IEventMetricKpiVerifier.Aggregation.SUM));
        assertEq(cfg.scale, 1);
        assertEq(cfg.windowStartBlock, WINDOW_START);
        assertEq(cfg.windowEndBlock, WINDOW_END);
    }

    function test_SetKpiConfig_onlyOwner() public {
        vm.prank(reporter);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, reporter));
        _configureAs(reporter, WINDOW_START, WINDOW_END);
    }

    function test_SetKpiConfig_revertsInvertedWindow() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IEventMetricKpiVerifier.BadWindow.selector, 500, 400));
        _configureAs(owner, 500, 400);
    }

    function test_SetKpiConfig_revertsEmptySignature() public {
        vm.prank(owner);
        vm.expectRevert(IEventMetricKpiVerifier.EmptyEventSignature.selector);
        verifier.setKpiConfig(
            campaign, KPI, address(0xDEAD), "", 0, IEventMetricKpiVerifier.Aggregation.SUM, 1, 1e18, 1, 2
        );
    }

    function test_SetKpiConfig_revertsZeroTarget() public {
        vm.prank(owner);
        vm.expectRevert(IEventMetricKpiVerifier.ZeroAddress.selector);
        verifier.setKpiConfig(
            campaign, KPI, address(0), SIG, 0, IEventMetricKpiVerifier.Aggregation.SUM, 1, 1e18, 1, 2
        );
    }

    /// @dev The reason replacement is allowed: `windowEndBlock` is provisional until `Campaign.end()`
    ///      actually lands, so extending it has to be possible without disturbing progress already
    ///      reported.
    function test_SetKpiConfig_extendingWindowPreservesTotalsAndCheckpoint() public {
        _report(alice, 42, WINDOW_END);

        _configure(WINDOW_START, WINDOW_END + 500);

        assertEq(verifier.verifiedTotalOf(campaign, KPI, alice), 42);
        assertEq(verifier.checkpointOf(campaign, KPI), WINDOW_END);

        // And the relayer can now proceed past the old bound.
        vm.prank(reporter);
        verifier.advanceCheckpoint(campaign, KPI, WINDOW_END + 500);
        assertEq(verifier.checkpointOf(campaign, KPI), WINDOW_END + 500);
    }

    // ── reporting ────────────────────────────────────────────────

    function test_ReportBatch_storesTotalsAndAdvancesCheckpoint() public {
        address[] memory users = new address[](2);
        uint256[] memory totals = new uint256[](2);
        (users[0], users[1]) = (alice, bob);
        (totals[0], totals[1]) = (7, 9);

        vm.prank(reporter);
        verifier.reportBatch(campaign, KPI, users, totals, 500);

        assertEq(verifier.verifiedTotalOf(campaign, KPI, alice), 7);
        assertEq(verifier.verifiedTotalOf(campaign, KPI, bob), 9);
        assertEq(verifier.checkpointOf(campaign, KPI), 500);
        assertEq(verifier.lastReportedAt(_userKey(alice)), block.timestamp);
    }

    function test_ReportBatch_onlyReporter() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IEventMetricKpiVerifier.NotReporter.selector, owner));
        verifier.reportBatch(campaign, KPI, new address[](0), new uint256[](0), 500);
    }

    function test_ReportBatch_revertsLengthMismatch() public {
        vm.prank(reporter);
        vm.expectRevert(abi.encodeWithSelector(IEventMetricKpiVerifier.LengthMismatch.selector, 2, 1));
        verifier.reportBatch(campaign, KPI, new address[](2), new uint256[](1), 500);
    }

    function test_ReportBatch_revertsUnconfiguredKpi() public {
        vm.prank(reporter);
        vm.expectRevert(
            abi.encodeWithSelector(IEventMetricKpiVerifier.KpiNotConfigured.selector, campaign, 7)
        );
        verifier.reportBatch(campaign, 7, new address[](0), new uint256[](0), 500);
    }

    /// @dev A checkpoint that could move backward would let a relayer rescan and re-credit a range.
    function test_ReportBatch_revertsCheckpointRegression() public {
        _report(alice, 1, 600);

        vm.prank(reporter);
        vm.expectRevert(
            abi.encodeWithSelector(IEventMetricKpiVerifier.CheckpointRegression.selector, 600, 599)
        );
        verifier.advanceCheckpoint(campaign, KPI, 599);
    }

    /// @dev Re-reporting at the same checkpoint is allowed: a run split across transactions carries
    ///      the old checkpoint on every sub-transaction but the last.
    function test_ReportBatch_sameCheckpointIsAllowed() public {
        _report(alice, 1, 600);
        _report(bob, 2, 600);

        assertEq(verifier.checkpointOf(campaign, KPI), 600);
        assertEq(verifier.verifiedTotalOf(campaign, KPI, bob), 2);
    }

    /// @dev The on-chain half of the window bound: even a compromised reporter cannot push past the
    ///      campaign's reporting close.
    function test_ReportBatch_revertsPastReportWindow() public {
        vm.prank(reporter);
        vm.expectRevert(
            abi.encodeWithSelector(
                IEventMetricKpiVerifier.PastReportWindow.selector, WINDOW_END, WINDOW_END + 1
            )
        );
        verifier.reportBatch(campaign, KPI, new address[](0), new uint256[](0), WINDOW_END + 1);
    }

    function test_AdvanceCheckpoint_movesWithoutTouchingTotals() public {
        _report(alice, 5, 400);

        vm.prank(reporter);
        verifier.advanceCheckpoint(campaign, KPI, 700);

        assertEq(verifier.checkpointOf(campaign, KPI), 700);
        assertEq(verifier.verifiedTotalOf(campaign, KPI, alice), 5);
    }

    function test_AdvanceCheckpoint_revertsPastReportWindow() public {
        vm.prank(reporter);
        vm.expectRevert(
            abi.encodeWithSelector(
                IEventMetricKpiVerifier.PastReportWindow.selector, WINDOW_END, WINDOW_END + 1
            )
        );
        verifier.advanceCheckpoint(campaign, KPI, WINDOW_END + 1);
    }

    function test_ReportVerifiedTotal_storesWithoutMovingCheckpoint() public {
        vm.prank(reporter);
        verifier.reportVerifiedTotal(campaign, KPI, alice, 33);

        assertEq(verifier.verifiedTotalOf(campaign, KPI, alice), 33);
        assertEq(verifier.checkpointOf(campaign, KPI), 0);
    }

    function test_ReportVerifiedTotal_onlyReporter() public {
        vm.expectRevert(abi.encodeWithSelector(IEventMetricKpiVerifier.NotReporter.selector, address(this)));
        verifier.reportVerifiedTotal(campaign, KPI, alice, 1);
    }

    // ── verification ─────────────────────────────────────────────

    /// @dev The only guarantee this contract makes: a claim can never be credited above what was
    ///      independently observed.
    function test_Verify_capsClaimAtObserved() public {
        _report(alice, 5, 500);
        assertEq(verifier.verify(campaign, KPI, alice, 100, "", ""), 5);
    }

    function test_Verify_returnsClaimWhenBelowObserved() public {
        _report(alice, 50, 500);
        assertEq(verifier.verify(campaign, KPI, alice, 12, "", ""), 12);
    }

    function test_Verify_returnsClaimWhenEqual() public {
        _report(alice, 20, 500);
        assertEq(verifier.verify(campaign, KPI, alice, 20, "", ""), 20);
    }

    /// @dev Never-reported users read as 0, so nothing is creditable before the relayer has run.
    ///      `Campaign` treats that as a no-op report rather than a revert.
    function test_Verify_unreportedUserCreditsNothing() public view {
        assertEq(verifier.verify(campaign, KPI, bob, 100, "", ""), 0);
    }

    /// @dev Fails closed rather than returning 0, so a KPI wired here before configuration is loudly
    ///      broken instead of silently crediting nothing forever.
    function test_Verify_revertsUnconfiguredKpi() public {
        vm.expectRevert(
            abi.encodeWithSelector(IEventMetricKpiVerifier.KpiNotConfigured.selector, campaign, 3)
        );
        verifier.verify(campaign, 3, alice, 1, "", "");
    }

    /// @dev `evidence` and `params` are accepted for interface compatibility and must not change the
    ///      answer — the independence of this verifier rests on it ignoring caller-supplied data.
    function test_Verify_ignoresEvidenceAndParams() public {
        _report(alice, 5, 500);
        assertEq(verifier.verify(campaign, KPI, alice, 100, hex"deadbeef", hex"c0ffee"), 5);
    }

    function testFuzz_Verify_neverExceedsClaimOrObserved(uint256 claim, uint256 observed) public {
        vm.prank(reporter);
        verifier.reportVerifiedTotal(campaign, KPI, alice, observed);

        uint256 credited = verifier.verify(campaign, KPI, alice, claim, "", "");
        assertLe(credited, claim);
        assertLe(credited, observed);
    }

    // ── scaling ──────────────────────────────────────────────────

    /// @dev The case that makes scaling load-bearing: the project claims display units while the
    ///      relayer observes raw wei. Without the divisor the cap sits ~1e18 too high and never binds.
    function test_Verify_scalesObservedBeforeCapping() public {
        _configureScaled(1e18);

        // 3.5 tokens observed, claimed as 4 whole units. Only 3 are creditable.
        _report(alice, 35e17, 500);
        assertEq(verifier.verify(campaign, KPI, alice, 4, "", ""), 3);
        assertEq(verifier.observedProgressOf(campaign, KPI, alice), 3);

        // The raw figure stays raw, which is what the relayer accumulates against.
        assertEq(verifier.verifiedTotalOf(campaign, KPI, alice), 35e17);
    }

    /// @dev Sub-scale activity credits nothing rather than reverting — it rounds down, like the
    ///      indexer's own scaling does.
    function test_Verify_subScaleObservationCreditsNothing() public {
        _configureScaled(1e18);
        _report(alice, 1e17, 500);

        assertEq(verifier.verify(campaign, KPI, alice, 1, "", ""), 0);
    }

    /// @dev The reason the raw total is what lives on chain: accumulating across runs has to stay
    ///      lossless, or two sub-scale runs that together clear the divisor would each floor to zero
    ///      and never credit anything.
    function test_Verify_subScaleObservationsAccumulateAcrossRuns() public {
        _configureScaled(1e18);

        _report(alice, 6e17, 400);
        assertEq(verifier.verify(campaign, KPI, alice, 10, "", ""), 0);

        // Second run adds another 0.6 — the relayer reads 6e17 back off chain and reports 12e17.
        _report(alice, 12e17, 500);
        assertEq(verifier.verify(campaign, KPI, alice, 10, "", ""), 1);
    }

    /// @dev 0 is what an unset field decodes to, and "no scaling" beats reverting on a division by
    ///      zero at report time.
    function test_Verify_zeroScaleMeansNoScaling() public {
        _configureScaled(0);
        _report(alice, 42, 500);

        assertEq(verifier.verify(campaign, KPI, alice, 100, "", ""), 42);
    }

    // ── helpers ──────────────────────────────────────────────────

    function _configureScaled(uint256 scale) internal {
        vm.prank(owner);
        verifier.setKpiConfig(
            campaign,
            KPI,
            address(0xDEAD),
            SIG,
            0,
            IEventMetricKpiVerifier.Aggregation.SUM,
            1,
            scale,
            WINDOW_START,
            WINDOW_END
        );
    }

    function _configure(uint256 startBlock, uint256 endBlock) internal {
        vm.prank(owner);
        _configureAs(owner, startBlock, endBlock);
    }

    /// @dev Split from `_configure` so revert tests can set their own `prank`/`expectRevert` pairing.
    ///      Scale is 1 here so the arithmetic under test is the cap, not the division; scaling has its
    ///      own tests.
    function _configureAs(address, uint256 startBlock, uint256 endBlock) internal {
        verifier.setKpiConfig(
            campaign,
            KPI,
            address(0xDEAD),
            SIG,
            0,
            IEventMetricKpiVerifier.Aggregation.SUM,
            1,
            1,
            startBlock,
            endBlock
        );
    }

    function _report(address user, uint256 total, uint256 checkpoint) internal {
        address[] memory users = new address[](1);
        uint256[] memory totals = new uint256[](1);
        users[0] = user;
        totals[0] = total;

        vm.prank(reporter);
        verifier.reportBatch(campaign, KPI, users, totals, checkpoint);
    }

    function _userKey(address user) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(campaign, KPI, user));
    }
}
