// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IKpiVerifier} from "./IKpiVerifier.sol";

/// @title ITouchWindowVerifier
/// @notice Declaration surface for `TouchWindowVerifier`.
/// @dev Errors live here rather than in the implementation so every revert this adapter can produce
///      is declared in one place, alongside the events and errors of every other module. The
///      `Action` struct stays with the implementation: it is evidence-encoding detail rather than
///      part of this adapter's declared surface.
interface ITouchWindowVerifier is IKpiVerifier {
    // ── errors ───────────────────────────────────────────────────

    error EvidenceExceedsClaim(uint256 total, uint256 amount);
    error FutureAction(uint64 timestamp, uint64 blockTimestamp);
}
