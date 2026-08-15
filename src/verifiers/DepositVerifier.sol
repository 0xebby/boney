// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IKpiVerifier} from "../interfaces/IKpiVerifier.sol";
import {IEventOracle} from "../interfaces/IEventOracle.sol";

/// @title DepositVerifier
/// @notice Verifies Deposit(address dst, uint256 wad) events from a target contract (e.g., WETH).
/// @dev Queries an oracle for verified cumulative deposit amounts for a user and caps
///      the reported amount at what was independently observed.
contract DepositVerifier is IKpiVerifier {
    error MissingOracle();
    error DepositAmountExceeded(uint256 verifiedAmount, uint256 reportedAmount);

    /// @notice Event signature for "Deposit(address,uint256)".
    bytes32 public constant DEPOSIT_SIGNATURE = keccak256("Deposit(address,uint256)");

    /// @notice The oracle providing verified deposit counts.
    IEventOracle public immutable oracle;

    constructor(address oracle_) {
        if (oracle_ == address(0)) revert MissingOracle();
        oracle = IEventOracle(oracle_);
    }

    /// @notice Verify a reported deposit amount against independently observed Deposit events.
    /// @param campaign The campaign requesting verification.
    /// @param kpiIndex Index of the KPI (unused; for interface compliance).
    /// @param user The end user whose deposits are being verified.
    /// @param newTotal The cumulative deposit amount reported by the oracle/reporter.
    /// @param evidence Optional proof (reserved for future use).
    /// @param params Unused (reserved for future filtering).
    /// @return credited The amount to credit; min(reported, verified deposits).
    function verify(
        address campaign,
        uint256 kpiIndex,
        address user,
        uint256 newTotal,
        bytes calldata evidence,
        bytes calldata params
    ) external view returns (uint256 credited) {
        // Query the oracle for independently verified cumulative deposit amount.
        uint256 verifiedAmount = oracle.eventAmount(campaign, DEPOSIT_SIGNATURE, user);

        // Never credit more than the verified amount.
        if (verifiedAmount > newTotal) {
            revert DepositAmountExceeded(verifiedAmount, newTotal);
        }

        return verifiedAmount;
    }
}
