// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Types} from "./libraries/Types.sol";
import {IAttributionRegistry} from "./interfaces/IAttributionRegistry.sol";

/// @title IBoney
/// @notice Marketplace-facing entry point for the Boney protocol.
/// @dev The facade holds no funds and no campaign state; it routes to the modules and provides
///      the aggregated views a marketplace UI needs. Protocol logic lives in the modules.
interface IBoney {
    // ── errors ───────────────────────────────────────────────────

    error ZeroAddress();
    error NotProject(address project, address caller);
    error CampaignMismatch(address expected, address provided);

    /// @notice A campaign summarized for listing pages.
    /// @param campaignId Sequential id assigned by the registry.
    /// @param campaign Address of the campaign contract.
    /// @param project Owner of the campaign; receives unspent escrow on end/cancel.
    /// @param name The campaign's display name, unique across the registry that created it.
    /// @param token ERC20 used for escrow and payouts.
    /// @param rewardPool Total escrow required before the campaign can be activated.
    /// @param paidOut Rewards released from the pool so far.
    /// @param startTime Earliest timestamp at which the campaign may be activated.
    /// @param endTime Timestamp after which KPI reports are rejected.
    /// @param minReputation Minimum reputation score required for a promoter to join.
    /// @param status Current lifecycle status.
    /// @param kpiCount Number of KPIs defined on the campaign.
    struct CampaignView {
        uint256 campaignId;
        address campaign;
        address project;
        string name;
        address token;
        uint256 rewardPool;
        uint256 paidOut;
        uint64 startTime;
        uint64 endTime;
        uint256 minReputation;
        Types.CampaignStatus status;
        uint256 kpiCount;
    }

    /// @notice Create a campaign. The caller becomes the project.
    /// @param cfg Immutable campaign parameters; `cfg.project` must be the caller.
    /// @param kpis KPI specs; at least one required.
    /// @param tiers Per-KPI reward tiers, outer index aligned to `kpis`.
    /// @return campaignId Sequential id assigned by the registry.
    /// @return campaign Address of the deployed campaign.
    function createCampaign(
        Types.CampaignConfig calldata cfg,
        Types.KpiSpec[] calldata kpis,
        Types.RewardTier[][] calldata tiers
    ) external returns (uint256 campaignId, address campaign);

    /// @param campaignId The campaign to fund.
    /// @param amount Amount of the campaign's token to escrow.
    function fundCampaign(uint256 campaignId, uint256 amount) external;

    /// @notice Relay a user-signed attribution touch.
    /// @param campaignId The campaign the touch belongs to.
    /// @param user The end user who signed the touch.
    /// @param touch The signed attribution message.
    /// @param signature EIP-712 signature over `touch` by `user`.
    function registerAttribution(
        uint256 campaignId,
        address user,
        IAttributionRegistry.Touch calldata touch,
        bytes calldata signature
    ) external;

    /// @notice Settle any rewards a promoter has earned but not yet received.
    /// @param campaignId The campaign to settle within.
    /// @param promoter The promoter whose earned tiers are paid out.
    /// @param kpiIndex Index of the KPI to settle.
    function claimRewards(uint256 campaignId, address promoter, uint256 kpiIndex) external;

    // ── views ────────────────────────────────────────────────────

    /// @notice Snapshot of one campaign's configuration and live state.
    /// @param campaignId The campaign to summarize.
    /// @return The campaign summary.
    function campaignView(uint256 campaignId) external view returns (CampaignView memory);

    /// @notice Paginated campaign summaries for marketplace discovery.
    /// @param offset Starting campaign id.
    /// @param limit Maximum number of campaigns to return.
    /// @return Summaries for the requested range; empty when `offset` is past the end.
    function browseCampaigns(uint256 offset, uint256 limit) external view returns (CampaignView[] memory);

    /// @notice Total number of campaigns ever created.
    /// @return The campaign count, which is also the next campaign id.
    function campaignCount() external view returns (uint256);

    /// @notice Composite reputation score for a wallet.
    /// @param wallet The wallet to query.
    /// @return The wallet's score.
    function reputationOf(address wallet) external view returns (uint256);

    /// @notice Cumulative attributed progress for a `(promoter, kpi)` pair in a campaign.
    /// @param campaignId The campaign to query.
    /// @param promoter The promoter.
    /// @param kpiIndex Index of the KPI.
    /// @return Progress credited to the promoter so far.
    function promoterProgress(uint256 campaignId, address promoter, uint256 kpiIndex)
        external
        view
        returns (uint256);
}
