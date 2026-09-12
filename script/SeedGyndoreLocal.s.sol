// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Campaign} from "../src/campaign/Campaign.sol";
import {CampaignRegistry} from "../src/campaign/CampaignRegistry.sol";
import {EscrowVault} from "../src/escrow/EscrowVault.sol";
import {AttributionRegistry} from "../src/attribution/AttributionRegistry.sol";
import {IAttributionRegistry} from "../src/interfaces/IAttributionRegistry.sol";
import {Types} from "../src/libraries/Types.sol";

/// @title SeedGyndoreLocal
/// @notice Creates a Gyndore-shaped Feature 1 campaign on the isolated Anvil playground.
contract SeedGyndoreLocal is Script {
    uint256 internal constant ANVIL_PROJECT_PK =
        0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
    uint256 internal constant ANVIL_KOL_PK =
        0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a;
    uint256 internal constant ANVIL_USER_PK =
        0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a;
    uint256 internal constant POOL = 6_000 ether;
    uint256 internal constant TOP_UP = 2_000 ether;
    uint64 internal constant DURATION = 30 days;

    function run() external {
        uint256 projectPk = vm.envOr("SEED_PROJECT_PK", ANVIL_PROJECT_PK);
        uint256 kolPk = vm.envOr("SEED_KOL_PK", ANVIL_KOL_PK);
        CampaignRegistry registry = CampaignRegistry(vm.envAddress("REGISTRY_ADDRESS"));
        EscrowVault vault = EscrowVault(vm.envAddress("VAULT_ADDRESS"));
        AttributionRegistry attribution = AttributionRegistry(vm.envAddress("ATTRIBUTION_ADDRESS"));
        IERC20 token = IERC20(vm.envAddress("TOKEN_ADDRESS"));
        address project = vm.addr(projectPk);
        address user = vm.addr(ANVIL_USER_PK);

        Types.KpiSpec[] memory kpis = new Types.KpiSpec[](1);
        kpis[0] = Types.KpiSpec({
            kind: Types.KpiKind.Swap,
            verifier: address(0),
            target: 20,
            aggregate: false,
            params: ""
        });

        Types.RewardTier[][] memory tiers = new Types.RewardTier[][](1);
        tiers[0] = new Types.RewardTier[](2);
        tiers[0][0] = Types.RewardTier({threshold: 10, reward: POOL});
        tiers[0][1] = Types.RewardTier({threshold: 20, reward: TOP_UP});

        Types.CampaignConfig memory cfg = Types.CampaignConfig({
            project: project,
            name: vm.envOr("CAMPAIGN_NAME", string("Gyndore Feature 1 Local")),
            token: address(token),
            rewardPool: POOL,
            startTime: uint64(block.timestamp),
            endTime: uint64(block.timestamp + DURATION),
            attributionWindow: DURATION,
            minReputation: 0
        });

        vm.startBroadcast(projectPk);
        (, address campaign) = registry.createCampaign(cfg, kpis, tiers);
        token.approve(address(vault), POOL);
        vault.deposit(campaign, POOL);
        Campaign(campaign).activate();
        vm.stopBroadcast();

        vm.broadcast(kolPk);
        bytes32 promoterId = Campaign(campaign).join();

        _storeTouch(attribution, campaign, promoterId, user, ANVIL_USER_PK, project);

        vm.startBroadcast(projectPk);
        Campaign(campaign).reportUserAction(0, user, 10, "");
        Campaign(campaign).extend(uint64(block.timestamp + DURATION + DURATION / 2));
        Campaign(campaign).reportUserAction(0, user, 20, "");
        token.approve(campaign, TOP_UP);
        Campaign(campaign).topUp(TOP_UP);
        vm.stopBroadcast();

        vm.broadcast(kolPk);
        Campaign(campaign).claimShortfall(0);

        console.log("Gyndore local Feature 1 campaign seeded.");
        console.log("  campaign: ", campaign);
        console.log("  promoter: ");
        console.logBytes32(promoterId);
        console.log("  initial pool: ", POOL);
        console.log("  planned top-up: ", TOP_UP);
        console.log("  extended deadline: ", Campaign(campaign).endTime());
        console.log("  user report before and after extension: complete");
        console.log("  top-up and shortfall claim: complete");
    }

    function _storeTouch(
        AttributionRegistry attribution,
        address campaign,
        bytes32 promoterId,
        address user,
        uint256 userPk,
        address relayer
    ) internal {
        IAttributionRegistry.Touch memory touch = IAttributionRegistry.Touch({
            campaign: campaign,
            promoterId: promoterId,
            signedAt: uint64(block.timestamp),
            expiresAt: uint64(block.timestamp + DURATION)
        });
        bytes32 structHash = keccak256(
            abi.encode(
                attribution.TOUCH_TYPEHASH(),
                touch.campaign,
                touch.promoterId,
                touch.signedAt,
                touch.expiresAt
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", attribution.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userPk, digest);

        vm.broadcast(relayer);
        attribution.storeTouch(user, touch, abi.encodePacked(r, s, v), relayer);
    }
}
