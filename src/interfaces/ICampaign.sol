// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Types} from "../libraries/Types.sol";

/// @title ICampaign
/// @notice A single performance campaign: escrowed rewards released as attributed KPI progress
///         crosses per-promoter thresholds.
interface ICampaign {
    // ── errors ───────────────────────────────────────────────────

    error NotProject();
    error NotReporter();
    error NotOracle();
    error WrongStatus(Types.CampaignStatus actual);
    error AlreadyJoined();
    error NotJoined();
    error InsufficientReputation(uint256 score, uint256 required);
    error UnreachableReputation(uint256 required, uint256 maxScore);
    error UnknownKpi(uint256 kpiIndex);
    error AggregateKpi(uint256 kpiIndex);
    error NotAggregateKpi(uint256 kpiIndex);
    error NoAttribution(address user);
    error NonMonotonic(uint256 current, uint256 provided);
    error VerifierOvercredit(uint256 credited, uint256 max);
    error OutsideWindow(uint64 startTime, uint64 endTime);
    error NotFunded(uint256 balance, uint256 required);
    error ClaimWindowOpen(uint64 until);
    error NothingToReclaim();
    error ZeroAddress();
    error InvalidWindow();
    error ZeroRewardPool();
    error NoKpis();
    error TierLengthMismatch();
    error EmptyTiers(uint256 kpiIndex);
    error TiersNotAscending(uint256 kpiIndex, uint256 tierIndex);
    error ZeroTierReward(uint256 kpiIndex, uint256 tierIndex);
    error CustomKpiNeedsVerifier(uint256 kpiIndex);
    error TooManyKpis(uint256 provided, uint256 max);
    error TooManyTiers(uint256 kpiIndex, uint256 provided, uint256 max);

    // ── events ───────────────────────────────────────────────────

    /// @notice Emitted once the reward pool is fully escrowed and reporting opens.
    /// @param startTime When reports begin being accepted.
    /// @param endTime When they stop.
    event Activated(uint64 startTime, uint64 endTime);

    /// @notice Emitted on every campaign status transition.
    /// @param previous Status before the transition.
    /// @param current Status after it.
    event StatusChanged(Types.CampaignStatus previous, Types.CampaignStatus current);

    /// @notice Emitted when a promoter passes the reputation gate and joins.
    /// @param promoter The promoter's wallet.
    /// @param promoterId Their campaign-scoped attribution id.
    /// @param reputation Score at join time; recorded because the gate is only checked once.
    event PromoterJoined(address indexed promoter, bytes32 indexed promoterId, uint256 reputation);

    /// @notice Emitted when a user's action is credited to the promoter who attributed them.
    /// @param kpiIndex KPI the progress counts toward.
    /// @param promoterId Promoter receiving the credit.
    /// @param user End user whose action produced it.
    /// @param amount Progress credited by this report.
    event ProgressCredited(
        uint256 indexed kpiIndex, bytes32 indexed promoterId, address indexed user, uint256 amount
    );

    /// @notice Emitted when the campaign-level total for a KPI moves.
    /// @param kpiIndex The KPI that advanced.
    /// @param total New running total across all promoters.
    event AggregateProgress(uint256 indexed kpiIndex, uint256 total);

    /// @notice Emitted per tier crossed. One report can cross several, emitting one event each.
    /// @param promoterId Promoter being paid.
    /// @param promoter Their wallet, the payout recipient.
    /// @param kpiIndex KPI whose ladder was crossed.
    /// @param tier Index of the crossed tier.
    /// @param paid Amount actually released, which is less than the tier reward if the pool ran
    ///        short. Compare against the tier's configured reward to detect a partial payout.
    event TierSettled(
        bytes32 indexed promoterId,
        address indexed promoter,
        uint256 indexed kpiIndex,
        uint256 tier,
        uint256 paid
    );

