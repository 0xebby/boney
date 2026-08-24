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

/// @title SeedRealKpi
/// @notice Campaigns whose KPIs track *real third-party protocols* on Base Sepolia, rather than a
///         mock token this repo deployed itself.
/// @dev The point of the fixture: nothing here depends on Boney controlling the watched contract.
///      Aave and Sygma have no idea these campaigns exist, which is exactly the situation a real
///      project hosting a campaign is in.
///
///      **Every signature below was confirmed against the chain, not assumed.** Aave's `Supply`
///      topic0 was matched against live logs on Base Sepolia; Sygma's `Deposit` topic0 was matched
///      against a PUSH32 constant in the deployed bytecode (the bridge is idle on testnet, so there
///      were no logs to sample). This matters more than it sounds: a wrong signature produces a
///      campaign that deploys cleanly, configures cleanly, and then credits nothing forever.
///
///      **Why both KPIs are COUNT and not SUM.** The off-chain halves read the same activity through
///      different lenses, and they have to agree on denomination or the cap is meaningless. The
///      indexer takes its amount from `KpiSpec.params.amountMode`, which can only be "count each log"
///      or "read the first 32-byte word of `data`". Aave's `Supply` puts `user` in that first word and
///      `amount` in the second, so the indexer *cannot* read the amount — pointing it at `dataWord0`
///      would credit progress equal to a wallet address. Sygma's amount is not a top-level param at
///      all; it is inside the `data` bytes. So `COUNT` is the only reading both sides can compute
///      identically, and "number of supplies" / "number of bridge transfers" are honest KPIs anyway.
///
///      **Flaunch is deliberately absent.** Its `PositionManager` at
///      `0x4e7cb1e6800a7b297b38bddcecaf9ca5b6616fdc` does emit `PoolSwap`, `PoolFeesReceived`,
///      `PoolFeesDistributed`, `PoolFeesSwapped` and `PoolStateUpdated` (all confirmed in its
///      bytecode), but every one of them is keyed by `bytes32 poolId` and none carries an `address`.
///      There is no user to attribute, so `EventMetricKpiVerifier` cannot gate it —
///      `validateParamIndexes` rejects a `userParamIndex` that does not point at an address, which is
///      the correct outcome rather than a workaround.
///
///      Rewards are still escrowed in the mock bUSD (`TOKEN_ADDRESS`). What a campaign *pays* and
///      what it *measures* are independent, and that separation is the whole reason `KpiSpec` carries
///      its own source config.
///
///      Usage (against an anvil fork of Base Sepolia, so the real contracts exist locally):
///        PRIVATE_KEY=… REGISTRY_ADDRESS=… VAULT_ADDRESS=… TOKEN_ADDRESS=… \
///        KPI_VERIFIER_ADDRESS=… GUARDED_VERIFIER_ADDRESS=… \
///        forge script script/SeedRealKpi.s.sol:SeedRealKpi --rpc-url http://127.0.0.1:8545 --broadcast
contract SeedRealKpi is Script {
    /// @dev Raised when the seeding key does not own the verifiers, whose setters are `onlyOwner`.
    error VerifierNotOwned(address verifier, address owner, address seeder);

    /// @notice Aave V3 Pool on Base Sepolia. Events come from the proxy, which is this address.
    address public constant AAVE_POOL = 0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27;

    /// @notice Sygma Bridge on Base Sepolia.
    address public constant SYGMA_BRIDGE = 0x9D5C332Ebe0DaE36e07a4eD552Ad4d8c5067A61F;

    /// @notice `keccak256("Supply(address,address,address,uint256,uint16)")`.
    /// @dev Verified against live Base Sepolia logs from `AAVE_POOL`, not derived on faith.
    bytes32 public constant AAVE_SUPPLY_TOPIC =
        0x2b627736bca15cd5381dcf80b0bf11fd197d01a037c52b927a881a10fb73ba61;

    /// @notice `keccak256("Deposit(uint8,bytes32,uint64,address,bytes,bytes)")`.
    /// @dev Verified as a constant inside `SYGMA_BRIDGE`'s deployed bytecode.
    bytes32 public constant SYGMA_DEPOSIT_TOPIC =
        0x17bc3181e17a9620a479c24e6c606e474ba84fc036877b768926872e8cd0e11f;

    /// @notice Aave's supply event, full declaration order `(reserve, user, onBehalfOf, amount, referralCode)`.
    /// @dev The attributed wallet is `onBehalfOf` (param 2), not `user` (param 1): `user` is whoever
    ///      sent the transaction, while `onBehalfOf` is the account actually credited with the
    ///      aTokens. They differ whenever a router or account abstraction supplies for someone.
    ///      `onBehalfOf` is also indexed, so it lands in `topics[2]` for the indexer.
    string public constant AAVE_SUPPLY_EVENT =
        "Supply(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint16 indexed referralCode)";

    /// @notice Sygma's deposit event. `user` is param 3 and the only indexed param, so `topics[1]`.
    string public constant SYGMA_DEPOSIT_EVENT =
        "Deposit(uint8 destinationDomainID, bytes32 resourceID, uint64 depositNonce, address indexed user, bytes data, bytes handlerResponse)";

    /// @dev Both campaigns run 30 days, long enough that nothing lapses mid-session.
    uint64 public constant DURATION = 30 days;

    /// @dev Seconds per block on Base Sepolia, for projecting the reporting close onto a block.
    uint256 public constant BLOCK_TIME = 2;

    /// @dev Slack past that projection, biased high — `windowEndBlock` only bounds the relayer, while
    ///      `Campaign` enforces its own window regardless, so over-estimating merely wastes scanning
    ///      while under-estimating under-credits promoters.
    uint256 public constant BLOCK_MARGIN = 10_000;

    /// @dev Held as state rather than locals: `run()` is at the stack-slot limit without `via_ir`.
    uint256 pk;
    address project;
    CampaignRegistry registry;
    EscrowVault vault;
    IERC20 token;
    EventMetricKpiVerifier kpiVerifier;
    GuardedKpiVerifier guardedVerifier;

    function run() external {
        pk = vm.envUint("PRIVATE_KEY");
        project = vm.addr(pk);
        registry = CampaignRegistry(vm.envAddress("REGISTRY_ADDRESS"));
        vault = EscrowVault(vm.envAddress("VAULT_ADDRESS"));
        token = IERC20(vm.envAddress("TOKEN_ADDRESS"));
        kpiVerifier = EventMetricKpiVerifier(vm.envAddress("KPI_VERIFIER_ADDRESS"));
        guardedVerifier = GuardedKpiVerifier(vm.envAddress("GUARDED_VERIFIER_ADDRESS"));

        if (kpiVerifier.owner() != project) {
            revert VerifierNotOwned(address(kpiVerifier), kpiVerifier.owner(), project);
        }
        if (guardedVerifier.owner() != project) {
            revert VerifierNotOwned(address(guardedVerifier), guardedVerifier.owner(), project);
        }

        uint256 pool = vm.envOr("SEED_POOL", uint256(20_000 ether));

        address aave = _create("Aave Supplies", pool, AAVE_POOL, AAVE_SUPPLY_TOPIC, 2, Types.KpiKind.Deposit);
        _configure(aave, AAVE_POOL, AAVE_SUPPLY_EVENT, 2);

        address sygma =
            _create("Sygma Bridge", pool, SYGMA_BRIDGE, SYGMA_DEPOSIT_TOPIC, 1, Types.KpiKind.Bridge);
        _configure(sygma, SYGMA_BRIDGE, SYGMA_DEPOSIT_EVENT, 3);

        console.log("");
        console.log("Real-protocol campaigns seeded (rewards in bUSD, activity tracked on chain)");
        console.log("  Aave Supplies :", aave);
        console.log("    watching Supply on", AAVE_POOL);
        console.log("  Sygma Bridge  :", sygma);
        console.log("    watching Deposit on", SYGMA_BRIDGE);
        console.log("");
        console.log("  Both COUNT one event per action. Tiers at 1 / 3 / 5.");
    }

    /// @dev One campaign, funded and activated, carrying the event-source blob the indexer reads.
    /// @param name Campaign name; must be unique per registry.
    /// @param pool Reward escrow, in `token`.
    /// @param source Contract whose logs are watched.
    /// @param topic0 Signature hash of the watched event.
    /// @param actorTopic Which indexed topic carries the attributed wallet, 1-based over `topics`.
    /// @param kind Category hint. Must describe the event actually being watched — the UI renders it
    ///        next to the decoded event source, so a `kind` that contradicts the source reads as an
    ///        app bug rather than a fixture choice.
    /// @return campaign The activated campaign.
    function _create(
        string memory name,
        uint256 pool,
        address source,
        bytes32 topic0,
        uint8 actorTopic,
        Types.KpiKind kind
    ) internal returns (address campaign) {
        Types.CampaignConfig memory cfg = Types.CampaignConfig({
            project: project,
            name: name,
            token: address(token),
            rewardPool: pool,
            startTime: uint64(block.timestamp),
            endTime: uint64(block.timestamp) + DURATION,
            // Equal to the campaign's length, so a touch never lapses out from under a promoter.
            attributionWindow: DURATION,
            // Ungated: the point of this fixture is the verification path, and a reputation gate
            // would only add a reason for the wallet under test to be turned away.
            minReputation: 0
        });

        Types.KpiSpec[] memory kpis = new Types.KpiSpec[](1);
        kpis[0] = Types.KpiSpec({
            kind: kind,
            verifier: address(guardedVerifier),
            target: 100,
            aggregate: false,
            // amountMode 0 is COUNT and scale 1 is no scaling — matching `Aggregation.COUNT` on the
            // verifier, so the project's claim and Boney's observation are the same quantity.
            params: abi.encode(source, topic0, actorTopic, uint8(0), uint256(1))
        });

        // First rung at a single action, so one real supply proves settlement end to end.
        Types.RewardTier[][] memory tiers = new Types.RewardTier[][](1);
        tiers[0] = new Types.RewardTier[](3);
        tiers[0][0] = Types.RewardTier({threshold: 1, reward: pool / 20});
        tiers[0][1] = Types.RewardTier({threshold: 3, reward: pool / 10});
        tiers[0][2] = Types.RewardTier({threshold: 5, reward: pool / 5});

        vm.startBroadcast(pk);
        (, campaign) = registry.createCampaign(cfg, kpis, tiers);
        token.approve(address(vault), pool);
        vault.deposit(campaign, pool);
        Campaign(campaign).activate();
        vm.stopBroadcast();
    }

    /// @dev Points Boney's verifier at the same event and routes the guard through Boney alone.
    ///      Runs after creation because `kpiIndex`, `startTime` and `endTime` do not exist until the
    ///      campaign does.
    /// @param campaign The activated campaign.
    /// @param source Contract whose logs are watched.
    /// @param signature Full human-readable event ABI the relayer decodes against.
    /// @param userParamIndex Declaration-order position of the attributed wallet.
    function _configure(address campaign, address source, string memory signature, uint8 userParamIndex)
        internal
    {
        uint256 closesIn = uint256(DURATION) + Campaign(campaign).CLAIM_GRACE();
        uint256 windowEndBlock = block.number + closesIn / BLOCK_TIME + BLOCK_MARGIN;

        vm.startBroadcast(pk);
        kpiVerifier.setKpiConfig(
            campaign,
            0,
            source,
            signature,
            userParamIndex,
            IEventMetricKpiVerifier.Aggregation.COUNT,
            0, // valueParamIndex — ignored under COUNT
            1, // scale — counting events, nothing to denominate
            block.number,
            windowEndBlock
        );
        // Boney alone. `TouchWindowVerifier` under CAP would credit nothing here, because it needs
        // `evidence` and returns 0 without it.
        guardedVerifier.setGuardConfig(campaign, 0, address(0), 0, IGuardedKpiVerifier.Mode.AGREE);
        vm.stopBroadcast();
    }
}
