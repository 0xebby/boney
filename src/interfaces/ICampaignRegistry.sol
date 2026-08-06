// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Types} from "../libraries/Types.sol";

/// @title ICampaignRegistry
/// @notice Factory and directory for campaigns. Deploys each campaign, registers it with the
///         escrow vault, and indexes it for marketplace discovery.
interface ICampaignRegistry {
    /// @notice Emitted for every campaign this registry deploys. The canonical discovery feed —
    ///         a campaign address that never appears here was not deployed by this registry.
    /// @param campaignId Sequential id assigned to the campaign.
    /// @param campaign Address of the deployed campaign.
    /// @param project The campaign's owner.
    /// @param token ERC20 the campaign escrows and pays out in.
    event CampaignCreated(
        uint256 indexed campaignId, address indexed campaign, address indexed project, address token
    );

    /// @notice Deploy a new campaign.
    /// @param cfg Immutable campaign parameters.
    /// @param kpis KPI specs; at least one required.
    /// @param tiers Per-KPI reward tiers, outer index aligned to `kpis`.
    /// @return campaignId Sequential id assigned to the new campaign.
    /// @return campaign Address of the deployed campaign contract.
    function createCampaign(
        Types.CampaignConfig calldata cfg,
        Types.KpiSpec[] calldata kpis,
        Types.RewardTier[][] calldata tiers
    ) external returns (uint256 campaignId, address campaign);

    /// @notice Total number of campaigns ever created.
    /// @return The campaign count, which is also the next campaign id.
    function campaignCount() external view returns (uint256);

    /// @notice Resolve a campaign id to its contract address.
    /// @param campaignId The campaign id.
    /// @return The campaign contract address.
    function campaignAt(uint256 campaignId) external view returns (address);

    /// @notice Whether `campaign` was deployed by this registry.
    /// @param campaign Address to check.
    /// @return True if the address is a registry-deployed campaign.
    function isCampaign(address campaign) external view returns (bool);

    /// @notice Every campaign created for `project`.
    /// @param project The project address.
    /// @return Campaign addresses in creation order.
    function campaignsOf(address project) external view returns (address[] memory);

    /// @notice Vault holding every campaign's escrowed rewards.
    /// @return The escrow vault address.
    function escrowVault() external view returns (address);

    /// @notice Registry backing promoter reputation lookups.
    /// @return The reputation registry address.
    function reputationRegistry() external view returns (address);

    /// @notice Registry storing user-signed attribution touches.
    /// @return The attribution registry address.
    function attributionRegistry() external view returns (address);

    /// @notice Coordinator authorized to push oracle-reported KPI updates.
    /// @return The oracle coordinator address.
    function oracleCoordinator() external view returns (address);
}
