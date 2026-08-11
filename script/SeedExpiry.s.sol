// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Campaign} from "../src/campaign/Campaign.sol";
import {CampaignRegistry} from "../src/campaign/CampaignRegistry.sol";
import {EscrowVault} from "../src/escrow/EscrowVault.sol";
import {Types} from "../src/libraries/Types.sol";

/// @title SeedExpiry
/// @notice Adds a spread of short-dated campaigns so campaign expiry is observable while testing.
/// @dev Append-only, and separate from `SeedLocal` for the same reason `SeedGated` is: that script
///      is a whole-fixture seed whose output `web/src/lib/live.test.ts` pins, so re-running it to
///      add campaigns would deploy a second token and duplicate the existing five. This one only
///      appends, and reuses the token already on chain rather than minting a rival currency the
///      existing campaigns do not price in.
///
///      **Why these durations.** Every campaign already on chain runs 30–60 days out, so nothing
///      in the fixture ever reaches `endTime` during a testing session and the whole
///      window-closed → `end()` → grace → `reclaimUnspent` path is unreachable without warping a
///      local chain. These seven bracket that: the 24-hour campaign lapses within a day, the
///      5–14 day spread gives a staircase of "expires next" states for list sorting and countdown
///      rendering, and the 23-day one stays open as the control that should still be Active when
///      the others are not.
///
///      Note what is deliberately *not* shortened: `attributionWindow` stays at the 30 minutes the
///      rest of this branch uses, because a touch expiring is a different fact from a campaign
///      expiring and collapsing the two would make an expired-attribution bug look like an
///      expired campaign.
///
///      Campaigns are funded and activated rather than left Pending: a Pending campaign never
///      reaches its window at all, so it cannot show expiry. Reputation gates are left at zero for
///      the same reason — `SeedGated` owns that axis, and a gate here would only stop a wallet
///      from joining a campaign whose expiry is the thing under test.
///
///      Usage (Base Sepolia):
///        PRIVATE_KEY=… REGISTRY_ADDRESS=… VAULT_ADDRESS=… TOKEN_ADDRESS=… \
///        forge script script/SeedExpiry.s.sol:SeedExpiry --rpc-url … --broadcast --slow
contract SeedExpiry is Script {
    /// @dev Small on purpose. These campaigns exist to exercise expiry, not the payout ladder, and
    ///      the funding wallet pays for all seven out of one finite testnet balance.
    uint256 constant POOL = 2_000 ether;

    /// @dev Held at the 30 minutes this branch uses everywhere else — see the note above on why
    ///      this is not scaled to the campaign duration.
    uint64 constant ATTRIBUTION_WINDOW = 30 minutes;

    uint256 PROJECT_PK;
    CampaignRegistry registry;
    EscrowVault vault;
    IERC20 token;
    address project;

    function run() external {
        PROJECT_PK = vm.envUint("PRIVATE_KEY");
        registry = CampaignRegistry(vm.envAddress("REGISTRY_ADDRESS"));
        vault = EscrowVault(vm.envAddress("VAULT_ADDRESS"));
        token = IERC20(vm.envAddress("TOKEN_ADDRESS"));
        project = vm.addr(PROJECT_PK);

        // Ascending so the log reads as a countdown ladder, and so the first row is the one that
        // expires first — the campaign a tester actually wants to watch.
        uint64[7] memory durations = [
            uint64(24 hours),
            uint64(5 days),
            uint64(7 days),
            uint64(10 days),
            uint64(12 days),
            uint64(14 days),
            uint64(23 days)
        ];

        address[7] memory created;
        for (uint256 i = 0; i < durations.length; i++) {
            created[i] = _createFunded(durations[i]);
        }

        console.log("");
        console.log("Short-dated campaigns added (pool %s each):", POOL / 1 ether);
        console.log("  expires in 24h:     ", created[0]);
        console.log("  expires in 5 days:  ", created[1]);
        console.log("  expires in 7 days:  ", created[2]);
        console.log("  expires in 10 days: ", created[3]);
        console.log("  expires in 12 days: ", created[4]);
        console.log("  expires in 14 days: ", created[5]);
        console.log("  expires in 23 days: ", created[6]);
    }

    /// @dev Creates, funds, and activates one campaign expiring `duration` from now.
    ///
    ///      The KPI shape mirrors `SeedLocal._create` — one Mint KPI with a three-rung ladder
    ///      scaled to the pool — so these campaigns are reportable with the same calls as the rest
    ///      of the fixture and the only variable between them is `endTime`.
    function _createFunded(uint64 duration) internal returns (address campaign) {
        Types.CampaignConfig memory cfg = Types.CampaignConfig({
            project: project,
            token: address(token),
            rewardPool: POOL,
            startTime: uint64(block.timestamp),
            endTime: uint64(block.timestamp) + duration,
            attributionWindow: ATTRIBUTION_WINDOW,
            minReputation: 0
        });

        Types.KpiSpec[] memory kpis = new Types.KpiSpec[](1);
        kpis[0] = Types.KpiSpec({
            kind: Types.KpiKind.Mint,
            verifier: address(0),
            target: 100,
            aggregate: false,
            params: ""
        });

        Types.RewardTier[][] memory tiers = new Types.RewardTier[][](1);
        tiers[0] = new Types.RewardTier[](3);
        tiers[0][0] = Types.RewardTier({threshold: 10, reward: POOL / 20});
        tiers[0][1] = Types.RewardTier({threshold: 50, reward: POOL / 10});
        tiers[0][2] = Types.RewardTier({threshold: 100, reward: POOL / 5});

        vm.startBroadcast(PROJECT_PK);
        (, campaign) = registry.createCampaign(cfg, kpis, tiers);
        token.approve(address(vault), POOL);
        vault.deposit(campaign, POOL);
        Campaign(campaign).activate();
        vm.stopBroadcast();
    }
}
