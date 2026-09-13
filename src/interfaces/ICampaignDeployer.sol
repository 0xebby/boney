// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Types} from "../libraries/Types.sol";

/// @title ICampaignDeployer
/// @notice Registry-bound campaign deployment surface.
interface ICampaignDeployer {
    error NotRegistry(address caller);
    error ZeroAddress();

    /// @notice Registry permitted to deploy campaigns.
    /// @return The bound registry address.
    function registry() external view returns (address);

    /// @notice Vault passed to each deployed campaign.
    /// @return The escrow vault address.
    function escrowVault() external view returns (address);

    /// @notice Attribution registry passed to each deployed campaign.
    /// @return The attribution registry address.
    function attributionRegistry() external view returns (address);

    /// @notice Reputation registry passed to each deployed campaign.
    /// @return The reputation registry address.
    function reputationRegistry() external view returns (address);

    /// @notice Oracle coordinator passed to each deployed campaign.
    /// @return The oracle coordinator address.
    function oracleCoordinator() external view returns (address);

    /// @notice Deploys a campaign for the bound registry.
    /// @param cfg Immutable campaign parameters.
    /// @param kpis KPI specifications.
    /// @param tiers Reward tiers per KPI.
    /// @return campaign The deployed campaign address.
    function deployCampaign(
        Types.CampaignConfig calldata cfg,
        Types.KpiSpec[] calldata kpis,
        Types.RewardTier[][] calldata tiers
    ) external returns (address campaign);
}
