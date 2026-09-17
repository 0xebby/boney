// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Types} from "../libraries/Types.sol";
import {IAttributionRegistry} from "./IAttributionRegistry.sol";

/// @title ICampaign
/// @notice A single performance campaign: escrowed rewards released as attributed KPI progress
/// crosses per-promoter thresholds.
interface ICampaign {
    /// @notice One cumulative user-action report in a campaign batch.
    /// @param kpiIndex Index of the KPI being reported against.
    /// @param user The end user whose action is credited.
    /// @param newTotal Cumulative amount for the user and KPI pair.
    /// @param evidence Report-specific proof forwarded to the KPI verifier.
    struct UserActionReport {
        uint256 kpiIndex;
        address user;
        uint256 newTotal;
        bytes evidence;
    }

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

    /// @notice Emitted when the project extends the reporting window.
    /// @param oldEndTime Previous reporting deadline.
    /// @param newEndTime New reporting deadline.
    event Extended(uint64 oldEndTime, uint64 newEndTime);

    /// @notice Emitted when the project adds escrow to the reward pool.
    /// @param oldRewardPool Pool ceiling before the top-up.
    /// @param newRewardPool Pool ceiling after the top-up.
    event PoolIncreased(uint256 oldRewardPool, uint256 newRewardPool);

    /// @notice Emitted when an unpaid tier shortfall is claimed.
    /// @param promoterId Promoter owed the shortfall.
    /// @param promoter Wallet receiving the payment.
    /// @param kpiIndex KPI whose shortfall was paid.
    /// @param amount Amount paid.
    event ShortfallPaid(
        bytes32 indexed promoterId, address indexed promoter, uint256 indexed kpiIndex, uint256 amount
    );

    /// @notice Emitted when a project grants or revokes an automated reporting account.
    /// @param reporter Account whose reports are being configured.
    /// @param allowed Whether the account may report user actions.
    event AuthorizedReporterUpdated(address indexed reporter, bool allowed);

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

    /// @notice Extend the reporting window by at most half its original duration.
    /// @dev Only Active and Paused campaigns may be extended. The new deadline must be later than
    ///      the current deadline and no later than the fixed maximum deadline.
    /// @param newEndTime New reporting deadline.
    function extend(uint64 newEndTime) external;

    /// @notice Add project funds to the reward pool after it is substantially depleted.
    /// @dev Requires 90 percent of the current pool to be paid out and a top-up of at least 20
    ///      percent of the initial pool.
    /// @param amount Amount requested from the project.
    function topUp(uint256 amount) external;

    /// @notice Join as a promoter (KOL). Reverts unless the caller's reputation clears
    ///         `minReputation`.
    /// @return promoterId The caller's campaign-bound promoter id, to encode in boneylink(boney promoter tracking link) links.
    function join() external returns (bytes32 promoterId);

    /// @notice Credit an attributed end-user action toward the promoter who owns that user.
    /// @param kpiIndex Index of the KPI being reported against.
    /// @param user The end user whose action is credited.
    /// @param newTotal Cumulative amount for this `(user, kpiIndex)` pair, not a delta.
    /// @param evidence Report-specific proof data forwarded to the KPI's verifier.
    function reportUserAction(uint256 kpiIndex, address user, uint256 newTotal, bytes calldata evidence)
        external;

    /// @notice Credit an ordered batch of cumulative end-user actions atomically.
    /// @dev Each item follows `reportUserAction` semantics. A failing item reverts the full batch.
    /// @param reports Reports to process in caller-supplied order.
    function reportUserActionsBatch(UserActionReport[] calldata reports) external;

    /// @notice Allow or disallow an account to report user actions for this campaign.
    /// @param reporter Account to configure.
    /// @param allowed Whether the account may report.
    function setAuthorizedReporter(address reporter, bool allowed) external;

    /// @notice Apply a campaign-level aggregate update. Oracle coordinator only.
    /// @param kpiIndex Index of the aggregate KPI.
    /// @param newTotal New campaign-level total; must be monotonically non-decreasing.
    function applyAggregateUpdate(uint256 kpiIndex, uint256 newTotal) external;

    /// @notice Settle any unpaid tiers a promoter has already earned.
    /// @param promoter The promoter to pay out.
    /// @param kpiIndex Index of the KPI whose tier ladder is settled.
    function settle(address promoter, uint256 kpiIndex) external;

    /// @notice Pay an earned tier shortfall from newly available escrow.
    /// @dev Pays the caller's outstanding amount for the selected KPI, or the available remainder
    ///      when escrow cannot cover it in full.
    /// @param kpiIndex KPI whose shortfall is owed.
    function claimShortfall(uint256 kpiIndex) external;

    /// @notice Return unspent escrow to the project once the campaign is terminal and the claim
    ///         grace window has elapsed.
    function reclaimUnspent() external;

    /// @notice Current lifecycle status of the campaign.
    /// @return The campaign status.
    function status() external view returns (Types.CampaignStatus);

    /// @notice The campaign configuration.
    /// @return The campaign parameters, including the current pool and end time.
    function config() external view returns (Types.CampaignConfig memory);

    /// @notice Current reward pool ceiling.
    /// @return The current pool ceiling.
    function rewardPool() external view returns (uint256);

    /// @notice Start of the reporting window.
    /// @return The campaign start time.
    function startTime() external view returns (uint64);

    /// @notice Current reporting deadline.
    /// @return The current end time.
    function endTime() external view returns (uint64);

    /// @notice Timestamp when the campaign entered a terminal status.
    /// @return The terminal transition time, or zero.
    function endedAt() external view returns (uint64);

    /// @notice Post-end report and settlement window.
    /// @return The claim grace duration.
    function CLAIM_GRACE() external view returns (uint64);

    /// @notice Post-end deadline for applying previously submitted aggregate reports.
    /// @return The aggregate update deadline.
    function aggregateUpdateDeadline() external view returns (uint256);

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

    /// @notice Attribution registry used by this campaign.
    /// @return The campaign's attribution registry.
    function attributionRegistry() external view returns (IAttributionRegistry);

    /// @notice Rewards released from the pool so far.
    /// @return The cumulative amount paid out.
    function paidOut() external view returns (uint256);

    /// @notice Whether an account may report user actions for this campaign.
    /// @param reporter Account to check.
    /// @return True when the project has authorized the account.
    function authorizedReporters(address reporter) external view returns (bool);

    /// @notice Cumulative amount already credited for a `(user, kpi)` pair.
    /// @param user The end user.
    /// @param kpiIndex Index of the KPI.
    /// @return Amount credited so far.
    function userCreditedOf(address user, uint256 kpiIndex) external view returns (uint256);

    /// @notice Block of the last report that credited a `(user, kpi)` pair.
    /// @param user The end user.
    /// @param kpiIndex Index of the KPI.
    /// @return Block number, or zero when the pair has not been credited.
    function lastReportBlockOf(address user, uint256 kpiIndex) external view returns (uint64);

    /// @notice The campaign's project.
    /// @return The project address.
    function getProject() external view returns (address);

    /// @notice The coordinator authorized to push oracle updates.
    /// @return The oracle coordinator address.
    function getOracle() external view returns (address);
}
