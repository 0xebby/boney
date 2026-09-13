// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {BoneyCreReceiver} from "../src/automation/BoneyCreReceiver.sol";
import {Campaign} from "../src/campaign/Campaign.sol";
import {CampaignRegistry} from "../src/campaign/CampaignRegistry.sol";
import {EscrowVault} from "../src/escrow/EscrowVault.sol";
import {AttributionRegistry} from "../src/attribution/AttributionRegistry.sol";
import {AttestationVerifier} from "../src/reputation/AttestationVerifier.sol";
import {ReputationRegistry} from "../src/reputation/ReputationRegistry.sol";
import {EventMetricKpiVerifier} from "../src/verifiers/EventMetricKpiVerifier.sol";
import {GuardedKpiVerifier} from "../src/verifiers/GuardedKpiVerifier.sol";
import {IAttributionRegistry} from "../src/interfaces/IAttributionRegistry.sol";
import {IEventMetricKpiVerifier} from "../src/interfaces/IEventMetricKpiVerifier.sol";
import {IGuardedKpiVerifier} from "../src/interfaces/IGuardedKpiVerifier.sol";
import {ICampaign} from "../src/interfaces/ICampaign.sol";
import {IReceiver} from "../src/interfaces/IReceiver.sol";
import {Types} from "../src/libraries/Types.sol";

contract CreGuardMock {
    address public boneyVerifier;
    address public projectVerifier;
    bool public configured = true;

    constructor(address boneyVerifier_) {
        boneyVerifier = boneyVerifier_;
    }

    function setProjectVerifier(address verifier) external {
        projectVerifier = verifier;
    }

    function setConfigured(bool configured_) external {
        configured = configured_;
    }

    function guardOf(address, uint256) external view returns (address, uint16, uint8, bool) {
        return (projectVerifier, 0, 0, configured);
    }
}

contract CreCampaignMock {
    Types.KpiSpec private _spec;
    uint256 public count = 1;
    mapping(address => bool) public authorized;
    address public lastUser;
    uint256 public lastTotal;
    bool public failReports;

    error Unauthorized();
    error ReportFailed();

    constructor(address verifier) {
        _spec = Types.KpiSpec({
            kind: Types.KpiKind.Custom,
            verifier: verifier,
            target: 1,
            aggregate: false,
            params: ""
        });
    }

    function setAggregate(bool aggregate) external {
        _spec.aggregate = aggregate;
    }

    function setVerifier(address verifier) external {
        _spec.verifier = verifier;
    }

    function setCount(uint256 count_) external {
        count = count_;
    }

    function setAuthorized(address reporter, bool allowed) external {
        authorized[reporter] = allowed;
    }

    function setFailReports(bool fail) external {
        failReports = fail;
    }

    function kpiCount() external view returns (uint256) {
        return count;
    }

    function kpi(uint256) external view returns (Types.KpiSpec memory) {
        return _spec;
    }

    function reportUserAction(uint256, address user, uint256 newTotal, bytes calldata) external {
        if (!authorized[msg.sender]) revert Unauthorized();
        if (failReports) revert ReportFailed();
        lastUser = user;
        lastTotal = newTotal;
    }
}

