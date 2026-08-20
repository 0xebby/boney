// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Campaign} from "../src/campaign/Campaign.sol";
import {CampaignRegistry} from "../src/campaign/CampaignRegistry.sol";
import {EscrowVault} from "../src/escrow/EscrowVault.sol";
import {EventMetricKpiVerifier} from "../src/verifiers/EventMetricKpiVerifier.sol";
import {GuardedKpiVerifier} from "../src/verifiers/GuardedKpiVerifier.sol";
import {IEventMetricKpiVerifier} from "../src/interfaces/IEventMetricKpiVerifier.sol";
import {IGuardedKpiVerifier} from "../src/interfaces/IGuardedKpiVerifier.sol";
import {Types} from "../src/libraries/Types.sol";

/// @title SeedEventKpi
/// @notice Creates a campaign whose KPI is fed by a *real* contract's events rather than by the
///         project typing numbers into `reportUserAction`.
/// @dev This is the on-chain half of event-sourced KPIs. `KpiSpec.params` carries what
///      `Types.sol:50` always said it would — "the contract address and event signature being
///      tracked" — encoded as five abi words (see `web/src/lib/kpiSource.ts`, the canonical
///      definition):
///
///          abi.encode(address source, bytes32 topic0, uint8 actorTopic, uint8 amountMode,
///                     uint256 scale)
///
///      Here that is WETH's `Deposit(address indexed dst, uint256 wad)` on Base's canonical
///      predeploy. The shape was confirmed against a live Base Sepolia log before being encoded:
///      `topics[1]` holds `dst` (so `actorTopic = 1`) and `data` is the single `uint256` `wad`
///      (so `amountMode = 1`).
///
///      `verifier` is gated behind env vars and defaults to `address(0)`. The reason it *had* to be
///      `address(0)` is gone: verifiers used to read their config from the same `params` field, where
///      `TouchWindowVerifier` reads a bare `uint64` lookback and ignores anything that is not exactly
///      32 bytes — so a 160-byte event blob silently yielded a lookback of 0 and the two encodings
///      could not share the field. `EventMetricKpiVerifier` keeps its config in its own storage via
///      `setKpiConfig`, so event sourcing and verification can now coexist on one KPI. Pass
///      `KPI_VERIFIER_ADDRESS` and `GUARDED_VERIFIER_ADDRESS` to gate this campaign; leave them unset
///      for the original ungated behavior.
///
///      Reuses the token the main seed already deployed rather than minting another, so the
///      campaign shows up under the same balance a wallet already holds. Pass it via
///      `SEED_TOKEN`.
contract SeedEventKpi is Script {
    /// @notice Canonical WETH predeploy. Same address on every OP-stack chain, Base included.
    address public constant WETH = 0x4200000000000000000000000000000000000006;

    /// @notice `keccak256("Deposit(address,uint256)")` — verified against a live Base Sepolia log.
    bytes32 public constant DEPOSIT_TOPIC = 0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c;

    /// @notice `topics[1]` carries `dst`, the depositing wallet.
    uint8 public constant ACTOR_TOPIC = 1;

    /// @notice Read the amount from the first data word, rather than counting events.
    uint8 public constant AMOUNT_MODE_DATA_WORD0 = 1;

    /// @notice 0.001 WETH per unit of progress.
    /// @dev Without scaling, one deposit credits ~1e15 progress and every tier crosses at once —
    ///      the ladder would be decorative. This keeps `RewardTier.threshold` a human number.
    uint256 public constant SCALE = 1e15;

    /// @notice The tracked event in the human-readable form `EventMetricKpiVerifier` stores.
    /// @dev Declaration order is (dst, wad), so the user param is index 0 and the summed param is
    ///      index 1. Consistent with `ACTOR_TOPIC = 1` above, which is `topics[1] == dst`.
    string public constant DEPOSIT_EVENT = "Deposit(address indexed dst, uint256 wad)";

    /// @notice Blocks of slack added past the campaign's projected reporting close.
    /// @dev Biased high on purpose: `windowEndBlock` only bounds the relayer's checkpoint, while
    ///      `Campaign` enforces its own report window regardless, so over-estimating wastes a little
    ///      scanning and under-estimating under-credits promoters. `pnpm report-window` derives the
    ///      exact value once the campaign exists.
    uint256 public constant BLOCK_MARGIN = 10_000;

    /// @dev Held as state rather than locals: `run()` is at the stack-slot limit without `via_ir`.
    address kpiVerifier;
    address guardedVerifier;
    bool gated;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address project = vm.addr(pk);

        CampaignRegistry registry = CampaignRegistry(vm.envAddress("REGISTRY_ADDRESS"));
        EscrowVault vault = EscrowVault(vm.envAddress("VAULT_ADDRESS"));
        IERC20 token = IERC20(vm.envAddress("SEED_TOKEN"));

        // Optional. Both must be set to gate the KPI; either one alone leaves it ungated, since a
        // guard with no Boney verifier behind it has nothing to cap against.
        kpiVerifier = vm.envOr("KPI_VERIFIER_ADDRESS", address(0));
        guardedVerifier = vm.envOr("GUARDED_VERIFIER_ADDRESS", address(0));
        gated = kpiVerifier != address(0) && guardedVerifier != address(0);

        // Small next to the 10M the seed minted: this campaign exists to prove the loop, and
        // escrow only returns after the claim grace window.
        uint256 pool = vm.envOr("SEED_POOL", uint256(1_000 ether));

        uint256 balance = token.balanceOf(project);
        if (balance < pool) {
            revert(
                string.concat(
                    "project token balance too low: has ", vm.toString(balance), ", needs ", vm.toString(pool)
                )
            );
        }

        Types.CampaignConfig memory cfg = Types.CampaignConfig({
            project: project,
            // Names are unique per registry, so this appends the campaign id the registry is about
            // to assign — re-running this script against the same chain would otherwise revert
            // `NameTaken` on the second run.
            name: string.concat("Event KPI Demo ", vm.toString(registry.campaignCount())),
            token: address(token),
            rewardPool: pool,
            startTime: uint64(block.timestamp),
            endTime: uint64(block.timestamp + 30 days),
            attributionWindow: 30 minutes,
            minReputation: 0
        });

        Types.KpiSpec[] memory kpis = new Types.KpiSpec[](1);
        kpis[0] = Types.KpiSpec({
            kind: Types.KpiKind.Deposit,
            verifier: gated ? guardedVerifier : address(0),
            target: 100,
            aggregate: false,
            params: abi.encode(WETH, DEPOSIT_TOPIC, ACTOR_TOPIC, AMOUNT_MODE_DATA_WORD0, SCALE)
        });

        // First rung at 1 unit — a single 0.001 WETH deposit crosses it, so the end-to-end run
        // proves settlement without needing real money.
        Types.RewardTier[][] memory tiers = new Types.RewardTier[][](1);
        tiers[0] = new Types.RewardTier[](3);
        tiers[0][0] = Types.RewardTier({threshold: 1, reward: pool / 20});
        tiers[0][1] = Types.RewardTier({threshold: 5, reward: pool / 10});
        tiers[0][2] = Types.RewardTier({threshold: 20, reward: pool / 5});

        vm.startBroadcast(pk);

        (uint256 campaignId, address campaign) = registry.createCampaign(cfg, kpis, tiers);

        token.approve(address(vault), pool);
        vault.deposit(campaign, pool);
        Campaign(campaign).activate();

        vm.stopBroadcast();

        // Configured after creation because `kpiIndex`, `startTime` and `endTime` do not exist until
        // the campaign does — the same ordering a real project has to follow.
        if (gated) _configureVerification(campaign, pk);

        console.log("Event-sourced campaign created");
        console.log("  campaignId: ", campaignId);
        console.log("  campaign:   ", campaign);
        console.log("  tracking:   Deposit(address,uint256) on", WETH);
        console.log("  scale:      1 unit per 0.001 WETH");
        console.log("  verifier:   ", gated ? guardedVerifier : address(0));
    }

    /// @dev Points the KPI at WETH's `Deposit` event on Boney's verifier and routes the guard through
    ///      Boney alone. Split out of `run()` rather than inlined because `run()` is already at the
    ///      stack-slot limit without `via_ir`.
    /// @param campaign The freshly created campaign.
    /// @param pk Key to broadcast with; must own both verifiers.
    function _configureVerification(address campaign, uint256 pk) internal {
        uint256 windowEndBlock =
            block.number + (30 days + Campaign(campaign).CLAIM_GRACE()) / 2 + BLOCK_MARGIN;

        vm.startBroadcast(pk);
        EventMetricKpiVerifier(kpiVerifier).setKpiConfig(
            campaign,
            0,
            WETH,
            DEPOSIT_EVENT,
            0, // userParamIndex — `dst`
            IEventMetricKpiVerifier.Aggregation.SUM,
            1, // valueParamIndex — `wad`
            SCALE, // same divisor the indexer applies, so the cap is denominated in progress units
            block.number,
            windowEndBlock
        );
        // Boney alone: this campaign exists to prove event sourcing, and a second verifier would add
        // a reason for it not to credit.
        GuardedKpiVerifier(guardedVerifier).setGuardConfig(
            campaign, 0, address(0), 0, IGuardedKpiVerifier.Mode.AGREE
        );
        vm.stopBroadcast();
    }
}
