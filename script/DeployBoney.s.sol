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
import {EventMetricKpiVerifier} from "../src/verifiers/EventMetricKpiVerifier.sol";
import {GuardedKpiVerifier} from "../src/verifiers/GuardedKpiVerifier.sol";
import {TouchWindowVerifier} from "../src/verifiers/TouchWindowVerifier.sol";

/// @title DeployBoney
/// @notice Boney deployment script.
contract DeployBoney is Script {
    /// @dev [bscoretest] Protocol dispute window is 1 day.
    uint256 public constant DISPUTE_WINDOW = 4 minutes;
    uint64 public constant MAX_TOUCH_DURATION = 360 days;

    address public constant DEV_ATTESTOR = 0x98405c5776a63547E7Cb16000bA04cA53D9Fb2f8;

    function run() external returns (Boney boney, CampaignRegistry registry) {
        uint64 maxTouch = uint64(vm.envOr("BONEY_MAX_TOUCH", uint256(MAX_TOUCH_DURATION)));

        address deployer = vm.addr(vm.envUint("PRIVATE_KEY"));

        vm.startBroadcast(vm.envUint("PRIVATE_KEY"));

        // @dev Standalone modules.
        AttributionRegistry attribution = new AttributionRegistry(maxTouch);
        AttestationVerifier attestations =
            new AttestationVerifier(deployer, vm.envOr("BONEY_INITIAL_ATTESTOR", DEV_ATTESTOR));
        ReputationRegistry reputation = new ReputationRegistry(deployer, address(attestations));

        // @dev Oracle coordinator.
        OracleCoordinator coordinator = new OracleCoordinator(deployer, DISPUTE_WINDOW);

        // @dev Vault, then registry.
        EscrowVault vault = new EscrowVault(deployer);
        registry = new CampaignRegistry(
            address(vault), address(reputation), address(attribution), address(coordinator)
        );
        vault.setRegistrar(address(registry));

        // @dev Wire the coordinator to the registry, then the facade.
        coordinator.setCampaignRegistry(address(registry));
        boney = new Boney(address(registry));

        // @dev KPI verification layer. one deployment of each serves every campaign.
        //
        //    @dev `GuardedKpiVerifier` is what a campaign's `KpiSpec.verifier` should point at: it always
        //    consults Boney's `EventMetricKpiVerifier`, and optionally cross-checks a second
        //    verifier per KPI.
        //    `TouchWindowVerifier` is deployed for off-chain window reads only. `Campaign` credits
        //    each evidence action to whoever held attribution at that action's block, so the adapter
        //    must not be wired as a `KpiSpec.verifier` or as a `Mode.CAP` second verifier.
        EventMetricKpiVerifier kpiVerifier =
            new EventMetricKpiVerifier(deployer, vm.envOr("BONEY_KPI_REPORTER", deployer));
        GuardedKpiVerifier guardedVerifier = new GuardedKpiVerifier(deployer, address(kpiVerifier));
        TouchWindowVerifier touchVerifier = new TouchWindowVerifier();

        vm.stopBroadcast();

        console.log("Boney deployed");
        console.log("  Boney (facade):         ", address(boney));
        console.log("  CampaignRegistry:       ", address(registry));
        console.log("  EscrowVault:            ", address(vault));
        console.log("  AttributionRegistry:    ", address(attribution));
        console.log("  AttestationVerifier:    ", address(attestations));
        console.log("  ReputationRegistry:     ", address(reputation));
        console.log("  OracleCoordinator:      ", address(coordinator));
        console.log("  EventMetricKpiVerifier: ", address(kpiVerifier));
        console.log("  GuardedKpiVerifier:     ", address(guardedVerifier));
        console.log("  TouchWindowVerifier:    ", address(touchVerifier));
        console.log("  KPI reporter:           ", kpiVerifier.reporter());
    }
}
