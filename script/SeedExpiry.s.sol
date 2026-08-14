// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Campaign} from "../src/campaign/Campaign.sol";
import {CampaignRegistry} from "../src/campaign/CampaignRegistry.sol";
import {EscrowVault} from "../src/escrow/EscrowVault.sol";
import {AttributionRegistry} from "../src/attribution/AttributionRegistry.sol";
import {Types} from "../src/libraries/Types.sol";

/// @title SeedExpiry
/// @notice Seeds exactly seven short-dated campaigns, each attributing for its whole lifetime.
/// @dev Append-only, and separate from `SeedLocal` for the same reason `SeedGated` is: that script
///      is a whole-fixture seed whose output `web/src/lib/live.test.ts` pins, so re-running it to
///      add campaigns would deploy a second token and duplicate the existing five. This one only
///      appends, and reuses the token already on chain rather than minting a rival currency the
///      existing campaigns do not price in.
///
///      **Why these durations.** Campaigns seeded elsewhere run 30–60 days out, so nothing ever
///      reaches `endTime` during a testing session and the whole window-closed → `end()` → grace →
///      `reclaimUnspent` path is unreachable without warping a local chain. These seven bracket
///      that: the 24-hour campaign lapses within a day, the 5–14 day spread gives a staircase of
///      "expires next" states for list sorting and countdown rendering, and the 23-day one stays
///      open as the control that should still be Active when the others are not.
///
///      **`attributionWindow` equals the campaign's own length.** A touch therefore stays live for
///      as long as the campaign it belongs to, and attribution never lapses out from under a
///      promoter mid-campaign — so a promoter who is not credited is a reporting bug, not an
///      expired touch.
///
///      This only holds if `AttributionRegistry.maxTouchDuration` is at least the longest campaign
///      here. That cap is a hard ceiling applied per touch, and it is applied **silently**:
///      `_effectiveMaxDuration` returns `min(attributionWindow, maxTouchDuration)` and campaign
///      creation does not validate against it. A registry deployed with the 2-hour testing cap
///      would leave every campaign below *reporting* a 5-day window while the chain honoured two
///      hours — the UI reads `attributionWindow` from the campaign, not the effective value. So
///      `DeployBoney.MAX_TOUCH_DURATION` must cover `LONGEST` below, and `run()` asserts it rather
///      than seeding a fixture that quietly disagrees with itself.
///
///      Campaigns are funded and activated rather than left Pending: a Pending campaign never
///      reaches its window at all, so it cannot show expiry. Reputation gates are left at zero for
///      the same reason — `SeedGated` owns that axis, and a gate here would only stop a wallet
///      from joining a campaign whose expiry is the thing under test.
///
///      Usage (Base Sepolia):
///        PRIVATE_KEY=… REGISTRY_ADDRESS=… VAULT_ADDRESS=… TOKEN_ADDRESS=… \
///        ATTRIBUTION_ADDRESS=… \
///        forge script script/SeedExpiry.s.sol:SeedExpiry --rpc-url … --broadcast --slow
contract SeedExpiry is Script {
    /// @dev Raised when the registry's global cap would silently shorten these windows.
    error TouchCapTooLow(uint64 maxTouchDuration, uint64 longestCampaign);

    /// @dev Small on purpose. These campaigns exist to exercise expiry, not the payout ladder, and
    ///      the funding wallet pays for all seven out of one finite testnet balance.
    uint256 constant POOL = 2_000 ether;

    /// @dev The longest campaign seeded here, and therefore the minimum global touch cap this
    ///      fixture needs. Kept as a named constant so the guard in `run()` and the durations
    ///      below cannot drift apart.
    uint64 constant LONGEST = 23 days;

    uint256 PROJECT_PK;
    CampaignRegistry registry;
    EscrowVault vault;
    IERC20 token;
    AttributionRegistry attribution;
    address project;

    function run() external {
        PROJECT_PK = vm.envUint("PRIVATE_KEY");
        registry = CampaignRegistry(vm.envAddress("REGISTRY_ADDRESS"));
        vault = EscrowVault(vm.envAddress("VAULT_ADDRESS"));
        token = IERC20(vm.envAddress("TOKEN_ADDRESS"));
        attribution = AttributionRegistry(vm.envAddress("ATTRIBUTION_ADDRESS"));
        project = vm.addr(PROJECT_PK);

        // Fail before spending gas rather than seeding windows the registry will not honour. The
        // clamp in `_effectiveMaxDuration` is silent, so without this check the fixture would look
        // correct on the campaign page and behave differently at `storeTouch`.
        uint64 cap = attribution.maxTouchDuration();
        if (cap < LONGEST) revert TouchCapTooLow(cap, LONGEST);

        // Ascending so the log reads as a countdown ladder, and so the first row is the one that
        // expires first — the campaign a tester actually wants to watch.
        uint64[7] memory durations = [
            uint64(24 hours),
            uint64(5 days),
            uint64(7 days),
            uint64(10 days),
            uint64(12 days),
            uint64(14 days),
            LONGEST
        ];

        address[7] memory created;
        for (uint256 i = 0; i < durations.length; i++) {
            created[i] = _createFunded(durations[i]);
        }

        console.log("");
        console.log(
            "Seven campaigns added (pool %s each, attribution = full campaign length):", POOL / 1 ether
        );
        console.log("  24h:     ", created[0]);
        console.log("  5 days:  ", created[1]);
        console.log("  7 days:  ", created[2]);
        console.log("  10 days: ", created[3]);
        console.log("  12 days: ", created[4]);
        console.log("  14 days: ", created[5]);
        console.log("  23 days: ", created[6]);
    }

    /// @dev Creates, funds, and activates one campaign expiring `duration` from now, attributing
    ///      for that same `duration`.
    ///
    ///      The KPI shape mirrors `SeedLocal._create` — one Mint KPI with a three-rung ladder
    ///      scaled to the pool — so these campaigns are reportable with the same calls as the rest
    ///      of the fixture and the only variable between them is the duration.
    function _createFunded(uint64 duration) internal returns (address campaign) {
        Types.CampaignConfig memory cfg = Types.CampaignConfig({
            project: project,
            // Suffixed with the id the registry is about to assign: names are unique per registry,
            // so a fixed string here would revert `NameTaken` on the second of these seven.
            name: string.concat("Expiry Demo ", vm.toString(registry.campaignCount())),
            token: address(token),
            rewardPool: POOL,
            startTime: uint64(block.timestamp),
            endTime: uint64(block.timestamp) + duration,
            // Equal to the campaign's own length: a touch signed at any point stays live until the
            // campaign itself closes, so attribution never lapses mid-campaign.
            attributionWindow: duration,
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
