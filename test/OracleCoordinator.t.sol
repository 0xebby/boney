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
    uint256 internal constant DISPUTE_WINDOW = 1 days;
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
        coordinator = new OracleCoordinator(governor, DISPUTE_WINDOW);
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

    function _allowReporter(address who) internal {
        vm.prank(governor);
        coordinator.addReporter(who);
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

    // ── submission ───────────────────────────────────────────────

    function test_SubmitReport() public {
        _allowReporter(reporter);
        _activateAndFund();

        bytes32 reportId = _submit(reporter, address(campaign), 500_000);

        assertTrue(reportId != bytes32(0));
        assertEq(coordinator.reportDeadline(reportId), block.timestamp + DISPUTE_WINDOW);
        assertFalse(coordinator.reportDisputed(reportId));
        assertFalse(coordinator.reportApplied(reportId));
    }

    function test_Submit_revertsReporterNotListed() public {
        _activateAndFund();
        vm.prank(reporter);
        vm.expectRevert(abi.encodeWithSelector(IOracleCoordinator.NotAReporter.selector, reporter));
        coordinator.submitReport(
            IOracleCoordinator.Report({campaign: address(campaign), kpiIndex: 0, amount: 1, evidence: ""})
        );
    }

    function test_Submit_revertsUnknownCampaign() public {
        _allowReporter(reporter);
        vm.prank(reporter);
        vm.expectRevert(abi.encodeWithSelector(IOracleCoordinator.UnknownCampaign.selector, address(0xDEAD)));
        coordinator.submitReport(
            IOracleCoordinator.Report({campaign: address(0xDEAD), kpiIndex: 0, amount: 1, evidence: ""})
        );
    }

    /// @dev Two reporters can make the same claim independently; ids differ and both may land.
    function test_Submit_independentReportersDontCollide() public {
        _allowReporter(reporter);
        _allowReporter(otherReporter);
        _activateAndFund();

        bytes32 r1 = _submit(reporter, address(campaign), 100);
        bytes32 r2 = _submit(otherReporter, address(campaign), 100);

        assertTrue(r1 != r2);
    }

    // ── dispute window ───────────────────────────────────────────

    function test_ApplyReport_afterWindow() public {
        _allowReporter(reporter);
        _activateAndFund();
        bytes32 reportId = _submit(reporter, address(campaign), 500_000);

        _advancePastDispute(reportId);
        coordinator.applyReport(reportId);

        assertTrue(coordinator.reportApplied(reportId));
        assertEq(campaign.totalProgress(0), 500_000);
    }

    function test_ApplyReport_revertsInsideWindow() public {
        _allowReporter(reporter);
        _activateAndFund();
        bytes32 reportId = _submit(reporter, address(campaign), 500_000);

        vm.expectRevert(
            abi.encodeWithSelector(
                IOracleCoordinator.DisputeWindowOpen.selector, block.timestamp + DISPUTE_WINDOW
            )
        );
        coordinator.applyReport(reportId);
        assertEq(campaign.totalProgress(0), 0, "nothing applied early");
    }

    function test_ApplyReport_revertsTwice() public {
        _allowReporter(reporter);
        _activateAndFund();
        bytes32 reportId = _submit(reporter, address(campaign), 500_000);
        _advancePastDispute(reportId);
        coordinator.applyReport(reportId);

        vm.expectRevert(abi.encodeWithSelector(IOracleCoordinator.ReportAlreadyApplied.selector, reportId));
        coordinator.applyReport(reportId);
        assertEq(campaign.totalProgress(0), 500_000, "no double application");
    }

    function test_ApplyReport_revertsUnknown() public {
        vm.expectRevert(abi.encodeWithSelector(IOracleCoordinator.UnknownReport.selector, bytes32(0)));
        coordinator.applyReport(bytes32(0));
    }

    // ── dispute ──────────────────────────────────────────────────

    function test_DisputeVoids() public {
        _allowReporter(reporter);
        _activateAndFund();
        bytes32 reportId = _submit(reporter, address(campaign), 500_000);

        vm.prank(governor);
        coordinator.disputeReport(reportId);

        assertTrue(coordinator.reportDisputed(reportId));
        _advancePastDispute(reportId);
        vm.expectRevert(abi.encodeWithSelector(IOracleCoordinator.ReportIsDisputed.selector, reportId));
        coordinator.applyReport(reportId);
        assertEq(campaign.totalProgress(0), 0, "disputed report never lands");
    }

    function test_Dispute_onlyGovernor() public {
        _allowReporter(reporter);
        _activateAndFund();
        bytes32 reportId = _submit(reporter, address(campaign), 500_000);

        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, outsider));
        coordinator.disputeReport(reportId);
    }

    function test_Dispute_revertsAfterWindow() public {
        _allowReporter(reporter);
        _activateAndFund();
        bytes32 reportId = _submit(reporter, address(campaign), 500_000);
        _advancePastDispute(reportId);

        vm.prank(governor);
        vm.expectRevert(
            abi.encodeWithSelector(IOracleCoordinator.DisputeWindowClosed.selector, block.timestamp)
        );
        coordinator.disputeReport(reportId);
    }

    function test_Dispute_revertsAlreadyApplied() public {
        _allowReporter(reporter);
        _activateAndFund();
        bytes32 reportId = _submit(reporter, address(campaign), 500_000);
        _advancePastDispute(reportId);
        coordinator.applyReport(reportId);

        vm.prank(governor);
        vm.expectRevert(abi.encodeWithSelector(IOracleCoordinator.ReportAlreadyApplied.selector, reportId));
        coordinator.disputeReport(reportId);
    }

    // ── wiring ───────────────────────────────────────────────────

    function test_SetCampaignRegistry_onlyOnce() public {
        vm.prank(governor);
        vm.expectRevert(IOracleCoordinator.RegistryAlreadySet.selector);
        coordinator.setCampaignRegistry(address(0x1111));
    }

    function test_Submit_revertsBeforeRegistrySet() public {
        OracleCoordinator fresh = new OracleCoordinator(governor, DISPUTE_WINDOW);
        vm.prank(governor);
        fresh.addReporter(reporter);

        vm.prank(reporter);
        vm.expectRevert(IOracleCoordinator.RegistryNotSet.selector);
        fresh.submitReport(
            IOracleCoordinator.Report({campaign: address(campaign), kpiIndex: 0, amount: 1, evidence: ""})
        );
    }

    // ── reporter allowlist ─────────────────────────────────────────

    function test_AddReporter_onlyGovernor() public {
        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, outsider));
        coordinator.addReporter(reporter);
    }

    function test_AddReporter_revertsDuplicate() public {
        _allowReporter(reporter);

        vm.prank(governor);
        vm.expectRevert(abi.encodeWithSelector(IOracleCoordinator.ReporterAlreadyListed.selector, reporter));
        coordinator.addReporter(reporter);
    }

    function test_AddReporter_enumeratesReporter() public {
        _allowReporter(reporter);
        _allowReporter(otherReporter);

        assertTrue(coordinator.isReporter(reporter));
        assertTrue(coordinator.isReporter(otherReporter));
        assertEq(coordinator.reporterCount(), 2);
        assertEq(coordinator.reporterAt(0), reporter);
        assertEq(coordinator.reporterAt(1), otherReporter);
    }

    function test_RemoveReporter_onlyGovernor() public {
        _allowReporter(reporter);

        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, outsider));
        coordinator.removeReporter(reporter);
    }

    function test_RemoveReporter_revertsMissing() public {
        vm.prank(governor);
        vm.expectRevert(abi.encodeWithSelector(IOracleCoordinator.ReporterNotListed.selector, reporter));
        coordinator.removeReporter(reporter);
    }

    function test_RemoveReporter_updatesEnumerationAndBlocksSubmission() public {
        _allowReporter(reporter);
        _allowReporter(otherReporter);

        vm.prank(governor);
        coordinator.removeReporter(reporter);

        assertFalse(coordinator.isReporter(reporter));
        assertTrue(coordinator.isReporter(otherReporter));
        assertEq(coordinator.reporterCount(), 1);
        assertEq(coordinator.reporterAt(0), otherReporter);

        vm.prank(reporter);
        vm.expectRevert(abi.encodeWithSelector(IOracleCoordinator.NotAReporter.selector, reporter));
        coordinator.submitReport(
            IOracleCoordinator.Report({campaign: address(campaign), kpiIndex: 0, amount: 1, evidence: ""})
        );
    }

    function test_RemoveReporter_preservesOtherIndexes() public {
        address thirdReporter = address(0x0BAE);
        _allowReporter(reporter);
        _allowReporter(otherReporter);
        _allowReporter(thirdReporter);

        vm.prank(governor);
        coordinator.removeReporter(otherReporter);

        assertEq(coordinator.reporterCount(), 2);
        assertEq(coordinator.reporterAt(0), reporter);
        assertEq(coordinator.reporterAt(1), thirdReporter);

        vm.prank(governor);
        coordinator.removeReporter(thirdReporter);
        assertEq(coordinator.reporterCount(), 1);
        assertEq(coordinator.reporterAt(0), reporter);
    }

    // ── fuzz ─────────────────────────────────────────────────────

    function testFuzz_ApplyIsMonotonicAcrossReporters(uint256 a, uint256 b) public {
        a = bound(a, 1, 1_000_000);
        b = bound(b, 1, 1_000_000);

        _allowReporter(reporter);
        _allowReporter(otherReporter);
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
