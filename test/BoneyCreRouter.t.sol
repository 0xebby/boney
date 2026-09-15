// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {BoneyCreRouter} from "../src/automation/BoneyCreRouter.sol";
import {ICampaign} from "../src/interfaces/ICampaign.sol";
import {ICampaignRegistry} from "../src/interfaces/ICampaignRegistry.sol";
import {IOracleCoordinator} from "../src/interfaces/IOracleCoordinator.sol";
import {IReceiver} from "../src/interfaces/IReceiver.sol";
import {
    IEventMetricAutomation,
    IKpiAutomation,
    IKpiAutomationObservation
} from "../src/interfaces/IKpiAutomation.sol";
import {Types} from "../src/libraries/Types.sol";
import {EventMetricKpiVerifier} from "../src/verifiers/EventMetricKpiVerifier.sol";
import {IEventMetricKpiVerifier} from "../src/interfaces/IEventMetricKpiVerifier.sol";

contract RouterRegistryMock {
    address public automatedReporter;
    address public oracleCoordinator;
    mapping(address => bool) public campaigns;

    function setTopology(address reporter, address coordinator) external {
        automatedReporter = reporter;
        oracleCoordinator = coordinator;
    }

    function setCampaign(address campaign, bool known) external {
        campaigns[campaign] = known;
    }

    function isCampaign(address campaign) external view returns (bool) {
        return campaigns[campaign];
    }
}

contract RouterEventMetricMock is IEventMetricAutomation {
    mapping(bytes32 => KpiConfig) private _configs;
    mapping(bytes32 => uint256) private _observed;

    function configure(address campaign, uint256 kpiIndex, bool configured, uint256 epoch) external {
        _configs[_targetKey(campaign, kpiIndex)] = KpiConfig({
            targetContract: address(0xCAFE),
            eventSignature: "Action(address,uint256)",
            userParamIndex: 0,
            valueParamIndex: 1,
            aggregation: 1,
            scale: 1,
            windowStartBlock: 10,
            windowEndBlock: 100,
            configured: configured,
            epoch: epoch
        });
    }

    function setObserved(address campaign, uint256 kpiIndex, address user, uint256 observed) external {
        _observed[_userKey(campaign, kpiIndex, user)] = observed;
    }

    function configOf(address campaign, uint256 kpiIndex) external view returns (KpiConfig memory) {
        return _configs[_targetKey(campaign, kpiIndex)];
    }

    function observedProgressOf(address campaign, uint256 kpiIndex, address user)
        external
        view
        returns (uint256)
    {
        return _observed[_userKey(campaign, kpiIndex, user)];
    }

    function _targetKey(address campaign, uint256 kpiIndex) private pure returns (bytes32) {
        return keccak256(abi.encode(campaign, kpiIndex));
    }

    function _userKey(address campaign, uint256 kpiIndex, address user) private pure returns (bytes32) {
        return keccak256(abi.encode(campaign, kpiIndex, user));
    }
}

contract RouterAutomationMock is IKpiAutomation, IKpiAutomationObservation {
    error UnknownSelector();

    AutomationMode public mode;
    address public adapter;
    uint256 public epoch;
    uint256 public aggregateObserved;
    mapping(address => uint256) public userObserved;

    constructor() {
        adapter = address(this);
    }

    function setCapability(AutomationMode mode_, address adapter_) external {
        mode = mode_;
        adapter = adapter_;
    }

    function setEpoch(uint256 epoch_) external {
        epoch = epoch_;
    }

    function setUserObserved(address user, uint256 observed) external {
        userObserved[user] = observed;
    }

    function setAggregateObserved(uint256 observed) external {
        aggregateObserved = observed;
    }

    function automationCapability(address, uint256) external view returns (AutomationMode, address) {
        return (mode, adapter);
    }

    function observationEpoch(address, uint256) external view returns (uint256) {
        return epoch;
    }

    function observedProgressOf(address, uint256, address user) external view returns (uint256) {
        return userObserved[user];
    }

    function observedAggregateProgressOf(address, uint256) external view returns (uint256) {
        return aggregateObserved;
    }

    fallback() external {
        revert UnknownSelector();
    }
}

contract RouterGuardMock {
    address public boneyVerifier;
    address public projectVerifier;
    bool public configured = true;

    constructor(address boneyVerifier_) {
        boneyVerifier = boneyVerifier_;
    }

    function setGuard(address projectVerifier_, bool configured_) external {
        projectVerifier = projectVerifier_;
        configured = configured_;
    }

    function guardOf(address, uint256) external view returns (address, uint16, uint8, bool) {
        return (projectVerifier, 0, 0, configured);
    }
}

contract RouterCampaignMock {
    Types.KpiSpec[] private _kpis;
    mapping(address => bool) public authorizedReporters;
    mapping(uint256 => uint256) private _totalProgress;
    ICampaign.UserActionReport[] private _received;
    bool public failReports;
    uint256 public batchCalls;
    Types.CampaignStatus public status = Types.CampaignStatus.Active;
    uint64 public startTime;
    uint64 public endTime = type(uint64).max;
    uint64 public endedAt;
    uint64 public constant CLAIM_GRACE = 20 minutes;
    uint256 public aggregateDeadline = type(uint256).max;

    error ReportFailed();

    function addKpi(address verifier, bool aggregate) external {
        _kpis.push(
            Types.KpiSpec({
                kind: Types.KpiKind.Custom,
                verifier: verifier,
                target: 100,
                aggregate: aggregate,
                params: ""
            })
        );
    }

    function setAuthorized(address reporter, bool allowed) external {
        authorizedReporters[reporter] = allowed;
    }

    function setTotalProgress(uint256 kpiIndex, uint256 progress) external {
        _totalProgress[kpiIndex] = progress;
    }

    function setLifecycle(
        Types.CampaignStatus status_,
        uint64 startTime_,
        uint64 endTime_,
        uint64 endedAt_,
        uint256 aggregateDeadline_
    ) external {
        status = status_;
        startTime = startTime_;
        endTime = endTime_;
        endedAt = endedAt_;
        aggregateDeadline = aggregateDeadline_;
    }

    function aggregateUpdateDeadline() external view returns (uint256) {
        return aggregateDeadline;
    }

    function totalProgress(uint256 kpiIndex) external view returns (uint256) {
        return _totalProgress[kpiIndex];
    }

    function setFailReports(bool fail) external {
        failReports = fail;
    }

    function kpiCount() external view returns (uint256) {
        return _kpis.length;
    }

    function kpi(uint256 index) external view returns (Types.KpiSpec memory) {
        return _kpis[index];
    }

    function reportUserActionsBatch(ICampaign.UserActionReport[] calldata reports) external {
        if (failReports) revert ReportFailed();
        ++batchCalls;
        for (uint256 i; i < reports.length; ++i) {
            _received.push(reports[i]);
        }
    }

    function receivedCount() external view returns (uint256) {
        return _received.length;
    }

    function received(uint256 index) external view returns (uint256, address, uint256, bytes memory) {
        ICampaign.UserActionReport storage report = _received[index];
        return (report.kpiIndex, report.user, report.newTotal, report.evidence);
    }
}

