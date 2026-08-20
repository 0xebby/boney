// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IKpiVerifier} from "./IKpiVerifier.sol";

/// @title IGuardedKpiVerifier
/// @notice Declaration surface for `GuardedKpiVerifier`.
/// @dev `Mode` is declared here rather than in the implementation because `GuardConfigured` carries
///      it: an event's parameter types are part of the declaration, so the enum has to live wherever
///      the event does.
interface IGuardedKpiVerifier is IKpiVerifier {
    // ── errors ───────────────────────────────────────────────────

    error ZeroAddress();
    error BpsOutOfRange(uint16 toleranceBps);
    error NotConfigured(address campaign, uint256 kpiIndex);
    error VerifierDisagreement(uint256 projectValue, uint256 boneyValue, uint256 diff, uint256 allowed);

    // ── events ───────────────────────────────────────────────────

    /// @notice Emitted when a KPI's guard config is set or replaced.
    /// @param campaign Campaign the KPI belongs to.
    /// @param kpiIndex Index of the KPI within that campaign.
    /// @param projectVerifier The second verifier, or `address(0)` for Boney alone.
    /// @param toleranceBps Allowed divergence in basis points; meaningful under `AGREE`.
    /// @param mode `AGREE` or `CAP`.
    event GuardConfigured(
        address indexed campaign,
        uint256 indexed kpiIndex,
        address projectVerifier,
        uint16 toleranceBps,
        Mode mode
    );

    // ── types ────────────────────────────────────────────────────

    /// @notice How the second verifier's answer is combined with Boney's.
    enum Mode {
        /// @dev Require agreement within tolerance; revert otherwise. Boney's value is credited.
        AGREE,
        /// @dev Credit `min(boney, project)`. For a stricter lens measuring a narrower quantity.
        CAP
    }
}
