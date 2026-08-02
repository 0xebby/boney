// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title IOracleCoordinator
/// @notice Coordinates oracle-reported campaign updates. Reporters stake collateral; reports enter
///         a dispute window before being applied. A governance-disputed report slashes the
///         reporter and is never applied.
/// @dev MVP keeps dispute authority with governance (permissionless dispute bonds are deferred).
interface IOracleCoordinator {
    event ReporterStaked(address indexed reporter, uint256 amount);
    event ReporterSlashed(address indexed reporter, uint256 amount);
    event ReportSubmitted(
        bytes32 indexed reportId, address indexed campaign, address indexed reporter, uint256 deadline
    );
    event ReportApplied(bytes32 indexed reportId, address indexed campaign);
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
    function submitReport(Report calldata report) external returns (bytes32 reportId);

    /// @notice Apply a previously submitted, un-disputed report to its campaign.
    /// @dev Callable by anyone once the dispute window has elapsed.
    function applyReport(bytes32 reportId) external;

    /// @notice Dispute a report. Callable only by the governor while the window is open.
    ///         Slashes the reporter's stake; the report can never be applied.
    function disputeReport(bytes32 reportId) external;

    function reportDeadline(bytes32 reportId) external view returns (uint256);
    function reportDisputed(bytes32 reportId) external view returns (bool);
    function reportApplied(bytes32 reportId) external view returns (bool);
    function stakeOf(address reporter) external view returns (uint256);
    function disputeWindow() external view returns (uint256);
    function campaignContract() external view returns (address);
}