contract RouterOracleMock is IOracleCoordinator {
    mapping(bytes32 => bool) public applied;
    mapping(bytes32 => bool) public disputed;
    mapping(bytes32 => address) public reportCampaign;
    mapping(bytes32 => uint256) public reportKpi;
    mapping(bytes32 => uint256) public reportAmount;
    mapping(bytes32 => uint256) public deadline;
    uint256 public disputeWindowSeconds;
    uint256 public sequence;
    bool public failApply;
    bool public failSubmit;
    address public registry;
    mapping(address => bool) public reporters;
    uint256 public returnedIdCount = type(uint256).max;

    error ForcedFailure();

    function setStatus(bytes32 reportId, bool applied_, bool disputed_) external {
        applied[reportId] = applied_;
        disputed[reportId] = disputed_;
    }

    function setFailure(bool applyFailure, bool submitFailure) external {
        failApply = applyFailure;
        failSubmit = submitFailure;
    }

    function setTopology(address registry_, address reporter, bool allowed) external {
        registry = registry_;
        reporters[reporter] = allowed;
    }

    function setReturnedIdCount(uint256 count) external {
        returnedIdCount = count;
    }

    function setDisputeWindow(uint256 window) external {
        disputeWindowSeconds = window;
    }

    function submitReports(Report[] calldata reports) external returns (bytes32[] memory ids) {
        if (failSubmit) revert ForcedFailure();
        uint256 count = returnedIdCount == type(uint256).max ? reports.length : returnedIdCount;
        ids = new bytes32[](count);
        uint256 stored = count < reports.length ? count : reports.length;
        for (uint256 i; i < stored; ++i) {
            ids[i] = keccak256(abi.encode(msg.sender, sequence++));
            reportCampaign[ids[i]] = reports[i].campaign;
            reportKpi[ids[i]] = reports[i].kpiIndex;
            reportAmount[ids[i]] = reports[i].amount;
            deadline[ids[i]] = block.timestamp + disputeWindowSeconds;
        }
        for (uint256 i = stored; i < count; ++i) {
            ids[i] = keccak256(abi.encode(msg.sender, sequence++, i));
        }
    }

    function applyReports(bytes32[] calldata ids) external {
        if (failApply) revert ForcedFailure();
        for (uint256 i; i < ids.length; ++i) {
            applied[ids[i]] = true;
        }
    }

    function reportApplied(bytes32 reportId) external view returns (bool) {
        return applied[reportId];
    }

    function reportDisputed(bytes32 reportId) external view returns (bool) {
        return disputed[reportId];
    }

    function addReporter(address) external {}
    function removeReporter(address) external {}

    function submitReport(Report calldata) external pure returns (bytes32) {
        return bytes32(0);
    }

    function submitUserReport(UserReport calldata) external pure returns (bytes32) {
        return bytes32(0);
    }

    function submitUserReports(UserReport[] calldata) external pure returns (bytes32[] memory ids) {
        return ids;
    }

    function applyReport(bytes32) external {}
    function applyUserReport(bytes32) external {}
    function disputeReport(bytes32) external {}

    function reportDeadline(bytes32 reportId) external view returns (uint256) {
        return deadline[reportId];
    }

    function reportTarget(bytes32 reportId) external view returns (address campaign, uint256 kpiIndex) {
        return (reportCampaign[reportId], reportKpi[reportId]);
    }

    function reporterCount() external pure returns (uint256) {
        return 0;
    }

    function reporterAt(uint256) external pure returns (address) {
        return address(0);
    }

    function isReporter(address who) external view returns (bool) {
        return reporters[who];
    }

    function disputeWindow() external view returns (uint256) {
        return disputeWindowSeconds;
    }

    function campaignContract() external view returns (address) {
        return registry;
    }

    function MAX_REPORTS_PER_BATCH() external pure returns (uint256) {
        return 32;
    }
}

