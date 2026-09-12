// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Campaign} from "./Campaign.sol";
import {ICampaignDeployer} from "../interfaces/ICampaignDeployer.sol";
import {Types} from "../libraries/Types.sol";

/// @title CampaignDeployer
/// @notice Deploys campaigns exclusively for one CampaignRegistry.
contract CampaignDeployer is ICampaignDeployer {
    address public immutable override registry;
    address public immutable override escrowVault;
    address public immutable override attributionRegistry;
    address public immutable override reputationRegistry;
    address public immutable override oracleCoordinator;

    /// @notice Binds the deployer to one registry and its campaign dependencies.
    /// @param registry_ Registry permitted to deploy campaigns.
    /// @param escrowVault_ Vault holding escrowed rewards.
    /// @param attributionRegistry_ Registry storing attribution touches.
    /// @param reputationRegistry_ Registry backing reputation lookups.
    /// @param oracleCoordinator_ Coordinator authorized to push oracle updates.
    constructor(
        address registry_,
        address escrowVault_,
        address attributionRegistry_,
        address reputationRegistry_,
        address oracleCoordinator_
    ) {
        if (
            registry_ == address(0) || escrowVault_ == address(0) || attributionRegistry_ == address(0)
                || reputationRegistry_ == address(0) || oracleCoordinator_ == address(0)
        ) revert ZeroAddress();

        registry = registry_;
        escrowVault = escrowVault_;
        attributionRegistry = attributionRegistry_;
        reputationRegistry = reputationRegistry_;
        oracleCoordinator = oracleCoordinator_;
    }

    /// @inheritdoc ICampaignDeployer
    function deployCampaign(
        Types.CampaignConfig calldata cfg,
        Types.KpiSpec[] calldata kpis,
        Types.RewardTier[][] calldata tiers
    ) external override returns (address campaign) {
        if (msg.sender != registry) revert NotRegistry(msg.sender);

        campaign = address(
            new Campaign(
                cfg, kpis, tiers, escrowVault, attributionRegistry, reputationRegistry, oracleCoordinator
            )
        );
    }
}
