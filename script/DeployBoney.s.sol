// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {Boney} from "../src/Boney.sol";
import {BoneyCreRouter} from "../src/automation/BoneyCreRouter.sol";
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
/// @notice Deploys the Boney protocol with one shared CRE router.
contract DeployBoney is Script {
    /// @notice Addresses deployed by one script run.
    struct Deployment {
        Boney boney;
        BoneyCreRouter router;
        CampaignRegistry registry;
        EscrowVault vault;
        AttributionRegistry attribution;
        AttestationVerifier attestations;
        ReputationRegistry reputation;
        OracleCoordinator coordinator;
        EventMetricKpiVerifier kpiVerifier;
        GuardedKpiVerifier guardedVerifier;
        TouchWindowVerifier touchVerifier;
    }

    /// @dev [bscoretest] Protocol dispute window is 1 day.
    uint256 public constant DISPUTE_WINDOW = 4 minutes;
    /// @notice Maximum attribution touch duration.
    uint64 public constant MAX_TOUCH_DURATION = 360 days;
    /// @notice Official production Keystone forwarder.
    address public constant CRE_FORWARDER = 0xF8344CFd5c43616a4366C34E3EEE75af79a74482;
    /// @notice Default development attestor.
    address public constant DEV_ATTESTOR = 0x98405c5776a63547E7Cb16000bA04cA53D9Fb2f8;

    /// @notice Deploy the protocol and bind its shared automation topology.
    /// @return boney Protocol facade.
    /// @return registry Campaign registry.
    function run() external returns (Boney boney, CampaignRegistry registry) {
        uint64 maxTouch = uint64(vm.envOr("BONEY_MAX_TOUCH", uint256(MAX_TOUCH_DURATION)));
        // uint256 privateKey = vm.envUint("PRIVATE_KEY");
        uint256 privateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(privateKey);
        bytes32 workflowId = vm.envBytes32("CRE_WORKFLOW_ID");
        address workflowOwner = vm.envAddress("CRE_WORKFLOW_OWNER");

        vm.startBroadcast(privateKey);

        Deployment memory deployment;
        deployment.kpiVerifier =
            new EventMetricKpiVerifier(deployer, vm.envOr("BONEY_KPI_REPORTER", deployer));
        deployment.guardedVerifier = new GuardedKpiVerifier(deployer, address(deployment.kpiVerifier));
        deployment.coordinator = new OracleCoordinator(deployer, DISPUTE_WINDOW);
        deployment.router = new BoneyCreRouter(
            CRE_FORWARDER, address(deployment.kpiVerifier), deployment.coordinator, workflowId, workflowOwner
        );

        deployment.touchVerifier = new TouchWindowVerifier();
        deployment.attribution = new AttributionRegistry(maxTouch);
        deployment.attestations =
            new AttestationVerifier(deployer, vm.envOr("BONEY_INITIAL_ATTESTOR", DEV_ATTESTOR));
        deployment.reputation = new ReputationRegistry(deployer, address(deployment.attestations));
        deployment.vault = new EscrowVault(deployer);
        deployment.registry = new CampaignRegistry(
            address(deployment.vault),
            address(deployment.reputation),
            address(deployment.attribution),
            address(deployment.coordinator),
            address(deployment.router)
        );

        deployment.vault.setRegistrar(address(deployment.registry));
        deployment.coordinator.setCampaignRegistry(address(deployment.registry));
        deployment.coordinator.addReporter(address(deployment.router));
        deployment.router.setCampaignRegistry(deployment.registry);
        deployment.boney = new Boney(address(deployment.registry));

        vm.stopBroadcast();

        _printDeployment(deployment);
        return (deployment.boney, deployment.registry);
    }

    /// @dev Print deployed addresses and automation identity.
    /// @param deployment Deployed protocol contracts.
    function _printDeployment(Deployment memory deployment) private view {
        console.log("Boney deployed");
        console.log("  Boney (facade):         ", address(deployment.boney));
        console.log("  CampaignRegistry:       ", address(deployment.registry));
        console.log("  CampaignDeployer:       ", deployment.registry.campaignDeployer());
        console.log("  EscrowVault:            ", address(deployment.vault));
        console.log("  AttributionRegistry:    ", address(deployment.attribution));
        console.log("  AttestationVerifier:    ", address(deployment.attestations));
        console.log("  ReputationRegistry:     ", address(deployment.reputation));
        console.log("  OracleCoordinator:      ", address(deployment.coordinator));
        console.log("  BoneyCreRouter:         ", address(deployment.router));
        console.log("  Automated reporter:     ", deployment.registry.automatedReporter());
        console.log(
            "  Router allowlisted:     ", deployment.coordinator.isReporter(address(deployment.router))
        );
        console.log("  EventMetricKpiVerifier: ", address(deployment.kpiVerifier));
        console.log("  GuardedKpiVerifier:     ", address(deployment.guardedVerifier));
        console.log("  TouchWindowVerifier:    ", address(deployment.touchVerifier));
        console.log("  KPI reporter:           ", deployment.kpiVerifier.reporter());
        console.log("  CRE forwarder:          ", deployment.router.OFFICIAL_FORWARDER());
        console.log("  CRE workflow owner:     ", deployment.router.expectedWorkflowOwner());
        console.log("  CRE workflow ID:");
        console.logBytes32(deployment.router.expectedWorkflowId());
    }
}
