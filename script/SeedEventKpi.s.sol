// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Campaign} from "../src/campaign/Campaign.sol";
import {CampaignRegistry} from "../src/campaign/CampaignRegistry.sol";
import {EscrowVault} from "../src/escrow/EscrowVault.sol";
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
///      `verifier` is deliberately `address(0)`. A verifier's `params` is read by
///      `TouchWindowVerifier` as a bare `uint64` lookback and ignored unless it is exactly 32
///      bytes; a 160-byte event blob would silently yield a lookback of 0. The two encodings
///      cannot share the field, and event sourcing is the one in use here.
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

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address project = vm.addr(pk);

        CampaignRegistry registry = CampaignRegistry(vm.envAddress("REGISTRY_ADDRESS"));
        EscrowVault vault = EscrowVault(vm.envAddress("VAULT_ADDRESS"));
        IERC20 token = IERC20(vm.envAddress("SEED_TOKEN"));

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
            verifier: address(0),
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

        console.log("Event-sourced campaign created");
        console.log("  campaignId: ", campaignId);
        console.log("  campaign:   ", campaign);
        console.log("  tracking:   Deposit(address,uint256) on", WETH);
        console.log("  scale:      1 unit per 0.001 WETH");
    }
}
