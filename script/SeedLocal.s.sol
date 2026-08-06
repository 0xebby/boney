// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Boney} from "../src/Boney.sol";
import {Campaign} from "../src/campaign/Campaign.sol";
import {CampaignRegistry} from "../src/campaign/CampaignRegistry.sol";
import {EscrowVault} from "../src/escrow/EscrowVault.sol";
import {AttributionRegistry} from "../src/attribution/AttributionRegistry.sol";
import {ReputationRegistry} from "../src/reputation/ReputationRegistry.sol";
import {IAttributionRegistry} from "../src/interfaces/IAttributionRegistry.sol";
import {Types} from "../src/libraries/Types.sol";

contract SeedToken is ERC20 {
    constructor() ERC20("Boney Test USD", "bUSD") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @title SeedLocal
/// @notice Populates a local anvil deployment with realistic campaign data so the frontend has
///         something to render.
/// @dev Seeds four campaigns across different lifecycle states — active with progress, active and
///      empty, pending (unfunded), and ended — so the UI's status handling, empty states, and
///      utilization meters each have a real case.
///
///      Module references live in storage rather than as locals in `run()`: the seed flow touches
///      five contracts and six accounts, which overflows the EVM stack if held as locals.
contract SeedLocal is Script {
    // Anvil's deterministic accounts, used as defaults so the local fixture is unchanged.
    //
    // Every broadcasting role is overridable, because none of these keys can hold value on a
    // public chain. Deployer and project own protocol state — the deployer is the attestor and
    // owner of the verifier, reputation registry, coordinator, and vault; the project owns every
    // seeded campaign — so off anvil they point at a real wallet via env.
    uint256 constant ANVIL_DEPLOYER_PK =
        0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    uint256 constant ANVIL_PROJECT_PK =
        0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
    // The KOL and user accounts default to anvil's, and both are overridable.
    //
    // Users only ever sign — `_storeTouch` relays through the deployer — so they need no gas on
    // any chain and the deterministic keys are fine everywhere. The KOLs send their own
    // `join()`, and on a public testnet a well-known key cannot hold gas: sweeper bots drain
    // anything sent to anvil's accounts within seconds, so a top-up is gone before the seed can
    // spend it. Off anvil the runner supplies burner keys derived from the deployer instead.
    uint256 constant ANVIL_KOL_PK =
        0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a;
    uint256 constant ANVIL_KOL2_PK =
        0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6;
    uint256 constant USER_PK = 0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a;
    uint256 constant USER2_PK = 0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba;

    // Resolved in `run()`. Storage rather than locals for the same stack-depth reason as the
    // module references below.
    uint256 DEPLOYER_PK;
    uint256 PROJECT_PK;
    uint256 KOL_PK;
    uint256 KOL2_PK;

    CampaignRegistry registry;
    EscrowVault vault;
    AttributionRegistry attribution;
    ReputationRegistry reputation;
    SeedToken token;
    address project;

    function run() external {
        DEPLOYER_PK = vm.envOr("SEED_DEPLOYER_PK", ANVIL_DEPLOYER_PK);
        PROJECT_PK = vm.envOr("SEED_PROJECT_PK", ANVIL_PROJECT_PK);
        KOL_PK = vm.envOr("SEED_KOL_PK", ANVIL_KOL_PK);
        KOL2_PK = vm.envOr("SEED_KOL2_PK", ANVIL_KOL2_PK);

        registry = CampaignRegistry(vm.envAddress("REGISTRY_ADDRESS"));
        vault = EscrowVault(vm.envAddress("VAULT_ADDRESS"));
        attribution = AttributionRegistry(vm.envAddress("ATTRIBUTION_ADDRESS"));
        reputation = ReputationRegistry(vm.envAddress("REPUTATION_ADDRESS"));
        project = vm.addr(PROJECT_PK);

        _deployToken();
        _seedReputation();

        address c1 = _campaignWithProgress();
        address c2 = _activeEmptyCampaign();
        _pendingCampaign();
        address c4 = _endedCampaign();
        address c5 = _multiKpiCampaign();

        console.log("");
        console.log("Seeded. Token (import into wallet):", address(token));
        console.log("  active w/ progress:", c1);
        console.log("  active, no KOLs:  ", c2);
        console.log("  ended:            ", c4);
        console.log("  multi-KPI:        ", c5);
    }

    function _deployToken() internal {
        vm.startBroadcast(DEPLOYER_PK);
        token = new SeedToken();
        token.mint(project, 10_000_000 ether);
        vm.stopBroadcast();
    }

    /// @dev Registers a reputation schema and vouches for both KOLs, so reputation-gated
    ///      campaigns are actually joinable.
    ///
    ///      Re-runnable against an already-seeded chain, which reseeding onto a live deployment
    ///      requires. Two separate replay guards have to be respected: `registerSchema` reverts
    ///      with `SchemaAlreadyRegistered`, so it is skipped when `schemaInfo` reports the schema
    ///      exists; and `storeAttestation` burns its `attestationId` permanently, so the ids are
    ///      salted with the block number rather than being fixed strings. Attestations overwrite
    ///      the stored record, so reseeding refreshes the values instead of duplicating them.
    function _seedReputation() internal {
        bytes32 schema = reputation.schemaId("X_FOLLOWERS");
        (,, bool exists) = reputation.schemaInfo(schema);

        vm.startBroadcast(DEPLOYER_PK);
        if (!exists) reputation.registerSchema("X_FOLLOWERS", 1);
        reputation.storeAttestation(
            vm.addr(KOL_PK), schema, 24_000, keccak256(abi.encode("seed-kol-1", block.number))
        );
        reputation.storeAttestation(
            vm.addr(KOL2_PK), schema, 8_500, keccak256(abi.encode("seed-kol-2", block.number))
        );
        vm.stopBroadcast();
    }

    /// @dev Active campaign with two promoters, attributed users, and crossed tiers.
    function _campaignWithProgress() internal returns (address campaign) {
        campaign = _create(50_000 ether, 2_500);
        _fundAndActivate(campaign, 50_000 ether);

        vm.broadcast(KOL_PK);
        bytes32 promoter1 = Campaign(campaign).join();
        vm.broadcast(KOL2_PK);
        bytes32 promoter2 = Campaign(campaign).join();

        _storeTouch(campaign, promoter1, USER_PK);
        _storeTouch(campaign, promoter2, USER2_PK);

        // Cumulative reports; crossing a tier pays out automatically.
        vm.startBroadcast(PROJECT_PK);
        Campaign(campaign).reportUserAction(0, vm.addr(USER_PK), 62, "");
        Campaign(campaign).reportUserAction(0, vm.addr(USER2_PK), 14, "");
        vm.stopBroadcast();
    }

    function _activeEmptyCampaign() internal returns (address campaign) {
        campaign = _create(12_000 ether, 0);
        _fundAndActivate(campaign, 12_000 ether);
    }

    function _pendingCampaign() internal returns (address campaign) {
        // Created but never funded — stays Pending, which is the state the UI must not confuse
        // with Active.
        campaign = _create(8_000 ether, 5_000);
    }

    function _endedCampaign() internal returns (address campaign) {
        campaign = _create(5_000 ether, 0);
        _fundAndActivate(campaign, 5_000 ether);
        vm.broadcast(PROJECT_PK);
        Campaign(campaign).end();
    }

    /**
     * @dev Three KPIs with *different* ladder lengths and one aggregate flag set.
     *
     * The frontend reads KPI specs and tier ladders index by index. A campaign where every KPI
     * looks alike cannot catch an off-by-one that returns KPI 0's ladder for every index — the
     * ladders here have 1, 2, and 3 rungs precisely so that bug fails loudly.
     */
    function _multiKpiCampaign() internal returns (address campaign) {
        uint256 pool = 30_000 ether;

        Types.CampaignConfig memory cfg = Types.CampaignConfig({
            project: project,
            token: address(token),
            rewardPool: pool,
            startTime: uint64(block.timestamp),
            endTime: uint64(block.timestamp + 60 days),
            attributionWindow: 14 days,
            minReputation: 0
        });

        Types.KpiSpec[] memory kpis = new Types.KpiSpec[](3);
        kpis[0] = Types.KpiSpec({
            kind: Types.KpiKind.Swap,
            verifier: address(0),
            target: 250,
            aggregate: false,
            params: ""
        });
        kpis[1] = Types.KpiSpec({
            kind: Types.KpiKind.Tvl,
            verifier: address(0),
            target: 1_000_000,
            aggregate: true,
            params: ""
        });
        kpis[2] = Types.KpiSpec({
            kind: Types.KpiKind.ActiveUser,
            verifier: address(0),
            target: 500,
            aggregate: false,
            params: ""
        });

        Types.RewardTier[][] memory tiers = new Types.RewardTier[][](3);

        tiers[0] = new Types.RewardTier[](1);
        tiers[0][0] = Types.RewardTier({threshold: 250, reward: pool / 10});

        tiers[1] = new Types.RewardTier[](2);
        tiers[1][0] = Types.RewardTier({threshold: 500_000, reward: pool / 20});
        tiers[1][1] = Types.RewardTier({threshold: 1_000_000, reward: pool / 10});

        tiers[2] = new Types.RewardTier[](3);
        tiers[2][0] = Types.RewardTier({threshold: 100, reward: pool / 50});
        tiers[2][1] = Types.RewardTier({threshold: 250, reward: pool / 25});
        tiers[2][2] = Types.RewardTier({threshold: 500, reward: pool / 10});

        vm.broadcast(PROJECT_PK);
        (, campaign) = registry.createCampaign(cfg, kpis, tiers);

        _fundAndActivate(campaign, pool);
    }

    /// @dev One mint KPI with a three-rung ladder scaled to the pool.
    function _create(uint256 pool, uint256 minReputation) internal returns (address campaign) {
        Types.CampaignConfig memory cfg = Types.CampaignConfig({
            project: project,
            token: address(token),
            rewardPool: pool,
            startTime: uint64(block.timestamp),
            endTime: uint64(block.timestamp + 30 days),
            attributionWindow: 7 days,
            minReputation: minReputation
        });

        Types.KpiSpec[] memory kpis = new Types.KpiSpec[](1);
        kpis[0] = Types.KpiSpec({
            kind: Types.KpiKind.Mint,
            verifier: address(0),
            target: 100,
            aggregate: false,
            params: ""
        });

        Types.RewardTier[][] memory tiers = new Types.RewardTier[][](1);
        tiers[0] = new Types.RewardTier[](3);
        tiers[0][0] = Types.RewardTier({threshold: 10, reward: pool / 20});
        tiers[0][1] = Types.RewardTier({threshold: 50, reward: pool / 10});
        tiers[0][2] = Types.RewardTier({threshold: 100, reward: pool / 5});

        vm.broadcast(PROJECT_PK);
        (, campaign) = registry.createCampaign(cfg, kpis, tiers);
    }

    function _fundAndActivate(address campaign, uint256 amount) internal {
        vm.startBroadcast(PROJECT_PK);
        token.approve(address(vault), amount);
        vault.deposit(campaign, amount);
        Campaign(campaign).activate();
        vm.stopBroadcast();
    }

    /// @dev Signs an attribution touch as the end user, then relays it — mirroring exactly what
    ///      the frontend must do in Phase 8. If the frontend's EIP-712 encoding disagrees with
    ///      this, the mismatch is a bug in the frontend.
    function _storeTouch(address campaign, bytes32 promoterId, uint256 userPk) internal {
        IAttributionRegistry.Touch memory t = IAttributionRegistry.Touch({
            campaign: campaign,
            promoterId: promoterId,
            signedAt: uint64(block.timestamp),
            expiresAt: uint64(block.timestamp + 7 days)
        });

        bytes32 structHash = keccak256(
            abi.encode(attribution.TOUCH_TYPEHASH(), t.campaign, t.promoterId, t.signedAt, t.expiresAt)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", attribution.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userPk, digest);

        vm.broadcast(DEPLOYER_PK);
        attribution.storeTouch(vm.addr(userPk), t, abi.encodePacked(r, s, v), vm.addr(userPk));
    }
}
