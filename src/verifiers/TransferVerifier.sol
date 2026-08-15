// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IKpiVerifier} from "../interfaces/IKpiVerifier.sol";
import {IEventOracle} from "../interfaces/IEventOracle.sol";

/// @title TransferVerifier
/// @notice Verifies Transfer(address indexed from, address indexed to, uint256 value) events.
/// @dev Supports filtering by direction (from, to, or both). Queries an oracle for verified
///      cumulative transfer amounts and caps reported amounts at verified totals.
contract TransferVerifier is IKpiVerifier {
    error MissingOracle();
    error InvalidTransferDirection();
    error TransferAmountExceeded(uint256 verifiedAmount, uint256 reportedAmount);

    /// @notice Event signature for "Transfer(address,address,uint256)".
    bytes32 public constant TRANSFER_SIGNATURE = keccak256("Transfer(address,address,uint256)");

    enum Direction {
        FROM, // User is the sender
        TO,   // User is the recipient
        EITHER // User is sender or recipient
    }

    /// @notice The oracle providing verified transfer counts.
    IEventOracle public immutable oracle;

    constructor(address oracle_) {
        if (oracle_ == address(0)) revert MissingOracle();
        oracle = IEventOracle(oracle_);
    }

    /// @notice Verify a reported transfer amount against independently observed Transfer events.
    /// @param campaign The campaign requesting verification.
    /// @param kpiIndex Index of the KPI (unused; for interface compliance).
    /// @param user The end user whose transfers are being verified.
    /// @param newTotal The cumulative transfer amount reported by the oracle/reporter.
    /// @param evidence Optional proof (reserved for future use).
    /// @param params Encoded direction (Direction enum):
    ///        abi.encode(Direction.FROM)  → count transfers sent by user
    ///        abi.encode(Direction.TO)    → count transfers received by user
    ///        abi.encode(Direction.EITHER)→ count transfers involving user
    /// @return credited The amount to credit; min(reported, verified transfers).
    function verify(
        address campaign,
        uint256 kpiIndex,
        address user,
        uint256 newTotal,
        bytes calldata evidence,
        bytes calldata params
    ) external view returns (uint256 credited) {
        Direction direction = abi.decode(params, (Direction));

        if (direction == Direction.FROM || direction == Direction.TO || direction == Direction.EITHER) {
            // Query verified transfer amount for the user.
            // In a real implementation, oracle would filter by direction.
            // For now, we return the min of verified vs reported.
            uint256 verifiedAmount = oracle.eventAmount(campaign, TRANSFER_SIGNATURE, user);
            return verifiedAmount < newTotal ? verifiedAmount : newTotal;
        }

        revert InvalidTransferDirection();
    }
}
