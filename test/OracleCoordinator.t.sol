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
import {ICampaign} from "../src/interfaces/ICampaign.sol";
import {IAttributionRegistry} from "../src/interfaces/IAttributionRegistry.sol";
import {IOracleCoordinator} from "../src/interfaces/IOracleCoordinator.sol";
import {Types} from "../src/libraries/Types.sol";
import {Errors} from "../src/libraries/Errors.sol";

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

    uint256 internal userPk = 0x5EED;
    uint256 internal user2Pk = 0x5EED2;
    address internal user;
    address internal user2;

    uint64 internal startTime;
    uint64 internal endTime;

    function setUp() public {
        user = vm.addr(userPk);
        user2 = vm.addr(user2Pk);
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
            address(vault), address(reputation), address(attribution), address(coordinator), address(this)
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

        Types.KpiSpec[] memory kpis = new Types.KpiSpec[](2);
        kpis[0] = Types.KpiSpec({
            kind: Types.KpiKind.Tvl,
            verifier: address(0),
            target: 1_000_000,
            aggregate: true,
            params: ""
        });
        kpis[1] = Types.KpiSpec({
            kind: Types.KpiKind.Mint,
            verifier: address(0),
            target: 1_000_000,
            aggregate: false,
            params: ""
        });
        Types.RewardTier[][] memory tiers = new Types.RewardTier[][](2);
        tiers[0] = new Types.RewardTier[](0);
        tiers[1] = new Types.RewardTier[](1);
        tiers[1][0] = Types.RewardTier({threshold: 1_000_000, reward: 1 ether});

        vm.prank(project);
        (, address addr) = registry.createCampaign(cfg, kpis, tiers);
        return Campaign(addr);
    }

    function _allowReporter(address who) internal {
        vm.prank(governor);
        coordinator.addReporter(who);
    }

    function _submit(address who, address campaign_, uint256 amount) internal returns (bytes32 reportId) {
        IOracleCoordinator.Report memory report = _aggregateReport(campaign_, amount);
        vm.prank(who);
        return coordinator.submitReport(report);
    }

    function _aggregateReport(address campaign_, uint256 amount)
        internal
        pure
        returns (IOracleCoordinator.Report memory)
    {
        return IOracleCoordinator.Report({campaign: campaign_, kpiIndex: 0, amount: amount, evidence: ""});
    }

    function _userReport(address campaign_, address user_, uint256 amount, bytes memory evidence)
        internal
        pure
        returns (IOracleCoordinator.UserReport memory)
    {
        return IOracleCoordinator.UserReport({
            campaign: campaign_,
            kpiIndex: 1,
            user: user_,
            newTotal: amount,
            evidence: evidence
        });
    }

    function _joinPromoter() internal returns (bytes32 promoterId) {
        vm.prank(reporter);
        return campaign.join();
    }

    function _touch(address user_, uint256 privateKey, bytes32 promoterId) internal {
        IAttributionRegistry.Touch memory touch = IAttributionRegistry.Touch({
            campaign: address(campaign),
            promoterId: promoterId,
            signedAt: uint64(block.timestamp),
            expiresAt: uint64(block.timestamp + 7 days)
        });
        bytes32 structHash = keccak256(
            abi.encode(
                attribution.TOUCH_TYPEHASH(),
                touch.campaign,
                touch.promoterId,
                touch.signedAt,
                touch.expiresAt
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", attribution.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        attribution.storeTouch(user_, touch, abi.encodePacked(r, s, v), user_);
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

    function test_SubmitReports_returnsOrderedIndependentIds() public {
        _allowReporter(reporter);
        _activateAndFund();
        IOracleCoordinator.Report[] memory reports = new IOracleCoordinator.Report[](2);
        reports[0] = _aggregateReport(address(campaign), 100);
        reports[1] = _aggregateReport(address(campaign), 200);

        vm.prank(reporter);
        bytes32[] memory reportIds = coordinator.submitReports(reports);

        assertEq(reportIds[0], keccak256(abi.encode(reporter, address(campaign), 0, 100, address(0), 0)));
        assertEq(reportIds[1], keccak256(abi.encode(reporter, address(campaign), 0, 200, address(0), 1)));
        assertEq(coordinator.reportDeadline(reportIds[0]), block.timestamp + DISPUTE_WINDOW);
        assertEq(coordinator.reportDeadline(reportIds[1]), block.timestamp + DISPUTE_WINDOW);
        assertFalse(coordinator.reportDisputed(reportIds[0]));
        assertFalse(coordinator.reportApplied(reportIds[1]));
    }

    function test_SubmitUserReports_preservesEvidenceAndOrder() public {
        _allowReporter(reporter);
        IOracleCoordinator.UserReport[] memory reports = new IOracleCoordinator.UserReport[](2);
        reports[0] = _userReport(address(campaign), user, 100, hex"0102");
        reports[1] = _userReport(address(campaign), user2, 200, hex"0304");

        vm.prank(reporter);
        bytes32[] memory reportIds = coordinator.submitUserReports(reports);

        assertEq(reportIds[0], keccak256(abi.encode(reporter, address(campaign), 1, 100, user, 0)));
        assertEq(reportIds[1], keccak256(abi.encode(reporter, address(campaign), 1, 200, user2, 1)));
        OracleCoordinator.ReportState memory first = coordinator.reportState(reportIds[0]);
        OracleCoordinator.ReportState memory second = coordinator.reportState(reportIds[1]);
        assertEq(first.user, user);
        assertEq(first.evidence, hex"0102");
        assertEq(second.user, user2);
        assertEq(second.evidence, hex"0304");
    }

    function test_SubmitReports_rejectsEmptyAndAboveBound() public {
        _allowReporter(reporter);
        IOracleCoordinator.Report[] memory empty = new IOracleCoordinator.Report[](0);
        vm.prank(reporter);
        vm.expectRevert(IOracleCoordinator.EmptyReportBatch.selector);
        coordinator.submitReports(empty);

        uint256 provided = coordinator.MAX_REPORTS_PER_BATCH() + 1;
        IOracleCoordinator.Report[] memory reports = new IOracleCoordinator.Report[](provided);
        vm.prank(reporter);
        vm.expectRevert(abi.encodeWithSelector(IOracleCoordinator.TooManyReports.selector, provided, 32));
        coordinator.submitReports(reports);
    }

    function test_SubmitUserReports_invalidMiddleRollsBackSequence() public {
        _allowReporter(reporter);
        _activateAndFund();
        IOracleCoordinator.UserReport[] memory reports = new IOracleCoordinator.UserReport[](2);
        reports[0] = _userReport(address(campaign), user, 100, hex"01");
        reports[1] = _userReport(address(campaign), address(0), 200, hex"02");

        vm.prank(reporter);
        vm.expectRevert(IOracleCoordinator.ZeroAddress.selector);
        coordinator.submitUserReports(reports);

        bytes32 reportId = _submit(reporter, address(campaign), 300);
        assertEq(reportId, keccak256(abi.encode(reporter, address(campaign), 0, 300, address(0), 0)));
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

    function test_ApplyReports_appliesMixedReportsInOrder() public {
        _allowReporter(reporter);
        _activateAndFund();
        bytes32 promoterId = _joinPromoter();
        _touch(user, userPk, promoterId);

        IOracleCoordinator.UserReport[] memory userReports = new IOracleCoordinator.UserReport[](1);
        userReports[0] = _userReport(address(campaign), user, 7, "");
        vm.prank(reporter);
        bytes32 userId = coordinator.submitUserReports(userReports)[0];
        bytes32 aggregateId = _submit(reporter, address(campaign), 500_000);

        bytes32[] memory reportIds = new bytes32[](2);
        reportIds[0] = userId;
        reportIds[1] = aggregateId;
        vm.warp(block.timestamp + DISPUTE_WINDOW);
        coordinator.applyReports(reportIds);

        assertEq(campaign.progressOf(reporter, 1), 7);
        assertEq(campaign.totalProgress(0), 500_000);
        assertEq(campaign.totalProgress(1), 7);
        assertTrue(coordinator.reportApplied(userId));
        assertTrue(coordinator.reportApplied(aggregateId));
    }

    function test_ApplyReports_coalescesOnlyContiguousSameCampaignUsers() public {
        _allowReporter(reporter);
        _activateAndFund();
        bytes32 promoterId = _joinPromoter();
        _touch(user, userPk, promoterId);
        _touch(user2, user2Pk, promoterId);

        IOracleCoordinator.UserReport[] memory reports = new IOracleCoordinator.UserReport[](3);
        reports[0] = _userReport(address(campaign), user, 5, "");
        reports[1] = _userReport(address(campaign), user2, 8, "");
        reports[2] = _userReport(address(campaign), user, 9, "");
        vm.prank(reporter);
        bytes32[] memory userIds = coordinator.submitUserReports(reports);
        bytes32 aggregateId = _submit(reporter, address(campaign), 100);

        ICampaign.UserActionReport[] memory firstGroup = new ICampaign.UserActionReport[](2);
        firstGroup[0] = ICampaign.UserActionReport({kpiIndex: 1, user: user, newTotal: 5, evidence: ""});
        firstGroup[1] = ICampaign.UserActionReport({kpiIndex: 1, user: user2, newTotal: 8, evidence: ""});
        ICampaign.UserActionReport[] memory secondGroup = new ICampaign.UserActionReport[](1);
        secondGroup[0] = ICampaign.UserActionReport({kpiIndex: 1, user: user, newTotal: 9, evidence: ""});
        vm.expectCall(
            address(campaign), abi.encodeCall(ICampaign.reportUserActionsBatch, (firstGroup)), uint64(1)
        );
        vm.expectCall(
            address(campaign), abi.encodeCall(ICampaign.reportUserActionsBatch, (secondGroup)), uint64(1)
        );

        bytes32[] memory reportIds = new bytes32[](4);
        reportIds[0] = userIds[0];
        reportIds[1] = userIds[1];
        reportIds[2] = aggregateId;
        reportIds[3] = userIds[2];
        vm.warp(block.timestamp + DISPUTE_WINDOW);
        coordinator.applyReports(reportIds);

        assertEq(campaign.progressOf(reporter, 1), 17);
        assertEq(campaign.totalProgress(0), 100);
        assertEq(campaign.totalProgress(1), 17);
        for (uint256 i; i < reportIds.length; ++i) {
            assertTrue(coordinator.reportApplied(reportIds[i]));
        }
    }

    function test_ApplyReports_invalidMiddleRollsBackFlagsAndEffects() public {
        _allowReporter(reporter);
        _activateAndFund();
        bytes32 first = _submit(reporter, address(campaign), 100);
        bytes32 second = _submit(reporter, address(campaign), 200);

        bytes32[] memory reportIds = new bytes32[](3);
        reportIds[0] = first;
        reportIds[1] = bytes32(uint256(0xDEAD));
        reportIds[2] = second;
        vm.warp(block.timestamp + DISPUTE_WINDOW);
        vm.expectRevert(abi.encodeWithSelector(IOracleCoordinator.UnknownReport.selector, reportIds[1]));
        coordinator.applyReports(reportIds);

        assertEq(campaign.totalProgress(0), 0);
        assertFalse(coordinator.reportApplied(first));
        assertFalse(coordinator.reportApplied(second));
    }

    function test_ApplyReports_downstreamFailureRollsBackEveryGroupedFlag() public {
        _allowReporter(reporter);
        _activateAndFund();
        bytes32 promoterId = _joinPromoter();
        _touch(user, userPk, promoterId);

        IOracleCoordinator.UserReport[] memory reports = new IOracleCoordinator.UserReport[](2);
        reports[0] = _userReport(address(campaign), user, 8, "");
        reports[1] = _userReport(address(campaign), user2, 9, "");
        vm.prank(reporter);
        bytes32[] memory reportIds = coordinator.submitUserReports(reports);

        vm.warp(block.timestamp + DISPUTE_WINDOW);
        vm.expectRevert(abi.encodeWithSelector(Errors.NoAttribution.selector, user2));
        coordinator.applyReports(reportIds);

        assertEq(campaign.progressOf(reporter, 1), 0);
        assertEq(campaign.totalProgress(1), 0);
        assertFalse(coordinator.reportApplied(reportIds[0]));
        assertFalse(coordinator.reportApplied(reportIds[1]));
    }

    function test_ApplyReports_rejectsEmptyAndAboveBound() public {
        bytes32[] memory empty = new bytes32[](0);
        vm.expectRevert(IOracleCoordinator.EmptyReportBatch.selector);
        coordinator.applyReports(empty);

        uint256 provided = coordinator.MAX_REPORTS_PER_BATCH() + 1;
        bytes32[] memory reportIds = new bytes32[](provided);
        vm.expectRevert(abi.encodeWithSelector(IOracleCoordinator.TooManyReports.selector, provided, 32));
        coordinator.applyReports(reportIds);
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
