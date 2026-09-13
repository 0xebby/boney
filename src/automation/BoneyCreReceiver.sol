// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {ICampaign} from "../interfaces/ICampaign.sol";
import {IReceiver} from "../interfaces/IReceiver.sol";
import {Types} from "../libraries/Types.sol";

/// @dev Read surface every guarded campaign verifier exposes.
interface ICreGuardedVerifier {
    /// @notice Boney's canonical event metric verifier.
    /// @return The verifier address.
    function boneyVerifier() external view returns (address);

    /// @notice Return whether one campaign KPI has guard configuration.
    /// @param campaign The configured campaign.
    /// @param kpiIndex The configured KPI.
    /// @return projectVerifier The optional project verifier.
    /// @return toleranceBps The allowed agreement tolerance.
    /// @return mode The verifier composition mode.
    /// @return configured Whether the guard is configured.
    function guardOf(address campaign, uint256 kpiIndex)
        external
        view
        returns (address projectVerifier, uint16 toleranceBps, uint8 mode, bool configured);
}

/// @title BoneyCreReceiver
/// @notice Receives CRE reports for one guarded, non-aggregate campaign KPI.
contract BoneyCreReceiver is IReceiver, ERC165 {
    /// @notice Current report encoding version.
    uint8 public constant REPORT_VERSION = 1;

    /// @notice CRE report contents.
    /// @param version Encoding version.
    /// @param expectedNonce Receiver nonce this report consumes.
    /// @param validUntil Last timestamp at which the report is valid.
    /// @param nextCursor Cursor stored after successful processing.
    /// @param user User whose progress is reported.
    /// @param newTotal New cumulative user total.
    /// @param applyProgress Whether to call the campaign.
    struct CreReport {
        uint8 version;
        uint64 expectedNonce;
        uint64 validUntil;
        uint256 nextCursor;
        address user;
        uint256 newTotal;
        bool applyProgress;
    }

    /// @notice CRE Keystone forwarder allowed to deliver reports.
    address public immutable forwarder;
    /// @notice Campaign receiving progress.
    ICampaign public immutable campaign;
    /// @notice KPI receiving progress.
    uint256 public immutable kpiIndex;
    /// @notice Canonical EventMetric verifier behind the guard.
    address public immutable eventMetricVerifier;
    /// @notice Whether production workflow metadata is enforced.
    bool public immutable production;
    /// @notice Workflow ID accepted in production mode.
    bytes32 public immutable expectedWorkflowId;
    /// @notice Workflow owner accepted in production mode.
    address public immutable expectedWorkflowOwner;

    /// @notice Next observed-user position the workflow should scan.
    uint256 public cursor;
    /// @notice Number consumed by the next accepted report.
    uint64 public nonce;

    error NotForwarder(address caller);
    error ZeroAddress();
    error UnknownKpi(uint256 kpiIndex);
    error AggregateKpi(uint256 kpiIndex);
    error IncompatibleVerifier(address verifier);
    error GuardNotConfigured(address campaign, uint256 kpiIndex);
    error ProjectVerifierRequiresEvidence(address verifier);
    error InvalidWorkflowIdentity();
    error InvalidMetadataLength(uint256 provided);
    error WorkflowIdMismatch(bytes32 provided, bytes32 expected);
    error WorkflowOwnerMismatch(address provided, address expected);
    error InvalidReportVersion(uint8 provided);
    error NonceMismatch(uint64 provided, uint64 expected);
    error ReportExpired(uint64 validUntil, uint64 nowTs);
    error InvalidProgressReport();
    error InvalidCursorOnlyReport();
    error NonceOverflow();

    /// @notice Emitted after a CRE report advances receiver state.
    /// @param consumedNonce Nonce consumed by the report.
    /// @param nextCursor New circular scan cursor.
    /// @param user Reported user, or zero for a cursor-only report.
    /// @param newTotal Reported cumulative total, or zero for a cursor-only report.
    /// @param applied Whether campaign progress was forwarded.
    event CreReportProcessed(
        uint64 indexed consumedNonce, uint256 nextCursor, address indexed user, uint256 newTotal, bool applied
    );

    /// @notice Deploy a receiver for one campaign KPI and workflow identity policy.
    /// @param forwarder_ CRE Keystone forwarder.
    /// @param campaign_ Campaign receiving reports.
    /// @param kpiIndex_ KPI receiving progress.
    /// @param eventMetricVerifier_ Canonical EventMetric verifier required behind the guard.
    /// @param production_ Whether workflow metadata must match the expected identity.
    /// @param expectedWorkflowId_ Workflow ID required in production mode.
    /// @param expectedWorkflowOwner_ Workflow owner required in production mode.
    constructor(
        address forwarder_,
        ICampaign campaign_,
        uint256 kpiIndex_,
        address eventMetricVerifier_,
        bool production_,
        bytes32 expectedWorkflowId_,
        address expectedWorkflowOwner_
    ) {
        if (
            forwarder_ == address(0) || address(campaign_) == address(0) || eventMetricVerifier_ == address(0)
        ) revert ZeroAddress();
        if (production_ && (expectedWorkflowId_ == bytes32(0) || expectedWorkflowOwner_ == address(0))) {
            revert InvalidWorkflowIdentity();
        }

        uint256 count = campaign_.kpiCount();
        if (kpiIndex_ >= count) revert UnknownKpi(kpiIndex_);
        Types.KpiSpec memory spec = campaign_.kpi(kpiIndex_);
        if (spec.aggregate) revert AggregateKpi(kpiIndex_);
        if (spec.verifier == address(0)) revert IncompatibleVerifier(address(0));

        ICreGuardedVerifier guard = ICreGuardedVerifier(spec.verifier);
        try guard.boneyVerifier() returns (address configuredVerifier) {
            if (configuredVerifier != eventMetricVerifier_) {
                revert IncompatibleVerifier(spec.verifier);
            }
        } catch {
            revert IncompatibleVerifier(spec.verifier);
        }

        try guard.guardOf(address(campaign_), kpiIndex_) returns (
            address projectVerifier, uint16, uint8, bool configured
        ) {
            if (!configured) revert GuardNotConfigured(address(campaign_), kpiIndex_);
            if (projectVerifier != address(0)) {
                revert ProjectVerifierRequiresEvidence(projectVerifier);
            }
        } catch (bytes memory reason) {
            if (reason.length != 0) {
                assembly ("memory-safe") {
                    revert(add(reason, 32), mload(reason))
                }
            }
            revert IncompatibleVerifier(spec.verifier);
        }

        forwarder = forwarder_;
        campaign = campaign_;
        kpiIndex = kpiIndex_;
        eventMetricVerifier = eventMetricVerifier_;
        production = production_;
        expectedWorkflowId = expectedWorkflowId_;
        expectedWorkflowOwner = expectedWorkflowOwner_;
    }

    /// @inheritdoc IReceiver
    function onReport(bytes calldata metadata, bytes calldata report) external {
        if (msg.sender != forwarder) revert NotForwarder(msg.sender);
        if (production) _validateMetadata(metadata);

        CreReport memory decoded = abi.decode(report, (CreReport));
        if (decoded.version != REPORT_VERSION) revert InvalidReportVersion(decoded.version);
        if (decoded.expectedNonce != nonce) revert NonceMismatch(decoded.expectedNonce, nonce);

        uint64 nowTs = uint64(block.timestamp);
        if (decoded.validUntil < nowTs) revert ReportExpired(decoded.validUntil, nowTs);

        if (decoded.applyProgress) {
            if (decoded.user == address(0)) revert InvalidProgressReport();
            campaign.reportUserAction(kpiIndex, decoded.user, decoded.newTotal, bytes(""));
        } else if (decoded.user != address(0) || decoded.newTotal != 0) {
            revert InvalidCursorOnlyReport();
        }

        uint64 consumedNonce = nonce;
        if (consumedNonce == type(uint64).max) revert NonceOverflow();
        cursor = decoded.nextCursor;
        nonce = consumedNonce + 1;
        emit CreReportProcessed(
            consumedNonce, decoded.nextCursor, decoded.user, decoded.newTotal, decoded.applyProgress
        );
    }

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId) public view override(IERC165, ERC165) returns (bool) {
        return interfaceId == type(IReceiver).interfaceId || super.supportsInterface(interfaceId);
    }

    /// @dev Validate the workflow ID and owner in Keystone metadata.
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
}
