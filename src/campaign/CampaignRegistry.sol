// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ICampaignRegistry} from "../interfaces/ICampaignRegistry.sol";
import {IEscrowVault} from "../interfaces/IEscrowVault.sol";
import {Campaign} from "./Campaign.sol";
import {Types} from "../libraries/Types.sol";
import {Names} from "../libraries/Names.sol";

/// @title CampaignRegistry
/// @notice Factory and directory for campaigns.
/// @dev The registry is the escrow vault's registrar: it is the only contract that can bind a
///      campaign to a token, which is what stops an attacker pre-registering a real campaign
///      address against the wrong token. Deployment is permissionless — anyone may run a campaign
///      — but every campaign that exists came from here.
///
///      Campaigns are deployed in full rather than cloned.
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
    /// @dev Keyed by `Names.key`, so it is case- and whitespace-insensitive: "Aave", "aave" and
    ///      Claims are permanent. Ending or cancelling a campaign does not release its name, because
    ///      recycling one would silently repoint every link, screenshot and indexer row that
    ///      referenced the campaign it used to mean.
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
    /// @dev Deliberately does **not** require `cfg.project == msg.sender`. Requiring it would
    ///      break every composable caller — facades, routers, multisig wrappers — since the
    ///      registry would see the wrapper rather than the project.
    ///
    ///      This is safe because naming someone else as the project grants the caller nothing:
    ///      `project` is the address that must fund the campaign, and the only address that can
    ///      activate it or reclaim escrow. Creating a campaign for a project that never funds it
    ///      leaves an inert `Pending` contract. Callers that *do* want caller-binding (such as
    ///      the Boney facade) enforce it at their own layer.
    ///
    ///      **Name uniqueness is enforced here and only here.** The check needs an index across all
    ///      campaigns, and this is the contract that holds one — the same reason escrow binding
    ///      lives here. A `Campaign` constructed directly still validates its own name's shape but
    ///      cannot know whether it duplicates another, so it never enters this index; such a campaign
    ///      is invisible to `campaignCount`, `browse` and the vault too, so it is outside the
    ///      marketplace in every other respect as well.
    ///
    ///      The claim is recorded *after* the campaign deploys, so a constructor revert (a bad
    ///      window, an unreachable gate, a malformed name) leaves the name free rather than burning
    ///      it on a campaign that does not exist.
    function createCampaign(
        Types.CampaignConfig calldata cfg,
        Types.KpiSpec[] calldata kpis,
        Types.RewardTier[][] calldata tiers
    ) external returns (uint256 campaignId, address campaign) {
        // Reverts on a malformed name before any deployment gas is spent. `Campaign`'s constructor
        // validates again — that is the guard for direct construction, and it is cheap.
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
    /// @dev The form's pre-flight check. Normalization happens here rather than in the client so the
    ///      two cannot disagree about what counts as a duplicate — a TypeScript reimplementation of
    ///      trimming, case folding and hashing would be a second source of truth, and the failure
    ///      mode is a form that promises a name is free and then reverts on submit.
    ///
    ///      Returns `false` for a malformed name instead of reverting: to a caller asking "may I use
    ///      this?", an over-long or non-ASCII name is unusable, which is the same answer. The
    ///      specific reason comes from the length and charset checks the form runs locally.
    /// @param name The raw name to test.
    /// @return Whether a campaign could be created with it right now.
    function isNameAvailable(string calldata name) external view returns (bool) {
        // `Names.key` reverts on a malformed name; this surface answers rather than reverting.
        (bool ok, bytes32 nameKey) = _tryKey(name);
        return ok && campaignByName[nameKey] == address(0);
    }

    /// @dev `Names.key` in a form that reports failure instead of reverting. `try` needs an external
    ///      call, so the validation is inlined here against the same `Names` rules.
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