contract CreToken is ERC20 {
    constructor() ERC20("CRE", "CRE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract BoneyCreReceiverIntegrationTest is Test {
    uint256 internal constant POOL = 1_000 ether;
    address internal constant FORWARDER = address(0xF0);
    address internal constant PROJECT = address(0xC0DE);
    address internal constant PROMOTER = address(0xC01);
    address internal constant REPORTER = address(0xBEEF);
    uint256 internal constant USER_PK = 0x5EED;

    CreToken internal token;
    EscrowVault internal vault;
    AttributionRegistry internal attribution;
    Campaign internal campaign;
    EventMetricKpiVerifier internal eventVerifier;
    GuardedKpiVerifier internal guard;
    BoneyCreReceiver internal receiver;
    address internal user;

    function setUp() public {
        vm.warp(1_000_000);
        user = vm.addr(USER_PK);

        token = new CreToken();
        attribution = new AttributionRegistry(30 days);
        AttestationVerifier attestation = new AttestationVerifier(address(this), address(this));
        ReputationRegistry reputation = new ReputationRegistry(address(this), address(attestation));
        vault = new EscrowVault(address(this));
        CampaignRegistry registry =
            new CampaignRegistry(address(vault), address(reputation), address(attribution), address(0x0BAC));
        vault.setRegistrar(address(registry));

        eventVerifier = new EventMetricKpiVerifier(address(this), REPORTER);
        guard = new GuardedKpiVerifier(address(this), address(eventVerifier));
        campaign = _createCampaign(registry);
        guard.setGuardConfig(address(campaign), 0, address(0), 0, IGuardedKpiVerifier.Mode.AGREE);
        eventVerifier.setKpiConfig(
            address(campaign),
            0,
            address(0xDEAD),
            "Deposit(address indexed user, uint256 amount)",
            0,
            IEventMetricKpiVerifier.Aggregation.SUM,
            1,
            1,
            block.number,
            block.number + 1_000
        );

        receiver = new BoneyCreReceiver(
            FORWARDER, ICampaign(address(campaign)), 0, address(eventVerifier), false, bytes32(0), address(0)
        );
        vm.prank(PROJECT);
        campaign.setAuthorizedReporter(address(receiver), true);

        _activateAndAttribute();
    }

    function test_ReceiverCreditsOnlyObservedProgressAndSettlesTier() public {
        vm.prank(REPORTER);
        eventVerifier.reportVerifiedTotal(address(campaign), 0, user, 12);

        uint256 before = token.balanceOf(PROMOTER);
        vm.prank(FORWARDER);
        receiver.onReport("", _report(0, 1, user, 50, true));

        assertEq(campaign.userCreditedOf(user, 0), 12);
        assertEq(campaign.progressOf(PROMOTER, 0), 12);
        assertEq(token.balanceOf(PROMOTER) - before, 100 ether);
        assertEq(receiver.cursor(), 1);
        assertEq(receiver.nonce(), 1);
    }

    function test_ReceiverRejectsMissingAttributionWithoutAdvancingState() public {
        address unattributed = address(0xBAD);
        vm.prank(REPORTER);
        eventVerifier.reportVerifiedTotal(address(campaign), 0, unattributed, 5);

        vm.prank(FORWARDER);
        vm.expectRevert(abi.encodeWithSelector(ICampaign.NoAttribution.selector, unattributed));
        receiver.onReport("", _report(0, 1, unattributed, 5, true));

        assertEq(receiver.cursor(), 0);
        assertEq(receiver.nonce(), 0);
    }

    function _createCampaign(CampaignRegistry registry) internal returns (Campaign created) {
        Types.CampaignConfig memory cfg = Types.CampaignConfig({
            project: PROJECT,
            name: "CRE Integration",
            token: address(token),
            rewardPool: POOL,
            startTime: uint64(block.timestamp),
            endTime: uint64(block.timestamp + 30 days),
            attributionWindow: 7 days,
            minReputation: 0
        });
        Types.KpiSpec[] memory kpis = new Types.KpiSpec[](1);
        kpis[0] = Types.KpiSpec({
            kind: Types.KpiKind.Deposit,
            verifier: address(guard),
            target: 100,
            aggregate: false,
            params: ""
        });
        Types.RewardTier[][] memory tiers = new Types.RewardTier[][](1);
        tiers[0] = new Types.RewardTier[](1);
        tiers[0][0] = Types.RewardTier({threshold: 10, reward: 100 ether});
        (, address deployed) = registry.createCampaign(cfg, kpis, tiers);
        return Campaign(deployed);
    }

    function _activateAndAttribute() internal {
        token.mint(PROJECT, POOL);
        vm.startPrank(PROJECT);
        token.approve(address(vault), POOL);
        vault.deposit(address(campaign), POOL);
        campaign.activate();
        vm.stopPrank();

        vm.prank(PROMOTER);
        bytes32 promoterId = campaign.join();
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
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(USER_PK, digest);
        attribution.storeTouch(user, touch, abi.encodePacked(r, s, v), user);
    }

    function _report(
        uint64 expectedNonce,
        uint256 nextCursor,
        address reportUser,
        uint256 newTotal,
        bool applyProgress
    ) internal view returns (bytes memory) {
        return abi.encode(
            BoneyCreReceiver.CreReport({
                version: 1,
                expectedNonce: expectedNonce,
                validUntil: uint64(block.timestamp + 1),
                nextCursor: nextCursor,
                user: reportUser,
                newTotal: newTotal,
                applyProgress: applyProgress
            })
        );
    }
}

contract BoneyCreReceiverTest is Test {
    address internal constant FORWARDER = address(0xF0);
    address internal constant EVENT_VERIFIER = address(0xE1);
    address internal constant USER = address(0xA11CE);
    address internal constant WORKFLOW_OWNER = address(0xBEEF);
    bytes32 internal constant WORKFLOW_ID = keccak256("boney-cre");

    CreGuardMock internal guard;
    CreCampaignMock internal campaign;
    BoneyCreReceiver internal receiver;

    function setUp() public {
        vm.warp(1_000_000);
        guard = new CreGuardMock(EVENT_VERIFIER);
        campaign = new CreCampaignMock(address(guard));
        receiver = _deploy(false, bytes32(0), address(0));
        campaign.setAuthorized(address(receiver), true);
    }

    function test_ConstructorStoresTargetAndPolicy() public view {
        assertEq(receiver.forwarder(), FORWARDER);
        assertEq(address(receiver.campaign()), address(campaign));
        assertEq(receiver.kpiIndex(), 0);
        assertEq(receiver.eventMetricVerifier(), EVENT_VERIFIER);
        assertFalse(receiver.production());
    }

    function test_SupportsReceiverAndErc165() public view {
        assertTrue(receiver.supportsInterface(type(IReceiver).interfaceId));
        assertTrue(receiver.supportsInterface(type(IERC165).interfaceId));
        assertFalse(receiver.supportsInterface(0xffffffff));
    }

    function test_ConstructorRejectsZeroAddresses() public {
        vm.expectRevert(BoneyCreReceiver.ZeroAddress.selector);
        new BoneyCreReceiver(
            address(0), ICampaign(address(campaign)), 0, EVENT_VERIFIER, false, bytes32(0), address(0)
        );

        vm.expectRevert(BoneyCreReceiver.ZeroAddress.selector);
        new BoneyCreReceiver(
            FORWARDER, ICampaign(address(0)), 0, EVENT_VERIFIER, false, bytes32(0), address(0)
        );

        vm.expectRevert(BoneyCreReceiver.ZeroAddress.selector);
        new BoneyCreReceiver(
            FORWARDER, ICampaign(address(campaign)), 0, address(0), false, bytes32(0), address(0)
        );
    }

    function test_ConstructorRejectsIncompleteProductionIdentity() public {
        vm.expectRevert(BoneyCreReceiver.InvalidWorkflowIdentity.selector);
        _deploy(true, bytes32(0), WORKFLOW_OWNER);

        vm.expectRevert(BoneyCreReceiver.InvalidWorkflowIdentity.selector);
        _deploy(true, WORKFLOW_ID, address(0));
    }

    function test_ConstructorRejectsUnknownOrAggregateKpi() public {
        campaign.setCount(0);
        vm.expectRevert(abi.encodeWithSelector(BoneyCreReceiver.UnknownKpi.selector, 0));
        _deploy(false, bytes32(0), address(0));

        campaign.setCount(1);
        campaign.setAggregate(true);
        vm.expectRevert(abi.encodeWithSelector(BoneyCreReceiver.AggregateKpi.selector, 0));
        _deploy(false, bytes32(0), address(0));
    }

    function test_ConstructorRejectsUnguardedOrWrongCanonicalVerifier() public {
        campaign.setVerifier(address(0));
        vm.expectRevert(abi.encodeWithSelector(BoneyCreReceiver.IncompatibleVerifier.selector, address(0)));
        _deploy(false, bytes32(0), address(0));

        campaign.setVerifier(address(guard));
        vm.expectRevert(
            abi.encodeWithSelector(BoneyCreReceiver.IncompatibleVerifier.selector, address(guard))
        );
        new BoneyCreReceiver(
            FORWARDER, ICampaign(address(campaign)), 0, address(0xBAD), false, bytes32(0), address(0)
        );
    }

    function test_ConstructorRejectsUnconfiguredOrEvidenceGuard() public {
        guard.setConfigured(false);
        vm.expectRevert(
            abi.encodeWithSelector(BoneyCreReceiver.GuardNotConfigured.selector, address(campaign), 0)
        );
        _deploy(false, bytes32(0), address(0));

        guard.setConfigured(true);
        guard.setProjectVerifier(address(0xCAFE));
        vm.expectRevert(
            abi.encodeWithSelector(BoneyCreReceiver.ProjectVerifierRequiresEvidence.selector, address(0xCAFE))
        );
        _deploy(false, bytes32(0), address(0));
    }

    function test_OnReportRejectsNonForwarder() public {
        vm.expectRevert(abi.encodeWithSelector(BoneyCreReceiver.NotForwarder.selector, address(this)));
        receiver.onReport("", _report(0, block.timestamp + 1, 1, USER, 5, true));
    }

    function test_SimulationAppliesProgressAndAdvancesState() public {
        vm.prank(FORWARDER);
        receiver.onReport(hex"deadbeef", _report(0, block.timestamp + 1, 7, USER, 5, true));

        assertEq(campaign.lastUser(), USER);
        assertEq(campaign.lastTotal(), 5);
        assertEq(receiver.cursor(), 7);
        assertEq(receiver.nonce(), 1);
    }

    function test_OnReportRejectsMalformedVersionNonceAndExpiry() public {
        vm.startPrank(FORWARDER);

        vm.expectRevert(abi.encodeWithSelector(BoneyCreReceiver.InvalidReportVersion.selector, 2));
        receiver.onReport("", _reportVersion(2, 0, block.timestamp + 1, 1, USER, 5, true));

        vm.expectRevert(abi.encodeWithSelector(BoneyCreReceiver.NonceMismatch.selector, 1, 0));
        receiver.onReport("", _report(1, block.timestamp + 1, 1, USER, 5, true));

        vm.expectRevert(
            abi.encodeWithSelector(
                BoneyCreReceiver.ReportExpired.selector, uint64(block.timestamp - 1), uint64(block.timestamp)
            )
        );
        receiver.onReport("", _report(0, block.timestamp - 1, 1, USER, 5, true));
        vm.stopPrank();
    }

    function test_OnReportRejectsInvalidProgressAndCursorOnlyShapes() public {
        vm.startPrank(FORWARDER);
        vm.expectRevert(BoneyCreReceiver.InvalidProgressReport.selector);
        receiver.onReport("", _report(0, block.timestamp + 1, 1, address(0), 5, true));

        vm.expectRevert(BoneyCreReceiver.InvalidCursorOnlyReport.selector);
        receiver.onReport("", _report(0, block.timestamp + 1, 1, USER, 0, false));

        vm.expectRevert(BoneyCreReceiver.InvalidCursorOnlyReport.selector);
        receiver.onReport("", _report(0, block.timestamp + 1, 1, address(0), 1, false));
        vm.stopPrank();
    }

    function test_CursorOnlyAdvancesWithoutCampaignCall() public {
        vm.prank(FORWARDER);
        receiver.onReport("", _report(0, block.timestamp + 1, 13, address(0), 0, false));

        assertEq(campaign.lastUser(), address(0));
        assertEq(receiver.cursor(), 13);
        assertEq(receiver.nonce(), 1);
    }

    function test_ReplayRejected() public {
        bytes memory report = _report(0, block.timestamp + 1, 2, USER, 5, true);
        vm.prank(FORWARDER);
        receiver.onReport("", report);

        vm.prank(FORWARDER);
        vm.expectRevert(abi.encodeWithSelector(BoneyCreReceiver.NonceMismatch.selector, 0, 1));
        receiver.onReport("", report);
    }

    function test_CampaignRevertRollsBackCursorAndNonce() public {
        campaign.setFailReports(true);
        vm.prank(FORWARDER);
        vm.expectRevert(CreCampaignMock.ReportFailed.selector);
        receiver.onReport("", _report(0, block.timestamp + 1, 9, USER, 5, true));

        assertEq(receiver.cursor(), 0);
        assertEq(receiver.nonce(), 0);
    }

    function test_ProductionAcceptsMatchingMetadata() public {
        BoneyCreReceiver productionReceiver = _deploy(true, WORKFLOW_ID, WORKFLOW_OWNER);
        campaign.setAuthorized(address(productionReceiver), true);

        vm.prank(FORWARDER);
        productionReceiver.onReport(
            _metadata(WORKFLOW_ID, WORKFLOW_OWNER), _report(0, block.timestamp + 1, 1, USER, 5, true)
        );

        assertEq(campaign.lastTotal(), 5);
    }

    function test_ProductionRejectsMetadataLengthIdAndOwner() public {
        BoneyCreReceiver productionReceiver = _deploy(true, WORKFLOW_ID, WORKFLOW_OWNER);
        vm.startPrank(FORWARDER);

        vm.expectRevert(abi.encodeWithSelector(BoneyCreReceiver.InvalidMetadataLength.selector, 0));
        productionReceiver.onReport("", _report(0, block.timestamp + 1, 1, USER, 5, true));

        bytes32 wrongId = keccak256("wrong");
        vm.expectRevert(
            abi.encodeWithSelector(BoneyCreReceiver.WorkflowIdMismatch.selector, wrongId, WORKFLOW_ID)
        );
        productionReceiver.onReport(
            _metadata(wrongId, WORKFLOW_OWNER), _report(0, block.timestamp + 1, 1, USER, 5, true)
        );

        address wrongOwner = address(0xBAD);
        vm.expectRevert(
            abi.encodeWithSelector(
                BoneyCreReceiver.WorkflowOwnerMismatch.selector, wrongOwner, WORKFLOW_OWNER
            )
        );
        productionReceiver.onReport(
            _metadata(WORKFLOW_ID, wrongOwner), _report(0, block.timestamp + 1, 1, USER, 5, true)
        );
        vm.stopPrank();
    }

    function test_RevocationBlocksProgressAndRollsBack() public {
        campaign.setAuthorized(address(receiver), false);
        vm.prank(FORWARDER);
        vm.expectRevert(CreCampaignMock.Unauthorized.selector);
        receiver.onReport("", _report(0, block.timestamp + 1, 3, USER, 5, true));

        assertEq(receiver.cursor(), 0);
        assertEq(receiver.nonce(), 0);
    }

    function _deploy(bool production, bytes32 workflowId, address workflowOwner)
        internal
        returns (BoneyCreReceiver)
    {
        return new BoneyCreReceiver(
            FORWARDER, ICampaign(address(campaign)), 0, EVENT_VERIFIER, production, workflowId, workflowOwner
        );
    }

    function _report(
        uint64 expectedNonce,
        uint256 validUntil,
        uint256 nextCursor,
        address reportUser,
        uint256 newTotal,
        bool applyProgress
    ) internal pure returns (bytes memory) {
        return _reportVersion(1, expectedNonce, validUntil, nextCursor, reportUser, newTotal, applyProgress);
    }

    function _reportVersion(
        uint8 version,
        uint64 expectedNonce,
        uint256 validUntil,
        uint256 nextCursor,
        address reportUser,
        uint256 newTotal,
        bool applyProgress
    ) internal pure returns (bytes memory) {
        return abi.encode(
            BoneyCreReceiver.CreReport({
                version: version,
                expectedNonce: expectedNonce,
                validUntil: uint64(validUntil),
                nextCursor: nextCursor,
                user: reportUser,
                newTotal: newTotal,
                applyProgress: applyProgress
            })
        );
    }

    function _metadata(bytes32 workflowId, address workflowOwner) internal pure returns (bytes memory) {
        return abi.encodePacked(workflowId, bytes10("boney-cre"), workflowOwner, bytes2(0));
    }
}
