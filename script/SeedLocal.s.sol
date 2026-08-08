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
    uint256 constant ANVIL_DEPLOYER_PK = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    uint256 constant ANVIL_PROJECT_PK = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
    // The KOL and user accounts default to anvil's, and both are overridable.
    //
    // Users only ever sign — `_storeTouch` relays through the deployer — so they need no gas on
    // any chain and the deterministic keys are fine everywhere. The KOLs send their own
    // `join()`, and on a public testnet a well-known key cannot hold gas: sweeper bots drain
    // anything sent to anvil's accounts within seconds, so a top-up is gone before the seed can
    // spend it. Off anvil the runner supplies burner keys derived from the deployer instead.
    uint256 constant ANVIL_KOL_PK = 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a;
    uint256 constant ANVIL_KOL2_PK = 0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6;
    uint256 constant USER_PK = 0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a;
    uint256 constant USER2_PK = 0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba;

    // ── BoneyScore ───────────────────────────────────────────────
    // BoneyScore = 7*ETHOS_SCORE + 3*REACH, both inputs on a 0–2800 scale, so the composite
    // tops out at 28,000. Trust outweighs reach 70/30 because reach is purchasable and Ethos
    // vouches are not. Mirrored in `web/src/lib/boneyscore.ts`; the two must agree.
    uint256 constant ETHOS_WEIGHT = 7;
    uint256 constant REACH_WEIGHT = 3;

    /// @dev Join gate for the reputation-gated seed campaign. Sits between KOL 2 (14,863) and
    ///      KOL 1 (19,494) so one KOL clears it and one does not — otherwise the gate is invisible
    ///      in the local fixture and a regression in `join()` would pass unnoticed.
    uint256 constant GATED_MIN_REPUTATION = 16_000;

    /// @dev Freshness windows. Credibility is not constant: an Ethos score can crater and followers
    ///      can be lost or bought, so a stored value stops counting once it ages past its window and
    ///      the KOL has to re-attest. Ethos moves slowly and is vouch-backed, so it gets the longer
    ///      window; reach is more volatile. FOLLOWERS is left non-expiring because it scores at
    ///      weight 0 anyway — expiring it would only blank a display figure.
    uint64 constant ETHOS_MAX_AGE = 180 days;
    uint64 constant REACH_MAX_AGE = 90 days;

    /// @dev Value ceilings for the two scoring schemas. Both inputs live on Ethos's 0–2800 scale —
    ///      reach is normalised onto it by `reachFromFollowers` precisely so the 70/30 weighting
    ///      means something — which makes the composite maximum 7*2800 + 3*2800 = 28,000.
    ///
    ///      These are what make `ReputationRegistry.maxScore` answerable, and therefore what lets
    ///      `Campaign`'s constructor reject a `minReputation` above 28,000. Leave them unset and
    ///      the registry reports an unbounded ceiling and the gate check silently does nothing.
    ///
    ///      FOLLOWERS is deliberately left unbounded: it carries weight 0, so it is excluded from
    ///      `maxScore` entirely, and a raw follower count has no natural ceiling to invent.
    uint256 constant ETHOS_MAX_VALUE = 2_800;
    uint256 constant REACH_MAX_VALUE = 2_800;

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

    /// @dev Registers the BoneyScore schemas and vouches for both KOLs, so reputation-gated
    ///      campaigns are actually joinable.
    ///
    ///      BoneyScore = 7*ETHOS_SCORE + 3*REACH. Both inputs are on the same 0–2800 scale,
    ///      which is what makes the 70/30 weighting mean anything: `scoreOf` multiplies value by
    ///      weight and never divides, so a raw follower count (tens of thousands) blended against
    ///      an Ethos score (hundreds to low thousands) would be ~92% followers. The attestor
    ///      normalises followers off-chain into REACH via
    ///      `reach = min(2800, floor(400*log10(1+followers)))` — see `web/src/lib/boneyscore.ts`,
    ///      which is the single source of truth for that curve.
    ///
    ///      FOLLOWERS stays registered at weight 0: still attested and readable for display and
    ///      audit, but contributing nothing to the score. Weight 0 retires a schema's contribution
    ///      without erasing its data, so the raw counts already stored remain intact.
    ///
    ///      ETHOS_SCORE and REACH additionally carry freshness windows, so a seeded score decays
    ///      the way a real one does rather than standing forever.
    ///
    ///      Re-runnable against an already-seeded chain, which reseeding onto a live deployment
    ///      requires. Two separate replay guards have to be respected: `registerSchema` reverts
    ///      with `SchemaAlreadyRegistered`, so it is skipped when `schemaInfo` reports the schema
    ///      exists; and `storeAttestation` burns its `attestationId` permanently, so the ids are
    ///      salted with the block number rather than being fixed strings. Attestations overwrite
    ///      the stored record, so reseeding refreshes the values instead of duplicating them.
    function _seedReputation() internal {
        bytes32 followers = reputation.schemaId("FOLLOWERS");
        bytes32 ethos = reputation.schemaId("ETHOS_SCORE");
        bytes32 reach = reputation.schemaId("REACH");

        (, uint256 followersWeight, bool followersExists) = reputation.schemaInfo(followers);
        (,, bool ethosExists) = reputation.schemaInfo(ethos);
        (,, bool reachExists) = reputation.schemaInfo(reach);

        vm.startBroadcast(DEPLOYER_PK);
        if (!followersExists) reputation.registerSchema("FOLLOWERS", 0);
        if (!ethosExists) reputation.registerSchema("ETHOS_SCORE", ETHOS_WEIGHT);
        if (!reachExists) reputation.registerSchema("REACH", REACH_WEIGHT);

        // Retire the legacy follower weight on chains seeded before BoneyScore existed. Guarded so
        // a reseed of an already-migrated chain is a no-op rather than a redundant write.
        if (followersExists && followersWeight != 0) reputation.setSchemaWeight(followers, 0);

        // Freshness windows. Schemas register non-expiring, so these are set explicitly on every
        // run — that also migrates a chain seeded before the freshness gate existed. Idempotent:
        // setting the same window twice is a redundant write, not a revert.
        if (reputation.schemaMaxAge(ethos) != ETHOS_MAX_AGE) {
            reputation.setSchemaMaxAge(ethos, ETHOS_MAX_AGE);
        }
        if (reputation.schemaMaxAge(reach) != REACH_MAX_AGE) {
            reputation.setSchemaMaxAge(reach, REACH_MAX_AGE);
        }

        // Value ceilings, set on every run for the same migration reason as the windows above.
        // These must land before the attestations below, since `storeAttestation` now enforces
        // them — and before any campaign is created, since `Campaign`'s constructor reads
        // `maxScore` to reject an unreachable `minReputation`.
        if (reputation.schemaMaxValue(ethos) != ETHOS_MAX_VALUE) {
            reputation.setSchemaMaxValue(ethos, ETHOS_MAX_VALUE);
        }
        if (reputation.schemaMaxValue(reach) != REACH_MAX_VALUE) {
            reputation.setSchemaMaxValue(reach, REACH_MAX_VALUE);
        }

        // KOL 1: Ethos 2034 ("exemplary"), 24,000 followers -> reach 1752 -> BoneyScore 19,494.
        _attest(vm.addr(KOL_PK), ethos, 2_034, "seed-kol-1-ethos");
        _attest(vm.addr(KOL_PK), reach, 1_752, "seed-kol-1-reach");
        _attest(vm.addr(KOL_PK), followers, 24_000, "seed-kol-1-followers");

        // KOL 2: Ethos 1450, 8,500 followers -> reach 1571 -> BoneyScore 14,863, which sits just
        // below the 16,000 gate so the reputation check is actually exercised locally.
        _attest(vm.addr(KOL2_PK), ethos, 1_450, "seed-kol-2-ethos");
        _attest(vm.addr(KOL2_PK), reach, 1_571, "seed-kol-2-reach");
        _attest(vm.addr(KOL2_PK), followers, 8_500, "seed-kol-2-followers");
        vm.stopBroadcast();
    }

    /// @dev Stores one attested value, salting the attestation id with the block number so the
    ///      permanent replay guard does not block a reseed.
    function _attest(address subject, bytes32 schema, uint256 value, string memory tag) internal {
        reputation.storeAttestation(subject, schema, value, keccak256(abi.encode(tag, block.number)));
    }

    /// @dev Active campaign with two promoters, attributed users, and crossed tiers.
    function _campaignWithProgress() internal returns (address campaign) {
        // Gated at 12,000: both seeded KOLs clear it (14,863 and 19,494), so the gate is real
        // rather than 0 but still lets this campaign demonstrate two joined promoters. Raising it
        // above KOL 2's score here would revert their `join()` below and break the seed.
        campaign = _create(50_000 ether, 12_000);
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
        // with Active. Also carries the BoneyScore gate that actually excludes someone: at 16,000
        // KOL 1 (19,494) qualifies and KOL 2 (14,863) does not, so `InsufficientReputation` has a
        // live case in the fixture. Nobody joins this campaign, so the gate cannot break the seed.
        campaign = _create(8_000 ether, GATED_MIN_REPUTATION);
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