    /// @notice Emitted when earned rewards exceed the remaining pool. The campaign pays what it
    ///         can rather than reverting, so this is the signal that a promoter was underpaid.
    /// @param shortfall Amount earned but not payable.
    event PoolExhausted(uint256 shortfall);

    /// @notice Emitted when unspent escrow returns to the project.
    /// @param to Recipient, always the project.
    /// @param amount Amount returned.
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
    ///         `minReputation`.
    /// @return promoterId The caller's campaign-bound promoter id, to encode in tracking links.
    function join() external returns (bytes32 promoterId);

    /// @notice Credit an attributed end-user action toward the promoter who owns that user.
    /// @dev Callable by the project or the oracle coordinator. Runs the KPI's verifier adapter
    ///      when one is configured, then settles any newly crossed tiers.
    /// @param kpiIndex Index of the KPI being reported against.
    /// @param user The end user whose action is credited.
    /// @param newTotal Cumulative amount for this `(user, kpiIndex)` pair, not a delta. Only
    ///        `newTotal` minus what was already credited is applied, so replays are no-ops.
    /// @param evidence Report-specific proof data forwarded to the KPI's verifier.
    function reportUserAction(uint256 kpiIndex, address user, uint256 newTotal, bytes calldata evidence)
        external;

    /// @notice Apply a campaign-level aggregate update. Oracle coordinator only.
    /// @param kpiIndex Index of the aggregate KPI.
    /// @param newTotal New campaign-level total; must be monotonically non-decreasing.
    function applyAggregateUpdate(uint256 kpiIndex, uint256 newTotal) external;

    /// @notice Settle any unpaid tiers a promoter has already earned.
    /// @param promoter The promoter to pay out.
    /// @param kpiIndex Index of the KPI whose tier ladder is settled.
    function settle(address promoter, uint256 kpiIndex) external;

    /// @notice Return unspent escrow to the project once the campaign is terminal and the claim
    ///         grace window has elapsed.
    function reclaimUnspent() external;

    /// @notice Current lifecycle status of the campaign.
    /// @return The campaign status.
    function status() external view returns (Types.CampaignStatus);

    /// @notice The campaign's immutable configuration.
    /// @return The frozen campaign parameters.
    function config() external view returns (Types.CampaignConfig memory);

    /// @notice Number of KPIs defined on this campaign.
    /// @return The KPI count.
    function kpiCount() external view returns (uint256);

    /// @notice The KPI spec at `index`.
    /// @param index Index of the KPI.
    /// @return The KPI specification.
    function kpi(uint256 index) external view returns (Types.KpiSpec memory);

    /// @notice The reward tier ladder for a KPI.
    /// @param kpiIndex Index of the KPI.
    /// @return Tiers in ascending threshold order.
    function tiers(uint256 kpiIndex) external view returns (Types.RewardTier[] memory);

    /// @notice The campaign-bound promoter id issued to `promoter`.
    /// @param promoter The promoter wallet.
    /// @return The promoter id, or `bytes32(0)` if they have not joined.
    function promoterIdOf(address promoter) external view returns (bytes32);

    /// @notice The wallet behind a promoter id issued by this campaign.
    /// @param promoterId The promoter id.
    /// @return The promoter wallet, or `address(0)` if unknown here.
    function promoterOf(bytes32 promoterId) external view returns (address);

    /// @notice Cumulative attributed progress for a `(promoter, kpi)` pair.
    /// @param promoter The promoter.
    /// @param kpiIndex Index of the KPI.
    /// @return Progress credited to the promoter so far.
    function progressOf(address promoter, uint256 kpiIndex) external view returns (uint256);

    /// @notice Campaign-wide total progress for a KPI.
    /// @param kpiIndex Index of the KPI.
    /// @return The campaign-level total.
    function totalProgress(uint256 kpiIndex) external view returns (uint256);

    /// @notice Rewards released from the pool so far.
    /// @return The cumulative amount paid out.
    function paidOut() external view returns (uint256);

    function getProject() external view returns (address);

    function getOracle() external view returns (address);
}
