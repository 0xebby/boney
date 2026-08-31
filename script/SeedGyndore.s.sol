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

/// @title SeedGyndore
/// @notice One campaign promoting Gyndore's Base Sepolia testnet, paying in GYND for swaps, stakes
///         and liquidity positions on Gyndore's own contracts.
/// @dev Appends to a registry that already holds campaigns, so it asserts nothing about
///      `campaignCount()`. It checks `isNameAvailable` first, because `createCampaign` reverts
///      `NameTaken` only after the name key is computed.
///
///      **The reward token is GYND, which is also what two of the three KPIs are denominated
///      against.** No KPI watches GYND's own `Transfer`, so tier payouts leaving the `EscrowVault`
///      emit nothing any KPI counts. That is what keeps the payout out of the metric it funds.
///
///      All three KPIs are `aggregate: false` and carry reward tiers. An aggregate KPI never moves
///      `_progress[promoter]`, so a ladder on one can never pay — the state a previous Gyndore
///      campaign shipped in.
///
///      Every KPI is gated through `GuardedKpiVerifier`, so `pnpm relay` must run before `pnpm index`
///      credits anything. `GYNDORE_TESTNET_DEPLOYER` becomes the campaign's project, so it must equal
///      `PRIVATE_KEY`, own both verifiers, and match `EventMetricKpiVerifier.reporter()`.
///
///      `EventMetricKpiVerifier.KpiConfig` carries no topic filter, so the relayer's ceiling is
///      observed unfiltered while `KpiSpec.params` reads filtered. The ceiling is therefore at or
///      above the claim, which is the direction the guard tolerates.
///
///      Usage (Base Sepolia):
///        GYNDORE_TESTNET_DEPLOYER=… REGISTRY_ADDRESS=… VAULT_ADDRESS=… TOKEN_ADDRESS=<GYND> \
///        KPI_VERIFIER_ADDRESS=… GUARDED_VERIFIER_ADDRESS=… \
///        forge script script/SeedGyndore.s.sol:SeedGyndore --rpc-url "$RPC_URL" --broadcast --slow
contract SeedGyndore is Script {
    /// @dev Raised when the seeding key does not own the verifiers, whose setters are `onlyOwner`.
    error VerifierNotOwned(address verifier, address owner, address seeder);
    /// @dev Raised when the project wallet holds less of the escrow token than the pool needs.
    error PoolUnfunded(address token, uint256 has, uint256 needs);
    /// @dev Raised when another campaign on this registry already holds the name.
    error NameUnavailable(string name);

    /// @notice Gyndore's GYND/cbBTC pool, fee tier 10000. Carries the `Swap` logs a swap surfaces on.
    address public constant POOL_GYND_CBBTC = 0x7B47daC59075aF44046795BA347EC872D5409263;

    /// @notice Gyndore's SwapRouter. Appears as `sender` on every routed swap and emits nothing itself.
    address public constant SWAP_ROUTER = 0xC7dbf300B6aEA3CFE1730f1C692C606b17B514a6;

    /// @notice Gyndore's `GyndStaking`.
    address public constant STAKING = 0x5c0E023Ce4A353e5Cd9a43E28D2879Cb9e876865;

    /// @notice Gyndore's `NonfungiblePositionManager`, `UNI-V3-POS`. Mints an ERC-721 per position.
    address public constant POSITION_MANAGER = 0x76998e42B789d81004f006402b6c62a8BDCAfD5b;

    /// @notice GYND, 18 decimals. The escrow token, and the staked token KPI 1 pins.
    address public constant GYND = 0x0d442EC7BdDB06b531DCA3Dd39ABaFf554170776;

    /// @notice `keccak256("Swap(address,address,int256,int256,uint160,uint128,int24)")`.
    /// @dev Matched against live logs from `POOL_GYND_CBBTC`, where `topics[1]` is `SWAP_ROUTER`.
    bytes32 public constant SWAP_TOPIC = 0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67;

    /// @notice `keccak256("Staked(address,address,uint256)")`.
    /// @dev Matched against live logs from `STAKING`: `topics[1]` is the staker, `topics[2]` the
    ///      staked token, and `data` is the single `uint256` amount.
    bytes32 public constant STAKED_TOPIC = 0x5dac0c1b1112564a045ba943c9d50270893e8e826c49be8e7073adc713ab7bd7;

    /// @notice `keccak256("Transfer(address,address,uint256)")` — ERC-721, so fixed by the standard.
    bytes32 public constant TRANSFER_TOPIC =
        0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef;

    /// @dev Amount modes, mirroring `web/src/lib/kpiSource.ts`.
    uint8 internal constant COUNT = 0;

    /// @dev Topic index carrying the credited wallet, per KPI.
    uint8 internal constant SWAP_ACTOR_TOPIC = 2;
    uint8 internal constant STAKE_ACTOR_TOPIC = 1;
    uint8 internal constant LP_ACTOR_TOPIC = 2;

    /// @dev Topic index pinned to a fixed value, per KPI.
    uint8 internal constant SWAP_FILTER_TOPIC = 1;
    uint8 internal constant STAKE_FILTER_TOPIC = 2;
    uint8 internal constant LP_FILTER_TOPIC = 1;

    /// @dev A mint's `from`, which is what `LP_FILTER_TOPIC` matches.
    bytes32 internal constant ZERO_TOPIC = bytes32(0);

    /// @notice Human-readable event ABIs, as `EventMetricKpiVerifier` stores them.
    /// @dev `userParamIndex` addresses these by 0-based declaration order, not by topic index.
    string public constant SWAP_EVENT =
        "Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)";
    string public constant STAKED_EVENT =
        "Staked(address indexed user, address indexed token, uint256 amount)";
    string public constant TRANSFER_EVENT =
        "Transfer(address indexed from, address indexed to, uint256 tokenId)";

    /// @dev Declaration-order position of the credited address in each event above.
    uint8 internal constant SWAP_USER_PARAM = 1;
    uint8 internal constant STAKE_USER_PARAM = 0;
    uint8 internal constant LP_USER_PARAM = 1;

    uint64 public constant DURATION = 30 days;

    /// @notice Blocks of slack added past the campaign's projected reporting close.
    /// @dev `pnpm report-window` derives the exact value once the campaign exists.
    uint256 public constant BLOCK_MARGIN = 10_000;

    /// @dev Held as state rather than locals: `run()` is at the stack-slot limit without `via_ir`.
    uint256 internal pk;
    address internal project;
    CampaignRegistry internal registry;
    EscrowVault internal vault;
    IERC20 internal token;
    address internal kpiVerifier;
    address internal guardedVerifier;

    /// @notice Creates, funds and activates the campaign, then points the verifiers at its KPIs.
    function run() external {
        pk = vm.envUint("GYNDORE_TESTNET_DEPLOYER");
        project = vm.addr(pk);
        registry = CampaignRegistry(vm.envAddress("REGISTRY_ADDRESS"));
        vault = EscrowVault(vm.envAddress("VAULT_ADDRESS"));
        token = IERC20(vm.envAddress("TOKEN_ADDRESS"));
        kpiVerifier = vm.envAddress("KPI_VERIFIER_ADDRESS");
        guardedVerifier = vm.envAddress("GUARDED_VERIFIER_ADDRESS");

        _requireOwned(kpiVerifier, EventMetricKpiVerifier(kpiVerifier).owner());
        _requireOwned(guardedVerifier, GuardedKpiVerifier(guardedVerifier).owner());

        if (!registry.isNameAvailable("Gyndore Testnet")) revert NameUnavailable("Gyndore Testnet");

        uint256 pool = vm.envOr("SEED_POOL", uint256(10000 ether));
        uint256 balance = token.balanceOf(project);
        if (balance < pool) revert PoolUnfunded(address(token), balance, pool);

        address campaign = _create(pool);
        _configureVerification(campaign);

        console.log("");
        console.log("Gyndore campaign seeded. Rewards in GYND.");
        console.log("  campaign:  ", campaign);
        console.log("  pool:      ", pool);
        console.log("  kpi0 swaps ", POOL_GYND_CBBTC);
        console.log("  kpi1 stakes", STAKING);
        console.log("  kpi2 LP    ", POSITION_MANAGER);
        console.log("  joining open to anyone, every KPI gated");
        console.log("");
        console.log("  Next: pnpm report-window --campaign <above>, then relay-loop TARGETS");
    }

    /// @dev Builds the three KPIs, creates the campaign, escrows the pool and activates.
    /// @param pool Reward pool, in GYND's smallest unit.
    /// @return campaign The created campaign's address.
    function _create(uint256 pool) internal returns (address campaign) {
        Types.KpiSpec[] memory kpis = new Types.KpiSpec[](3);
        // Count mode on the swap: `amount0` is a signed `int256`, so the first data word is not a
        // magnitude. The filter pins `sender` to Gyndore's router.
        kpis[0] = _filteredKpi(
            Types.KpiKind.Swap,
            POOL_GYND_CBBTC,
            SWAP_TOPIC,
            SWAP_ACTOR_TOPIC,
            SWAP_FILTER_TOPIC,
            bytes32(uint256(uint160(SWAP_ROUTER)))
        );
        // Count mode on the stake, not volume: GYND is the reward, and a volume reading would let a
        // payout buy the next threshold. The filter pins the staked token to GYND.
        kpis[1] = _filteredKpi(
            Types.KpiKind.Stake,
            STAKING,
            STAKED_TOPIC,
            STAKE_ACTOR_TOPIC,
            STAKE_FILTER_TOPIC,
            bytes32(uint256(uint160(GYND)))
        );
        // The position manager's ERC-721 `Transfer` with `from` pinned to zero, so only mints count.
        // The manager's own `IncreaseLiquidity` carries a `tokenId` in `topics[1]`, not an address.
        kpis[2] = _filteredKpi(
            Types.KpiKind.Mint, POSITION_MANAGER, TRANSFER_TOPIC, LP_ACTOR_TOPIC, LP_FILTER_TOPIC, ZERO_TOPIC
        );

        Types.RewardTier[][] memory tiers = new Types.RewardTier[][](3);
        tiers[0] = _tiers(pool, 5, 25, 100);
        tiers[1] = _tiers(pool, 3, 15, 50);
        tiers[2] = _tiers(pool, 1, 5, 20);

        Types.CampaignConfig memory cfg = Types.CampaignConfig({
            project: project,
            name: "Gyndore Testnet",
            token: address(token),
            rewardPool: pool,
            startTime: uint64(block.timestamp),
            endTime: uint64(block.timestamp) + DURATION,
            attributionWindow: DURATION,
            minReputation: 10000
        });

        vm.startBroadcast(pk);
        (, campaign) = registry.createCampaign(cfg, kpis, tiers);
        token.approve(address(vault), pool);
        vault.deposit(campaign, pool);
        Campaign(campaign).activate();
        vm.stopBroadcast();
    }

    /// @dev One gated KPI whose `params` carry the 224-byte filtered event-source layout.
    /// @param kind KPI kind rendered by the UI.
    /// @param source Contract whose logs are watched.
    /// @param topic0 Event signature hash to match.
    /// @param actorTopic Topic index carrying the credited wallet.
    /// @param filterTopic Topic index pinned to a fixed value; must differ from `actorTopic`.
    /// @param filterValue The 32-byte word `filterTopic` must equal.
    /// @return The KPI spec.
    function _filteredKpi(
        Types.KpiKind kind,
        address source,
        bytes32 topic0,
        uint8 actorTopic,
        uint8 filterTopic,
        bytes32 filterValue
    ) internal view returns (Types.KpiSpec memory) {
        return Types.KpiSpec({
            kind: kind,
            verifier: guardedVerifier,
            target: 100,
            aggregate: false,
            params: abi.encode(source, topic0, actorTopic, COUNT, uint256(1), filterTopic, filterValue)
        });
    }

    /// @dev Three ascending rungs at 1% / 2% / 4% of the pool, so escrow cannot be exhausted.
    /// @param pool Reward pool the rungs are a fraction of.
    /// @param t1 First threshold.
    /// @param t2 Second threshold.
    /// @param t3 Third threshold.
    /// @return out The three tiers, ascending.
    function _tiers(uint256 pool, uint256 t1, uint256 t2, uint256 t3)
        internal
        pure
        returns (Types.RewardTier[] memory out)
    {
        out = new Types.RewardTier[](3);
        out[0] = Types.RewardTier({threshold: t1, reward: pool / 100});
        out[1] = Types.RewardTier({threshold: t2, reward: pool / 50});
        out[2] = Types.RewardTier({threshold: t3, reward: pool / 25});
    }

    /// @dev Points Boney's verifier at each KPI's event and routes every guard through Boney alone.
    ///      Split out of `_create` because the campaign, and so `kpiIndex`, does not exist until it runs.
    /// @param campaign The freshly created campaign.
    function _configureVerification(address campaign) internal {
        uint256 windowEndBlock =
            block.number + (DURATION + Campaign(campaign).CLAIM_GRACE()) / 2 + BLOCK_MARGIN;

        vm.startBroadcast(pk);
        _configureKpi(campaign, 0, POOL_GYND_CBBTC, SWAP_EVENT, SWAP_USER_PARAM, windowEndBlock);
        _configureKpi(campaign, 1, STAKING, STAKED_EVENT, STAKE_USER_PARAM, windowEndBlock);
        _configureKpi(campaign, 2, POSITION_MANAGER, TRANSFER_EVENT, LP_USER_PARAM, windowEndBlock);
        vm.stopBroadcast();
    }

    /// @dev One KPI's observation config and its guard.
    /// @param campaign The campaign the KPI belongs to.
    /// @param kpiIndex Index of the KPI within that campaign.
    /// @param source Contract emitting the watched event.
    /// @param eventSignature Full human-readable event ABI, `indexed` keywords included.
    /// @param userParamIndex 0-based declaration-order position of the user-address param.
    /// @param windowEndBlock Latest block the relayer may report up to.
    function _configureKpi(
        address campaign,
        uint256 kpiIndex,
        address source,
        string memory eventSignature,
        uint8 userParamIndex,
        uint256 windowEndBlock
    ) internal {
        EventMetricKpiVerifier(kpiVerifier).setKpiConfig(
            campaign,
            kpiIndex,
            source,
            eventSignature,
            userParamIndex,
            IEventMetricKpiVerifier.Aggregation.COUNT,
            0, // valueParamIndex — ignored under COUNT
            1, // scale — the KPI counts logs, so the observed metric needs no divisor
            block.number,
            windowEndBlock
        );
        GuardedKpiVerifier(guardedVerifier).setGuardConfig(
            campaign, kpiIndex, address(0), 0, IGuardedKpiVerifier.Mode.AGREE
        );
    }

    /// @dev Reverts unless the seeding key owns a verifier whose setters are `onlyOwner`.
    /// @param verifier The verifier being configured.
    /// @param owner Its current owner.
    function _requireOwned(address verifier, address owner) internal view {
        if (owner != project) revert VerifierNotOwned(verifier, owner, project);
    }
}
