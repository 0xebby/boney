// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IOracleCoordinator} from "../interfaces/IOracleCoordinator.sol";
import {ICampaign} from "../interfaces/ICampaign.sol";
import {ICampaignRegistry} from "../interfaces/ICampaignRegistry.sol";
import {Types} from "../libraries/Types.sol";

/// @title OracleCoordinator
/// @notice Allowlisted reporting of campaign-level KPI aggregates with an optimistic dispute window.
/// @dev Listed reporters may submit reports, which land only after `disputeWindow` elapses without
///      a challenge. Governance can void a report while the window remains open. Report ids hash
///      the reporter and a per-reporter sequence, so identical claims do not collide.
contract OracleCoordinator is IOracleCoordinator, Ownable {
    /// @inheritdoc IOracleCoordinator
    uint256 public constant MAX_REPORTS_PER_BATCH = 32;

    /// @notice Lifecycle state of a submitted report.
    /// @param reporter Account that submitted the report.
    /// @param campaign Campaign the report targets.
    /// @param kpiIndex KPI index within that campaign.
    /// @param amount New total being reported — campaign-level for an aggregate report,
    ///        `(user, kpi)`-level for a per-user one.
    /// @param deadline Timestamp after which the report may be applied.
    /// @param disputed Whether governance voided the report.
    /// @param applied Whether the report has already been pushed to the campaign.
    /// @param user End user credited by a per-user report, or `address(0)` for an aggregate. The
    ///        discriminator between the two kinds.
    /// @param evidence Verifier evidence forwarded to `reportUserAction`; empty for aggregates.
    struct ReportState {
        address reporter;
        address campaign;
        uint256 kpiIndex;
        uint256 amount;
        uint64 deadline;
        bool disputed;
        bool applied;
        address user;
        bytes evidence;
    }

    /// @notice Registry used to confirm a target address is a real campaign.
    /// @dev Not immutable: the coordinator is deployed before the registry, then wired exactly once
    ///      via `setCampaignRegistry`.
    ICampaignRegistry public campaignRegistry;

    /// @inheritdoc IOracleCoordinator
    uint256 public immutable disputeWindow;

    /// @dev Listed reporters accepted to submit reports.
    mapping(address => bool) public reporterAllowed;
    /// @dev Reporter list index plus one, for O(1) removal.
    mapping(address => uint256) private _reporterIndex;
    /// @notice Enumerable reporter allowlist.
    address[] public reporters;
    /// @dev reporter => next report sequence number, folded into the report id.
    mapping(address => uint256) private _sequence;
    /// @dev reportId => report state.
    mapping(bytes32 => ReportState) private _reports;
    /// @notice Deploys the coordinator with dispute parameters.
    /// @param governor Owner able to dispute reports.
    /// @param disputeWindow_ Seconds a report stays challengeable before it can be applied.

    constructor(address governor, uint256 disputeWindow_) Ownable(governor) {
        if (governor == address(0)) revert ZeroAddress();
        disputeWindow = disputeWindow_;
    }

    /// @notice Wire the campaign registry. Callable exactly once, by the governor.
    /// @param registry Address of the campaign registry.
    function setCampaignRegistry(address registry) external onlyOwner {
        if (registry == address(0)) revert ZeroAddress();
        if (address(campaignRegistry) != address(0)) revert RegistryAlreadySet();
        campaignRegistry = ICampaignRegistry(registry);
        emit RegistrySet(registry);
    }

    /// @inheritdoc IOracleCoordinator
    function addReporter(address reporter) external onlyOwner {
        if (reporter == address(0)) revert ZeroAddress();
        if (reporterAllowed[reporter]) revert ReporterAlreadyListed(reporter);
        _addReporter(reporter);
    }

    /// @inheritdoc IOracleCoordinator
    function removeReporter(address reporter) external onlyOwner {
        if (!reporterAllowed[reporter]) revert ReporterNotListed(reporter);
        reporterAllowed[reporter] = false;
        uint256 index = _reporterIndex[reporter] - 1;
        uint256 last = reporters.length - 1;
        if (index != last) {
            address moved = reporters[last];
            reporters[index] = moved;
            _reporterIndex[moved] = index + 1;
        }
        reporters.pop();
        delete _reporterIndex[reporter];
        emit ReporterAllowlistUpdated(reporter, false);
    }

    // ── reporting ────────────────────────────────────────────────

    /// @inheritdoc IOracleCoordinator
    function submitReport(Report calldata report) external returns (bytes32 reportId) {
        return _record(report.campaign, report.kpiIndex, report.amount, address(0), "");
    }

    /// @inheritdoc IOracleCoordinator
    /// @dev Rejects a zero user; `address(0)` marks a stored report as an aggregate.
    function submitUserReport(UserReport calldata report) external returns (bytes32 reportId) {
        if (report.user == address(0)) revert ZeroAddress();
        return _record(report.campaign, report.kpiIndex, report.newTotal, report.user, report.evidence);
    }

    /// @inheritdoc IOracleCoordinator
    function submitReports(Report[] calldata reports) external returns (bytes32[] memory reportIds) {
        uint256 length = _validateBatchLength(reports.length);
        reportIds = new bytes32[](length);
        for (uint256 i; i < length; ++i) {
            Report calldata report = reports[i];
            reportIds[i] = _record(report.campaign, report.kpiIndex, report.amount, address(0), "");
        }
    }

    /// @inheritdoc IOracleCoordinator
    function submitUserReports(UserReport[] calldata reports) external returns (bytes32[] memory reportIds) {
        uint256 length = _validateBatchLength(reports.length);
        reportIds = new bytes32[](length);
        for (uint256 i; i < length; ++i) {
            UserReport calldata report = reports[i];
            if (report.user == address(0)) revert ZeroAddress();
            reportIds[i] =
                _record(report.campaign, report.kpiIndex, report.newTotal, report.user, report.evidence);
        }
    }

    /// @dev Enforces the shared batch bound.
    /// @param length Number of batch items.
    /// @return The validated length.
    function _validateBatchLength(uint256 length) private pure returns (uint256) {
        if (length == 0) revert EmptyReportBatch();
        if (length > MAX_REPORTS_PER_BATCH) revert TooManyReports(length, MAX_REPORTS_PER_BATCH);
        return length;
    }

    /// @dev Stores one report with an independent sequence and deadline.
    /// @param campaign Campaign the report targets.
    /// @param kpiIndex KPI index within that campaign.
    /// @param amount New total being reported.
    /// @param user End user for a per-user report, or `address(0)` for an aggregate.
    /// @param evidence Verifier evidence forwarded on apply; empty for aggregates.
    /// @return reportId Id of the stored report.
    function _record(address campaign, uint256 kpiIndex, uint256 amount, address user, bytes memory evidence)
        private
        returns (bytes32 reportId)
    {
        if (!reporterAllowed[msg.sender]) revert NotAReporter(msg.sender);
        if (address(campaignRegistry) == address(0)) revert RegistryNotSet();
        if (!campaignRegistry.isCampaign(campaign)) revert UnknownCampaign(campaign);
        if (user == address(0)) {
            ICampaign target = ICampaign(campaign);
            if (target.status() != Types.CampaignStatus.Active) revert WrongCampaignStatus(target.status());
            uint64 start = target.startTime();
            uint64 end = target.endTime();
            if (block.timestamp < start || block.timestamp > end) {
                revert CampaignOutsideWindow(start, end);
            }
        }

        uint256 seq = _sequence[msg.sender]++;
        reportId = keccak256(abi.encode(msg.sender, campaign, kpiIndex, amount, user, seq));
        if (_reports[reportId].reporter != address(0)) revert ReportAlreadyExists(reportId);

        uint64 deadline = uint64(block.timestamp + disputeWindow);
        _reports[reportId] = ReportState({
            reporter: msg.sender,
            campaign: campaign,
            kpiIndex: kpiIndex,
            amount: amount,
            deadline: deadline,
            disputed: false,
            applied: false,
            user: user,
            evidence: evidence
        });

        emit ReportSubmitted(reportId, campaign, msg.sender, deadline);
    }

    /// @inheritdoc IOracleCoordinator
    /// @dev Permissionless once the dispute window closes.
    function applyReport(bytes32 reportId) external {
        ReportState storage r = _reports[reportId];
        if (r.user != address(0)) revert NotAggregateReport(reportId);
        _clearForApply(r, reportId);
        _applyAggregate(r, reportId);
    }

    /// @inheritdoc IOracleCoordinator
    /// @dev The campaign resolves attribution, credits the promoter, and settles crossed tiers inline.
    function applyUserReport(bytes32 reportId) external {
        ReportState storage r = _reports[reportId];
        if (r.user == address(0)) revert NotUserReport(reportId);
        _clearForApply(r, reportId);

        ICampaign(r.campaign).reportUserAction(r.kpiIndex, r.user, r.amount, r.evidence);
        emit ReportApplied(reportId, r.campaign);
    }

    /// @inheritdoc IOracleCoordinator
    function applyReports(bytes32[] calldata reportIds) external {
        uint256 length = _validateBatchLength(reportIds.length);
        uint256 i;
        while (i < length) {
            bytes32 reportId = reportIds[i];
            ReportState storage report = _reports[reportId];
            _clearForApply(report, reportId);

            if (report.user == address(0)) {
                _applyAggregate(report, reportId);
                ++i;
                continue;
            }

            address campaign = report.campaign;
            uint256 end = i + 1;
            while (end < length) {
                ReportState storage next = _reports[reportIds[end]];
                if (next.reporter != address(0) && (next.user == address(0) || next.campaign != campaign)) {
                    break;
                }
                _clearForApply(next, reportIds[end]);
                ++end;
            }
            _applyUserGroup(reportIds, i, end, campaign);
            i = end;
        }
    }

    /// @dev Applies one aggregate report.
    /// @param report Stored aggregate report.
    /// @param reportId Id of the report.
    function _applyAggregate(ReportState storage report, bytes32 reportId) private {
        ICampaign(report.campaign).applyAggregateUpdate(report.kpiIndex, report.amount);
        emit ReportApplied(reportId, report.campaign);
    }

    /// @dev Applies one contiguous same-campaign user-report group.
    /// @param reportIds Full ordered report-id input.
    /// @param start Inclusive group start.
    /// @param end Exclusive group end.
    /// @param campaign Campaign shared by the group.
    function _applyUserGroup(bytes32[] calldata reportIds, uint256 start, uint256 end, address campaign)
        private
    {
        uint256 length = end - start;
        ICampaign.UserActionReport[] memory reports = new ICampaign.UserActionReport[](length);
        for (uint256 i; i < length; ++i) {
            ReportState storage report = _reports[reportIds[start + i]];
            reports[i] = ICampaign.UserActionReport({
                kpiIndex: report.kpiIndex,
                user: report.user,
                newTotal: report.amount,
                evidence: report.evidence
            });
        }

        ICampaign(campaign).reportUserActionsBatch(reports);
        for (uint256 i; i < length; ++i) {
            emit ReportApplied(reportIds[start + i], campaign);
        }
    }

    /// @dev Validates and reserves one report for application.
    /// @param r The stored report.
    /// @param reportId Id of that report, for error reporting.
    function _clearForApply(ReportState storage r, bytes32 reportId) private {
        _validateForApply(r, reportId);
        r.applied = true;
    }

    /// @dev Checks whether one report can be applied.
    /// @param r The stored report.
    /// @param reportId Id of that report, for error reporting.
    function _validateForApply(ReportState storage r, bytes32 reportId) private view {
        if (r.reporter == address(0)) revert UnknownReport(reportId);
        if (r.disputed) revert ReportIsDisputed(reportId);
        if (r.applied) revert ReportAlreadyApplied(reportId);
        if (block.timestamp < r.deadline) revert DisputeWindowOpen(r.deadline);
    }

    /// @inheritdoc IOracleCoordinator
    function disputeReport(bytes32 reportId) external onlyOwner {
        ReportState storage r = _reports[reportId];
        if (r.reporter == address(0)) revert UnknownReport(reportId);
        if (r.applied) revert ReportAlreadyApplied(reportId);
        if (block.timestamp >= r.deadline) revert DisputeWindowClosed(r.deadline);

        r.disputed = true;

        emit ReportDisputed(reportId, r.campaign, msg.sender);
    }

    // ── views ────────────────────────────────────────────────────

    /// @inheritdoc IOracleCoordinator
    function reportDeadline(bytes32 reportId) external view returns (uint256) {
        return _reports[reportId].deadline;
    }

    /// @inheritdoc IOracleCoordinator
    function reportTarget(bytes32 reportId) external view returns (address campaign, uint256 kpiIndex) {
        ReportState storage report = _reports[reportId];
        return (report.campaign, report.kpiIndex);
    }

    /// @inheritdoc IOracleCoordinator
    function reportDisputed(bytes32 reportId) external view returns (bool) {
        return _reports[reportId].disputed;
    }

    /// @inheritdoc IOracleCoordinator
    function reportApplied(bytes32 reportId) external view returns (bool) {
        return _reports[reportId].applied;
    }

    /// @inheritdoc IOracleCoordinator
    function campaignContract() external view returns (address) {
        return address(campaignRegistry);
    }

    /// @notice Full state of a report.
    /// @param reportId Id returned by `submitReport`.
    /// @return The stored report state.
    function reportState(bytes32 reportId) external view returns (ReportState memory) {
        return _reports[reportId];
    }

    /// @notice Whether `who` is listed as a reporter.
    /// @param who Address to check.
    /// @return True when the account is listed.
    function isReporter(address who) external view returns (bool) {
        return reporterAllowed[who];
    }

    /// @inheritdoc IOracleCoordinator
    function reporterCount() external view returns (uint256) {
        return reporters.length;
    }

    /// @inheritdoc IOracleCoordinator
    function reporterAt(uint256 index) external view returns (address) {
        return reporters[index];
    }

    /// @dev Adds an account to the enumerable reporter list.
    /// @param reporter Account to list.
    function _addReporter(address reporter) private {
        reporterAllowed[reporter] = true;
        reporters.push(reporter);
        _reporterIndex[reporter] = reporters.length;
        emit ReporterAllowlistUpdated(reporter, true);
    }
}
