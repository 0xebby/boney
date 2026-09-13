// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title IOracleCoordinator
/// @notice Coordinates oracle-reported campaign updates through a dispute window.
/// @dev Dispute authority is governance's.
interface IOracleCoordinator {
    // ── errors ───────────────────────────────────────────────────

    error ZeroAddress();
    error NotAReporter(address who);
    error UnknownReport(bytes32 reportId);
    error ReportAlreadyExists(bytes32 reportId);
    error DisputeWindowOpen(uint256 until);
    error DisputeWindowClosed(uint256 until);
    error ReportIsDisputed(bytes32 reportId);
    error ReportAlreadyApplied(bytes32 reportId);
    error UnknownCampaign(address campaign);
    error NotUserReport(bytes32 reportId);
    error NotAggregateReport(bytes32 reportId);
    error RegistryAlreadySet();
    error RegistryNotSet();
    error ReporterAlreadyListed(address reporter);
    error ReporterNotListed(address reporter);

    // ── events ───────────────────────────────────────────────────

    /// @notice Emitted once when the campaign registry is wired, enabling report submission.
    /// @param registry The campaign registry used to validate report targets.
    event RegistrySet(address indexed registry);

    /// @notice Emitted when an account is added to or removed from the reporter list.
    /// @param reporter Account whose listing changed.
    /// @param allowed Whether the account may submit reports.
    event ReporterAllowlistUpdated(address indexed reporter, bool allowed);

    /// @notice Emitted when a report enters the challenge window. It is not applied yet.
    /// @param reportId Id of the report.
    /// @param campaign Campaign it targets.
    /// @param reporter Who submitted it.
    /// @param deadline When the challenge window closes and the report becomes applicable.
    event ReportSubmitted(
        bytes32 indexed reportId, address indexed campaign, address indexed reporter, uint256 deadline
    );

    /// @notice Emitted when an unchallenged report is pushed to its campaign.
    /// @param reportId Id of the report.
    /// @param campaign Campaign updated.
    event ReportApplied(bytes32 indexed reportId, address indexed campaign);

    /// @notice Emitted when a report is challenged before its deadline, which prevents it from
    ///         ever being applied.
    /// @param reportId Id of the disputed report.
    /// @param campaign Campaign it targeted.
    /// @param disputer Who raised the dispute.
    event ReportDisputed(bytes32 indexed reportId, address indexed campaign, address disputer);

    /// @notice A candidate update for one campaign.
    /// @param campaign Campaign receiving the update.
    /// @param kpiIndex KPI index within the campaign.
    /// @param amount New campaign-level total (monotonic; oracle may only increase it).
    /// @param evidence Opaque reference to the evidence behind the report (off-chain or a hash).
    struct Report {
        address campaign;
        uint256 kpiIndex;
        uint256 amount;
        bytes evidence;
    }

    /// @notice A candidate per-user update, routed to `Campaign.reportUserAction`.
    /// @dev The counterpart to `Report`, which reaches only `applyAggregateUpdate` and credits no
    ///      individual promoter.
    /// @param campaign Campaign receiving the update.
    /// @param kpiIndex KPI index within the campaign; must be a per-user (non-aggregate) KPI.
    /// @param user End user whose actions are being reported.
    /// @param newTotal Cumulative amount for this `(user, kpiIndex)` pair, not a delta.
    /// @param evidence Passed through to the KPI's verifier, when it has one.
    struct UserReport {
        address campaign;
        uint256 kpiIndex;
        address user;
        uint256 newTotal;
        bytes evidence;
    }

    /// @notice Add an account to the reporter allowlist.
    /// @param reporter Account accepted as a reporter.
    function addReporter(address reporter) external;

    /// @notice Remove an account from the reporter allowlist.
    /// @param reporter Account no longer accepted as a reporter.
    function removeReporter(address reporter) external;

    /// @notice Submit a candidate report; it becomes applicable after `disputeWindow`.
    /// @param report The candidate update.
    /// @return reportId Content-derived id used to apply or dispute the report.
    function submitReport(Report calldata report) external returns (bytes32 reportId);

    /// @notice Submit a candidate per-user report; it becomes applicable after `disputeWindow`.
    /// @dev Uses the same reporter allowlist and dispute window as `submitReport`. Ids are
    ///      domain-separated from aggregate reports.
    /// @param report The candidate per-user update.
    /// @return reportId Content-derived id used to apply or dispute the report.
    function submitUserReport(UserReport calldata report) external returns (bytes32 reportId);

    /// @notice Apply a previously submitted, un-disputed report to its campaign.
    /// @dev Callable by anyone once the dispute window has elapsed.
    /// @param reportId Id returned by `submitReport`.
    function applyReport(bytes32 reportId) external;

    /// @notice Apply a previously submitted, un-disputed per-user report to its campaign.
    /// @dev Callable by anyone once the dispute window has elapsed. The campaign credits the
    ///      attributed promoter and settles any crossed tier in the same call.
    /// @param reportId Id returned by `submitUserReport`.
    function applyUserReport(bytes32 reportId) external;

    /// @notice Dispute a report. Callable only by the governor while the window is open.
    ///         The report can never be applied afterward.
    /// @param reportId Id returned by `submitReport`.
    function disputeReport(bytes32 reportId) external;

    /// @notice Deadline after which a report may be applied.
    /// @param reportId The report id.
    /// @return Timestamp the dispute window closes.
    function reportDeadline(bytes32 reportId) external view returns (uint256);

    /// @notice Whether a report was disputed and permanently voided.
    /// @param reportId The report id.
    /// @return True if the report can never be applied.
    function reportDisputed(bytes32 reportId) external view returns (bool);

    /// @notice Whether a report has already been pushed to its campaign.
    /// @param reportId The report id.
    /// @return True if the report was applied.
    function reportApplied(bytes32 reportId) external view returns (bool);

    /// @notice Number of listed reporters.
    /// @return The reporter-list length.
    function reporterCount() external view returns (uint256);

    /// @notice Listed reporter at an index.
    /// @param index Position in the reporter list.
    /// @return The listed reporter.
    function reporterAt(uint256 index) external view returns (address);

    /// @notice Whether an account is listed as a reporter.
    /// @param who Account to check.
    /// @return True when the account is accepted for submissions.
    function isReporter(address who) external view returns (bool);

    /// @notice Seconds a report stays challengeable before it can be applied.
    /// @return The dispute window length.
    function disputeWindow() external view returns (uint256);

    /// @notice Registry used to confirm a target address is a real campaign.
    /// @return The campaign registry address.
    function campaignContract() external view returns (address);
}
