// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Types} from "../libraries/Types.sol";

/// @title ICampaign
/// @notice A single performance campaign: escrowed rewards released as attributed KPI progress
///         crosses per-promoter thresholds.
interface ICampaign {
    event Activated(uint64 startTime, uint64 endTime);
    event StatusChanged(Types.CampaignStatus previous, Types.CampaignStatus current);
    event PromoterJoined(address indexed promoter, bytes32 indexed promoterId, uint256 reputation);
    event ProgressCredited(
        uint256 indexed kpiIndex, bytes32 indexed promoterId, address indexed user, uint256 amount
    );
    event AggregateProgress(uint256 indexed kpiIndex, uint256 total);
    event TierSettled(
        bytes32 indexed promoterId,
        address indexed promoter,
        uint256 indexed kpiIndex,
        uint256 tier,
        uint256 paid
    );
    event PoolExhausted(uint256 shortfall);
    event Reclaimed(address indexed to, uint256 amount);

    /// @notice Move from `Pending` to `Active` once the reward pool is fully escrowed.
    function activate() external;

    /// @notice Reversibly halt KPI reporting and settlement.
    function pause() external;

    /// @notice Resume from `Paused`.
    function unpause() external;

    /// @notice Terminate the campaign. Allowed after `endTime`, or earlier by the project.
    function end() external;

    /// @notice Cancel before activation and release escrow back to the project.
    function cancel() external;

    /// @notice Join as a promoter (KOL). Reverts unless the caller's reputation clears
    ///         `minReputation`. Returns the caller's campaign-bound promoter id.
    function join() external returns (bytes32 promoterId);

    /// @notice Credit an attributed end-user action toward the promoter who owns that user.
    /// @dev Callable by the project or the oracle coordinator. Runs the KPI's verifier adapter
    ///      when one is configured, then settles any newly crossed tiers.
    function reportUserAction(uint256 kpiIndex, address user, uint256 amount, bytes calldata evidence)
        external;

    /// @notice Apply a campaign-level aggregate update. Oracle coordinator only.
    function applyAggregateUpdate(uint256 kpiIndex, uint256 newTotal) external;

    /// @notice Settle any unpaid tiers a promoter has already earned.
    function settle(address promoter, uint256 kpiIndex) external;

    /// @notice Return unspent escrow to the project once the campaign is terminal and the claim
    ///         grace window has elapsed.
    function reclaimUnspent() external;

    function status() external view returns (Types.CampaignStatus);
    function config() external view returns (Types.CampaignConfig memory);
    function kpiCount() external view returns (uint256);
    function kpi(uint256 index) external view returns (Types.KpiSpec memory);
    function tiers(uint256 kpiIndex) external view returns (Types.RewardTier[] memory);
    function promoterIdOf(address promoter) external view returns (bytes32);
    function promoterOf(bytes32 promoterId) external view returns (address);
    function progressOf(address promoter, uint256 kpiIndex) external view returns (uint256);
    function totalProgress(uint256 kpiIndex) external view returns (uint256);
    function paidOut() external view returns (uint256);
}
