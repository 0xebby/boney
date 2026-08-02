// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Types} from "../libraries/Types.sol";

/// @title ICampaignRegistry
/// @notice Factory and directory for campaigns. Deploys each campaign, registers it with the
///         escrow vault, and indexes it for marketplace discovery.
interface ICampaignRegistry {
    event CampaignCreated(
        uint256 indexed campaignId, address indexed campaign, address indexed project, address token
    );

    /// @notice Deploy a new campaign.
    /// @param cfg Immutable campaign parameters.
    /// @param kpis KPI specs; at least one required.
    /// @param tiers Per-KPI reward tiers, outer index aligned to `kpis`.
    function createCampaign(
        Types.CampaignConfig calldata cfg,
        Types.KpiSpec[] calldata kpis,
        Types.RewardTier[][] calldata tiers
    ) external returns (uint256 campaignId, address campaign);

    function campaignCount() external view returns (uint256);
    function campaignAt(uint256 campaignId) external view returns (address);
    function isCampaign(address campaign) external view returns (bool);
    function campaignsOf(address project) external view returns (address[] memory);
    function escrowVault() external view returns (address);
    function reputationRegistry() external view returns (address);
    function attributionRegistry() external view returns (address);
    function oracleCoordinator() external view returns (address);
}
