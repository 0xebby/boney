// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Campaign} from "../src/campaign/Campaign.sol";
import {CampaignRegistry} from "../src/campaign/CampaignRegistry.sol";
import {EscrowVault} from "../src/escrow/EscrowVault.sol";
import {Types} from "../src/libraries/Types.sol";

/// @title SeedTouchKpi
/// @notice Creates a Boneyard campaign whose single KPI counts attributions a referred wallet signs
///         on the campaign named by `PINNED_CAMPAIGN`.
/// @dev One ungated per-user KPI over `AttributionRegistry.TouchStored`, actor topic 2, count mode,
///      with topic 1 pinned so touches on this campaign's own attribution do not count themselves.
///      Reads `PRIVATE_KEY`, `REGISTRY_ADDRESS`, `VAULT_ADDRESS` and `SEED_TOKEN`.
contract SeedTouchKpi is Script {
    address public constant ATTRIBUTION = 0xe04C5185eDd4C9b1c91e31c790843c335766258e;
    address public constant PINNED_CAMPAIGN = 0x27aCEe5bD884d8944f192C43050596a753377341;
    bytes32 public constant TOUCH_TOPIC = 0xa6b53575a93644bcb44b9eaf21cc608d43ebc50c03ab4366fe5a6360ad008f99;
    uint8 public constant ACTOR_TOPIC = 2;
    uint8 public constant AMOUNT_MODE_COUNT = 0;
    uint256 public constant SCALE = 1;
    uint8 public constant FILTER_TOPIC = 1;
    uint256 public constant POOL = 2_000_000 ether;
    uint64 public constant DURATION = 90 days;
    uint64 public constant ATTRIBUTION_WINDOW = 20 days;
    uint256 public constant MIN_REPUTATION = 12_000;

    /// @notice Creates the campaign, escrows `POOL` and activates it.
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address project = vm.addr(pk);

        CampaignRegistry registry = CampaignRegistry(vm.envAddress("REGISTRY_ADDRESS"));
        EscrowVault vault = EscrowVault(vm.envAddress("VAULT_ADDRESS"));
        IERC20 token = IERC20(vm.envOr("SEED_TOKEN", vm.envAddress("TOKEN_ADDRESS")));

        uint256 balance = token.balanceOf(project);
        if (balance < POOL) {
            revert(
                string.concat(
                    "project token balance too low: has ", vm.toString(balance), ", needs ", vm.toString(POOL)
                )
            );
        }

        Types.CampaignConfig memory cfg = Types.CampaignConfig({
            project: project,
            name: "Boneyard-sign-attribution",
            token: address(token),
            rewardPool: POOL,
            startTime: uint64(block.timestamp),
            endTime: uint64(block.timestamp) + DURATION,
            attributionWindow: ATTRIBUTION_WINDOW,
            minReputation: MIN_REPUTATION
        });

        Types.KpiSpec[] memory kpis = new Types.KpiSpec[](1);
        kpis[0] = Types.KpiSpec({
            kind: Types.KpiKind.ActiveUser,
            verifier: address(0),
            target: 1000,
            aggregate: false,
            params: abi.encode(
                ATTRIBUTION,
                TOUCH_TOPIC,
                ACTOR_TOPIC,
                AMOUNT_MODE_COUNT,
                SCALE,
                FILTER_TOPIC,
                bytes32(uint256(uint160(PINNED_CAMPAIGN)))
            )
        });

        Types.RewardTier[][] memory tiers = new Types.RewardTier[][](1);
        tiers[0] = new Types.RewardTier[](4);
        tiers[0][0] = Types.RewardTier({threshold: 5, reward: 5_000 ether});
        tiers[0][1] = Types.RewardTier({threshold: 10, reward: 10_000 ether});
        tiers[0][2] = Types.RewardTier({threshold: 15, reward: 15_000 ether});
        tiers[0][3] = Types.RewardTier({threshold: 25, reward: 25_000 ether});

        vm.startBroadcast(pk);
        (uint256 campaignId, address campaign) = registry.createCampaign(cfg, kpis, tiers);
        token.approve(address(vault), POOL);
        vault.deposit(campaign, POOL);
        Campaign(campaign).activate();
        vm.stopBroadcast();

        console.log("Attribution campaign created");
        console.log("  campaignId:", campaignId);
        console.log("  campaign:  ", campaign);
        console.log("  pinned to: ", PINNED_CAMPAIGN);
        console.log("  params:    ", vm.toString(kpis[0].params));
    }
}
