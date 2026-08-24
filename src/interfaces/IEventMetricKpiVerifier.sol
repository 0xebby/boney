// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IKpiVerifier} from "./IKpiVerifier.sol";

/// @title IEventMetricKpiVerifier
/// @notice Declaration surface for `EventMetricKpiVerifier`.
/// @dev `Aggregation` is declared here rather than in the implementation because `KpiConfigured`
///      carries it: an event's parameter types are part of the declaration, so the enum has to live
///      wherever the event does. `KpiConfig` stays with the implementation — it is storage layout
///      rather than declared surface, and nothing here references it.
interface IEventMetricKpiVerifier is IKpiVerifier {
    // ── errors ───────────────────────────────────────────────────

    error ZeroAddress();
    error EmptyEventSignature();
    error BadWindow(uint256 windowStartBlock, uint256 windowEndBlock);
    error KpiNotConfigured(address campaign, uint256 kpiIndex);
    error LengthMismatch(uint256 users, uint256 totals);
    error CheckpointRegression(uint256 current, uint256 provided);
    error PastReportWindow(uint256 windowEndBlock, uint256 provided);
    error NotReporter(address caller);

    // ── events ───────────────────────────────────────────────────

    /// @notice Emitted when the reporter key rotates.
    /// @param oldReporter Previously authorized reporter.
    /// @param newReporter Newly authorized reporter.
    event ReporterUpdated(address indexed oldReporter, address indexed newReporter);

    /// @notice Emitted when a KPI's watch config is set or replaced.
    /// @param campaign Campaign the KPI belongs to.
    /// @param kpiIndex Index of the KPI within that campaign.
    /// @param targetContract Contract emitting the watched event.
    /// @param eventSignature Human-readable event ABI the relayer decodes against.
    /// @param userParamIndex Declaration-order position of the user-address param.
    /// @param aggregation `COUNT` or `SUM`.
    /// @param valueParamIndex Declaration-order position of the summed param; unused for `COUNT`.
    /// @param scale Divisor applied to cumulative totals before reporting; 0 is read as 1.
    /// @param windowStartBlock First block in scope.
    /// @param windowEndBlock Last block in scope.
    event KpiConfigured(
        address indexed campaign,
        uint256 indexed kpiIndex,
        address targetContract,
        string eventSignature,
        uint8 userParamIndex,
        Aggregation aggregation,
        uint8 valueParamIndex,
        uint256 scale,
        uint256 windowStartBlock,
        uint256 windowEndBlock
    );

    /// @notice Emitted when a config change invalidates every total already observed for a KPI.
    /// @dev Fires only when `setKpiConfig` changes *what is watched* — the contract, event signature,
    ///      param indexes, aggregation, scale, or window start. Extending `windowEndBlock`, the reason
    ///      replacement is allowed in the first place, does not fire it.
    ///
    ///      A bumped epoch is what makes the invalidation real rather than advisory: totals are keyed
    ///      by it, so every figure observed under the old config becomes unreachable in the same
    ///      transaction and the checkpoint restarts from the window. Without this, totals accumulated
    ///      from the wrong event would stay live as the cap a claim is measured against.
    /// @param campaign Campaign the KPI belongs to.
    /// @param kpiIndex Index of the KPI within that campaign.
    /// @param epoch The generation now in force. Totals reported under earlier epochs are abandoned.
    event KpiTotalsInvalidated(address indexed campaign, uint256 indexed kpiIndex, uint256 epoch);

    /// @notice Emitted for each user whose observed total was pushed.
    /// @param campaign Campaign the KPI belongs to.
    /// @param kpiIndex Index of the KPI within that campaign.
    /// @param user End user the metric describes.
    /// @param verifiedTotal Cumulative metric the relayer observed for that user.
    event VerifiedTotalReported(
        address indexed campaign, uint256 indexed kpiIndex, address indexed user, uint256 verifiedTotal
    );

    /// @notice Emitted when the scan checkpoint moves forward.
    /// @param campaign Campaign the KPI belongs to.
    /// @param kpiIndex Index of the KPI within that campaign.
    /// @param scannedUpToBlock Block the relayer has now fully incorporated.
    event CheckpointAdvanced(address indexed campaign, uint256 indexed kpiIndex, uint256 scannedUpToBlock);

    // ── types ────────────────────────────────────────────────────

    /// @notice How matching events fold into a user's total.
    enum Aggregation {
        /// @dev Each matching event contributes 1 (e.g. "5 deposits").
        COUNT,
        /// @dev Each matching event contributes its decoded numeric param (e.g. "12,400 USDC").
        SUM
    }
}
