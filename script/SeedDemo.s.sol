// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Campaign} from "../src/campaign/Campaign.sol";
import {CampaignRegistry} from "../src/campaign/CampaignRegistry.sol";
import {EscrowVault} from "../src/escrow/EscrowVault.sol";
import {AttributionRegistry} from "../src/attribution/AttributionRegistry.sol";
import {EventMetricKpiVerifier} from "../src/verifiers/EventMetricKpiVerifier.sol";
import {GuardedKpiVerifier} from "../src/verifiers/GuardedKpiVerifier.sol";
import {IEventMetricKpiVerifier} from "../src/interfaces/IEventMetricKpiVerifier.sol";
import {IGuardedKpiVerifier} from "../src/interfaces/IGuardedKpiVerifier.sol";
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
///      **Every KPI is gated by `GuardedKpiVerifier`, so the relayer has to run for progress to
///      move.** A gated KPI credits `min(project's claim, Boney's independently observed total)`, and
///      Boney's total is 0 until `pnpm relay` has scanned. Reports that land first are silent no-ops,
///      not reverts — `Campaign` returns early when the verified total does not exceed what is
///      already credited. So the fixture needs both off-chain halves running: `pnpm index` to claim
///      as the project, and `pnpm relay` to observe as Boney. Running only the indexer leaves every
///      progress bar at zero, which is the verification layer working, not a bug.
///
///      Campaign 1 (the multi-KPI one) additionally cross-checks `TouchWindowVerifier` under
///      `Mode.CAP`, so the fixture exercises both shapes: five campaigns on Boney alone, one with a
///      second on-chain lens layered on. Note that `TouchWindowVerifier` credits nothing without
///      `evidence`, so campaign 1 only moves for reporters that send it — the indexer does.
///
///      **Three of the six are reputation-gated, so `SeedDevRep` must run first.** `Campaign`'s
///      constructor reads `maxScore()` and rejects any `minReputation` above it, and a freshly
///      deployed `ReputationRegistry` has no schemas — so its ceiling is 0 and every gate below
///      would revert `UnreachableReputation`. Seeding reputation first both raises that ceiling to
///      28,000 and restores the dev wallet's 24,620, which is the score the gates are placed around.
///
///      Usage (Base Sepolia), after redeploying and regenerating `web/src/lib/deployments.ts`:
///        PRIVATE_KEY=… REGISTRY_ADDRESS=… VAULT_ADDRESS=… TOKEN_ADDRESS=… \
///        ATTRIBUTION_ADDRESS=… KPI_VERIFIER_ADDRESS=… GUARDED_VERIFIER_ADDRESS=… \
///        TOUCH_VERIFIER_ADDRESS=… \
///        forge script script/SeedDemo.s.sol:SeedDemo --rpc-url … --broadcast --slow
contract SeedDemo is Script {
    /// @dev Raised when the registry's global cap would silently shorten these windows.
    error TouchCapTooLow(uint64 maxTouchDuration, uint64 longestCampaign);

    /// @dev Raised when the target registry already holds campaigns. Seeding on top of them would
    ///      produce a list of old + new rather than the exact six this fixture promises.
    error RegistryNotEmpty(uint256 existing);

    /// @dev Raised when the seeding key does not own the KPI verifiers. `setKpiConfig` and
    ///      `setGuardConfig` are `onlyOwner`, and both are owned by whoever ran `DeployBoney` — the
    ///      same key in this fixture. Checked up front so a mismatch fails before any campaign is
    ///      created, rather than leaving half a fixture behind.
    error VerifierNotOwned(address verifier, address owner, address seeder);

    /// @dev The number of campaigns in the fixture. Named so the arrays below cannot drift.
    uint256 constant COUNT = 6;

    /// @dev The longest campaign seeded here, and therefore the minimum global touch cap this
    ///      fixture needs. Kept as a named constant so the guard in `run()` and the durations
    ///      cannot drift apart.
    uint64 constant LONGEST = 14 days;

    /// @dev Seconds per block on Base Sepolia, used to project a campaign's reporting close onto a
    ///      block number for `windowEndBlock`.
    uint256 constant BLOCK_TIME = 2;

    /// @dev Extra blocks added to that projection. The estimate is deliberately biased **high**,
    ///      because the two directions are not symmetric: `windowEndBlock` only bounds how far the
    ///      relayer may checkpoint, while `Campaign` independently enforces its own report window. An
    ///      over-estimate therefore costs a little wasted scanning after a campaign closes, whereas an
    ///      under-estimate stops the relayer early and under-credits promoters. `pnpm report-window`
    ///      derives the exact value, and `setKpiConfig` can be re-run to tighten it.
    uint256 constant BLOCK_MARGIN = 10_000;

    /// @dev The event all six campaigns track, in the human-readable form `EventMetricKpiVerifier`
    ///      stores and the relayer decodes against. Declaration order is (from, to, value), so the
    ///      user param is index 1 and the summed param is index 2 — matching the `actorTopic: 2`
    ///      (topics[2] == `to`) in the event-source blob written into `KpiSpec.params` below.
    string constant TRANSFER_EVENT = "Transfer(address indexed from, address indexed to, uint256 value)";

    uint256 PROJECT_PK;
    address project;
    CampaignRegistry registry;
    EscrowVault vault;
    IERC20 token;
    AttributionRegistry attribution;
    EventMetricKpiVerifier kpiVerifier;
    GuardedKpiVerifier guardedVerifier;
    address touchVerifier;

    function run() external {
        PROJECT_PK = vm.envUint("PRIVATE_KEY");
        registry = CampaignRegistry(vm.envAddress("REGISTRY_ADDRESS"));
        vault = EscrowVault(vm.envAddress("VAULT_ADDRESS"));
        token = IERC20(vm.envAddress("TOKEN_ADDRESS"));
        attribution = AttributionRegistry(vm.envAddress("ATTRIBUTION_ADDRESS"));
        kpiVerifier = EventMetricKpiVerifier(vm.envAddress("KPI_VERIFIER_ADDRESS"));
        guardedVerifier = GuardedKpiVerifier(vm.envAddress("GUARDED_VERIFIER_ADDRESS"));
        touchVerifier = vm.envAddress("TOUCH_VERIFIER_ADDRESS");
        project = vm.addr(PROJECT_PK);

        // Both checks fail before spending gas rather than producing a fixture that looks right and
        // behaves differently.
        uint256 existing = registry.campaignCount();
        if (existing != 0) revert RegistryNotEmpty(existing);

        if (kpiVerifier.owner() != project) {
            revert VerifierNotOwned(address(kpiVerifier), kpiVerifier.owner(), project);
        }
        if (guardedVerifier.owner() != project) {
            revert VerifierNotOwned(address(guardedVerifier), guardedVerifier.owner(), project);
        }

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

        // Uniform, and deliberately so. These six previously carried a different `kind` each purely
        // so the marketplace rows looked distinguishable, while every one of them tracked the same
        // thing: a bUSD `Transfer` with the referred wallet as recipient. The UI renders `kind`
        // alongside the decoded event source, so a campaign named "Aave" labelled `Stake` while
        // actually measuring token transfers reads as a bug in the app — the panels disagreed
        // because the fixture made them disagree.
        //
        // `kind` is only a hint (settlement never branches on it), which is exactly why it must not
        // contradict the event source: it is the one part of a KPI a reader trusts without decoding
        // anything. `TokenPurchase` is the honest reading of "this wallet received tokens".
        Types.KpiKind[COUNT] memory kinds = [
            Types.KpiKind.TokenPurchase,
            Types.KpiKind.TokenPurchase,
            Types.KpiKind.TokenPurchase,
            Types.KpiKind.TokenPurchase,
            Types.KpiKind.TokenPurchase,
            Types.KpiKind.TokenPurchase
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
            if (i == 1) {
                // Campaign 1 (3d) uses 2 KPIs to test multi-KPI support
                created[i] = _createFundedMultiKpi(names[i], durations[i], pools[i], gates[i], 2);
            } else {
                created[i] = _createFunded(names[i], durations[i], pools[i], kinds[i], gates[i]);
            }
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

        // Configure event source to track Transfer events from the token contract.
        // Transfer(address indexed from, address indexed to, uint256 value)
        // Actor is "to" (topics[2]), amount is value (from data)
        // Scale by 1e18 to convert from token base units to display units
        bytes32 transferSignature = keccak256("Transfer(address,address,uint256)");
        bytes memory eventSourceParams = abi.encode(
            address(token), // source: token contract where Transfer events come from
            transferSignature, // topic0: Transfer event signature
            uint8(2), // actorTopic: 2 (the "to" indexed parameter, 1-based from topic[0])
            // amountMode: 1 = dataWord0, read `value` from the first data word. NOT 0 — that is
            // `count` (`AMOUNT_MODE` in `web/src/lib/kpiSource.ts`), which folds 1 per log and then
            // divides by the 1e18 scale below, flooring every referral to zero. The verifier config
            // in `_configureVerification` folds by SUM, so 0 here also puts the two halves in
            // disagreement about the unit itself.
            uint8(1),
            uint256(1e18) // scale: divide by 1e18 to normalize token decimals
        );

        kpis[0] = Types.KpiSpec({
            kind: kind,
            verifier: address(guardedVerifier),
            target: 100,
            aggregate: false,
            params: eventSourceParams
        });

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

        // Boney alone for the single-KPI campaigns. `address(0)` as the project verifier means the
        // guard forwards Boney's number untouched, which keeps all five reportable with empty
        // `evidence`.
        _configureVerification(campaign, 0, duration, address(0), IGuardedKpiVerifier.Mode.AGREE);

        return campaign;
    }

    /// @dev Creates a campaign with multiple event-based KPIs to test multi-KPI support.
    function _createFundedMultiKpi(
        string memory name,
        uint64 duration,
        uint256 pool,
        uint256 gate,
        uint256 numKpis
    ) internal returns (address campaign) {
        Types.CampaignConfig memory cfg = Types.CampaignConfig({
            project: project,
            name: name,
            token: address(token),
            rewardPool: pool,
            startTime: uint64(block.timestamp),
            endTime: uint64(block.timestamp) + duration,
            attributionWindow: duration,
            minReputation: gate
        });

        Types.KpiSpec[] memory kpis = new Types.KpiSpec[](numKpis);
        Types.RewardTier[][] memory tiers = new Types.RewardTier[][](numKpis);

        bytes32 transferSignature = keccak256("Transfer(address,address,uint256)");

        for (uint256 i = 0; i < numKpis; i++) {
            // `uint8(1)` is `dataWord0` — see the note in `_createCampaign`. `uint8(0)` would be
            // `count`, which the 1e18 scale then floors to zero.
            bytes memory eventSourceParams =
                abi.encode(address(token), transferSignature, uint8(2), uint8(1), uint256(1e18));

            kpis[i] = Types.KpiSpec({
                // Same event source as every other KPI in this fixture, so the same honest `kind`.
                kind: Types.KpiKind.TokenPurchase,
                verifier: address(guardedVerifier),
                target: 100,
                aggregate: false,
                params: eventSourceParams
            });

            // Equal tier structure for each KPI
            tiers[i] = new Types.RewardTier[](3);
            tiers[i][0] = Types.RewardTier({threshold: 10, reward: pool / (20 * numKpis)});
            tiers[i][1] = Types.RewardTier({threshold: 50, reward: pool / (10 * numKpis)});
            tiers[i][2] = Types.RewardTier({threshold: 100, reward: pool / (5 * numKpis)});
        }

        vm.startBroadcast(PROJECT_PK);
        (, campaign) = registry.createCampaign(cfg, kpis, tiers);
        token.approve(address(vault), pool);
        vault.deposit(campaign, pool);
        Campaign(campaign).activate();
        vm.stopBroadcast();

        // The one campaign that layers a second on-chain lens. `TouchWindowVerifier` under
        // `Mode.CAP` credits `min(Boney, touch-window)`, so activity a promoter did not hold
        // attribution for is denied on chain rather than only in the relayer. `CAP` and not `AGREE`
        // because the two verifiers measure deliberately different quantities — see
        // `GuardedKpiVerifier`'s contract docs.
        for (uint256 i = 0; i < numKpis; i++) {
            _configureVerification(campaign, i, duration, touchVerifier, IGuardedKpiVerifier.Mode.CAP);
        }

        return campaign;
    }

    /// @dev Points a KPI's verification at the `Transfer` event this fixture tracks, and configures
    ///      how the guard combines Boney's reading with an optional second one.
    ///
    ///      Run after `activate()` rather than before: nothing reads the config until a report lands,
    ///      and configuring afterwards keeps campaign creation and verifier setup as separate
    ///      transactions, which is also the order a real project would follow — `kpiIndex`, `startTime`
    ///      and `endTime` do not exist until the campaign is created.
    /// @param campaign The freshly created campaign.
    /// @param kpiIndex Index of the KPI within it.
    /// @param duration The campaign's length, used to project its reporting close onto a block.
    /// @param projectVerifier Second verifier to consult, or `address(0)` for Boney alone.
    /// @param mode How the two readings combine.
    function _configureVerification(
        address campaign,
        uint256 kpiIndex,
        uint64 duration,
        address projectVerifier,
        IGuardedKpiVerifier.Mode mode
    ) internal {
        uint256 closesIn = uint256(duration) + Campaign(campaign).CLAIM_GRACE();
        uint256 windowEndBlock = block.number + closesIn / BLOCK_TIME + BLOCK_MARGIN;

        vm.startBroadcast(PROJECT_PK);
        kpiVerifier.setKpiConfig(
            campaign,
            kpiIndex,
            address(token),
            TRANSFER_EVENT,
            1, // userParamIndex — `to`, the wallet receiving the transfer
            IEventMetricKpiVerifier.Aggregation.SUM,
            2, // valueParamIndex — `value`
            1e18, // scale, matching the event-source blob the indexer reads
            block.number, // campaigns start at `block.timestamp`, so tracking starts here
            windowEndBlock
        );
        guardedVerifier.setGuardConfig(campaign, kpiIndex, projectVerifier, 0, mode);
        vm.stopBroadcast();
    }
}
