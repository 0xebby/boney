// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title IOracleCoordinator
/// @notice Coordinates oracle-reported campaign updates. Reporters stake collateral; reports enter
///         a dispute window before being applied. A governance-disputed report slashes the
///         reporter and is never applied.
/// @dev MVP keeps dispute authority with governance (permissionless dispute bonds are deferred).
interface IOracleCoordinator {
    /// @notice Emitted when a reporter posts collateral.
    /// @param reporter The reporter.
    /// @param amount Amount added to their stake.
    event ReporterStaked(address indexed reporter, uint256 amount);

    /// @notice Emitted when a reporter's stake is cut for a successfully disputed report.
    /// @param reporter The reporter penalized.
    /// @param amount Stake removed.
    event ReporterSlashed(address indexed reporter, uint256 amount);

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

    /// @notice Lock collateral to become eligible to submit reports.
    function stake() external payable;

    /// @notice Withdraw the caller's entire stake.
    function unstake() external;

    /// @notice Submit a candidate report; it becomes applicable after `disputeWindow`.
    /// @param report The candidate update.
    /// @return reportId Content-derived id used to apply or dispute the report.
    function submitReport(Report calldata report) external returns (bytes32 reportId);

    /// @notice Apply a previously submitted, un-disputed report to its campaign.
    /// @dev Callable by anyone once the dispute window has elapsed.
    /// @param reportId Id returned by `submitReport`.
    function applyReport(bytes32 reportId) external;

    /// @notice Dispute a report. Callable only by the governor while the window is open.
    ///         Slashes the reporter's stake; the report can never be applied.
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

    /// @notice Collateral currently posted by a reporter.
    /// @param reporter The reporter to query.
    /// @return The staked amount in wei.
    function stakeOf(address reporter) external view returns (uint256);

    /// @notice Seconds a report stays challengeable before it can be applied.
    /// @return The dispute window length.
    function disputeWindow() external view returns (uint256);

    /// @notice Registry used to confirm a target address is a real campaign.
    /// @return The campaign registry address.
    function campaignContract() external view returns (address);
}
