// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Types} from "./libraries/Types.sol";
import {IAttributionRegistry} from "./interfaces/IAttributionRegistry.sol";

/// @title IBoney
/// @notice Marketplace-facing entry point for the Boney protocol.
/// @dev The facade holds no funds and no campaign state; it routes to the modules and provides
///      the aggregated views a marketplace UI needs. Protocol logic lives in the modules
///      (decision D9), so a new frontend never requires touching escrow or settlement code.
interface IBoney {
    /// @notice A campaign summarized for listing pages.
    struct CampaignView {
        uint256 campaignId;
        address campaign;
        address project;
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
    function createCampaign(
        Types.CampaignConfig calldata cfg,
        Types.KpiSpec[] calldata kpis,
        Types.RewardTier[][] calldata tiers
    ) external returns (uint256 campaignId, address campaign);

    /// @notice Escrow `amount` of the campaign's token, pulled from the caller.
    function fundCampaign(uint256 campaignId, uint256 amount) external;

    /// @notice Relay a user-signed attribution touch.
    function registerAttribution(
        uint256 campaignId,
        address user,
        IAttributionRegistry.Touch calldata touch,
        bytes calldata signature
    ) external;

    /// @notice Settle any rewards a promoter has earned but not yet received.
    function claimRewards(uint256 campaignId, address promoter, uint256 kpiIndex) external;

    // ── views ────────────────────────────────────────────────────

    function campaignView(uint256 campaignId) external view returns (CampaignView memory);
    function browseCampaigns(uint256 offset, uint256 limit) external view returns (CampaignView[] memory);
    function campaignCount() external view returns (uint256);
    function reputationOf(address wallet) external view returns (uint256);
    function promoterProgress(uint256 campaignId, address promoter, uint256 kpiIndex)
        external
        view
        returns (uint256);
}
