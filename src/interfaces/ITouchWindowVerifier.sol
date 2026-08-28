// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IKpiVerifier} from "./IKpiVerifier.sol";

/// @title ITouchWindowVerifier
/// @notice Declaration surface for `TouchWindowVerifier`.
/// @dev Errors are declared here; the `Action` struct stays with the implementation as
///      evidence-encoding detail.
interface ITouchWindowVerifier is IKpiVerifier {
    // ── errors ───────────────────────────────────────────────────

    error EvidenceExceedsClaim(uint256 total, uint256 amount);
    error FutureAction(uint64 timestamp, uint64 blockTimestamp);
}
