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
    /// @dev [bscoretest] Dispute and unstake delays shortened from their protocol values (1 day /
    ///      2 days) so both resolve inside a manual testing session. Restore before any
    ///      release/merge to main.
    uint256 public constant DISPUTE_WINDOW = 4 minutes;
    uint256 public constant UNSTAKE_DELAY = 10 minutes;

    /// @dev [bscoretest] Held at the protocol value of 30 days, deliberately *not* shortened.
    ///
    ///      This is a per-touch ceiling the attribution registry applies as
    ///      `min(campaign.attributionWindow, maxTouchDuration)`, and it applies **silently** — a
    ///      campaign whose window exceeds the cap still reports its own longer window from
    ///      `attributionWindow()`, which is what the UI renders. Shortening this to a testing value
    ///      therefore does not shorten what the app *says*; it only makes the app disagree with the
    ///      chain, which is a worse failure than a long window.
    ///
    ///      `script/SeedExpiry.s.sol` seeds campaigns up to 23 days that attribute for their whole
    ///      lifetime, and asserts this cap covers them before spending gas. Lowering this below
    ///      23 days will fail that seed rather than silently truncating it.
    uint64 public constant MAX_TOUCH_DURATION = 30 days;

    /// @dev [bscoretest] Default initial attestor: the dev wallet that `web/.env.local`'s
    ///      `ATTESTOR_PRIVATE_KEY` (== `ETHOS_PK`) signs with, and that `pnpm ethos:stub:dev` pins.
    ///      The deployer is a *different* wallet, so without this the redeployed verifier would not
    ///      recognise the signing key and every `submitAttestation` from the app would revert
    ///      `NotAnAttestor` — the stub-driven reputation path would be dead on arrival. Still
    ///      overridable with `BONEY_INITIAL_ATTESTOR`.
    address public constant DEV_ATTESTOR = 0x98405c5776a63547E7Cb16000bA04cA53D9Fb2f8;

    function run() external returns (Boney boney, CampaignRegistry registry) {
        uint256 minStake = vm.envOr("BONEY_MIN_STAKE", uint256(100 ether));
        uint64 maxTouch = uint64(vm.envOr("BONEY_MAX_TOUCH", uint256(MAX_TOUCH_DURATION)));

        address deployer = vm.addr(vm.envUint("PRIVATE_KEY"));

        vm.startBroadcast(vm.envUint("PRIVATE_KEY"));

        // 1. Standalone modules.
        AttributionRegistry attribution = new AttributionRegistry(maxTouch);
        AttestationVerifier attestations =
            new AttestationVerifier(deployer, vm.envOr("BONEY_INITIAL_ATTESTOR", DEV_ATTESTOR));
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
