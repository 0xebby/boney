// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {Boney} from "../src/Boney.sol";
import {CampaignRegistry} from "../src/campaign/CampaignRegistry.sol";
import {EscrowVault} from "../src/escrow/EscrowVault.sol";
import {AttributionRegistry} from "../src/attribution/AttributionRegistry.sol";
import {AttestationVerifier} from "../src/reputation/AttestationVerifier.sol";
import {ReputationRegistry} from "../src/reputation/ReputationRegistry.sol";
import {OracleCoordinator} from "../src/oracle/OracleCoordinator.sol";

/// @title DeployBoney
/// @notice Full-stack Boney deployment script.
/// @dev Deploy order:
///      1. Modules with no cross-dependencies (attribution, attestations, reputation).
///      2. The coordinator, deployed *before* the registry, because the registry needs the
///         coordinator's address at construction (coordinator → registry is wired afterward).
///      3. The escrow vault and registry; the registry becomes the vault's registrar.
///      4. Wire the coordinator to the registry, then deploy the facade.
///
///      `MAX_TOUCH_DURATION` and `MIN_STAKE` are env-configurable for testing; the rest are
///      protocol constants.
contract DeployBoney is Script {
    uint64 public constant MAX_TOUCH_DURATION = 30 days;
    uint256 public constant DISPUTE_WINDOW = 1 days;
    uint256 public constant UNSTAKE_DELAY = 2 days;

    function run() external returns (Boney boney, CampaignRegistry registry) {
        uint256 minStake = vm.envOr("BONEY_MIN_STAKE", uint256(100 ether));
        uint64 maxTouch = uint64(vm.envOr("BONEY_MAX_TOUCH", uint256(MAX_TOUCH_DURATION)));

        address deployer = vm.addr(vm.envUint("PRIVATE_KEY"));

        vm.startBroadcast(vm.envUint("PRIVATE_KEY"));

        // 1. Standalone modules.
        AttributionRegistry attribution = new AttributionRegistry(maxTouch);
        AttestationVerifier attestations =
            new AttestationVerifier(deployer, vm.envAddress("BONEY_INITIAL_ATTESTOR"));
        ReputationRegistry reputation = new ReputationRegistry(deployer, address(attestations));

        // 2. Oracle coordinator (needs no registry yet).
        OracleCoordinator coordinator =
            new OracleCoordinator(deployer, minStake, DISPUTE_WINDOW, UNSTAKE_DELAY);

        // 3. Vault, then registry. The vault's registrar is wired afterwards rather than
        //    predicted, so a nonce mismatch between simulation and broadcast cannot produce a
        //    vault that the registry is unable to register campaigns with.
        EscrowVault vault = new EscrowVault(deployer);
        registry = new CampaignRegistry(
            address(vault), address(reputation), address(attribution), address(coordinator)
        );
        vault.setRegistrar(address(registry));

        // 4. Wire the coordinator to the registry, then the facade.
        coordinator.setCampaignRegistry(address(registry));
        boney = new Boney(address(registry));

        vm.stopBroadcast();

        console.log("Boney deployed");
        console.log("  Boney (facade):         ", address(boney));
        console.log("  CampaignRegistry:       ", address(registry));
        console.log("  EscrowVault:            ", address(vault));
        console.log("  AttributionRegistry:    ", address(attribution));
        console.log("  AttestationVerifier:    ", address(attestations));
        console.log("  ReputationRegistry:     ", address(reputation));
        console.log("  OracleCoordinator:      ", address(coordinator));
    }
}
