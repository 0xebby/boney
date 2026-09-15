// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {BoneyCreReceiver, ICreGuardedVerifier} from "../src/automation/BoneyCreReceiver.sol";
import {ICampaign} from "../src/interfaces/ICampaign.sol";
import {Types} from "../src/libraries/Types.sol";

/// @title DeployBoneyCreReceiver
/// @notice Deploys and authorizes one CRE receiver for one campaign KPI.
contract DeployBoneyCreReceiver is Script {
    uint256 public constant BASE_SEPOLIA_CHAIN_ID = 84_532;

    error WrongChain(uint256 actual, uint256 expected);
    error WrongProject(address signer, address project);
    error UnknownKpi(uint256 kpiIndex);
    error AggregateKpi(uint256 kpiIndex);
    error IncompatibleVerifier(address verifier);
    error GuardNotConfigured(address campaign, uint256 kpiIndex);
    error ProjectVerifierRequiresEvidence(address verifier);
    error EventVerifierNotConfigured(address campaign, uint256 kpiIndex);
    error InvalidProductionForwarder(address provided, address expected);
    error InvalidSimulationForwarder(address provided, address expected);

    /// @notice Deploy and authorize the configured receiver.
    /// @return receiver The deployed receiver.
    function run() external returns (BoneyCreReceiver receiver) {
        uint256 expectedChainId = vm.envOr("CRE_CHAIN_ID", BASE_SEPOLIA_CHAIN_ID);
        if (block.chainid != expectedChainId) revert WrongChain(block.chainid, expectedChainId);

        uint256 projectKey = vm.envUint("CRE_PROJECT_PRIVATE_KEY");
        address signer = vm.addr(projectKey);
        ICampaign campaign = ICampaign(vm.envAddress("CRE_CAMPAIGN_ADDRESS"));
        uint256 kpiIndex = vm.envUint("CRE_KPI_INDEX");
        address eventVerifier = vm.envAddress("CRE_EVENT_VERIFIER_ADDRESS");
        address forwarder = vm.envAddress("CRE_FORWARDER_ADDRESS");
        bool production = vm.envOr("CRE_PRODUCTION", false);
        bytes32 workflowId = vm.envOr("CRE_WORKFLOW_ID", bytes32(0));
        address workflowOwner = vm.envOr("CRE_WORKFLOW_OWNER", address(0));

        address project = campaign.getProject();
        if (signer != project) revert WrongProject(signer, project);
        _validateForwarder(forwarder, production);
        _validateTarget(campaign, kpiIndex, eventVerifier);

        vm.startBroadcast(projectKey);
        receiver = new BoneyCreReceiver(
            forwarder, campaign, kpiIndex, eventVerifier, production, workflowId, workflowOwner
        );
        campaign.setAuthorizedReporter(address(receiver), true);
        vm.stopBroadcast();

        _printManifest(receiver, campaign, kpiIndex, eventVerifier, forwarder, signer, production);
    }

    /// @dev Validate the selected KPI and verifier configuration.
    /// @param campaign Campaign receiving reports.
    /// @param kpiIndex KPI receiving reports.
    /// @param eventVerifier Canonical EventMetric verifier.
    function _validateTarget(ICampaign campaign, uint256 kpiIndex, address eventVerifier) private view {
        uint256 count = campaign.kpiCount();
        if (kpiIndex >= count) revert UnknownKpi(kpiIndex);

        Types.KpiSpec memory spec = campaign.kpi(kpiIndex);
        if (spec.aggregate) revert AggregateKpi(kpiIndex);
        if (spec.verifier == address(0)) revert IncompatibleVerifier(address(0));

        ICreGuardedVerifier guard = ICreGuardedVerifier(spec.verifier);
        try guard.boneyVerifier() returns (address configuredVerifier) {
            if (configuredVerifier != eventVerifier) revert IncompatibleVerifier(spec.verifier);
        } catch {
            revert IncompatibleVerifier(spec.verifier);
        }

        try guard.guardOf(address(campaign), kpiIndex) returns (
            address projectVerifier, uint16, uint8, bool configured
        ) {
            if (!configured) revert GuardNotConfigured(address(campaign), kpiIndex);
            if (projectVerifier != address(0)) revert ProjectVerifierRequiresEvidence(projectVerifier);
        } catch (bytes memory reason) {
            if (reason.length != 0) {
                assembly ("memory-safe") {
                    revert(add(reason, 32), mload(reason))
                }
            }
            revert IncompatibleVerifier(spec.verifier);
        }

        ICreEventVerifier.KpiConfig memory eventConfig =
            ICreEventVerifier(eventVerifier).configOf(address(campaign), kpiIndex);
        if (!eventConfig.configured) revert EventVerifierNotConfigured(address(campaign), kpiIndex);
    }

    /// @dev Require the official forwarder for the selected receiver mode.
    /// @param forwarder Configured Keystone forwarder.
    /// @param production Whether production metadata is enforced.
    function _validateForwarder(address forwarder, bool production) private pure {
        address productionForwarder = 0xF8344CFd5c43616a4366C34E3EEE75af79a74482;
        address simulationForwarder = 0x82300bd7c3958625581cc2F77bC6464dcEcDF3e5;
        if (production && forwarder != productionForwarder) {
            revert InvalidProductionForwarder(forwarder, productionForwarder);
        }
        if (!production && forwarder != simulationForwarder) {
            revert InvalidSimulationForwarder(forwarder, simulationForwarder);
        }
    }

    /// @dev Print one JSON deployment record and one JSON revocation record.
    /// @param receiver Deployed receiver.
    /// @param campaign Target campaign.
    /// @param kpiIndex Target KPI.
    /// @param eventVerifier Canonical EventMetric verifier.
    /// @param forwarder Keystone forwarder.
    /// @param project Campaign project.
    /// @param production Whether production metadata is enforced.
    function _printManifest(
        BoneyCreReceiver receiver,
        ICampaign campaign,
        uint256 kpiIndex,
        address eventVerifier,
        address forwarder,
        address project,
        bool production
    ) private {
        string memory deployment = "boney-cre-receiver-deployment";
        vm.serializeUint(deployment, "chainId", block.chainid);
        vm.serializeAddress(deployment, "project", project);
        vm.serializeAddress(deployment, "campaign", address(campaign));
        vm.serializeUint(deployment, "kpiIndex", kpiIndex);
        vm.serializeAddress(deployment, "eventMetricVerifier", eventVerifier);
        vm.serializeAddress(deployment, "forwarder", forwarder);
        vm.serializeBool(deployment, "production", production);
        vm.serializeBytes32(deployment, "workflowId", receiver.expectedWorkflowId());
        vm.serializeAddress(deployment, "workflowOwner", receiver.expectedWorkflowOwner());
        string memory deploymentJson = vm.serializeAddress(deployment, "receiver", address(receiver));

        string memory revocation = "boney-cre-receiver-revocation";
        vm.serializeUint(revocation, "chainId", block.chainid);
        vm.serializeAddress(revocation, "campaign", address(campaign));
        vm.serializeAddress(revocation, "receiver", address(receiver));
        vm.serializeString(revocation, "function", "setAuthorizedReporter(address,bool)");
        string memory revocationJson = vm.serializeBytes(
            revocation,
            "calldata",
            abi.encodeCall(ICampaign.setAuthorizedReporter, (address(receiver), false))
        );

        console.log(deploymentJson);
        console.log(revocationJson);
    }
}

/// @dev CRE deployment validation surface for EventMetricKpiVerifier.
interface ICreEventVerifier {
    /// @notice Event metric configuration returned by the verifier.
    struct KpiConfig {
        address targetContract;
        string eventSignature;
        uint8 userParamIndex;
        uint8 valueParamIndex;
        uint8 aggregation;
        uint256 scale;
        uint256 windowStartBlock;
        uint256 windowEndBlock;
        bool configured;
        uint256 epoch;
    }

    /// @notice Return one KPI's event metric configuration.
    function configOf(address campaign, uint256 kpiIndex) external view returns (KpiConfig memory);
}
