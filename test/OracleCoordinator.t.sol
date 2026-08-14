// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {OracleCoordinator} from "../src/oracle/OracleCoordinator.sol";
import {Campaign} from "../src/campaign/Campaign.sol";
import {CampaignRegistry} from "../src/campaign/CampaignRegistry.sol";
import {EscrowVault} from "../src/escrow/EscrowVault.sol";
import {AttributionRegistry} from "../src/attribution/AttributionRegistry.sol";
import {AttestationVerifier} from "../src/reputation/AttestationVerifier.sol";
import {ReputationRegistry} from "../src/reputation/ReputationRegistry.sol";
import {IOracleCoordinator} from "../src/interfaces/IOracleCoordinator.sol";
import {Types} from "../src/libraries/Types.sol";

contract MockToken is ERC20 {
    constructor() ERC20("Mock", "MOCK") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract OracleCoordinatorTest is Test {
    uint256 internal constant MIN_STAKE = 100 ether;
    uint256 internal constant DISPUTE_WINDOW = 1 days;
    uint256 internal constant UNSTAKE_DELAY = 2 days;
    uint256 internal constant POOL = 10_000 ether;

    MockToken internal token;
    EscrowVault internal vault;
    CampaignRegistry internal registry;
    AttributionRegistry internal attribution;
    AttestationVerifier internal verifier;
    ReputationRegistry internal reputation;
    OracleCoordinator internal coordinator;
    Campaign internal campaign;

    address internal governor = address(0x60B);
    address internal project = address(0xC0DE);
    address internal reporter = address(0x0BAC);
    address internal otherReporter = address(0x0BAD);
    address internal outsider = address(0xBEEF);

    uint64 internal startTime;
    uint64 internal endTime;

    function setUp() public {
        vm.warp(1_000_000);
        startTime = uint64(block.timestamp);
        endTime = uint64(block.timestamp + 30 days);

        token = new MockToken();
        attribution = new AttributionRegistry(30 days);
        verifier = new AttestationVerifier(governor, governor);
        reputation = new ReputationRegistry(governor, address(verifier));

        // The coordinator is deployed first so the registry can reference it, then wired back to
        // the registry. Both directions use one-time setters rather than address prediction.
        coordinator = new OracleCoordinator(governor, MIN_STAKE, DISPUTE_WINDOW, UNSTAKE_DELAY);
        vault = new EscrowVault(address(this));
        registry = new CampaignRegistry(
            address(vault), address(reputation), address(attribution), address(coordinator)
        );
        vault.setRegistrar(address(registry));
        vm.prank(governor);
        coordinator.setCampaignRegistry(address(registry));

        campaign = _createCampaign();
    }

    // ── fixtures ─────────────────────────────────────────────────

    function _createCampaign() internal returns (Campaign) {
        Types.CampaignConfig memory cfg = Types.CampaignConfig({
            project: project,
            name: "Oracle Test",
            token: address(token),
            rewardPool: POOL,
            startTime: startTime,
            endTime: endTime,
            attributionWindow: 7 days,
            minReputation: 0
        });

        Types.KpiSpec[] memory kpis = new Types.KpiSpec[](1);
        kpis[0] = Types.KpiSpec({
            kind: Types.KpiKind.Tvl,
            verifier: address(0),
            target: 1_000_000,
            aggregate: true,
            params: ""
        });
        Types.RewardTier[][] memory tiers = new Types.RewardTier[][](1);
        tiers[0] = new Types.RewardTier[](0);

        vm.prank(project);
        (, address addr) = registry.createCampaign(cfg, kpis, tiers);
        return Campaign(addr);
    }

    function _stakeReporter(address who) internal {
        vm.deal(who, MIN_STAKE);
        vm.prank(who);
        coordinator.stake{value: MIN_STAKE}();
    }

    function _submit(address who, address campaign_, uint256 amount) internal returns (bytes32 reportId) {
        IOracleCoordinator.Report memory report =
            IOracleCoordinator.Report({campaign: campaign_, kpiIndex: 0, amount: amount, evidence: ""});
        vm.prank(who);
        return coordinator.submitReport(report);
    }

    function _activateAndFund() internal {
        token.mint(project, POOL);
        vm.startPrank(project);
        token.approve(address(vault), POOL);
        vault.deposit(address(campaign), POOL);
        campaign.activate();
        vm.stopPrank();
    }

    function _advancePastDispute(bytes32 reportId) internal {
        vm.warp(coordinator.reportDeadline(reportId));
    }

    // ── staking ──────────────────────────────────────────────────

    function test_Stake() public {
        vm.deal(reporter, MIN_STAKE);
        vm.prank(reporter);
        coordinator.stake{value: MIN_STAKE}();

        assertEq(coordinator.stakeOf(reporter), MIN_STAKE);
        assertTrue(coordinator.isReporter(reporter));
    }

    /// @dev Collateral below the minimum is accepted but confers no reporting rights, so a
    ///      reporter can accumulate over several transactions.
    function test_Stake_belowMinimumConfersNoRights() public {
        vm.deal(reporter, MIN_STAKE);
        vm.prank(reporter);
        coordinator.stake{value: MIN_STAKE - 1}();

        assertEq(coordinator.stakeOf(reporter), MIN_STAKE - 1);
        assertFalse(coordinator.isReporter(reporter), "not eligible below the minimum");
    }

    function test_Stake_revertsZeroValue() public {
        vm.prank(reporter);
        vm.expectRevert(OracleCoordinator.NothingStaked.selector);
        coordinator.stake{value: 0}();
    }

    function test_Stake_topUpReachesMinimum() public {
        vm.deal(reporter, MIN_STAKE);
        vm.prank(reporter);
        coordinator.stake{value: MIN_STAKE / 2}();

        assertFalse(coordinator.isReporter(reporter));

        vm.prank(reporter);
        coordinator.stake{value: MIN_STAKE / 2}();

        assertTrue(coordinator.isReporter(reporter));
    }

    function test_Unstake() public {
        _stakeReporter(reporter);
        vm.prank(reporter);
        coordinator.unstake();
        assertEq(coordinator.stakeOf(reporter), 0);
        assertEq(reporter.balance, MIN_STAKE);
    }

    function test_Unstake_revertsNothingStaked() public {
        vm.prank(reporter);
        vm.expectRevert(OracleCoordinator.NothingStaked.selector);
        coordinator.unstake();
    }

    /// @dev A reporter with an in-flight report must not be able to pull collateral and dodge a
    ///      slash.
    function test_Unstake_blockedWhileReportInFlight() public {
        _stakeReporter(reporter);
        _activateAndFund();
        _submit(reporter, address(campaign), 100);

        vm.prank(reporter);
        vm.expectRevert(
            abi.encodeWithSelector(
                OracleCoordinator.StakeLocked.selector, block.timestamp + DISPUTE_WINDOW + UNSTAKE_DELAY
            )
        );
        coordinator.unstake();
        assertEq(coordinator.stakeOf(reporter), MIN_STAKE);
    }

    function test_Unstake_allowedAfterLockExpires() public {
        _stakeReporter(reporter);
        _activateAndFund();
        _submit(reporter, address(campaign), 100);

        vm.warp(block.timestamp + DISPUTE_WINDOW + UNSTAKE_DELAY);
        vm.prank(reporter);
        coordinator.unstake();
        assertEq(coordinator.stakeOf(reporter), 0);
    }

    // ── submission ───────────────────────────────────────────────

    function test_SubmitReport() public {
        _stakeReporter(reporter);
        _activateAndFund();

        bytes32 reportId = _submit(reporter, address(campaign), 500_000);

        assertTrue(reportId != bytes32(0));
        assertEq(coordinator.reportDeadline(reportId), block.timestamp + DISPUTE_WINDOW);
        assertFalse(coordinator.reportDisputed(reportId));
        assertFalse(coordinator.reportApplied(reportId));
    }

    function test_Submit_revertsNoStake() public {
        _activateAndFund();
        vm.prank(reporter);
        vm.expectRevert(abi.encodeWithSelector(OracleCoordinator.NotAReporter.selector, reporter));
        coordinator.submitReport(
            IOracleCoordinator.Report({campaign: address(campaign), kpiIndex: 0, amount: 1, evidence: ""})
        );
    }

    function test_Submit_revertsUnknownCampaign() public {
        _stakeReporter(reporter);
        vm.prank(reporter);
        vm.expectRevert(abi.encodeWithSelector(OracleCoordinator.UnknownCampaign.selector, address(0xDEAD)));
        coordinator.submitReport(
            IOracleCoordinator.Report({campaign: address(0xDEAD), kpiIndex: 0, amount: 1, evidence: ""})
        );
    }

    /// @dev Two reporters can make the same claim independently; ids differ and both may land.
    function test_Submit_independentReportersDontCollide() public {
        _stakeReporter(reporter);
        _stakeReporter(otherReporter);
        _activateAndFund();

        bytes32 r1 = _submit(reporter, address(campaign), 100);
        bytes32 r2 = _submit(otherReporter, address(campaign), 100);

        assertTrue(r1 != r2);
    }

    // ── dispute window ───────────────────────────────────────────

    function test_ApplyReport_afterWindow() public {
        _stakeReporter(reporter);
        _activateAndFund();
        bytes32 reportId = _submit(reporter, address(campaign), 500_000);

        _advancePastDispute(reportId);
        coordinator.applyReport(reportId);

        assertTrue(coordinator.reportApplied(reportId));
        assertEq(campaign.totalProgress(0), 500_000);
    }

    function test_ApplyReport_revertsInsideWindow() public {
        _stakeReporter(reporter);
        _activateAndFund();
        bytes32 reportId = _submit(reporter, address(campaign), 500_000);

        vm.expectRevert(
            abi.encodeWithSelector(
                OracleCoordinator.DisputeWindowOpen.selector, block.timestamp + DISPUTE_WINDOW
            )
        );
        coordinator.applyReport(reportId);
        assertEq(campaign.totalProgress(0), 0, "nothing applied early");
    }

    function test_ApplyReport_revertsTwice() public {
        _stakeReporter(reporter);
        _activateAndFund();
        bytes32 reportId = _submit(reporter, address(campaign), 500_000);
        _advancePastDispute(reportId);
        coordinator.applyReport(reportId);

        vm.expectRevert(abi.encodeWithSelector(OracleCoordinator.ReportAlreadyApplied.selector, reportId));
        coordinator.applyReport(reportId);
        assertEq(campaign.totalProgress(0), 500_000, "no double application");
    }

    function test_ApplyReport_revertsUnknown() public {
        vm.expectRevert(abi.encodeWithSelector(OracleCoordinator.UnknownReport.selector, bytes32(0)));
        coordinator.applyReport(bytes32(0));
    }

    // ── dispute & slash ──────────────────────────────────────────

    function test_Dispute_slashesAndVoids() public {
        _stakeReporter(reporter);
        _activateAndFund();
        bytes32 reportId = _submit(reporter, address(campaign), 500_000);

        vm.prank(governor);
        coordinator.disputeReport(reportId);

        assertTrue(coordinator.reportDisputed(reportId));
        assertEq(coordinator.stakeOf(reporter), 0, "collateral slashed");
        assertEq(coordinator.slashPool(), MIN_STAKE);

        _advancePastDispute(reportId);
        vm.expectRevert(abi.encodeWithSelector(OracleCoordinator.ReportIsDisputed.selector, reportId));
        coordinator.applyReport(reportId);
        assertEq(campaign.totalProgress(0), 0, "disputed report never lands");
    }

    function test_Dispute_onlyGovernor() public {
        _stakeReporter(reporter);
        _activateAndFund();
        bytes32 reportId = _submit(reporter, address(campaign), 500_000);

        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, outsider));
        coordinator.disputeReport(reportId);
    }

    function test_Dispute_revertsAfterWindow() public {
        _stakeReporter(reporter);
        _activateAndFund();
        bytes32 reportId = _submit(reporter, address(campaign), 500_000);
        _advancePastDispute(reportId);

        vm.prank(governor);
        vm.expectRevert(
            abi.encodeWithSelector(OracleCoordinator.DisputeWindowClosed.selector, block.timestamp)
        );
        coordinator.disputeReport(reportId);
    }

    function test_Dispute_revertsAlreadyApplied() public {
        _stakeReporter(reporter);
        _activateAndFund();
        bytes32 reportId = _submit(reporter, address(campaign), 500_000);
        _advancePastDispute(reportId);
        coordinator.applyReport(reportId);

        vm.prank(governor);
        vm.expectRevert(abi.encodeWithSelector(OracleCoordinator.ReportAlreadyApplied.selector, reportId));
        coordinator.disputeReport(reportId);
    }

    /// @dev If the reporter's report would have been a no-op anyway, the dispute still burns
    ///      their collateral — a bad report is a bad report.
    function test_Dispute_slashesEvenWhenAmountBelowCurrent() public {
        _stakeReporter(reporter);
        _activateAndFund();

        bytes32 r1 = _submit(reporter, address(campaign), 100);
        _advancePastDispute(r1);
        coordinator.applyReport(r1);

        bytes32 r2 = _submit(reporter, address(campaign), 50);
        vm.prank(governor);
        coordinator.disputeReport(r2);

        assertEq(coordinator.stakeOf(reporter), 0);
        assertEq(campaign.totalProgress(0), 100, "applied value untouched");
    }

    // ── slash pool withdrawal ────────────────────────────────────

    function test_WithdrawSlashPool() public {
        _stakeReporter(reporter);
        _activateAndFund();
        bytes32 slashed = _submit(reporter, address(campaign), 100);
        vm.prank(governor);
        coordinator.disputeReport(slashed);

        uint256 before = address(governor).balance;
        vm.prank(governor);
        coordinator.withdrawSlashPool(governor);

        assertEq(coordinator.slashPool(), 0);
        assertEq(address(governor).balance - before, MIN_STAKE);
    }

    function test_WithdrawSlashPool_onlyGovernor() public {
        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, outsider));
        coordinator.withdrawSlashPool(outsider);
    }

    // ── wiring ───────────────────────────────────────────────────

    function test_SetCampaignRegistry_onlyOnce() public {
        vm.prank(governor);
        vm.expectRevert(OracleCoordinator.RegistryAlreadySet.selector);
        coordinator.setCampaignRegistry(address(0x1111));
    }

    function test_Submit_revertsBeforeRegistrySet() public {
        OracleCoordinator fresh = new OracleCoordinator(governor, MIN_STAKE, DISPUTE_WINDOW, UNSTAKE_DELAY);
        vm.deal(reporter, MIN_STAKE);
        vm.prank(reporter);
        fresh.stake{value: MIN_STAKE}();

        vm.prank(reporter);
        vm.expectRevert(OracleCoordinator.RegistryNotSet.selector);
        fresh.submitReport(
            IOracleCoordinator.Report({campaign: address(campaign), kpiIndex: 0, amount: 1, evidence: ""})
        );
    }

    // ── fuzz ─────────────────────────────────────────────────────

    function testFuzz_ApplyIsMonotonicAcrossReporters(uint256 a, uint256 b) public {
        a = bound(a, 1, 1_000_000);
        b = bound(b, 1, 1_000_000);

        _stakeReporter(reporter);
        _stakeReporter(otherReporter);
        _activateAndFund();

        bytes32 ra = _submit(reporter, address(campaign), a);
        bytes32 rb = _submit(otherReporter, address(campaign), b);

        _advancePastDispute(ra);
        coordinator.applyReport(ra);

        // Applying the other report either advances the total or reverts as non-monotonic; it
        // can never decrease it.
        _advancePastDispute(rb);
        try coordinator.applyReport(rb) {} catch {}

        uint256 total = campaign.totalProgress(0);
        assertGe(total, a, "first report applied");
        assertLe(total, a + b, "never credits more than reported");
    }
}
