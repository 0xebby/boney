// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ICampaignRegistry} from "../interfaces/ICampaignRegistry.sol";
import {IEscrowVault} from "../interfaces/IEscrowVault.sol";
import {Campaign} from "./Campaign.sol";
import {Types} from "../libraries/Types.sol";
import {Names} from "../libraries/Names.sol";

/// @title CampaignRegistry
/// @notice Factory and directory for campaigns.
/// @dev The escrow vault's registrar: the only contract that may bind a campaign to a token.
///      Deployment is permissionless, and campaigns are deployed in full rather than cloned.
contract CampaignRegistry is ICampaignRegistry {
    /// @inheritdoc ICampaignRegistry
    address public immutable escrowVault;
    /// @inheritdoc ICampaignRegistry
    address public immutable reputationRegistry;
    /// @inheritdoc ICampaignRegistry
    address public immutable attributionRegistry;
    /// @inheritdoc ICampaignRegistry
    address public immutable oracleCoordinator;

    /// @dev Every campaign ever deployed, indexed by campaign id.
    address[] private _campaigns;
    /// @dev campaign => deployed by this registry. Lets other modules reject spoofed campaigns.
    mapping(address => bool) private _isCampaign;
    /// @dev project => their campaigns, in creation order.
    mapping(address => address[]) private _byProject;

    /// @notice The campaign holding a given normalized name, or the zero address if unclaimed.
    /// @dev Keyed by `Names.key`, so it is case- and whitespace-insensitive. Claims are permanent:
    ///      ending or cancelling a campaign does not release its name.
    mapping(bytes32 => address) public campaignByName;

    /// @notice Deploys the registry with immutable module dependencies.
    /// @param escrowVault_ Vault holding campaign escrow.
    /// @param reputationRegistry_ Registry backing reputation lookups.
    /// @param attributionRegistry_ Registry storing attribution touches.
    /// @param oracleCoordinator_ Coordinator routing oracle reports.
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
    /// @dev Does not require `cfg.project == msg.sender`, so composable callers work; the Boney
    ///      facade enforces caller-binding at its own layer. Name uniqueness is enforced here and
    ///      only here, and the claim is recorded after the campaign deploys.
    function createCampaign(
        Types.CampaignConfig calldata cfg,
        Types.KpiSpec[] calldata kpis,
        Types.RewardTier[][] calldata tiers
    ) external returns (uint256 campaignId, address campaign) {
        // Reverts on a malformed name before any deployment gas is spent.
        bytes32 nameKey = Names.key(cfg.name);
        address holder = campaignByName[nameKey];
        if (holder != address(0)) revert NameTaken(cfg.name, holder);

        campaign = address(
            new Campaign(
                cfg, kpis, tiers, escrowVault, attributionRegistry, reputationRegistry, oracleCoordinator
            )
        );

        campaignId = _campaigns.length;
        _campaigns.push(campaign);
        _isCampaign[campaign] = true;
        _byProject[cfg.project].push(campaign);
        campaignByName[nameKey] = campaign;

        // Bind the campaign to its escrow token before anyone can deposit.
        IEscrowVault(escrowVault).registerCampaign(campaign, cfg.token);

        emit CampaignCreated(campaignId, campaign, cfg.project, cfg.token, cfg.name);
    }

    /// @notice Whether `name` can still be claimed.
    /// @dev Normalizes on chain so the client cannot disagree about what counts as a duplicate.
    ///      Returns `false` for a malformed name rather than reverting.
    /// @param name The raw name to test.
    /// @return Whether a campaign could be created with it right now.
    function isNameAvailable(string calldata name) external view returns (bool) {
        // `Names.key` reverts on a malformed name; this surface answers rather than reverting.
        (bool ok, bytes32 nameKey) = _tryKey(name);
        return ok && campaignByName[nameKey] == address(0);
    }

    /// @dev `Names.key` in a form that reports failure instead of reverting; the validation is inlined
    ///      because `try` needs an external call.
    /// @param name The raw name to key.
    /// @return ok False when the name is malformed.
    /// @return nameKey The uniqueness key, or zero when `ok` is false.
    function _tryKey(string calldata name) private pure returns (bool ok, bytes32 nameKey) {
        bytes memory raw = bytes(name);
        if (raw.length == 0 || raw.length > Names.MAX_NAME_BYTES) return (false, bytes32(0));

        bool hasVisible;
        for (uint256 i; i < raw.length; ++i) {
            uint8 c = uint8(raw[i]);
            if (c < 0x20 || c > 0x7E) return (false, bytes32(0));
            if (c != 0x20) hasVisible = true;
        }
        if (!hasVisible) return (false, bytes32(0));

        return (true, keccak256(Names.normalize(name)));
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
    /// @param offset Starting index in the campaign array.
    /// @param limit Maximum number of campaigns to return.
    /// @return page Array of campaign addresses in the requested range.
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
