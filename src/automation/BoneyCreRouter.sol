// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {ICampaign} from "../interfaces/ICampaign.sol";
import {ICampaignRegistry} from "../interfaces/ICampaignRegistry.sol";
import {IOracleCoordinator} from "../interfaces/IOracleCoordinator.sol";
import {IReceiver} from "../interfaces/IReceiver.sol";
import {
    IEventMetricAutomation,
    IGuardedAutomation,
    IKpiAutomation,
    IKpiAutomationObservation
} from "../interfaces/IKpiAutomation.sol";
import {Types} from "../libraries/Types.sol";

/// @title BoneyCreRouter
/// @notice Routes one production CRE workflow across protocol campaigns.
contract BoneyCreRouter is IReceiver, ERC165 {
    /// @notice Official production Keystone forwarder.
    address public constant OFFICIAL_FORWARDER = 0xF8344CFd5c43616a4366C34E3EEE75af79a74482;
    /// @notice Current report encoding version.
    uint8 public constant REPORT_VERSION = 2;
    /// @notice Maximum target cursor updates per report.
    uint256 public constant MAX_TARGETS = 32;
    /// @notice Maximum user progress items per report.
    uint256 public constant MAX_PROGRESS = 32;
    /// @notice Maximum aggregate submissions and applications per report.
    uint256 public constant MAX_ORACLE_ITEMS = 32;

    /// @notice One cumulative user-progress claim.
    struct Progress {
        address user;
        uint256 newTotal;
        bytes evidence;
    }

    /// @notice One KPI scan result and next user cursor.
    struct TargetScan {
        address campaign;
        uint256 kpiIndex;
        uint256 observationEpoch;
        uint256 nextUserCursor;
        Progress[] progress;
    }

    /// @notice One campaign-level aggregate claim.
    struct AggregateReport {
        address campaign;
        uint256 kpiIndex;
        uint256 observationEpoch;
        uint256 newTotal;
    }

    /// @notice One workflow delivery.
    struct CreReport {
        uint8 version;
        uint64 expectedNonce;
        uint64 validUntil;
        uint256 nextCampaignCursor;
        uint256 nextKpiCursor;
        TargetScan[] targets;
        AggregateReport[] aggregateReports;
        bytes32[] maturedReportIds;
    }

    /// @notice Official production Keystone forwarder.
    address public immutable forwarder;
    /// @notice Immutable coordinator for aggregate reports.
    IOracleCoordinator public immutable oracleCoordinator;
    /// @notice Canonical EventMetric verifier.
    address public immutable eventMetricVerifier;
    /// @notice Workflow ID accepted in metadata.
    bytes32 public immutable expectedWorkflowId;
    /// @notice Workflow owner accepted in metadata.
    address public immutable expectedWorkflowOwner;
    /// @notice Account permitted to bind the registry once.
    address public immutable registryBinder;
    /// @notice Bound campaign registry.
    ICampaignRegistry public campaignRegistry;

    /// @notice Next campaign position scanned by the workflow.
    uint256 public campaignCursor;
    /// @notice Next KPI position scanned by the workflow.
    uint256 public kpiCursor;
    /// @notice Number consumed by the next accepted report.
    uint64 public nonce;

    uint256 private constant PENDING_DEFER = 0;
    uint256 private constant PENDING_APPLY = 1;
    uint256 private constant PENDING_CLEAR = 2;

    mapping(bytes32 => uint256) private _userCursor;
    mapping(bytes32 => bytes32) private _pendingAggregate;
    mapping(bytes32 => uint256) private _pendingAggregateAmount;
    mapping(bytes32 => bytes32) private _aggregateKeyByReportId;

    error ZeroAddress();
    error NotOfficialForwarder(address provided);
    error InvalidWorkflowIdentity();
    error NotRegistryBinder(address caller);
    error RegistryAlreadySet();
    error RegistryNotSet();
    error RegistryTopologyMismatch();
    error NotForwarder(address caller);
    error InvalidMetadataLength(uint256 provided);
    error WorkflowIdMismatch(bytes32 provided, bytes32 expected);
    error WorkflowOwnerMismatch(address provided, address expected);
    error InvalidReportVersion(uint8 provided);
    error NonceMismatch(uint64 provided, uint64 expected);
    error ReportExpired(uint64 validUntil, uint64 nowTs);
    error NonceOverflow();
    error TooManyTargets(uint256 provided, uint256 max);
    error TooManyProgressItems(uint256 provided, uint256 max);
    error TooManyOracleItems(uint256 provided, uint256 max);
    error EmptyReport();
    error CompositeCursorRegression(
        uint256 campaignCursor, uint256 kpiCursor, uint256 nextCampaignCursor, uint256 nextKpiCursor
    );
    error UserCursorNotAdvanced(
        address campaign, uint256 kpiIndex, uint256 observationEpoch, uint256 current, uint256 provided
    );
    error InvalidCursorOnlyReport();
    error ZeroProgressUser();
    error DuplicateTarget(address campaign, uint256 kpiIndex);
    error NonContiguousCampaign(address campaign);
    error UnknownCampaign(address campaign);
    error UnauthorizedCampaign(address campaign);
    error UnknownKpi(address campaign, uint256 kpiIndex);
    error WrongKpiRoute(address campaign, uint256 kpiIndex);
    error UnsupportedAutomation(address verifier);
    error InvalidObservationAdapter(address adapter);
    error AggregateBelowCampaign(uint256 current, uint256 provided);
    error OracleReportCountMismatch(uint256 provided, uint256 expected);
    error EventMetricNotConfigured(address campaign, uint256 kpiIndex);
    error ObservationEpochMismatch(uint256 provided, uint256 expected);
    error ObservationBelowClaim(uint256 observed, uint256 claimed);
    error EvidenceNotAllowed(address campaign, uint256 kpiIndex);
    error EvidenceRequired(address campaign, uint256 kpiIndex);
    error PendingAggregateReport(address campaign, uint256 kpiIndex, bytes32 reportId);
    error UnknownPendingReport(bytes32 reportId);

    /// @notice Emitted when the registry is bound.
    /// @param registry The accepted registry.
    event CampaignRegistrySet(address indexed registry);

    /// @notice Emitted after one workflow report advances router state.
    /// @param consumedNonce Nonce consumed by the report.
    /// @param campaignCursor Next campaign cursor.
    /// @param kpiCursor Next KPI cursor.
    event CreReportProcessed(uint64 indexed consumedNonce, uint256 campaignCursor, uint256 kpiCursor);

    /// @notice Deploy the production router and capture its registry binder.
    /// @param forwarder_ Official production Keystone forwarder.
    /// @param eventMetricVerifier_ Canonical EventMetric verifier.
    /// @param oracleCoordinator_ Coordinator for aggregate reports.
    /// @param workflowId_ Exact workflow ID accepted in metadata.
    /// @param workflowOwner_ Exact workflow owner accepted in metadata.
    constructor(
        address forwarder_,
        address eventMetricVerifier_,
        IOracleCoordinator oracleCoordinator_,
        bytes32 workflowId_,
        address workflowOwner_
    ) {
        if (forwarder_ != OFFICIAL_FORWARDER) revert NotOfficialForwarder(forwarder_);
        if (
            eventMetricVerifier_ == address(0) || address(oracleCoordinator_) == address(0)
                || workflowOwner_ == address(0)
        ) revert ZeroAddress();
        if (workflowId_ == bytes32(0)) revert InvalidWorkflowIdentity();

        forwarder = forwarder_;
        eventMetricVerifier = eventMetricVerifier_;
        oracleCoordinator = oracleCoordinator_;
        expectedWorkflowId = workflowId_;
        expectedWorkflowOwner = workflowOwner_;
        registryBinder = msg.sender;
    }

    /// @notice Bind the protocol registry exactly once.
    /// @param registry_ Registry whose topology must name this router and coordinator.
    function setCampaignRegistry(ICampaignRegistry registry_) external {
        if (msg.sender != registryBinder) revert NotRegistryBinder(msg.sender);
        if (address(campaignRegistry) != address(0)) revert RegistryAlreadySet();
        if (address(registry_) == address(0)) revert ZeroAddress();
        if (
            registry_.automatedReporter() != address(this)
                || registry_.oracleCoordinator() != address(oracleCoordinator)
                || oracleCoordinator.campaignContract() != address(registry_)
                || !oracleCoordinator.isReporter(address(this))
        ) revert RegistryTopologyMismatch();
        campaignRegistry = registry_;
        emit CampaignRegistrySet(address(registry_));
    }

    /// @notice Return one epoch-scoped target cursor.
    /// @param campaign Campaign the target belongs to.
    /// @param kpiIndex Index of the KPI within the campaign.
    /// @param observationEpoch Observation generation.
    /// @return The stored next-user cursor.
    function userCursorOf(address campaign, uint256 kpiIndex, uint256 observationEpoch)
        external
        view
        returns (uint256)
    {
        return _userCursor[_userCursorKey(campaign, kpiIndex, observationEpoch)];
    }

    /// @notice Return the pending aggregate report for one KPI.
    /// @param campaign Campaign the KPI belongs to.
    /// @param kpiIndex Index of the KPI within the campaign.
    /// @return The pending report ID, or zero.
    function pendingAggregateReportOf(address campaign, uint256 kpiIndex) external view returns (bytes32) {
        return _pendingAggregate[_targetKey(campaign, kpiIndex)];
    }

    /// @inheritdoc IReceiver
    function onReport(bytes calldata metadata, bytes calldata report) external {
        if (msg.sender != forwarder) revert NotForwarder(msg.sender);
        if (address(campaignRegistry) == address(0)) revert RegistryNotSet();
        _validateMetadata(metadata);

        CreReport memory decoded = abi.decode(report, (CreReport));
        _validateEnvelope(decoded);

        (bytes32[] memory maturedKeys, bytes32[] memory applyIds, bool[] memory clearMatured) =
            _resolveMatured(decoded.maturedReportIds);
        IOracleCoordinator.Report[] memory oracleReports =
            new IOracleCoordinator.Report[](decoded.aggregateReports.length);
        bytes32[] memory aggregateKeys = new bytes32[](decoded.aggregateReports.length);

        _validateTargets(decoded.targets);
        _validateAggregates(
            decoded.aggregateReports, decoded.maturedReportIds, maturedKeys, oracleReports, aggregateKeys
        );

        _applyTargetGroups(decoded.targets);
        if (applyIds.length != 0) oracleCoordinator.applyReports(applyIds);

        bytes32[] memory newReportIds;
        if (oracleReports.length != 0) {
            newReportIds = oracleCoordinator.submitReports(oracleReports);
            if (newReportIds.length != oracleReports.length) {
                revert OracleReportCountMismatch(newReportIds.length, oracleReports.length);
            }
        }

        _writeBusinessState(decoded, maturedKeys, clearMatured, aggregateKeys, newReportIds);
    }

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId) public view override(IERC165, ERC165) returns (bool) {
        return interfaceId == type(IReceiver).interfaceId || super.supportsInterface(interfaceId);
    }

    /// @dev Validate envelope-level invariants.
    /// @param report Decoded workflow report.
    function _validateEnvelope(CreReport memory report) private view {
        if (report.version != REPORT_VERSION) revert InvalidReportVersion(report.version);
        if (report.expectedNonce != nonce) revert NonceMismatch(report.expectedNonce, nonce);
        if (report.validUntil < block.timestamp) {
            revert ReportExpired(report.validUntil, uint64(block.timestamp));
        }
        if (nonce == type(uint64).max) revert NonceOverflow();
        if (report.targets.length > MAX_TARGETS) revert TooManyTargets(report.targets.length, MAX_TARGETS);

        uint256 oracleItems = report.aggregateReports.length + report.maturedReportIds.length;
        if (oracleItems > MAX_ORACLE_ITEMS) revert TooManyOracleItems(oracleItems, MAX_ORACLE_ITEMS);

        uint256 progressCount;
        bool targetCursorAdvanced;
        for (uint256 i; i < report.targets.length; ++i) {
            TargetScan memory target = report.targets[i];
            progressCount += target.progress.length;
            uint256 current =
                _userCursor[_userCursorKey(target.campaign, target.kpiIndex, target.observationEpoch)];
            if (target.nextUserCursor <= current) {
                revert UserCursorNotAdvanced(
                    target.campaign, target.kpiIndex, target.observationEpoch, current, target.nextUserCursor
                );
            }
            targetCursorAdvanced = true;
        }
        if (progressCount > MAX_PROGRESS) revert TooManyProgressItems(progressCount, MAX_PROGRESS);

        bool downstream = progressCount != 0 || oracleItems != 0;
        bool compositeAdvanced = _validateCompositeCursor(report.nextCampaignCursor, report.nextKpiCursor);
        if (!downstream && !compositeAdvanced && !targetCursorAdvanced) {
            if (report.targets.length == 0) revert EmptyReport();
            revert InvalidCursorOnlyReport();
        }
    }

    /// @dev Validate the absolute composite discovery cursor.
    /// @param nextCampaignCursor Next absolute campaign position.
    /// @param nextKpiCursor Next KPI position within that campaign.
    /// @return advanced True when the cursor moves forward.
    function _validateCompositeCursor(uint256 nextCampaignCursor, uint256 nextKpiCursor)
        private
        view
        returns (bool advanced)
    {
        if (
            nextCampaignCursor < campaignCursor
                || (nextCampaignCursor == campaignCursor && nextKpiCursor < kpiCursor)
        ) {
            revert CompositeCursorRegression(campaignCursor, kpiCursor, nextCampaignCursor, nextKpiCursor);
        }
        return nextCampaignCursor != campaignCursor || nextKpiCursor != kpiCursor;
    }

    /// @dev Validate ordered target scans and route every progress item.
    /// @param targets Target scans in workflow order.
    function _validateTargets(TargetScan[] memory targets) private view {
        uint256 length = targets.length;
        for (uint256 i; i < length; ++i) {
            TargetScan memory target = targets[i];
            _requireCampaign(target.campaign);

            for (uint256 j; j < i; ++j) {
                if (targets[j].campaign == target.campaign && targets[j].kpiIndex == target.kpiIndex) {
                    revert DuplicateTarget(target.campaign, target.kpiIndex);
                }
                if (targets[j].campaign == target.campaign && targets[i - 1].campaign != target.campaign) {
                    revert NonContiguousCampaign(target.campaign);
                }
            }

            Types.KpiSpec memory spec = _requireKpi(target.campaign, target.kpiIndex);
            if (spec.aggregate) revert WrongKpiRoute(target.campaign, target.kpiIndex);
            (IKpiAutomation.AutomationMode mode, address adapter, uint256 epoch) =
                _userRoute(target.campaign, target.kpiIndex, spec.verifier);
            if (target.observationEpoch != epoch) {
                revert ObservationEpochMismatch(target.observationEpoch, epoch);
            }

            for (uint256 j; j < target.progress.length; ++j) {
                Progress memory progress = target.progress[j];
                if (progress.user == address(0)) revert ZeroProgressUser();
                if (mode == IKpiAutomation.AutomationMode.USER_EVIDENCE_FREE && progress.evidence.length != 0)
                {
                    revert EvidenceNotAllowed(target.campaign, target.kpiIndex);
                }
                if (mode == IKpiAutomation.AutomationMode.USER_ACTIONS && progress.evidence.length == 0) {
                    revert EvidenceRequired(target.campaign, target.kpiIndex);
                }
                uint256 observed = IKpiAutomationObservation(adapter).observedProgressOf(
                    target.campaign, target.kpiIndex, progress.user
                );
                if (observed < progress.newTotal) {
                    revert ObservationBelowClaim(observed, progress.newTotal);
                }
            }
        }
    }

    /// @dev Resolve one non-aggregate KPI's automation route.
    /// @param campaign Campaign the KPI belongs to.
    /// @param kpiIndex Index of the KPI within the campaign.
    /// @param verifier Campaign verifier address.
    /// @return mode Evidence route.
    /// @return adapter Canonical observation adapter.
    /// @return epoch Active observation generation.
    function _userRoute(address campaign, uint256 kpiIndex, address verifier)
        private
        view
        returns (IKpiAutomation.AutomationMode mode, address adapter, uint256 epoch)
    {
        if (verifier == address(0) || verifier == eventMetricVerifier) {
            adapter = eventMetricVerifier;
            mode = IKpiAutomation.AutomationMode.USER_EVIDENCE_FREE;
        } else {
            try IGuardedAutomation(verifier).boneyVerifier() returns (address outer) {
                if (outer != eventMetricVerifier) revert UnsupportedAutomation(verifier);
                try IGuardedAutomation(verifier).guardOf(campaign, kpiIndex) returns (
                    address projectVerifier, uint16, uint8, bool configured
                ) {
                    if (!configured) revert UnsupportedAutomation(verifier);
                    adapter = eventMetricVerifier;
                    if (projectVerifier == address(0)) {
                        mode = IKpiAutomation.AutomationMode.USER_EVIDENCE_FREE;
                    } else {
                        try IKpiAutomation(projectVerifier).automationCapability(campaign, kpiIndex) returns (
                            IKpiAutomation.AutomationMode projectMode, address
                        ) {
                            mode = projectMode;
                        } catch {
                            revert UnsupportedAutomation(projectVerifier);
                        }
                        if (
                            mode != IKpiAutomation.AutomationMode.USER_EVIDENCE_FREE
                                && mode != IKpiAutomation.AutomationMode.USER_ACTIONS
                        ) revert UnsupportedAutomation(projectVerifier);
                    }
                } catch {
                    revert UnsupportedAutomation(verifier);
                }
            } catch {
                try IKpiAutomation(verifier).automationCapability(campaign, kpiIndex) returns (
                    IKpiAutomation.AutomationMode customMode, address customAdapter
                ) {
                    mode = customMode;
                    adapter = customAdapter;
                } catch {
                    revert UnsupportedAutomation(verifier);
                }
                if (
                    mode != IKpiAutomation.AutomationMode.USER_EVIDENCE_FREE
                        && mode != IKpiAutomation.AutomationMode.USER_ACTIONS
                ) revert UnsupportedAutomation(verifier);
            }
        }
        if (adapter == address(0)) revert InvalidObservationAdapter(adapter);

        if (adapter == eventMetricVerifier) {
            IEventMetricAutomation.KpiConfig memory cfg =
                IEventMetricAutomation(eventMetricVerifier).configOf(campaign, kpiIndex);
            if (!cfg.configured) revert EventMetricNotConfigured(campaign, kpiIndex);
            epoch = cfg.epoch;
        } else {
            epoch = IKpiAutomationObservation(adapter).observationEpoch(campaign, kpiIndex);
        }
    }

    /// @dev Validate aggregate claims and prepare coordinator reports.
    /// @param reports Aggregate claims.
    /// @param maturedIds IDs applied before new submissions.
    /// @param maturedKeys Target keys parallel to matured IDs.
    /// @param oracleReports Prepared coordinator reports.
    /// @param aggregateKeys Target keys parallel to new submissions.
    function _validateAggregates(
        AggregateReport[] memory reports,
        bytes32[] memory maturedIds,
        bytes32[] memory maturedKeys,
        IOracleCoordinator.Report[] memory oracleReports,
        bytes32[] memory aggregateKeys
    ) private view {
        for (uint256 i; i < reports.length; ++i) {
            AggregateReport memory report = reports[i];
            _requireCampaign(report.campaign);
            bytes32 key = _targetKey(report.campaign, report.kpiIndex);
            for (uint256 j; j < i; ++j) {
                if (aggregateKeys[j] == key) revert DuplicateTarget(report.campaign, report.kpiIndex);
            }
            aggregateKeys[i] = key;
            oracleReports[i] = _validateAggregateReport(report, maturedIds, maturedKeys, key);
        }
    }

    /// @dev Validate one aggregate route and prepare its coordinator report.
    /// @param report Aggregate claim.
    /// @param maturedIds IDs applied before new submissions.
    /// @param maturedKeys Target keys parallel to matured IDs.
    /// @param key Aggregate target key.
    /// @return Prepared coordinator report.
    function _validateAggregateReport(
        AggregateReport memory report,
        bytes32[] memory maturedIds,
        bytes32[] memory maturedKeys,
        bytes32 key
    ) private view returns (IOracleCoordinator.Report memory) {
        Types.KpiSpec memory spec = _requireKpi(report.campaign, report.kpiIndex);
        if (!spec.aggregate) revert WrongKpiRoute(report.campaign, report.kpiIndex);

        if (spec.verifier == address(0)) {
            if (report.observationEpoch != 0) {
                revert ObservationEpochMismatch(report.observationEpoch, 0);
            }
        } else {
            (IKpiAutomation.AutomationMode mode, address adapter) =
                IKpiAutomation(spec.verifier).automationCapability(report.campaign, report.kpiIndex);
            if (mode != IKpiAutomation.AutomationMode.AGGREGATE) revert UnsupportedAutomation(spec.verifier);
            if (adapter == address(0)) revert InvalidObservationAdapter(adapter);
            _validateAggregateObservation(report, adapter);
        }
        _validatePendingAggregate(report, maturedIds, maturedKeys, key);

        return IOracleCoordinator.Report({
            campaign: report.campaign,
            kpiIndex: report.kpiIndex,
            amount: report.newTotal,
            evidence: ""
        });
    }

    /// @dev Validate an aggregate claim against one observation adapter.
    /// @param report Aggregate claim.
    /// @param adapter Observation adapter named by the verifier.
    function _validateAggregateObservation(AggregateReport memory report, address adapter) private view {
        uint256 epoch = IKpiAutomationObservation(adapter).observationEpoch(report.campaign, report.kpiIndex);
        if (report.observationEpoch != epoch) {
            revert ObservationEpochMismatch(report.observationEpoch, epoch);
        }
        uint256 observed =
            IKpiAutomationObservation(adapter).observedAggregateProgressOf(report.campaign, report.kpiIndex);
        if (observed < report.newTotal) revert ObservationBelowClaim(observed, report.newTotal);
    }

    /// @dev Validate an aggregate claim against campaign and pending totals.
    /// @param report Aggregate claim.
    /// @param maturedIds IDs applied before new submissions.
    /// @param maturedKeys Target keys parallel to matured IDs.
    /// @param key Aggregate target key.
    function _validatePendingAggregate(
        AggregateReport memory report,
        bytes32[] memory maturedIds,
        bytes32[] memory maturedKeys,
        bytes32 key
    ) private view {
        uint256 floor = ICampaign(report.campaign).totalProgress(report.kpiIndex);
        bytes32 pending = _pendingAggregate[key];
        if (pending != bytes32(0)) {
            bool resolved =
                oracleCoordinator.reportApplied(pending) || oracleCoordinator.reportDisputed(pending);
            bool requested = _containsMatured(pending, key, maturedIds, maturedKeys);
            if (!requested && !resolved) {
                revert PendingAggregateReport(report.campaign, report.kpiIndex, pending);
            }
            if (requested && !resolved && _pendingAction(pending, key) != PENDING_CLEAR) {
                uint256 amount = _pendingAggregateAmount[key];
                if (amount > floor) floor = amount;
            }
        }
        if (report.newTotal < floor) revert AggregateBelowCampaign(floor, report.newTotal);
    }

    /// @dev Validate and classify router-owned pending report IDs.
    /// @param reportIds Pending IDs requested for resolution.
    /// @return keys Reverse target keys parallel to IDs.
    /// @return applyIds Mature IDs that remain applicable.
    /// @return clear Pending items removed after downstream calls succeed.
    function _resolveMatured(bytes32[] memory reportIds)
        private
        view
        returns (bytes32[] memory keys, bytes32[] memory applyIds, bool[] memory clear)
    {
        keys = new bytes32[](reportIds.length);
        clear = new bool[](reportIds.length);
        bytes32[] memory candidates = new bytes32[](reportIds.length);
        uint256 applyCount;
        for (uint256 i; i < reportIds.length; ++i) {
            bytes32 key = _aggregateKeyByReportId[reportIds[i]];
            if (key == bytes32(0) || _pendingAggregate[key] != reportIds[i]) {
                revert UnknownPendingReport(reportIds[i]);
            }
            for (uint256 j; j < i; ++j) {
                if (reportIds[j] == reportIds[i]) revert UnknownPendingReport(reportIds[i]);
            }
            keys[i] = key;
            uint256 action = _pendingAction(reportIds[i], key);
            if (action == PENDING_APPLY) candidates[applyCount++] = reportIds[i];
            clear[i] = action != PENDING_DEFER;
        }
        applyIds = new bytes32[](applyCount);
        for (uint256 i; i < applyCount; ++i) {
            applyIds[i] = candidates[i];
        }
    }

    /// @dev Classify one pending aggregate report.
    /// @param reportId Coordinator report ID.
    /// @param key Router target key.
    /// @return Action code for defer, apply, or clear.
    function _pendingAction(bytes32 reportId, bytes32 key) private view returns (uint256) {
        if (oracleCoordinator.reportApplied(reportId) || oracleCoordinator.reportDisputed(reportId)) {
            return PENDING_CLEAR;
        }
        if (block.timestamp < oracleCoordinator.reportDeadline(reportId)) return PENDING_DEFER;

        (address campaignAddress, uint256 kpiIndex) = oracleCoordinator.reportTarget(reportId);
        ICampaign campaign = ICampaign(campaignAddress);
        if (_pendingAggregateAmount[key] < campaign.totalProgress(kpiIndex)) return PENDING_CLEAR;

        Types.CampaignStatus current = campaign.status();
        if (current == Types.CampaignStatus.Pending) {
            return block.timestamp >= campaign.endTime() ? PENDING_CLEAR : PENDING_DEFER;
        }
        if (current == Types.CampaignStatus.Active) {
            if (block.timestamp < campaign.startTime() || block.timestamp > campaign.endTime()) {
                return PENDING_DEFER;
            }
            return PENDING_APPLY;
        }
        if (current == Types.CampaignStatus.Paused) return PENDING_DEFER;
        if (current == Types.CampaignStatus.Ended) {
            return block.timestamp <= campaign.aggregateUpdateDeadline() ? PENDING_APPLY : PENDING_CLEAR;
        }
        return PENDING_CLEAR;
    }

    /// @dev Apply contiguous same-campaign user groups.
    /// @param targets Validated target scans.
    function _applyTargetGroups(TargetScan[] memory targets) private {
        uint256 i;
        while (i < targets.length) {
            address campaign = targets[i].campaign;
            uint256 end = i;
            uint256 count;
            while (end < targets.length && targets[end].campaign == campaign) {
                count += targets[end].progress.length;
                ++end;
            }
            if (count != 0) {
                ICampaign.UserActionReport[] memory batch = new ICampaign.UserActionReport[](count);
                uint256 cursor;
                for (uint256 targetIndex = i; targetIndex < end; ++targetIndex) {
                    for (
                        uint256 progressIndex;
                        progressIndex < targets[targetIndex].progress.length;
                        ++progressIndex
                    ) {
                        Progress memory progress = targets[targetIndex].progress[progressIndex];
                        batch[cursor++] = ICampaign.UserActionReport({
                            kpiIndex: targets[targetIndex].kpiIndex,
                            user: progress.user,
                            newTotal: progress.newTotal,
                            evidence: progress.evidence
                        });
                    }
                }
                ICampaign(campaign).reportUserActionsBatch(batch);
            }
            i = end;
        }
    }

    /// @dev Commit state after every downstream call succeeds.
    /// @param report Decoded workflow report.
    /// @param maturedKeys Keys parallel to requested pending report IDs.
    /// @param clearMatured Whether each requested pending report reached a terminal outcome.
    /// @param aggregateKeys Keys parallel to submitted report IDs.
    /// @param newReportIds IDs returned for aggregate submissions.
    function _writeBusinessState(
        CreReport memory report,
        bytes32[] memory maturedKeys,
        bool[] memory clearMatured,
        bytes32[] memory aggregateKeys,
        bytes32[] memory newReportIds
    ) private {
        for (uint256 i; i < report.targets.length; ++i) {
            TargetScan memory target = report.targets[i];
            _userCursor[_userCursorKey(target.campaign, target.kpiIndex, target.observationEpoch)] =
                target.nextUserCursor;
        }
        for (uint256 i; i < report.maturedReportIds.length; ++i) {
            if (!clearMatured[i]) continue;
            delete _pendingAggregate[maturedKeys[i]];
            delete _pendingAggregateAmount[maturedKeys[i]];
            delete _aggregateKeyByReportId[report.maturedReportIds[i]];
        }
        for (uint256 i; i < newReportIds.length; ++i) {
            bytes32 old = _pendingAggregate[aggregateKeys[i]];
            if (old != bytes32(0)) delete _aggregateKeyByReportId[old];
            _pendingAggregate[aggregateKeys[i]] = newReportIds[i];
            _pendingAggregateAmount[aggregateKeys[i]] = report.aggregateReports[i].newTotal;
            _aggregateKeyByReportId[newReportIds[i]] = aggregateKeys[i];
        }

        uint64 consumedNonce = nonce;
        campaignCursor = report.nextCampaignCursor;
        kpiCursor = report.nextKpiCursor;
        nonce = consumedNonce + 1;
        emit CreReportProcessed(consumedNonce, campaignCursor, kpiCursor);
    }

    /// @dev Require registry provenance and router authorization.
    /// @param campaign Campaign address to validate.
    function _requireCampaign(address campaign) private view {
        if (!campaignRegistry.isCampaign(campaign)) revert UnknownCampaign(campaign);
        if (!ICampaign(campaign).authorizedReporters(address(this))) revert UnauthorizedCampaign(campaign);
    }

    /// @dev Load one existing KPI.
    /// @param campaign Campaign the KPI belongs to.
    /// @param kpiIndex Index to load.
    /// @return The KPI specification.
    function _requireKpi(address campaign, uint256 kpiIndex) private view returns (Types.KpiSpec memory) {
        ICampaign target = ICampaign(campaign);
        if (kpiIndex >= target.kpiCount()) revert UnknownKpi(campaign, kpiIndex);
        return target.kpi(kpiIndex);
    }

    /// @dev Return whether a pending ID is being applied for one key.
    /// @param reportId Pending report ID.
    /// @param key Aggregate target key.
    /// @param maturedIds Requested application IDs.
    /// @param maturedKeys Keys parallel to requested IDs.
    /// @return True when the exact pending item is included.
    function _containsMatured(
        bytes32 reportId,
        bytes32 key,
        bytes32[] memory maturedIds,
        bytes32[] memory maturedKeys
    ) private pure returns (bool) {
        for (uint256 i; i < maturedIds.length; ++i) {
            if (maturedIds[i] == reportId && maturedKeys[i] == key) return true;
        }
        return false;
    }

    /// @dev Validate the exact workflow identity in Keystone metadata.
    /// @param metadata Keystone workflow metadata.
    function _validateMetadata(bytes calldata metadata) private view {
        if (metadata.length != 64) revert InvalidMetadataLength(metadata.length);
        bytes32 workflowId;
        address workflowOwner;
        assembly ("memory-safe") {
            workflowId := calldataload(metadata.offset)
            workflowOwner := shr(96, calldataload(add(metadata.offset, 42)))
        }
        if (workflowId != expectedWorkflowId) {
            revert WorkflowIdMismatch(workflowId, expectedWorkflowId);
        }
        if (workflowOwner != expectedWorkflowOwner) {
            revert WorkflowOwnerMismatch(workflowOwner, expectedWorkflowOwner);
        }
    }

    /// @dev Build a campaign and KPI key.
    /// @param campaign Campaign address.
    /// @param kpiIndex KPI index.
    /// @return The key.
    function _targetKey(address campaign, uint256 kpiIndex) private pure returns (bytes32) {
        return keccak256(abi.encode(campaign, kpiIndex));
    }

    /// @dev Build an epoch-scoped user cursor key.
    /// @param campaign Campaign address.
    /// @param kpiIndex KPI index.
    /// @param observationEpoch Observation generation.
    /// @return The key.
    function _userCursorKey(address campaign, uint256 kpiIndex, uint256 observationEpoch)
        private
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(campaign, kpiIndex, observationEpoch));
    }
}
