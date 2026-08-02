// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ICampaignRegistry} from "../interfaces/ICampaignRegistry.sol";
import {IEscrowVault} from "../interfaces/IEscrowVault.sol";
import {Campaign} from "./Campaign.sol";
import {Types} from "../libraries/Types.sol";

/// @title CampaignRegistry
/// @notice Factory and directory for campaigns.
/// @dev The registry is the escrow vault's registrar: it is the only contract that can bind a
///      campaign to a token, which is what stops an attacker pre-registering a real campaign
///      address against the wrong token. Deployment is permissionless — anyone may run a campaign
///      — but every campaign that exists came from here.
///
///      Campaigns are deployed in full rather than cloned (D8): a campaign holding escrowed funds
///      should not share code that anyone can later point elsewhere. Clone-based deployment is a
///      tracked optimization, not an MVP requirement.
contract CampaignRegistry is ICampaignRegistry {
    error ZeroAddress();
    error UnknownCampaign(uint256 campaignId);

    /// @inheritdoc ICampaignRegistry
    address public immutable escrowVault;
    /// @inheritdoc ICampaignRegistry
    address public immutable reputationRegistry;
    /// @inheritdoc ICampaignRegistry
    address public immutable attributionRegistry;
    /// @inheritdoc ICampaignRegistry
    address public immutable oracleCoordinator;

    address[] private _campaigns;
    mapping(address => bool) private _isCampaign;
    mapping(address => address[]) private _byProject;

    constructor(
        address escrowVault_,
        address reputationRegistry_,
        address attributionRegistry_,
        address oracleCoordinator_
    ) {
        if (
            escrowVault_ == address(0) || reputationRegistry_ == address(0)
                || attributionRegistry_ == address(0) || oracleCoordinator_ == address(0)
        ) revert ZeroAddress();

        escrowVault = escrowVault_;
        reputationRegistry = reputationRegistry_;
        attributionRegistry = attributionRegistry_;
        oracleCoordinator = oracleCoordinator_;
    }

    /// @inheritdoc ICampaignRegistry
    /// @dev Deliberately does **not** require `cfg.project == msg.sender`. Requiring it would
    ///      break every composable caller — facades, routers, multisig wrappers — since the
    ///      registry would see the wrapper rather than the project.
    ///
    ///      This is safe because naming someone else as the project grants the caller nothing:
    ///      `project` is the address that must fund the campaign, and the only address that can
    ///      activate it or reclaim escrow. Creating a campaign for a project that never funds it
    ///      leaves an inert `Pending` contract. Callers that *do* want caller-binding (such as
    ///      the Boney facade) enforce it at their own layer.
    function createCampaign(
        Types.CampaignConfig calldata cfg,
        Types.KpiSpec[] calldata kpis,
        Types.RewardTier[][] calldata tiers
    ) external returns (uint256 campaignId, address campaign) {
        campaign = address(
            new Campaign(
                cfg, kpis, tiers, escrowVault, attributionRegistry, reputationRegistry, oracleCoordinator
            )
        );

        campaignId = _campaigns.length;
        _campaigns.push(campaign);
        _isCampaign[campaign] = true;
        _byProject[cfg.project].push(campaign);

        // Bind the campaign to its escrow token before anyone can deposit.
        IEscrowVault(escrowVault).registerCampaign(campaign, cfg.token);

        emit CampaignCreated(campaignId, campaign, cfg.project, cfg.token);
    }

    /// @inheritdoc ICampaignRegistry
    function campaignCount() external view returns (uint256) {
        return _campaigns.length;
    }

    /// @inheritdoc ICampaignRegistry
    function campaignAt(uint256 campaignId) external view returns (address) {
        if (campaignId >= _campaigns.length) revert UnknownCampaign(campaignId);
        return _campaigns[campaignId];
    }

    /// @inheritdoc ICampaignRegistry
    function isCampaign(address campaign) external view returns (bool) {
        return _isCampaign[campaign];
    }

    /// @inheritdoc ICampaignRegistry
    function campaignsOf(address project) external view returns (address[] memory) {
        return _byProject[project];
    }

    /// @notice Paginated campaign listing for marketplace discovery.
    function browse(uint256 offset, uint256 limit) external view returns (address[] memory page) {
        uint256 total = _campaigns.length;
        if (offset >= total) return new address[](0);

        uint256 end = offset + limit;
        if (end > total) end = total;

        page = new address[](end - offset);
        for (uint256 i; i < page.length; ++i) {
            page[i] = _campaigns[offset + i];
        }
    }
}
