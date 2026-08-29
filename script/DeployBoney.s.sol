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
/// @dev Deploy order:
///      1. Modules with no cross-dependencies (attribution, attestations, reputation).
///      2. The coordinator, deployed before the registry, because the registry needs the
///         coordinator's address at construction.
///      3. The escrow vault and registry; the registry becomes the vault's registrar.
///      4. Wire the coordinator to the registry, then deploy the facade.
///      5. The KPI verification layer, which depends on nothing above it — verifiers are
///         configured per KPI after a campaign exists, not wired at deploy time.
contract DeployBoney is Script {
    /// @dev [bscoretest] Dispute and unstake delays shortened from their protocol values (1 day /
    ///      2 days) so both resolve inside a manual testing session. Restore before any
    ///      release/merge to main.
    uint256 public constant DISPUTE_WINDOW = 4 minutes;
    uint256 public constant UNSTAKE_DELAY = 10 minutes;

    /// @dev [bscoretest] Held at the protocol value of 30 days, deliberately not shortened.
    ///
    ///      This is a per-touch ceiling the attribution registry applies as
    ///      `min(campaign.attributionWindow, maxTouchDuration)`, and it applies **silently** — a
    ///      campaign whose window exceeds the cap still reports its own longer window from
    ///      `attributionWindow()`, which is what the UI renders.
    ///
    ///      `script/SeedExpiry.s.sol` seeds campaigns up to 23 days that attribute for their whole
    ///      lifetime, and asserts this cap covers them before spending gas.
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

        // 2. Oracle coordinator.
        OracleCoordinator coordinator =
            new OracleCoordinator(deployer, minStake, DISPUTE_WINDOW, UNSTAKE_DELAY);

        // 3. Vault, then registry.
        EscrowVault vault = new EscrowVault(deployer);
        registry = new CampaignRegistry(
            address(vault), address(reputation), address(attribution), address(coordinator)
        );
        vault.setRegistrar(address(registry));

        // 4. Wire the coordinator to the registry, then the facade.
        coordinator.setCampaignRegistry(address(registry));
        boney = new Boney(address(registry));

        // 5. KPI verification layer. All three are stateless-per-campaign and configured per KPI
        //    after campaign creation, so one deployment of each serves every campaign.
        //
        //    `GuardedKpiVerifier` is what a campaign's `KpiSpec.verifier` should point at: it always
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
