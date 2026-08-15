// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Campaign} from "../src/campaign/Campaign.sol";
import {CampaignRegistry} from "../src/campaign/CampaignRegistry.sol";
import {EscrowVault} from "../src/escrow/EscrowVault.sol";
import {AttributionRegistry} from "../src/attribution/AttributionRegistry.sol";
import {Types} from "../src/libraries/Types.sol";

/// @title SeedDemo
/// @notice Seeds the whole demo fixture: six short-dated campaigns, nothing else.
/// @dev **This is a whole-fixture seed for a freshly deployed registry, not an append.** It assumes
///      `campaignCount() == 0` and asserts it, because the point of the fixture is that the six
///      campaigns below are the *entire* marketplace. `CampaignRegistry` is append-only and
///      `Campaign.cancel()` is reachable only from `Pending`, so there is no way to retire a
///      campaign that has been activated — an empty registry is the only way to get an exact list.
///      Re-pointing the app at a new deployment (`DeployBoney` + `pnpm deployments 84532`) is
///      therefore part of running this script, not an alternative to it.
///
///      **Why it does not deploy a token.** `SeedLocal` deploys its own `SeedToken`, and doing that
///      here again would leave a third mock bUSD on Base Sepolia; two already exist and campaigns
///      split across them, which made "total pool" reads ambiguous until they were grouped by
///      denomination. This script takes `TOKEN_ADDRESS` and prices all six campaigns in that one
///      token, so every pool in the fixture is directly comparable.
///
///      **Why these durations.** Campaigns seeded elsewhere run 30-60 days out, so nothing reaches
///      `endTime` during a testing session and the window-closed -> `end()` -> grace ->
///      `reclaimUnspent` path is unreachable without warping a chain. These six bracket it: the
///      24-hour campaign lapses within a day, and the 3/5/7/10/14-day spread is a staircase of
///      "expires next" states for list sorting and countdown rendering. Unlike `SeedExpiry` there is
///      no long control campaign — the ask was a fixture where *everything* expires soon, so the
///      whole list turns over inside two weeks.
///
///      **`attributionWindow` equals each campaign's own length.** A touch therefore stays live for
///      as long as the campaign it belongs to, and attribution never lapses out from under a
///      promoter mid-campaign — so an uncredited promoter is a reporting bug, not an expired touch.
///
///      That only holds if `AttributionRegistry.maxTouchDuration` covers the longest campaign here.
///      The cap is applied per touch as `min(attributionWindow, maxTouchDuration)` and it is applied
///      **silently**: campaign creation does not validate against it, and the UI renders the
///      campaign's own `attributionWindow`. A registry deployed with a short testing cap would leave
///      these campaigns *reporting* 14 days while the chain honoured minutes, so `run()` asserts the
///      deployed cap rather than seeding a fixture that quietly disagrees with itself.
///
///      Campaigns are funded and activated rather than left Pending: a Pending campaign never
///      reaches its window, so it cannot show expiry.
///
///      **Three of the six are reputation-gated, so `SeedDevRep` must run first.** `Campaign`'s
///      constructor reads `maxScore()` and rejects any `minReputation` above it, and a freshly
///      deployed `ReputationRegistry` has no schemas — so its ceiling is 0 and every gate below
///      would revert `UnreachableReputation`. Seeding reputation first both raises that ceiling to
///      28,000 and restores the dev wallet's 24,620, which is the score the gates are placed around.
///
///      Usage (Base Sepolia), after redeploying and regenerating `web/src/lib/deployments.ts`:
///        PRIVATE_KEY=… REGISTRY_ADDRESS=… VAULT_ADDRESS=… TOKEN_ADDRESS=… \
///        ATTRIBUTION_ADDRESS=… \
///        forge script script/SeedDemo.s.sol:SeedDemo --rpc-url … --broadcast --slow
contract SeedDemo is Script {
    /// @dev Raised when the registry's global cap would silently shorten these windows.
    error TouchCapTooLow(uint64 maxTouchDuration, uint64 longestCampaign);

    /// @dev Raised when the target registry already holds campaigns. Seeding on top of them would
    ///      produce a list of old + new rather than the exact six this fixture promises.
    error RegistryNotEmpty(uint256 existing);

    /// @dev The number of campaigns in the fixture. Named so the arrays below cannot drift.
    uint256 constant COUNT = 6;

    /// @dev The longest campaign seeded here, and therefore the minimum global touch cap this
    ///      fixture needs. Kept as a named constant so the guard in `run()` and the durations
    ///      cannot drift apart.
    uint64 constant LONGEST = 14 days;

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

        // Both checks fail before spending gas rather than producing a fixture that looks right and
        // behaves differently.
        uint256 existing = registry.campaignCount();
        if (existing != 0) revert RegistryNotEmpty(existing);

        uint64 cap = attribution.maxTouchDuration();
        if (cap < LONGEST) revert TouchCapTooLow(cap, LONGEST);

        // Ascending, so campaign id order is also expiry order: id 0 is the one that lapses first,
        // which is the row a tester actually wants to watch.
        uint64[COUNT] memory durations =
            [uint64(24 hours), uint64(3 days), uint64(5 days), uint64(7 days), uint64(10 days), LONGEST];

        // Pools rise with duration so the list is not six identical rows: utilization meters, the
        // pool column, and the by-denomination totals each get a spread to render. Small on
        // purpose — these campaigns exercise expiry, not the payout ladder, and one testnet wallet
        // funds all six.
        uint256[COUNT] memory pools =
            [uint256(2_000 ether), 5_000 ether, 8_000 ether, 12_000 ether, 25_000 ether, 50_000 ether];

        // Varied only so the six rows are visually distinguishable. `kind` is a hint for indexers
        // and UIs — settlement never branches on it — and every KPI here leaves `verifier` at
        // address(0), so all six report and settle through the identical path.
        Types.KpiKind[COUNT] memory kinds = [
            Types.KpiKind.Mint,
            Types.KpiKind.Swap,
            Types.KpiKind.Deposit,
            Types.KpiKind.Stake,
            Types.KpiKind.TokenPurchase,
            Types.KpiKind.signUps
        ];

        // Reputation gates on three of the five multi-day campaigns. The 24-hour one stays ungated:
        // it is the campaign a tester reaches for to watch an expiry happen, and a gate there would
        // only add a reason for the wallet under test to be turned away from it.
        //
        // The three values bracket the dev wallet's seeded BoneyScore of 24,620 on purpose:
        //   10,000 — cleared comfortably; the ordinary "gated but joinable" row
        //   24,000 — cleared by 620; the margin is thin enough that a decayed ETHOS_SCORE or
        //            X_REACH record drops the wallet below it, which is the freshness gate becoming
        //            visible rather than a bug
        //   26,000 — not clearable by that wallet at all, so `InsufficientReputation` and the
        //            gate-blocked UI are reachable without editing the fixture
        //
        // Every value sits under `maxScore()` (28,000 = 7*2800 + 3*2800). `Campaign`'s constructor
        // rejects a gate above that ceiling with `UnreachableReputation`, and an unseeded registry
        // reports a ceiling of 0 — which is why `SeedDevRep` must run before this script.
        uint256[COUNT] memory gates = [uint256(0), 0, 10_000, 0, 24_000, 26_000];

        // Names are what the marketplace's project column renders. These six are the labels the
        // old `PROJECT_NAMES` placeholder map in `web/src/lib/projects.ts` used to fake by campaign
        // id — now that a name is on chain, the fixture supplies them for real and that map is gone.
        // Each must be unique after normalization or `createCampaign` reverts `NameTaken`.
        string[COUNT] memory names = ["Aerodrome", "Velodrome", "Moonwell", "Aave", "Compound", "Openseas"];

        address[COUNT] memory created;
        uint256 funded;
        for (uint256 i = 0; i < COUNT; i++) {
            created[i] = _createFunded(names[i], durations[i], pools[i], kinds[i], gates[i]);
            funded += pools[i];
        }

        string[COUNT] memory labels = ["24h ", "3d  ", "5d  ", "7d  ", "10d ", "14d "];

        console.log("");
        console.log("Demo fixture seeded: %s campaigns, %s bUSD escrowed", COUNT, funded / 1 ether);
        console.log("(attribution window = each campaign's own length)");
        for (uint256 i = 0; i < COUNT; i++) {
            console.log(
                string.concat(
                    "  id ",
                    vm.toString(i),
                    "  ",
                    labels[i],
                    " ",
                    vm.toString(created[i]),
                    "  minRep ",
                    vm.toString(gates[i]),
                    "  ",
                    names[i]
                )
            );
        }
    }

    /// @dev Creates, funds, and activates one campaign called `name`, expiring `duration` from now,
    ///      attributing for that same `duration`, behind a `gate` of `minReputation`.
    ///
    ///      The KPI shape mirrors `SeedLocal._create` — one KPI with a three-rung ladder scaled to
    ///      the pool — so these campaigns are reportable with the same calls as the rest of the
    ///      repo's fixtures and the only meaningful variables between them are duration and gate.
    function _createFunded(
        string memory name,
        uint64 duration,
        uint256 pool,
        Types.KpiKind kind,
        uint256 gate
    ) internal returns (address campaign) {
        Types.CampaignConfig memory cfg = Types.CampaignConfig({
            project: project,
            name: name,
            token: address(token),
            rewardPool: pool,
            startTime: uint64(block.timestamp),
            endTime: uint64(block.timestamp) + duration,
            // Equal to the campaign's own length: a touch signed at any point stays live until the
            // campaign itself closes, so attribution never lapses mid-campaign.
            attributionWindow: duration,
            minReputation: gate
        });

        Types.KpiSpec[] memory kpis = new Types.KpiSpec[](1);
        kpis[0] = Types.KpiSpec({kind: kind, verifier: address(0), target: 100, aggregate: false, params: ""});

        // Three rungs at 10/50/100 units paying 5%/10%/20% of the pool: a promoter who tops the
        // ladder takes 35%, so the pool supports roughly three full-ladder promoters before it is
        // exhausted. That leaves the fixture with headroom to demonstrate a partially spent pool
        // without any one campaign draining on the first report.
        Types.RewardTier[][] memory tiers = new Types.RewardTier[][](1);
        tiers[0] = new Types.RewardTier[](3);
        tiers[0][0] = Types.RewardTier({threshold: 10, reward: pool / 20});
        tiers[0][1] = Types.RewardTier({threshold: 50, reward: pool / 10});
        tiers[0][2] = Types.RewardTier({threshold: 100, reward: pool / 5});

        vm.startBroadcast(PROJECT_PK);
        (, campaign) = registry.createCampaign(cfg, kpis, tiers);
        token.approve(address(vault), pool);
        vault.deposit(campaign, pool);
        Campaign(campaign).activate();
        vm.stopBroadcast();
    }
}
