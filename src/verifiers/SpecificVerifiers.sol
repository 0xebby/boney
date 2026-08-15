// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IKpiVerifier} from "../interfaces/IKpiVerifier.sol";
import {IEventOracle} from "../interfaces/IEventOracle.sol";

/// @title SwapVerifier
/// @notice Verifies Swap events (e.g., Uniswap Swap(address sender, ...)) for a user.
/// @dev Queries an oracle for verified cumulative swap amounts and caps reported amounts
///      at verified totals.
contract SwapVerifier is IKpiVerifier {
    error MissingOracle();
    error SwapAmountExceeded(uint256 verifiedAmount, uint256 reportedAmount);

    /// @notice Event signature for "Swap(address,int256,int256,uint160,uint128,int24)".
    bytes32 public constant SWAP_SIGNATURE = keccak256("Swap(address,int256,int256,uint160,uint128,int24)");

    /// @notice The oracle providing verified swap counts.
    IEventOracle public immutable oracle;

    constructor(address oracle_) {
        if (oracle_ == address(0)) revert MissingOracle();
        oracle = IEventOracle(oracle_);
    }

    /// @notice Verify a reported swap amount against independently observed Swap events.
    /// @param campaign The campaign requesting verification.
    /// @param kpiIndex Index of the KPI (unused; for interface compliance).
    /// @param user The end user whose swaps are being verified.
    /// @param newTotal The cumulative swap amount reported by the oracle/reporter.
    /// @param evidence Optional proof (reserved for future use).
    /// @param params Unused (reserved for future filtering).
    /// @return credited The amount to credit; min(reported, verified swaps).
    function verify(
        address campaign,
        uint256 kpiIndex,
        address user,
        uint256 newTotal,
        bytes calldata evidence,
        bytes calldata params
    ) external view returns (uint256 credited) {
        uint256 verifiedAmount = oracle.eventAmount(campaign, SWAP_SIGNATURE, user);

        if (verifiedAmount > newTotal) {
            revert SwapAmountExceeded(verifiedAmount, newTotal);
        }

        return verifiedAmount;
    }
}

/// @title MintVerifier
/// @notice Verifies Mint(address to, uint256 amount) events for a user.
/// @dev Queries an oracle for verified cumulative mint amounts and caps reported amounts
///      at verified totals.
contract MintVerifier is IKpiVerifier {
    error MissingOracle();
    error MintAmountExceeded(uint256 verifiedAmount, uint256 reportedAmount);

    /// @notice Event signature for "Mint(address,uint256)".
    bytes32 public constant MINT_SIGNATURE = keccak256("Mint(address,uint256)");

    /// @notice The oracle providing verified mint counts.
    IEventOracle public immutable oracle;

    constructor(address oracle_) {
        if (oracle_ == address(0)) revert MissingOracle();
        oracle = IEventOracle(oracle_);
    }

    /// @notice Verify a reported mint amount against independently observed Mint events.
    /// @param campaign The campaign requesting verification.
    /// @param kpiIndex Index of the KPI (unused; for interface compliance).
    /// @param user The end user whose mints are being verified.
    /// @param newTotal The cumulative mint amount reported by the oracle/reporter.
    /// @param evidence Optional proof (reserved for future use).
    /// @param params Unused (reserved for future filtering).
    /// @return credited The amount to credit; min(reported, verified mints).
    function verify(
        address campaign,
        uint256 kpiIndex,
        address user,
        uint256 newTotal,
        bytes calldata evidence,
        bytes calldata params
    ) external view returns (uint256 credited) {
        uint256 verifiedAmount = oracle.eventAmount(campaign, MINT_SIGNATURE, user);

        if (verifiedAmount > newTotal) {
            revert MintAmountExceeded(verifiedAmount, newTotal);
        }

        return verifiedAmount;
    }
}

/// @title StakeVerifier
/// @notice Verifies Stake(address user, uint256 amount) events for a user.
/// @dev Queries an oracle for verified cumulative stake amounts and caps reported amounts
///      at verified totals.
contract StakeVerifier is IKpiVerifier {
    error MissingOracle();
    error StakeAmountExceeded(uint256 verifiedAmount, uint256 reportedAmount);

    /// @notice Event signature for "Stake(address,uint256)".
    bytes32 public constant STAKE_SIGNATURE = keccak256("Stake(address,uint256)");

    /// @notice The oracle providing verified stake counts.
    IEventOracle public immutable oracle;

    constructor(address oracle_) {
        if (oracle_ == address(0)) revert MissingOracle();
        oracle = IEventOracle(oracle_);
    }

    /// @notice Verify a reported stake amount against independently observed Stake events.
    /// @param campaign The campaign requesting verification.
    /// @param kpiIndex Index of the KPI (unused; for interface compliance).
    /// @param user The end user whose stakes are being verified.
    /// @param newTotal The cumulative stake amount reported by the oracle/reporter.
    /// @param evidence Optional proof (reserved for future use).
    /// @param params Unused (reserved for future filtering).
    /// @return credited The amount to credit; min(reported, verified stakes).
    function verify(
        address campaign,
        uint256 kpiIndex,
        address user,
        uint256 newTotal,
        bytes calldata evidence,
        bytes calldata params
    ) external view returns (uint256 credited) {
        uint256 verifiedAmount = oracle.eventAmount(campaign, STAKE_SIGNATURE, user);

        if (verifiedAmount > newTotal) {
            revert StakeAmountExceeded(verifiedAmount, newTotal);
        }

        return verifiedAmount;
    }
}

/// @title BridgeVerifier
/// @notice Verifies Bridge(address user, uint256 amount) events for a user.
/// @dev Queries an oracle for verified cumulative bridge amounts and caps reported amounts
///      at verified totals.
contract BridgeVerifier is IKpiVerifier {
    error MissingOracle();
    error BridgeAmountExceeded(uint256 verifiedAmount, uint256 reportedAmount);

    /// @notice Event signature for "Bridge(address,uint256)".
    bytes32 public constant BRIDGE_SIGNATURE = keccak256("Bridge(address,uint256)");

    /// @notice The oracle providing verified bridge counts.
    IEventOracle public immutable oracle;

    constructor(address oracle_) {
        if (oracle_ == address(0)) revert MissingOracle();
        oracle = IEventOracle(oracle_);
    }

    /// @notice Verify a reported bridge amount against independently observed Bridge events.
    /// @param campaign The campaign requesting verification.
    /// @param kpiIndex Index of the KPI (unused; for interface compliance).
    /// @param user The end user whose bridges are being verified.
    /// @param newTotal The cumulative bridge amount reported by the oracle/reporter.
    /// @param evidence Optional proof (reserved for future use).
    /// @param params Unused (reserved for future filtering).
    /// @return credited The amount to credit; min(reported, verified bridges).
    function verify(
        address campaign,
        uint256 kpiIndex,
        address user,
        uint256 newTotal,
        bytes calldata evidence,
        bytes calldata params
    ) external view returns (uint256 credited) {
        uint256 verifiedAmount = oracle.eventAmount(campaign, BRIDGE_SIGNATURE, user);

        if (verifiedAmount > newTotal) {
            revert BridgeAmountExceeded(verifiedAmount, newTotal);
        }

        return verifiedAmount;
    }
}