contract BoneyCreRouterTest is Test {
    address internal constant FORWARDER = 0xF8344CFd5c43616a4366C34E3EEE75af79a74482;
    address internal constant OWNER = address(0xBEEF);
    address internal constant USER = address(0xA11CE);
    address internal constant USER_TWO = address(0xB0B);
    bytes32 internal constant WORKFLOW_ID = keccak256("boney-router");

    RouterEventMetricMock internal eventMetric;
    RouterOracleMock internal oracle;
    RouterRegistryMock internal registry;
    RouterCampaignMock internal campaign;
    RouterAutomationMock internal automation;
    BoneyCreRouter internal router;

    function setUp() public {
        vm.warp(1_000_000);
        eventMetric = new RouterEventMetricMock();
        oracle = new RouterOracleMock();
        registry = new RouterRegistryMock();
        campaign = new RouterCampaignMock();
        automation = new RouterAutomationMock();
        automation.setCapability(IKpiAutomation.AutomationMode.AGGREGATE, address(automation));
        automation.setEpoch(3);
        automation.setAggregateObserved(100);

        router = new BoneyCreRouter(FORWARDER, address(eventMetric), oracle, WORKFLOW_ID, OWNER);
        registry.setTopology(address(router), address(oracle));
        oracle.setTopology(address(registry), address(router), true);
        registry.setCampaign(address(campaign), true);
        campaign.setAuthorized(address(router), true);
        router.setCampaignRegistry(ICampaignRegistry(address(registry)));
    }

    function test_ConstructorStoresRootsAndSupportsInterfaces() public view {
        assertEq(router.OFFICIAL_FORWARDER(), FORWARDER);
        assertEq(router.forwarder(), FORWARDER);
        assertEq(router.eventMetricVerifier(), address(eventMetric));
        assertEq(address(router.oracleCoordinator()), address(oracle));
        assertEq(router.expectedWorkflowId(), WORKFLOW_ID);
        assertEq(router.expectedWorkflowOwner(), OWNER);
        assertEq(router.registryBinder(), address(this));
        assertEq(address(router.campaignRegistry()), address(registry));
        assertTrue(router.supportsInterface(type(IReceiver).interfaceId));
        assertTrue(router.supportsInterface(type(IERC165).interfaceId));
        assertFalse(router.supportsInterface(0xffffffff));
    }

    function test_ProductionEventMetricConfigDecodesThroughRouterInterface() public {
        EventMetricKpiVerifier production = new EventMetricKpiVerifier(address(this), address(this));
        production.setKpiConfig(
            address(campaign),
            0,
            address(0xCAFE),
            "Action(address indexed user, uint256 amount)",
            0,
            IEventMetricKpiVerifier.Aggregation.SUM,
            1,
            2,
            10,
            100
        );

        IEventMetricAutomation.KpiConfig memory cfg =
            IEventMetricAutomation(address(production)).configOf(address(campaign), 0);
        assertEq(cfg.targetContract, address(0xCAFE));
        assertEq(cfg.eventSignature, "Action(address indexed user, uint256 amount)");
        assertEq(cfg.userParamIndex, 0);
        assertEq(cfg.valueParamIndex, 1);
        assertEq(cfg.aggregation, uint8(IEventMetricKpiVerifier.Aggregation.SUM));
        assertEq(cfg.scale, 2);
        assertEq(cfg.windowStartBlock, 10);
        assertEq(cfg.windowEndBlock, 100);
        assertTrue(cfg.configured);
        assertEq(cfg.epoch, 0);
    }

    function test_ConstructorRejectsWrongForwarderAndZeroRoots() public {
        vm.expectRevert(abi.encodeWithSelector(BoneyCreRouter.NotOfficialForwarder.selector, address(1)));
        new BoneyCreRouter(address(1), address(eventMetric), oracle, WORKFLOW_ID, OWNER);

        vm.expectRevert(BoneyCreRouter.ZeroAddress.selector);
        new BoneyCreRouter(FORWARDER, address(0), oracle, WORKFLOW_ID, OWNER);

        vm.expectRevert(BoneyCreRouter.ZeroAddress.selector);
        new BoneyCreRouter(
            FORWARDER, address(eventMetric), IOracleCoordinator(address(0)), WORKFLOW_ID, OWNER
        );

        vm.expectRevert(BoneyCreRouter.InvalidWorkflowIdentity.selector);
        new BoneyCreRouter(FORWARDER, address(eventMetric), oracle, bytes32(0), OWNER);
    }

    function test_RegistryBindingRequiresBinderAndTopologyAndRunsOnce() public {
        BoneyCreRouter candidate =
            new BoneyCreRouter(FORWARDER, address(eventMetric), oracle, WORKFLOW_ID, OWNER);
        vm.prank(address(0xBAD));
        vm.expectRevert(abi.encodeWithSelector(BoneyCreRouter.NotRegistryBinder.selector, address(0xBAD)));
        candidate.setCampaignRegistry(ICampaignRegistry(address(registry)));

        registry.setTopology(address(0xBAD), address(oracle));
        vm.expectRevert(BoneyCreRouter.RegistryTopologyMismatch.selector);
        candidate.setCampaignRegistry(ICampaignRegistry(address(registry)));

        registry.setTopology(address(candidate), address(oracle));
        oracle.setTopology(address(registry), address(candidate), true);
        candidate.setCampaignRegistry(ICampaignRegistry(address(registry)));
        vm.expectRevert(BoneyCreRouter.RegistryAlreadySet.selector);
        candidate.setCampaignRegistry(ICampaignRegistry(address(registry)));
    }

    function test_RegistryBindingRejectsCoordinatorMismatchAndMissingReporter() public {
        BoneyCreRouter candidate =
            new BoneyCreRouter(FORWARDER, address(eventMetric), oracle, WORKFLOW_ID, OWNER);
        registry.setTopology(address(candidate), address(oracle));

        oracle.setTopology(address(0xBAD), address(candidate), true);
        vm.expectRevert(BoneyCreRouter.RegistryTopologyMismatch.selector);
        candidate.setCampaignRegistry(ICampaignRegistry(address(registry)));

        oracle.setTopology(address(registry), address(candidate), false);
        vm.expectRevert(BoneyCreRouter.RegistryTopologyMismatch.selector);
        candidate.setCampaignRegistry(ICampaignRegistry(address(registry)));

        oracle.setTopology(address(registry), address(candidate), true);
        candidate.setCampaignRegistry(ICampaignRegistry(address(registry)));
    }

    function test_DeliveryRejectsBeforeBindAndNonForwarder() public {
        BoneyCreRouter candidate =
            new BoneyCreRouter(FORWARDER, address(eventMetric), oracle, WORKFLOW_ID, OWNER);
        vm.prank(FORWARDER);
        vm.expectRevert(BoneyCreRouter.RegistryNotSet.selector);
        candidate.onReport(_metadata(), _encode(_cursorReport(0, 1, 0)));

        vm.expectRevert(abi.encodeWithSelector(BoneyCreRouter.NotForwarder.selector, address(this)));
        router.onReport(_metadata(), _encode(_cursorReport(0, 1, 0)));
    }

    function test_MetadataVersionNonceExpiryReplayAndInclusiveExpiry() public {
        vm.startPrank(FORWARDER);
        vm.expectRevert(abi.encodeWithSelector(BoneyCreRouter.InvalidMetadataLength.selector, 0));
        router.onReport("", _encode(_cursorReport(0, 1, 0)));

        bytes32 wrong = keccak256("wrong");
        vm.expectRevert(
            abi.encodeWithSelector(BoneyCreRouter.WorkflowIdMismatch.selector, wrong, WORKFLOW_ID)
        );
        router.onReport(_metadata(wrong, OWNER), _encode(_cursorReport(0, 1, 0)));

        vm.expectRevert(
            abi.encodeWithSelector(BoneyCreRouter.WorkflowOwnerMismatch.selector, address(0xBAD), OWNER)
        );
        router.onReport(_metadata(WORKFLOW_ID, address(0xBAD)), _encode(_cursorReport(0, 1, 0)));

        BoneyCreRouter.CreReport memory malformed = _cursorReport(0, 1, 0);
        malformed.version = 1;
        vm.expectRevert(abi.encodeWithSelector(BoneyCreRouter.InvalidReportVersion.selector, 1));
        router.onReport(_metadata(), _encode(malformed));

        malformed = _cursorReport(1, 1, 0);
        vm.expectRevert(abi.encodeWithSelector(BoneyCreRouter.NonceMismatch.selector, 1, 0));
        router.onReport(_metadata(), _encode(malformed));

        malformed = _cursorReport(0, 1, 0);
        malformed.validUntil = uint64(block.timestamp - 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                BoneyCreRouter.ReportExpired.selector, uint64(block.timestamp - 1), uint64(block.timestamp)
            )
        );
        router.onReport(_metadata(), _encode(malformed));

        malformed = _cursorReport(0, 1, 0);
        malformed.validUntil = uint64(block.timestamp);
        bytes memory replay = _encode(malformed);
        router.onReport(_metadata(), replay);
        vm.expectRevert(abi.encodeWithSelector(BoneyCreRouter.NonceMismatch.selector, 0, 1));
        router.onReport(_metadata(), replay);
        vm.stopPrank();
    }

    function test_CursorOnlyRequiresAdvanceAndUpdatesCompositeCursor() public {
        BoneyCreRouter.CreReport memory empty = _cursorReport(0, 0, 0);
        vm.prank(FORWARDER);
        vm.expectRevert(BoneyCreRouter.EmptyReport.selector);
        router.onReport(_metadata(), _encode(empty));

        vm.prank(FORWARDER);
        router.onReport(_metadata(), _encode(_cursorReport(0, 7, 2)));
        assertEq(router.campaignCursor(), 7);
        assertEq(router.kpiCursor(), 2);
        assertEq(router.nonce(), 1);
    }

    function test_CompositeCursorRejectsBackwardMovement() public {
        _deliver(_cursorReport(0, 7, 2));

        vm.prank(FORWARDER);
        vm.expectRevert(abi.encodeWithSelector(BoneyCreRouter.CompositeCursorRegression.selector, 7, 2, 6, 9));
        router.onReport(_metadata(), _encode(_cursorReport(1, 6, 9)));

        vm.prank(FORWARDER);
        vm.expectRevert(abi.encodeWithSelector(BoneyCreRouter.CompositeCursorRegression.selector, 7, 2, 7, 1));
        router.onReport(_metadata(), _encode(_cursorReport(1, 7, 1)));
    }

    function test_EventMetricDirectAndUnguardedRoutesUseConfigEpoch() public {
        campaign.addKpi(address(0), false);
        eventMetric.configure(address(campaign), 0, true, 4);
        eventMetric.setObserved(address(campaign), 0, USER, 12);

        BoneyCreRouter.TargetScan[] memory targets = new BoneyCreRouter.TargetScan[](1);
        targets[0] = _target(address(campaign), 0, 4, 9, USER, 12, "");
        _deliver(_report(0, 1, 0, targets, _noAggregates(), _noIds()));

        assertEq(campaign.batchCalls(), 1);
        assertEq(campaign.receivedCount(), 1);
        (uint256 kpi, address user, uint256 total, bytes memory evidence) = campaign.received(0);
        assertEq(kpi, 0);
        assertEq(user, USER);
        assertEq(total, 12);
        assertEq(evidence.length, 0);
        assertEq(router.userCursorOf(address(campaign), 0, 4), 9);
    }

    function test_EventMetricRejectsUnconfiguredEpochAndOverclaim() public {
        campaign.addKpi(address(eventMetric), false);
        eventMetric.configure(address(campaign), 0, false, 4);
        BoneyCreRouter.TargetScan[] memory targets = new BoneyCreRouter.TargetScan[](1);
        targets[0] = _target(address(campaign), 0, 4, 1, USER, 1, "");
        vm.prank(FORWARDER);
        vm.expectRevert(
            abi.encodeWithSelector(BoneyCreRouter.EventMetricNotConfigured.selector, address(campaign), 0)
        );
        router.onReport(_metadata(), _encode(_report(0, 1, 0, targets, _noAggregates(), _noIds())));

        eventMetric.configure(address(campaign), 0, true, 5);
        eventMetric.setObserved(address(campaign), 0, USER, 5);
        vm.prank(FORWARDER);
        vm.expectRevert(abi.encodeWithSelector(BoneyCreRouter.ObservationEpochMismatch.selector, 4, 5));
        router.onReport(_metadata(), _encode(_report(0, 1, 0, targets, _noAggregates(), _noIds())));

        targets[0].observationEpoch = 5;
        targets[0].progress[0].newTotal = 6;
        vm.prank(FORWARDER);
        vm.expectRevert(abi.encodeWithSelector(BoneyCreRouter.ObservationBelowClaim.selector, 5, 6));
        router.onReport(_metadata(), _encode(_report(0, 1, 0, targets, _noAggregates(), _noIds())));
    }

    function test_GuardUsesCanonicalObservationAndSecondaryEvidenceMode() public {
        RouterAutomationMock secondary = new RouterAutomationMock();
        secondary.setCapability(IKpiAutomation.AutomationMode.USER_ACTIONS, address(secondary));
        RouterGuardMock guard = new RouterGuardMock(address(eventMetric));
        guard.setGuard(address(secondary), true);
        campaign.addKpi(address(guard), false);
        eventMetric.configure(address(campaign), 0, true, 2);
        eventMetric.setObserved(address(campaign), 0, USER, 8);

        BoneyCreRouter.TargetScan[] memory targets = new BoneyCreRouter.TargetScan[](1);
        targets[0] = _target(address(campaign), 0, 2, 1, USER, 8, "");
        vm.prank(FORWARDER);
        vm.expectRevert(
            abi.encodeWithSelector(BoneyCreRouter.EvidenceRequired.selector, address(campaign), 0)
        );
        router.onReport(_metadata(), _encode(_report(0, 1, 0, targets, _noAggregates(), _noIds())));

        targets[0].progress[0].evidence = hex"01";
        _deliver(_report(0, 1, 0, targets, _noAggregates(), _noIds()));
        assertEq(campaign.receivedCount(), 1);
    }

    function test_CustomUserRoutesValidateAdapterEpochAndEvidence() public {
        automation.setCapability(IKpiAutomation.AutomationMode.USER_EVIDENCE_FREE, address(automation));
        automation.setEpoch(7);
        automation.setUserObserved(USER, 20);
        campaign.addKpi(address(automation), false);

        BoneyCreRouter.TargetScan[] memory targets = new BoneyCreRouter.TargetScan[](1);
        targets[0] = _target(address(campaign), 0, 7, 2, USER, 20, hex"01");
        vm.prank(FORWARDER);
        vm.expectRevert(
            abi.encodeWithSelector(BoneyCreRouter.EvidenceNotAllowed.selector, address(campaign), 0)
        );
        router.onReport(_metadata(), _encode(_report(0, 1, 0, targets, _noAggregates(), _noIds())));

        automation.setCapability(IKpiAutomation.AutomationMode.USER_ACTIONS, address(automation));
        _deliver(_report(0, 1, 0, targets, _noAggregates(), _noIds()));
        assertEq(campaign.receivedCount(), 1);
    }

    function test_CustomUserRoutesFallbackAfterNonemptyGuardRevert() public {
        automation.setCapability(IKpiAutomation.AutomationMode.USER_EVIDENCE_FREE, address(automation));
        automation.setEpoch(9);
        automation.setUserObserved(USER, 21);
        campaign.addKpi(address(automation), false);

        BoneyCreRouter.TargetScan[] memory targets = new BoneyCreRouter.TargetScan[](1);
        targets[0] = _target(address(campaign), 0, 9, 3, USER, 21, "");
        _deliver(_report(0, 1, 0, targets, _noAggregates(), _noIds()));

        assertEq(campaign.receivedCount(), 1);
        assertEq(router.userCursorOf(address(campaign), 0, 9), 3);
    }

    function test_BoundsAndZeroProgressUser() public {
        BoneyCreRouter.TargetScan[] memory tooManyTargets = new BoneyCreRouter.TargetScan[](33);
        vm.prank(FORWARDER);
        vm.expectRevert(abi.encodeWithSelector(BoneyCreRouter.TooManyTargets.selector, 33, 32));
        router.onReport(_metadata(), _encode(_report(0, 1, 0, tooManyTargets, _noAggregates(), _noIds())));

        campaign.addKpi(address(eventMetric), false);
        eventMetric.configure(address(campaign), 0, true, 0);
        BoneyCreRouter.TargetScan[] memory targets = new BoneyCreRouter.TargetScan[](1);
        targets[0] = _target(address(campaign), 0, 0, 1, address(0), 1, "");
        vm.prank(FORWARDER);
        vm.expectRevert(BoneyCreRouter.ZeroProgressUser.selector);
        router.onReport(_metadata(), _encode(_report(0, 1, 0, targets, _noAggregates(), _noIds())));

        targets[0].progress = new BoneyCreRouter.Progress[](33);
        vm.prank(FORWARDER);
        vm.expectRevert(abi.encodeWithSelector(BoneyCreRouter.TooManyProgressItems.selector, 33, 32));
        router.onReport(_metadata(), _encode(_report(0, 1, 0, targets, _noAggregates(), _noIds())));

        bytes32[] memory tooManyOracleItems = new bytes32[](33);
        vm.prank(FORWARDER);
        vm.expectRevert(abi.encodeWithSelector(BoneyCreRouter.TooManyOracleItems.selector, 33, 32));
        router.onReport(
            _metadata(), _encode(_report(0, 1, 0, _noTargets(), _noAggregates(), tooManyOracleItems))
        );
    }

    function test_UnknownCampaignAndKpiRoutesRejected() public {
        RouterCampaignMock unknown = new RouterCampaignMock();
        unknown.addKpi(address(eventMetric), false);
        unknown.setAuthorized(address(router), true);
        eventMetric.configure(address(unknown), 0, true, 0);
        BoneyCreRouter.TargetScan[] memory targets = new BoneyCreRouter.TargetScan[](1);
        targets[0] = _emptyTarget(address(unknown), 0, 0, 1);
        vm.prank(FORWARDER);
        vm.expectRevert(abi.encodeWithSelector(BoneyCreRouter.UnknownCampaign.selector, address(unknown)));
        router.onReport(_metadata(), _encode(_report(0, 1, 0, targets, _noAggregates(), _noIds())));

        targets[0] = _emptyTarget(address(campaign), 0, 0, 1);
        vm.prank(FORWARDER);
        vm.expectRevert(abi.encodeWithSelector(BoneyCreRouter.UnknownKpi.selector, address(campaign), 0));
        router.onReport(_metadata(), _encode(_report(0, 1, 0, targets, _noAggregates(), _noIds())));
    }

    function test_TargetCursorOnlyAdvancesEpochScopedCursor() public {
        campaign.addKpi(address(eventMetric), false);
        eventMetric.configure(address(campaign), 0, true, 6);
        BoneyCreRouter.TargetScan[] memory targets = new BoneyCreRouter.TargetScan[](1);
        targets[0] = _emptyTarget(address(campaign), 0, 6, 11);
        _deliver(_report(0, 0, 0, targets, _noAggregates(), _noIds()));
        assertEq(router.userCursorOf(address(campaign), 0, 6), 11);
    }

    function test_NonAdvancingTargetCursorOnlyRejected() public {
        campaign.addKpi(address(eventMetric), false);
        eventMetric.configure(address(campaign), 0, true, 6);
        BoneyCreRouter.TargetScan[] memory targets = new BoneyCreRouter.TargetScan[](1);
        targets[0] = _emptyTarget(address(campaign), 0, 6, 0);
        vm.prank(FORWARDER);
        vm.expectRevert(
            abi.encodeWithSelector(
                BoneyCreRouter.UserCursorNotAdvanced.selector, address(campaign), 0, 6, 0, 0
            )
        );
        router.onReport(_metadata(), _encode(_report(0, 0, 0, targets, _noAggregates(), _noIds())));
    }

    function test_TargetCursorRejectsBackwardMovement() public {
        campaign.addKpi(address(eventMetric), false);
        eventMetric.configure(address(campaign), 0, true, 6);
        BoneyCreRouter.TargetScan[] memory targets = new BoneyCreRouter.TargetScan[](1);
        targets[0] = _emptyTarget(address(campaign), 0, 6, 11);
        _deliver(_report(0, 0, 0, targets, _noAggregates(), _noIds()));

        targets[0].nextUserCursor = 3;
        vm.prank(FORWARDER);
        vm.expectRevert(
            abi.encodeWithSelector(
                BoneyCreRouter.UserCursorNotAdvanced.selector, address(campaign), 0, 6, 11, 3
            )
        );
        router.onReport(_metadata(), _encode(_report(1, 0, 0, targets, _noAggregates(), _noIds())));
    }

    function test_TargetBoundsDuplicatesGroupingAndAuthorization() public {
        campaign.addKpi(address(eventMetric), false);
        eventMetric.configure(address(campaign), 0, true, 0);
        eventMetric.setObserved(address(campaign), 0, USER, 1);
        BoneyCreRouter.TargetScan[] memory targets = new BoneyCreRouter.TargetScan[](2);
        targets[0] = _target(address(campaign), 0, 0, 1, USER, 1, "");
        targets[1] = _target(address(campaign), 0, 0, 2, USER_TWO, 1, "");
        vm.prank(FORWARDER);
        vm.expectRevert(abi.encodeWithSelector(BoneyCreRouter.DuplicateTarget.selector, address(campaign), 0));
        router.onReport(_metadata(), _encode(_report(0, 1, 0, targets, _noAggregates(), _noIds())));

        campaign.setAuthorized(address(router), false);
        BoneyCreRouter.TargetScan[] memory one = new BoneyCreRouter.TargetScan[](1);
        one[0] = targets[0];
        vm.prank(FORWARDER);
        vm.expectRevert(
            abi.encodeWithSelector(BoneyCreRouter.UnauthorizedCampaign.selector, address(campaign))
        );
        router.onReport(_metadata(), _encode(_report(0, 1, 0, one, _noAggregates(), _noIds())));
    }

    function test_MultiCampaignGroupsPreserveOrderAndSkipEmptyGroup() public {
        RouterCampaignMock second = new RouterCampaignMock();
        second.addKpi(address(eventMetric), false);
        second.setAuthorized(address(router), true);
        registry.setCampaign(address(second), true);
        campaign.addKpi(address(eventMetric), false);
        eventMetric.configure(address(campaign), 0, true, 0);
        eventMetric.configure(address(second), 0, true, 0);
        eventMetric.setObserved(address(campaign), 0, USER, 3);
        eventMetric.setObserved(address(second), 0, USER_TWO, 4);

        BoneyCreRouter.TargetScan[] memory targets = new BoneyCreRouter.TargetScan[](3);
        targets[0] = _target(address(campaign), 0, 0, 1, USER, 3, "");
        targets[1] = _emptyTarget(address(campaign), 1, 0, 2);
        campaign.addKpi(address(eventMetric), false);
        eventMetric.configure(address(campaign), 1, true, 0);
        targets[2] = _target(address(second), 0, 0, 1, USER_TWO, 4, "");

        _deliver(_report(0, 1, 0, targets, _noAggregates(), _noIds()));
        assertEq(campaign.batchCalls(), 1);
        assertEq(second.batchCalls(), 1);
        assertEq(campaign.receivedCount(), 1);
        assertEq(second.receivedCount(), 1);
    }

    function test_NonContiguousCampaignRejected() public {
        RouterCampaignMock second = new RouterCampaignMock();
        second.addKpi(address(eventMetric), false);
        second.setAuthorized(address(router), true);
        registry.setCampaign(address(second), true);
        campaign.addKpi(address(eventMetric), false);
        campaign.addKpi(address(eventMetric), false);
        eventMetric.configure(address(campaign), 0, true, 0);
        eventMetric.configure(address(campaign), 1, true, 0);
        eventMetric.configure(address(second), 0, true, 0);

        BoneyCreRouter.TargetScan[] memory targets = new BoneyCreRouter.TargetScan[](3);
        targets[0] = _emptyTarget(address(campaign), 0, 0, 1);
        targets[1] = _emptyTarget(address(second), 0, 0, 1);
        targets[2] = _emptyTarget(address(campaign), 1, 0, 1);
        vm.prank(FORWARDER);
        vm.expectRevert(
            abi.encodeWithSelector(BoneyCreRouter.NonContiguousCampaign.selector, address(campaign))
        );
        router.onReport(_metadata(), _encode(_report(0, 1, 0, targets, _noAggregates(), _noIds())));
    }

    function test_AggregateRejectsTotalBelowCampaignProgress() public {
        campaign.addKpi(address(automation), true);
        campaign.setTotalProgress(0, 60);
        BoneyCreRouter.AggregateReport[] memory aggregates = new BoneyCreRouter.AggregateReport[](1);
        aggregates[0] = BoneyCreRouter.AggregateReport({
            campaign: address(campaign),
            kpiIndex: 0,
            observationEpoch: 3,
            newTotal: 50
        });

        vm.prank(FORWARDER);
        vm.expectRevert(abi.encodeWithSelector(BoneyCreRouter.AggregateBelowCampaign.selector, 60, 50));
        router.onReport(_metadata(), _encode(_report(0, 1, 0, _noTargets(), aggregates, _noIds())));
        assertEq(oracle.sequence(), 0);
        assertEq(router.nonce(), 0);
    }

    function test_AggregateRejectsShortOracleResultAndRollsBack() public {
        _expectOracleReportCountMismatch(0);
    }

    function test_AggregateRejectsLongOracleResultAndRollsBack() public {
        _expectOracleReportCountMismatch(2);
    }

    function test_AggregatePendingMatureApplyAndReplace() public {
        campaign.addKpi(address(automation), true);
        BoneyCreRouter.AggregateReport[] memory aggregates = new BoneyCreRouter.AggregateReport[](1);
        aggregates[0] = BoneyCreRouter.AggregateReport({
            campaign: address(campaign),
            kpiIndex: 0,
            observationEpoch: 3,
            newTotal: 50
        });
        _deliver(_report(0, 1, 0, _noTargets(), aggregates, _noIds()));
        bytes32 pending = router.pendingAggregateReportOf(address(campaign), 0);
        assertTrue(pending != bytes32(0));
        assertEq(oracle.reportAmount(pending), 50);

        vm.prank(FORWARDER);
        vm.expectRevert(
            abi.encodeWithSelector(
                BoneyCreRouter.PendingAggregateReport.selector, address(campaign), 0, pending
            )
        );
        router.onReport(_metadata(), _encode(_report(1, 2, 0, _noTargets(), aggregates, _noIds())));

        bytes32[] memory matured = new bytes32[](1);
        matured[0] = pending;
        aggregates[0].newTotal = 60;
        _deliver(_report(1, 2, 0, _noTargets(), aggregates, matured));
        assertTrue(oracle.applied(pending));
        bytes32 replacement = router.pendingAggregateReportOf(address(campaign), 0);
        assertTrue(replacement != pending);
        assertEq(oracle.reportAmount(replacement), 60);
    }

    function test_MaturedAggregateCannotBeReplacedBelowAppliedAmount() public {
        campaign.addKpi(address(automation), true);
        BoneyCreRouter.AggregateReport[] memory aggregates = new BoneyCreRouter.AggregateReport[](1);
        aggregates[0] = BoneyCreRouter.AggregateReport({
            campaign: address(campaign),
            kpiIndex: 0,
            observationEpoch: 3,
            newTotal: 100
        });
        _deliver(_report(0, 1, 0, _noTargets(), aggregates, _noIds()));

        bytes32 pending = router.pendingAggregateReportOf(address(campaign), 0);
        bytes32[] memory matured = new bytes32[](1);
        matured[0] = pending;
        aggregates[0].newTotal = 80;

        vm.prank(FORWARDER);
        vm.expectRevert(abi.encodeWithSelector(BoneyCreRouter.AggregateBelowCampaign.selector, 100, 80));
        router.onReport(_metadata(), _encode(_report(1, 2, 0, _noTargets(), aggregates, matured)));
        assertFalse(oracle.applied(pending));
        assertEq(router.pendingAggregateReportOf(address(campaign), 0), pending);
        assertEq(router.nonce(), 1);
    }

    function test_DisputedOrAppliedPendingCanBeReplacedWithoutApply() public {
        campaign.addKpi(address(automation), true);
        BoneyCreRouter.AggregateReport[] memory aggregates = new BoneyCreRouter.AggregateReport[](1);
        aggregates[0] = BoneyCreRouter.AggregateReport({
            campaign: address(campaign),
            kpiIndex: 0,
            observationEpoch: 3,
            newTotal: 50
        });
        _deliver(_report(0, 1, 0, _noTargets(), aggregates, _noIds()));
        bytes32 old = router.pendingAggregateReportOf(address(campaign), 0);
        oracle.setStatus(old, false, true);
        aggregates[0].newTotal = 70;
        _deliver(_report(1, 2, 0, _noTargets(), aggregates, _noIds()));
        assertTrue(router.pendingAggregateReportOf(address(campaign), 0) != old);
    }

    function test_UnknownMaturedIdRejected() public {
        bytes32[] memory matured = new bytes32[](1);
        matured[0] = keccak256("unknown");
        vm.prank(FORWARDER);
        vm.expectRevert(abi.encodeWithSelector(BoneyCreRouter.UnknownPendingReport.selector, matured[0]));
        router.onReport(_metadata(), _encode(_report(0, 1, 0, _noTargets(), _noAggregates(), matured)));
    }

    function test_CampaignAndOracleFailuresRollbackAllRouterState() public {
        campaign.addKpi(address(eventMetric), false);
        eventMetric.configure(address(campaign), 0, true, 0);
        eventMetric.setObserved(address(campaign), 0, USER, 5);
        BoneyCreRouter.TargetScan[] memory targets = new BoneyCreRouter.TargetScan[](1);
        targets[0] = _target(address(campaign), 0, 0, 8, USER, 5, "");
        campaign.setFailReports(true);
        vm.prank(FORWARDER);
        vm.expectRevert(RouterCampaignMock.ReportFailed.selector);
        router.onReport(_metadata(), _encode(_report(0, 9, 4, targets, _noAggregates(), _noIds())));
        assertEq(router.nonce(), 0);
        assertEq(router.campaignCursor(), 0);
        assertEq(router.userCursorOf(address(campaign), 0, 0), 0);

        campaign.setFailReports(false);
        RouterCampaignMock aggregateCampaign = new RouterCampaignMock();
        aggregateCampaign.addKpi(address(automation), true);
        aggregateCampaign.setAuthorized(address(router), true);
        registry.setCampaign(address(aggregateCampaign), true);
        BoneyCreRouter.AggregateReport[] memory aggregates = new BoneyCreRouter.AggregateReport[](1);
        aggregates[0] = BoneyCreRouter.AggregateReport({
            campaign: address(aggregateCampaign),
            kpiIndex: 0,
            observationEpoch: 3,
            newTotal: 1
        });
        oracle.setFailure(false, true);
        vm.prank(FORWARDER);
        vm.expectRevert(RouterOracleMock.ForcedFailure.selector);
        router.onReport(_metadata(), _encode(_report(0, 9, 4, targets, aggregates, _noIds())));
        assertEq(campaign.receivedCount(), 0);
        assertEq(router.nonce(), 0);
        assertEq(router.campaignCursor(), 0);
    }

    function _expectOracleReportCountMismatch(uint256 returnedCount) internal {
        campaign.addKpi(address(automation), true);
        oracle.setReturnedIdCount(returnedCount);
        BoneyCreRouter.AggregateReport[] memory aggregates = new BoneyCreRouter.AggregateReport[](1);
        aggregates[0] = BoneyCreRouter.AggregateReport({
            campaign: address(campaign),
            kpiIndex: 0,
            observationEpoch: 3,
            newTotal: 50
        });

        vm.prank(FORWARDER);
        vm.expectRevert(
            abi.encodeWithSelector(BoneyCreRouter.OracleReportCountMismatch.selector, returnedCount, 1)
        );
        router.onReport(_metadata(), _encode(_report(0, 1, 0, _noTargets(), aggregates, _noIds())));
        assertEq(oracle.sequence(), 0);
        assertEq(router.nonce(), 0);
        assertEq(router.campaignCursor(), 0);
        assertEq(router.pendingAggregateReportOf(address(campaign), 0), bytes32(0));
    }

    function _deliver(BoneyCreRouter.CreReport memory report) internal {
        vm.prank(FORWARDER);
        router.onReport(_metadata(), _encode(report));
    }

    function _report(
        uint64 expectedNonce,
        uint256 nextCampaignCursor,
        uint256 nextKpiCursor,
        BoneyCreRouter.TargetScan[] memory targets,
        BoneyCreRouter.AggregateReport[] memory aggregates,
        bytes32[] memory maturedIds
    ) internal view returns (BoneyCreRouter.CreReport memory) {
        return BoneyCreRouter.CreReport({
            version: 2,
            expectedNonce: expectedNonce,
            validUntil: uint64(block.timestamp + 1),
            nextCampaignCursor: nextCampaignCursor,
            nextKpiCursor: nextKpiCursor,
            targets: targets,
            aggregateReports: aggregates,
            maturedReportIds: maturedIds
        });
    }

    function _cursorReport(uint64 expectedNonce, uint256 nextCampaignCursor, uint256 nextKpiCursor)
        internal
        view
        returns (BoneyCreRouter.CreReport memory)
    {
        return
            _report(expectedNonce, nextCampaignCursor, nextKpiCursor, _noTargets(), _noAggregates(), _noIds());
    }

    function _target(
        address targetCampaign,
        uint256 kpiIndex,
        uint256 epoch,
        uint256 nextUserCursor,
        address user,
        uint256 total,
        bytes memory evidence
    ) internal pure returns (BoneyCreRouter.TargetScan memory) {
        BoneyCreRouter.Progress[] memory progress = new BoneyCreRouter.Progress[](1);
        progress[0] = BoneyCreRouter.Progress({user: user, newTotal: total, evidence: evidence});
        return BoneyCreRouter.TargetScan({
            campaign: targetCampaign,
            kpiIndex: kpiIndex,
            observationEpoch: epoch,
            nextUserCursor: nextUserCursor,
            progress: progress
        });
    }

    function _emptyTarget(address targetCampaign, uint256 kpiIndex, uint256 epoch, uint256 nextUserCursor)
        internal
        pure
        returns (BoneyCreRouter.TargetScan memory)
    {
        return BoneyCreRouter.TargetScan({
            campaign: targetCampaign,
            kpiIndex: kpiIndex,
            observationEpoch: epoch,
            nextUserCursor: nextUserCursor,
            progress: new BoneyCreRouter.Progress[](0)
        });
    }

    function _noTargets() internal pure returns (BoneyCreRouter.TargetScan[] memory) {
        return new BoneyCreRouter.TargetScan[](0);
    }

    function _noAggregates() internal pure returns (BoneyCreRouter.AggregateReport[] memory) {
        return new BoneyCreRouter.AggregateReport[](0);
    }

    function _noIds() internal pure returns (bytes32[] memory) {
        return new bytes32[](0);
    }

    function _encode(BoneyCreRouter.CreReport memory report) internal pure returns (bytes memory) {
        return abi.encode(report);
    }

    function _metadata() internal pure returns (bytes memory) {
        return _metadata(WORKFLOW_ID, OWNER);
    }

    function _metadata(bytes32 workflowId, address owner) internal pure returns (bytes memory) {
        return abi.encodePacked(workflowId, bytes10("boney-cre"), owner, bytes2(0));
    }
}
