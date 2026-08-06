// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title IKpiVerifier
/// @notice Extension point that lets anyone define a new KPI without modifying core contracts.
/// @dev A campaign calls `verify` before crediting progress. Implementations are expected to be
///      view-only and must revert (or return 0) when the evidence does not substantiate the claim.
interface IKpiVerifier {
    /// @notice Substantiate a reported KPI delta and return how much of it may be credited.
    /// @param campaign The campaign requesting verification.
    /// @param kpiIndex Index of the KPI within that campaign.
    /// @param user The end user whose action is being credited.
    /// @param amount The raw amount claimed by the reporter.
    /// @param evidence Report-specific proof data (e.g. a receipt or log reference).
    /// @param params The KPI's configured `params` blob.
    /// @return credited Amount to actually credit; may be less than `amount`, never more.
    function verify(
        address campaign,
        uint256 kpiIndex,
        address user,
        uint256 amount,
        bytes calldata evidence,
        bytes calldata params
    ) external view returns (uint256 credited);
}
