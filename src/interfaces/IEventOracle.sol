// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title IEventOracle
/// @notice Interface for oracles that track verified on-chain events.
/// @dev Event counts are indexed and maintained off-chain by an indexer/oracle, then queried
///      on-chain by verifiers to substantiate reported user actions.
interface IEventOracle {
    /// @notice Get the verified cumulative count of events for a user.
    /// @param campaign The campaign context.
    /// @param eventType The event identifier (e.g., keccak256("Deposit(address,uint256)")).
    /// @param user The user whose events are being queried.
    /// @return cumulativeCount The cumulative number of events of this type for this user.
    function eventCount(
        address campaign,
        bytes32 eventType,
        address user
    ) external view returns (uint256 cumulativeCount);

    /// @notice Get the verified cumulative amount from events for a user.
    /// @param campaign The campaign context.
    /// @param eventType The event identifier (e.g., keccak256("Deposit(address,uint256)")).
    /// @param user The user whose events are being queried.
    /// @return cumulativeAmount The cumulative amount from all events of this type for this user.
    function eventAmount(
        address campaign,
        bytes32 eventType,
        address user
    ) external view returns (uint256 cumulativeAmount);

    /// @notice Get the verified cumulative amount for a specific token within an event stream.
    /// @param campaign The campaign context.
    /// @param eventType The event identifier.
    /// @param user The user whose events are being queried.
    /// @param token The specific token to filter by (e.g., WETH address for Deposit events).
    /// @return cumulativeAmount The cumulative amount for this specific token.
    function eventAmountByToken(
        address campaign,
        bytes32 eventType,
        address user,
        address token
    ) external view returns (uint256 cumulativeAmount);
}
