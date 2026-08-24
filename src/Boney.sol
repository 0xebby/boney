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

/// @title Boney - web3 rewards  accountability protocol.
/// @dev Deliberately thin and stateless. It holds no funds, owns no campaign state,
///      and has no privileged role in any module — every call it makes could be made directly.
///      Its job is ergonomics: resolve campaign ids to addresses, batch the token approval dance,
///      and assemble the aggregate views a marketplace[boneyard] UI needs.
///
///      Because it is not trusted by the modules, replacing the facade (or running several in
///      parallel for different frontends) requires no migration of escrow or campaign state.
contract Boney is IBoney {
    using SafeERC20 for IERC20;

    /// @notice Factory and directory the facade resolves campaign ids through.
    ICampaignRegistry public immutable registry;
    /// @notice Vault holding every campaign's escrowed rewards.
    IEscrowVault public immutable escrowVault;
    /// @notice Registry backing promoter reputation lookups.
    IReputationRegistry public immutable reputationRegistry;
    /// @notice Registry storing user-signed attribution touches.
    IAttributionRegistry public immutable attributionRegistry;

    /// @notice Deploys the Boney facade and wires it to the protocol modules.
    /// @param registry_ Address of the campaign registry.
    constructor(address registry_) {
        if (registry_ == address(0)) revert ZeroAddress();
        registry = ICampaignRegistry(registry_);
        escrowVault = IEscrowVault(ICampaignRegistry(registry_).escrowVault());
        reputationRegistry = IReputationRegistry(ICampaignRegistry(registry_).reputationRegistry());
        attributionRegistry = IAttributionRegistry(ICampaignRegistry(registry_).attributionRegistry());
    }

    // ── project actions ──────────────────────────────────────────

    /// @inheritdoc IBoney
    /// @param cfg Immutable campaign parameters;
    /// @param kpis KPI specs; at least one required.
    /// @param tiers Per-KPI reward tiers, outer index aligned to `kpis`.
    /// @return campaignId Sequential id assigned by the registry.
    /// @return campaign Address of the deployed campaign.
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
    /// @param campaignId The campaign to fund.
    /// @param amount Amount of the campaign's token to escrow.
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

    /// @notice Returns the campaign address for joining.
    /// @dev Promoters join by calling `Campaign.join()` directly from the wallet that will
    ///      receive rewards.  Resolve the target with
    ///      this function, then call `join()` on it from the promoter's own wallet.
    /// @param campaignId The campaign id.
    /// @return The campaign contract address.
    function campaignJoinTarget(uint256 campaignId) external view returns (address) {
        return registry.campaignAt(campaignId);
    }

    /// @inheritdoc IBoney
    /// @param campaignId The campaign the touch belongs to.
    /// @param user The end user who signed the touch.
    /// @param touch The signed attribution message.
    /// @param signature EIP-712 signature over `touch` by `user`.
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
    /// @param campaignId The campaign to settle within.
    /// @param promoter The promoter whose earned tiers are paid out.
    /// @param kpiIndex Index of the KPI to settle.
    function claimRewards(uint256 campaignId, address promoter, uint256 kpiIndex) external {
        ICampaign(registry.campaignAt(campaignId)).settle(promoter, kpiIndex);
    }

    // ── views ────────────────────────────────────────────────────

    /// @inheritdoc IBoney
    /// @param campaignId The campaign to summarize.
    /// @return A snapshot of the campaign's configuration and live state.
    function campaignView(uint256 campaignId) public view returns (CampaignView memory) {
        address addr = registry.campaignAt(campaignId);
        ICampaign c = ICampaign(addr);
        Types.CampaignConfig memory cfg = c.config();

        return CampaignView({
            campaignId: campaignId,
            campaign: addr,
            project: cfg.project,
            name: cfg.name,
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
    /// @param offset Starting campaign id.
    /// @param limit Maximum number of campaigns to return.
    /// @return page Summaries for the requested range; empty when `offset` is past the end.
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
    /// @return The campaign count, which is also the next campaign id.
    function campaignCount() external view returns (uint256) {
        return registry.campaignCount();
    }

    /// @inheritdoc IBoney
    /// @param wallet The wallet to query.
    /// @return The wallet's composite reputation score.
    function reputationOf(address wallet) external view returns (uint256) {
        return reputationRegistry.scoreOf(wallet);
    }

    /// @inheritdoc IBoney
    /// @param campaignId The campaign to query.
    /// @param promoter The promoter.
    /// @param kpiIndex Index of the KPI.
    /// @return Progress credited to the promoter so far.
    function promoterProgress(uint256 campaignId, address promoter, uint256 kpiIndex)
        external
        view
        returns (uint256)
    {
        return ICampaign(registry.campaignAt(campaignId)).progressOf(promoter, kpiIndex);
    }

    /// @notice Resolve a campaign id to its contract address.
    /// @param campaignId The campaign id.
    /// @return The campaign contract address.
    function campaignAddress(uint256 campaignId) external view returns (address) {
        return registry.campaignAt(campaignId);
    }
}
