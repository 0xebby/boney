// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Campaign} from "../src/campaign/Campaign.sol";
import {CampaignRegistry} from "../src/campaign/CampaignRegistry.sol";
import {EscrowVault} from "../src/escrow/EscrowVault.sol";
import {AttributionRegistry} from "../src/attribution/AttributionRegistry.sol";
import {IAttributionRegistry} from "../src/interfaces/IAttributionRegistry.sol";
import {EventMetricKpiVerifier} from "../src/verifiers/EventMetricKpiVerifier.sol";
import {GuardedKpiVerifier} from "../src/verifiers/GuardedKpiVerifier.sol";
import {IEventMetricKpiVerifier} from "../src/interfaces/IEventMetricKpiVerifier.sol";
import {IGuardedKpiVerifier} from "../src/interfaces/IGuardedKpiVerifier.sol";
import {Types} from "../src/libraries/Types.sol";

/// @dev Minimal WETH surface used to generate tracked activity.
interface IWeth {
    /// @notice Wrap the sent value.
    function deposit() external payable;
}

/// @title SeedCreDemo
/// @notice Seeds one campaign carrying every precondition the CRE receiver path requires.
/// @dev Creates a guarded, evidence-free, event-sourced KPI, joins a promoter, stores a user touch,
///      performs one tracked WETH deposit, then writes the observation the relayer would write.
contract SeedCreDemo is Script {
    /// @notice Canonical WETH predeploy, identical on every OP-stack chain.
    address public constant WETH = 0x4200000000000000000000000000000000000006;
    /// @notice `keccak256("Deposit(address,uint256)")`.
    bytes32 public constant DEPOSIT_TOPIC = 0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c;
    /// @notice `topics[1]` carries the depositing wallet.
    uint8 public constant ACTOR_TOPIC = 1;
    /// @notice Read the amount from the first data word.
    uint8 public constant AMOUNT_MODE_DATA_WORD0 = 1;
    /// @notice 0.001 WETH per unit of progress.
    uint256 public constant SCALE = 1e15;
    /// @notice The tracked event in the form `EventMetricKpiVerifier` stores.
    string public constant DEPOSIT_EVENT = "Deposit(address indexed dst, uint256 wad)";
    /// @notice Blocks of slack added past the campaign's projected reporting close.
    uint256 public constant BLOCK_MARGIN = 10_000;
    /// @notice Reporting duration of the seeded campaign.
    uint64 public constant DURATION = 30 days;
    /// @notice Value the seeded user wraps, worth 10 units of progress.
    uint256 public constant DEPOSIT_VALUE = 0.01 ether;

    /// @dev the seeded promoter.
    uint256 PROMOTER_PK = vm.envUint("PROMOTER_PK");
    /// @dev the seeded end user.
    uint256 USER_PK = vm.envUint("KOL1_REF2");

    /// @dev Held as state rather than locals to stay within the stack-slot limit without `via_ir`.
    address kpiVerifier;
    address guardedVerifier;
    address campaign;
    bytes32 promoterId;

    /// @notice Seed the campaign and every precondition the CRE workflow reads.
    function run() external {
        uint256 projectPk = vm.envUint("PRIVATE_KEY");
        uint256 promoterPk = vm.envOr("SEED_PROMOTER_PK", PROMOTER_PK);
        uint256 userPk = vm.envOr("SEED_USER_PK", USER_PK);
        address project = vm.addr(projectPk);
        address user = vm.addr(userPk);

        CampaignRegistry registry = CampaignRegistry(vm.envAddress("REGISTRY_ADDRESS"));
        EscrowVault vault = EscrowVault(vm.envAddress("VAULT_ADDRESS"));
        AttributionRegistry attribution = AttributionRegistry(vm.envAddress("ATTRIBUTION_ADDRESS"));
        IERC20 token = IERC20(vm.envAddress("TOKEN_ADDRESS"));
        kpiVerifier = vm.envAddress("KPI_VERIFIER_ADDRESS");
        guardedVerifier = vm.envAddress("GUARDED_VERIFIER_ADDRESS");

        uint256 pool = vm.envOr("SEED_POOL", uint256(1_000 ether));
        _createCampaign(registry, vault, token, project, pool);
        _configureVerification(projectPk);

        vm.broadcast(promoterPk);
        promoterId = Campaign(campaign).join();

        _storeTouch(attribution, user, userPk, project);

        vm.broadcast(userPk);
        IWeth(WETH).deposit{value: DEPOSIT_VALUE}();

        _reportObservation(projectPk, user);

        console.log("CRE demo campaign seeded");
        console.log("  campaign:          ", campaign);
        console.log("  kpiIndex:          ", uint256(0));
        console.log("  promoter:          ", vm.addr(promoterPk));
        console.log("  user:              ", user);
        console.log(
            "  observed progress: ", EventMetricKpiVerifier(kpiVerifier).observedProgressOf(campaign, 0, user)
        );
        console.log("  credited progress: ", Campaign(campaign).userCreditedOf(user, 0));
        console.log("  eventVerifier:     ", kpiVerifier);
    }

    /// @dev Creates, funds and activates the campaign holding one guarded event-sourced KPI.
    /// @param registry Registry deploying the campaign.
    /// @param vault Vault receiving the escrowed pool.
    /// @param token ERC20 used for escrow and payouts.
    /// @param project Campaign owner and escrow funder.
    /// @param pool Reward pool escrowed at creation.
    function _createCampaign(
        CampaignRegistry registry,
        EscrowVault vault,
        IERC20 token,
        address project,
        uint256 pool
    ) private {
        Types.CampaignConfig memory cfg = Types.CampaignConfig({
            project: project,
            name: string.concat("CRE Demo ", vm.toString(registry.campaignCount())),
            token: address(token),
            rewardPool: pool,
            startTime: uint64(block.timestamp),
            endTime: uint64(block.timestamp + DURATION),
            attributionWindow: DURATION,
            minReputation: 0
        });

        Types.KpiSpec[] memory kpis = new Types.KpiSpec[](1);
        kpis[0] = Types.KpiSpec({
            kind: Types.KpiKind.Deposit,
            verifier: guardedVerifier,
            target: 100,
            aggregate: false,
            params: abi.encode(WETH, DEPOSIT_TOPIC, ACTOR_TOPIC, AMOUNT_MODE_DATA_WORD0, SCALE)
        });

        Types.RewardTier[][] memory tiers = new Types.RewardTier[][](1);
        tiers[0] = new Types.RewardTier[](3);
        tiers[0][0] = Types.RewardTier({threshold: 1, reward: pool / 20});
        tiers[0][1] = Types.RewardTier({threshold: 5, reward: pool / 10});
        tiers[0][2] = Types.RewardTier({threshold: 20, reward: pool / 5});

        vm.startBroadcast(vm.envUint("PRIVATE_KEY"));
        (, campaign) = registry.createCampaign(cfg, kpis, tiers);
        token.approve(address(vault), pool);
        vault.deposit(campaign, pool);
        Campaign(campaign).activate();
        vm.stopBroadcast();
    }

    /// @dev Points the KPI at WETH's `Deposit` and routes the guard through Boney alone.
    /// @param projectPk Key owning both verifiers.
    function _configureVerification(uint256 projectPk) private {
        uint256 windowEndBlock =
            block.number + (DURATION + Campaign(campaign).CLAIM_GRACE()) / 2 + BLOCK_MARGIN;

        vm.startBroadcast(projectPk);
        EventMetricKpiVerifier(kpiVerifier).setKpiConfig(
            campaign,
            0,
            WETH,
            DEPOSIT_EVENT,
            0,
            IEventMetricKpiVerifier.Aggregation.SUM,
            1,
            SCALE,
            block.number,
            windowEndBlock
        );
        GuardedKpiVerifier(guardedVerifier).setGuardConfig(
            campaign, 0, address(0), 0, IGuardedKpiVerifier.Mode.AGREE
        );
        vm.stopBroadcast();
    }

    /// @dev Signs and stores the user touch binding the user to the seeded promoter.
    /// @param attribution Registry storing the touch.
    /// @param user End user signing the touch.
    /// @param userPk Key signing the touch.
    /// @param relayer Account submitting the touch.
    function _storeTouch(AttributionRegistry attribution, address user, uint256 userPk, address relayer)
        private
    {
        IAttributionRegistry.Touch memory touch = IAttributionRegistry.Touch({
            campaign: campaign,
            promoterId: promoterId,
            signedAt: uint64(block.timestamp),
            expiresAt: uint64(block.timestamp + DURATION)
        });
        bytes32 structHash = keccak256(
            abi.encode(
                attribution.TOUCH_TYPEHASH(),
                touch.campaign,
                touch.promoterId,
                touch.signedAt,
                touch.expiresAt
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", attribution.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userPk, digest);

        vm.broadcast(relayer);
        attribution.storeTouch(user, touch, abi.encodePacked(r, s, v), relayer);
    }

    /// @dev Writes the cumulative observation `pnpm relay` would write for the seeded deposit.
    /// @param projectPk Key holding the verifier's reporter role.
    /// @param user End user the observation describes.
    function _reportObservation(uint256 projectPk, address user) private {
        address[] memory users = new address[](1);
        users[0] = user;
        uint256[] memory totals = new uint256[](1);
        totals[0] = DEPOSIT_VALUE;

        vm.broadcast(projectPk);
        EventMetricKpiVerifier(kpiVerifier).reportBatch(campaign, 0, users, totals, block.number + 100);
    }
}
