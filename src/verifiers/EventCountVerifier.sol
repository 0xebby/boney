// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IKpiVerifier} from "../interfaces/IKpiVerifier.sol";
import {IEventOracle} from "../interfaces/IEventOracle.sol";

/// @title EventCountVerifier
/// @notice Verifies event occurrence count (e.g., "number of Deposit events for this user").
/// @dev Each event contributes exactly 1 to the count, regardless of amount. Queries an oracle
///      for verified event counts and caps reported counts at verified totals.
contract EventCountVerifier is IKpiVerifier {
    error MissingOracle();
    error EventCountExceeded(uint256 verifiedCount, uint256 reportedCount);

    /// @notice The oracle providing verified event counts.
    IEventOracle public immutable oracle;

    constructor(address oracle_) {
        if (oracle_ == address(0)) revert MissingOracle();
        oracle = IEventOracle(oracle_);
    }

    /// @notice Verify a reported event count against independently observed events.
    /// @param campaign The campaign requesting verification.
    /// @param kpiIndex Index of the KPI (unused; for interface compliance).
    /// @param user The end user whose events are being verified.
    /// @param newTotal The cumulative event count reported by the oracle/reporter.
    /// @param evidence Optional proof (reserved for future use).
    /// @param params Encoded event signature:
    ///        abi.encode(bytes32 eventSignature)
    ///        e.g., abi.encode(keccak256("Deposit(address,uint256)"))
    /// @return credited The count to credit; min(reported, verified event count).
    function verify(
        address campaign,
        uint256 kpiIndex,
        address user,
        uint256 newTotal,
        bytes calldata evidence,
        bytes calldata params
    ) external view returns (uint256 credited) {
        bytes32 eventSignature = abi.decode(params, (bytes32));

        // Query the oracle for independently verified event count.
        uint256 verifiedCount = oracle.eventCount(campaign, eventSignature, user);

        // Never credit more than the verified count.
        if (verifiedCount > newTotal) {
            revert EventCountExceeded(verifiedCount, newTotal);
        }

        return verifiedCount;
    }
}
