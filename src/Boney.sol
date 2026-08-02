// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IBoney} from "./IBoney.sol";
import {ICampaign} from "./interfaces/ICampaign.sol";
import {ICampaignRegistry} from "./interfaces/ICampaignRegistry.sol";
import {IEscrowVault} from "./interfaces/IEscrowVault.sol";
import {IReputationRegistry} from "./interfaces/IReputationRegistry.sol";
import {IAttributionRegistry} from "./interfaces/IAttributionRegistry.sol";
import {Types} from "./libraries/Types.sol";

/// @title Boney
/// @notice Marketplace-facing facade for the Boney accountability protocol.
/// @dev Deliberately thin and stateless (decision D9). It holds no funds, owns no campaign state,
///      and has no privileged role in any module — every call it makes could be made directly.
///      Its job is ergonomics: resolve campaign ids to addresses, batch the token approval dance,
///      and assemble the aggregate views a marketplace UI needs.
///
///      Because it is not trusted by the modules, replacing the facade (or running several in
///      parallel for different frontends) requires no migration of escrow or campaign state.
contract Boney is IBoney {
    using SafeERC20 for IERC20;

    error ZeroAddress();
    error NotProject(address project, address caller);
    error CampaignMismatch(address expected, address provided);

    ICampaignRegistry public immutable registry;
    IEscrowVault public immutable escrowVault;
    IReputationRegistry public immutable reputationRegistry;
    IAttributionRegistry public immutable attributionRegistry;

    constructor(address registry_) {
        if (registry_ == address(0)) revert ZeroAddress();
        registry = ICampaignRegistry(registry_);
        escrowVault = IEscrowVault(ICampaignRegistry(registry_).escrowVault());
        reputationRegistry = IReputationRegistry(ICampaignRegistry(registry_).reputationRegistry());
        attributionRegistry = IAttributionRegistry(ICampaignRegistry(registry_).attributionRegistry());
    }

    // ── project actions ──────────────────────────────────────────

    /// @inheritdoc IBoney
    /// @dev `cfg.project` must be the caller: the registry enforces this too, but failing here
    ///      gives a clearer error before deployment gas is spent.
    function createCampaign(
        Types.CampaignConfig calldata cfg,
        Types.KpiSpec[] calldata kpis,
        Types.RewardTier[][] calldata tiers
    ) external returns (uint256 campaignId, address campaign) {
        if (cfg.project != msg.sender) revert NotProject(cfg.project, msg.sender);
        return registry.createCampaign(cfg, kpis, tiers);
    }

    /// @inheritdoc IBoney
    /// @dev Pulls tokens through the facade so a project needs only one approval (to this
    ///      contract) rather than one per campaign. Funds land in the vault, never held here.
    function fundCampaign(uint256 campaignId, uint256 amount) external {
        address campaign = registry.campaignAt(campaignId);
        address token = escrowVault.tokenOf(campaign);

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        IERC20(token).forceApprove(address(escrowVault), amount);
        escrowVault.deposit(campaign, amount);
    }

    // ── promoter actions ─────────────────────────────────────────

    /// @notice Promoters join by calling `Campaign.join()` directly from the wallet that will
    ///         receive rewards.
    /// @dev Intentionally not proxied: the campaign records `msg.sender` as the promoter, so a
    ///      facade-relayed join would register the facade. Use `campaignAddress` to resolve the
    ///      target, then call `join()` on it.
    function campaignJoinTarget(uint256 campaignId) external view returns (address) {
        return registry.campaignAt(campaignId);
    }

    /// @inheritdoc IBoney
    function registerAttribution(
        uint256 campaignId,
        address user,
        IAttributionRegistry.Touch calldata touch,
        bytes calldata signature
    ) external {
        address campaign = registry.campaignAt(campaignId);
        if (touch.campaign != campaign) revert CampaignMismatch(campaign, touch.campaign);
        attributionRegistry.storeTouch(user, touch, signature, msg.sender);
    }

    /// @inheritdoc IBoney
    function claimRewards(uint256 campaignId, address promoter, uint256 kpiIndex) external {
        ICampaign(registry.campaignAt(campaignId)).settle(promoter, kpiIndex);
    }

    // ── views ────────────────────────────────────────────────────

    /// @inheritdoc IBoney
    function campaignView(uint256 campaignId) public view returns (CampaignView memory) {
        address addr = registry.campaignAt(campaignId);
        ICampaign c = ICampaign(addr);
        Types.CampaignConfig memory cfg = c.config();

        return CampaignView({
            campaignId: campaignId,
            campaign: addr,
            project: cfg.project,
            token: cfg.token,
            rewardPool: cfg.rewardPool,
            paidOut: c.paidOut(),
            startTime: cfg.startTime,
            endTime: cfg.endTime,
            minReputation: cfg.minReputation,
            status: c.status(),
            kpiCount: c.kpiCount()
        });
    }

    /// @inheritdoc IBoney
    function browseCampaigns(uint256 offset, uint256 limit)
        external
        view
        returns (CampaignView[] memory page)
    {
        uint256 total = registry.campaignCount();
        if (offset >= total) return new CampaignView[](0);

        uint256 end = offset + limit;
        if (end > total) end = total;

        page = new CampaignView[](end - offset);
        for (uint256 i; i < page.length; ++i) {
            page[i] = campaignView(offset + i);
        }
    }

    /// @inheritdoc IBoney
    function campaignCount() external view returns (uint256) {
        return registry.campaignCount();
    }

    /// @inheritdoc IBoney
    function reputationOf(address wallet) external view returns (uint256) {
        return reputationRegistry.scoreOf(wallet);
    }

    /// @inheritdoc IBoney
    function promoterProgress(uint256 campaignId, address promoter, uint256 kpiIndex)
        external
        view
        returns (uint256)
    {
        return ICampaign(registry.campaignAt(campaignId)).progressOf(promoter, kpiIndex);
    }

    /// @notice Resolve a campaign id to its contract address.
    function campaignAddress(uint256 campaignId) external view returns (address) {
        return registry.campaignAt(campaignId);
    }
}
