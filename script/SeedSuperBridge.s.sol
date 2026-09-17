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

/// @title SeedSuperBridge
/// @notice Creates a fresh SuperBridge-shaped campaign on the live Base Sepolia registry, using
///         guarded event-source KPIs and a 5,000 BoneyScore promoter gate.
contract SeedSuperBridge is Script {
    error VerifierNotOwned(address verifier, address owner, address expected);
    error PoolUnfunded(address token, uint256 held, uint256 needed);
    error NameUnavailable(string name);

    address public constant WETH = 0x4200000000000000000000000000000000000006;

    bytes32 public constant DEPOSIT_TOPIC = 0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c;
    bytes32 public constant WITHDRAWAL_TOPIC =
        0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65;

    string public constant DEPOSIT_EVENT = "Deposit(address indexed dst, uint256 wad)";
    string public constant WITHDRAW_EVENT = "Withdrawal(address indexed src, uint256 wad)";

    uint8 internal constant COUNT = 0;
    uint8 internal constant SUM_WORD0 = 1;

    /// @dev 0.01 WETH per unit of progress, matching the live dashboard shape.
    uint256 public constant VOLUME_SCALE = 1e16;

    uint64 public constant DURATION = 30 days;
    uint256 public constant BLOCK_MARGIN = 10_000;
    uint256 public constant MIN_REPUTATION = 5_000;

    uint256 internal pk;
    address internal project;
    CampaignRegistry internal registry;
    EscrowVault internal vault;
    IERC20 internal token;
    EventMetricKpiVerifier internal kpiVerifier;
    GuardedKpiVerifier internal guardedVerifier;

    function run() external {
        pk = vm.envUint("PRIVATE_KEY");
        project = vm.addr(pk);
        registry = CampaignRegistry(vm.envAddress("REGISTRY_ADDRESS"));
        vault = EscrowVault(vm.envAddress("VAULT_ADDRESS"));
        token = IERC20(vm.envAddress("TOKEN_ADDRESS"));
        kpiVerifier = EventMetricKpiVerifier(vm.envAddress("KPI_VERIFIER_ADDRESS"));
        guardedVerifier = GuardedKpiVerifier(vm.envAddress("GUARDED_VERIFIER_ADDRESS"));

        _requireOwned(address(kpiVerifier), kpiVerifier.owner());
        _requireOwned(address(guardedVerifier), guardedVerifier.owner());

        string memory name = vm.envOr("SEED_NAME", string("SuperBridge CRE"));
        uint256 pool = vm.envOr("SEED_POOL", uint256(1_000_000 ether));

        if (!registry.isNameAvailable(name)) revert NameUnavailable(name);

        uint256 held = token.balanceOf(project);
        if (held < pool) revert PoolUnfunded(address(token), held, pool);

        address campaign = _create(name, pool);
        _configure(campaign);

        console.log("");
        console.log("SuperBridge campaign seeded (rewards in bUSD, all KPIs guarded)");
        console.log("  campaign:", campaign);
        console.log("  name    :", name);
        console.log("  pool    :", pool);
        console.log("  minRep  :", MIN_REPUTATION);
        console.log("  kpi0    : Deposit count on", WETH);
        console.log("  kpi1    : Withdraw count on", WETH);
        console.log("  kpi2    : Deposit volume on", WETH, "(SUM / 1e16)");
    }

    function _create(string memory name, uint256 pool) internal returns (address campaign) {
        Types.KpiSpec[] memory kpis = new Types.KpiSpec[](3);
        kpis[0] = Types.KpiSpec({
            kind: Types.KpiKind.Deposit,
            verifier: address(guardedVerifier),
            target: 1000,
            aggregate: false,
            params: abi.encode(WETH, DEPOSIT_TOPIC, uint8(1), COUNT, uint256(1))
        });
        kpis[1] = Types.KpiSpec({
            kind: Types.KpiKind.Withdraw,
            verifier: address(guardedVerifier),
            target: 1000,
            aggregate: false,
            params: abi.encode(WETH, WITHDRAWAL_TOPIC, uint8(1), COUNT, uint256(1))
        });
        kpis[2] = Types.KpiSpec({
            kind: Types.KpiKind.GenerateVolume,
            verifier: address(guardedVerifier),
            target: 2,
            aggregate: false,
            params: abi.encode(WETH, DEPOSIT_TOPIC, uint8(1), SUM_WORD0, VOLUME_SCALE)
        });

        Types.RewardTier[][] memory tiers = new Types.RewardTier[][](3);
        tiers[0] = _tiers();
        tiers[1] = _tiers();
        tiers[2] = _tiers();

        Types.CampaignConfig memory cfg = Types.CampaignConfig({
            project: project,
            name: name,
            token: address(token),
            rewardPool: pool,
            startTime: uint64(block.timestamp),
            endTime: uint64(block.timestamp) + DURATION,
            attributionWindow: DURATION,
            minReputation: MIN_REPUTATION
        });

        vm.startBroadcast(pk);
        (, campaign) = registry.createCampaign(cfg, kpis, tiers);
        token.approve(address(vault), pool);
        vault.deposit(campaign, pool);
        Campaign(campaign).activate();
        vm.stopBroadcast();
    }

    function _configure(address campaign) internal {
        uint256 closesIn = uint256(DURATION) + Campaign(campaign).CLAIM_GRACE();
        uint256 windowEndBlock = block.number + closesIn / 2 + BLOCK_MARGIN;

        vm.startBroadcast(pk);

        kpiVerifier.setKpiConfig(
            campaign,
            0,
            WETH,
            DEPOSIT_EVENT,
            0,
            IEventMetricKpiVerifier.Aggregation.COUNT,
            0,
            1,
            block.number,
            windowEndBlock
        );

        kpiVerifier.setKpiConfig(
            campaign,
            1,
            WETH,
            WITHDRAW_EVENT,
            0,
            IEventMetricKpiVerifier.Aggregation.COUNT,
            0,
            1,
            block.number,
            windowEndBlock
        );

        kpiVerifier.setKpiConfig(
            campaign,
            2,
            WETH,
            DEPOSIT_EVENT,
            0,
            IEventMetricKpiVerifier.Aggregation.SUM,
            1,
            VOLUME_SCALE,
            block.number,
            windowEndBlock
        );

        GuardedKpiVerifier(guardedVerifier).setGuardConfig(
            campaign, 0, address(0), 0, IGuardedKpiVerifier.Mode.AGREE
        );
        GuardedKpiVerifier(guardedVerifier).setGuardConfig(
            campaign, 1, address(0), 0, IGuardedKpiVerifier.Mode.AGREE
        );
        GuardedKpiVerifier(guardedVerifier).setGuardConfig(
            campaign, 2, address(0), 0, IGuardedKpiVerifier.Mode.AGREE
        );

        vm.stopBroadcast();
    }

    function _tiers() internal pure returns (Types.RewardTier[] memory out) {
        out = new Types.RewardTier[](4);
        out[0] = Types.RewardTier({threshold: 25, reward: 5_000 ether});
        out[1] = Types.RewardTier({threshold: 50, reward: 10_000 ether});
        out[2] = Types.RewardTier({threshold: 75, reward: 15_000 ether});
        out[3] = Types.RewardTier({threshold: 100, reward: 20_000 ether});
    }

    function _requireOwned(address verifier, address owner) internal view {
        if (owner != project) revert VerifierNotOwned(verifier, owner, project);
    }
}
