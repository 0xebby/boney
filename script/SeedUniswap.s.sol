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

/// @title SeedUniswap
/// @notice One Uniswap V3 campaign on Base Sepolia: a 700,000 bUSD pool and three KPIs, each on the
///         same four-rung ladder at 100 / 180 / 250 / 500 paying 1,000 / 2,800 / 15,000 / 25,000 bUSD.
/// @dev Each KPI's event was sampled on chain with a wallet — not a router or a token id — in the topic
///      the KPI credits: pool `Swap` at topics[2], USDC `Transfer` from the pool at topics[2], WETH
///      `Deposit` at topics[1]. All three are gated through `GuardedKpiVerifier`, so `pnpm relay` must
///      run before `pnpm index` credits anything, and the reporter key must equal the project key.
///
///      Usage (Base Sepolia):
///        PRIVATE_KEY=… REGISTRY_ADDRESS=… VAULT_ADDRESS=… TOKEN_ADDRESS=… \
///        KPI_VERIFIER_ADDRESS=… GUARDED_VERIFIER_ADDRESS=… \
///        forge script script/SeedUniswap.s.sol:SeedUniswap --rpc-url "$RPC_URL" --broadcast --slow
contract SeedUniswap is Script {
    /// @notice A verifier this script must own to configure.
    /// @param verifier The verifier read.
    /// @param owner Its current owner.
    /// @param expected The broadcasting project.
    error VerifierNotOwned(address verifier, address owner, address expected);

    /// @notice The project cannot escrow the reward pool.
    /// @param token The reward token.
    /// @param held The project's balance.
    /// @param needed The pool being escrowed.
    error PoolUnfunded(address token, uint256 held, uint256 needed);

    /// @notice The registry already holds this campaign name.
    /// @param name The name requested.
    error NameUnavailable(string name);

    /// @dev The 0.3% WETH/USDC pool, the only fee tier on this chain with swap history.
    address public constant POOL = 0x46880b404CD35c165EDdefF7421019F8dD25F4Ad;

    /// @dev Base's canonical WETH predeploy.
    address public constant WETH = 0x4200000000000000000000000000000000000006;

    /// @dev Circle's test USDC, the pool's token0 and the output leg of a WETH sale.
    address public constant USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    bytes32 public constant SWAP_TOPIC = 0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67;
    bytes32 public constant TRANSFER_TOPIC =
        0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef;
    bytes32 public constant DEPOSIT_TOPIC = 0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c;

    string public constant SWAP_EVENT =
        "Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)";
    string public constant TRANSFER_EVENT =
        "Transfer(address indexed from, address indexed to, uint256 value)";
    string public constant DEPOSIT_EVENT = "Deposit(address indexed dst, uint256 wad)";

    /// @dev `KpiSpec.params.amountMode` 0: each matching log credits 1.
    uint8 public constant COUNT = 0;

    /// @dev `KpiSpec.params.amountMode` 1: credit the first 32-byte data word.
    uint8 public constant SUM_WORD0 = 1;

    /// @dev 1e4 USDC units per unit of progress, so one unit is 0.01 USDC and the top rung is 5 USDC
    ///      out — about 0.031 WETH in at the pool's current price. USDC carries 6 decimals.
    uint256 public constant VOLUME_SCALE = 1e4;

    /// @dev Campaign length, and the attribution window, so a touch never lapses inside the campaign.
    uint64 public constant DURATION = 30 days;

    /// @dev Seconds per block on Base Sepolia, for projecting the reporting close onto a block.
    uint256 public constant BLOCK_TIME = 2;

    /// @dev Slack on that projection, so a slow chain cannot close the window before the campaign.
    uint256 public constant BLOCK_MARGIN = 10_000;

    /// @dev Promoter gate. Every promoter wallet in the Base Sepolia fixture clears it, including the
    ///      one scored by live Ethos rather than the stub.
    uint256 public constant MIN_REPUTATION = 5_000;

    /// @dev Held as state rather than locals: `run()` is at the stack-slot limit without `via_ir`.
    uint256 pk;
    address project;
    CampaignRegistry registry;
    EscrowVault vault;
    IERC20 token;
    EventMetricKpiVerifier kpiVerifier;
    GuardedKpiVerifier guardedVerifier;

    /// @notice Creates, funds, activates and configures the campaign.
    function run() external {
        pk = vm.envUint("PRIVATE_KEY");
        project = vm.addr(pk);
        registry = CampaignRegistry(vm.envAddress("REGISTRY_ADDRESS"));
        vault = EscrowVault(vm.envAddress("VAULT_ADDRESS"));
        token = IERC20(vm.envAddress("TOKEN_ADDRESS"));
        kpiVerifier = EventMetricKpiVerifier(vm.envAddress("KPI_VERIFIER_ADDRESS"));
        guardedVerifier = GuardedKpiVerifier(vm.envAddress("GUARDED_VERIFIER_ADDRESS"));

        _requireOwned(address(kpiVerifier), kpiVerifier.owner());
        _requireOwned(address(guardedVerifier), guardedVerifier.owner());

        uint256 pool = vm.envOr("SEED_POOL", uint256(700_000 ether));
        string memory name = vm.envOr("SEED_NAME", string("Uniswap"));

        uint256 held = token.balanceOf(project);
        if (held < pool) revert PoolUnfunded(address(token), held, pool);
        if (!registry.isNameAvailable(name)) revert NameUnavailable(name);

        address campaign = _create(name, pool);
        _configure(campaign);

        console.log("");
        console.log("Uniswap campaign seeded (rewards in bUSD, activity tracked on chain)");
        console.log("  campaign :", campaign);
        console.log("  project  :", project);
        console.log("  pool     :", pool / 1e18, "bUSD");
        console.log("  gate     :", MIN_REPUTATION, "BoneyScore");
        console.log("");
        console.log("  Every KPI: rungs 100 / 180 / 250 / 500 paying 1000 / 2800 / 15000 / 25000 bUSD,");
        console.log("  43800 bUSD per KPI and 131400 across the three for one promoter at the top.");
        console.log("");
        console.log("  KPI 0  Swaps   - Uniswap V3 Swap on", POOL);
        console.log("         actor topics[2] (recipient), COUNT. 500 swaps tops the ladder.");
        console.log("  KPI 1  Volume  - USDC Transfer on", USDC);
        console.log("         actor topics[2] (to), filtered to topics[1] == the pool, SUM / 1e4.");
        console.log("         Rungs are 1 / 1.80 / 2.50 / 5 USDC of swap output.");
        console.log("  KPI 2  Wraps   - WETH Deposit on", WETH);
        console.log("         actor topics[1] (dst), COUNT. 500 wraps tops the ladder.");
        console.log("");
        console.log("  To test: join as a promoter, sign a touch for a referral wallet, then have that");
        console.log("  wallet wrap ETH and swap WETH for USDC through SwapRouter02");
        console.log("  0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4 with itself as recipient.");
        console.log("  Then `pnpm relay` (observe as Boney) before `pnpm index` (claim as the project).");
    }

    /// @dev Reverts unless the broadcasting project owns a verifier this script configures.
    /// @param verifier The verifier being checked.
    /// @param owner Its current owner.
    function _requireOwned(address verifier, address owner) internal view {
        if (owner != project) revert VerifierNotOwned(verifier, owner, project);
    }

    /// @dev The campaign, funded and activated, carrying the three event-source blobs the indexer reads.
    /// @param name Campaign name; must be unique per registry.
    /// @param pool Reward escrow, in `token`.
    /// @return campaign The activated campaign.
    function _create(string memory name, uint256 pool) internal returns (address campaign) {
        Types.CampaignConfig memory cfg = Types.CampaignConfig({
            project: project,
            name: name,
            token: address(token),
            rewardPool: pool,
            startTime: uint64(block.timestamp),
            endTime: uint64(block.timestamp) + DURATION,
            attributionWindow: DURATION,
            minReputation: MIN_REPUTATION
        });

        Types.KpiSpec[] memory kpis = new Types.KpiSpec[](3);

        // Every swap the pool routes carries the end user at topics[2]; topics[1] is the router.
        kpis[0] = Types.KpiSpec({
            kind: Types.KpiKind.Swap,
            verifier: address(guardedVerifier),
            target: 500,
            aggregate: false,
            params: abi.encode(POOL, SWAP_TOPIC, uint8(2), COUNT, uint256(1))
        });

        // `value` is the first data word of `Transfer`. The filter pins topics[1] to the pool, so only
        // USDC the pool paid out counts and a faucet drip to the same wallet does not.
        kpis[1] = Types.KpiSpec({
            kind: Types.KpiKind.Volume,
            verifier: address(guardedVerifier),
            target: 500,
            aggregate: false,
            params: abi.encode(
                USDC, TRANSFER_TOPIC, uint8(2), SUM_WORD0, VOLUME_SCALE, uint8(1), bytes32(uint256(uint160(POOL)))
            )
        });

        // WETH `Deposit` names the wrapper at topics[1]. The router wraps its own ETH under the same
        // event, which credits the router rather than any referral.
        kpis[2] = Types.KpiSpec({
            kind: Types.KpiKind.Deposit,
            verifier: address(guardedVerifier),
            target: 500,
            aggregate: false,
            params: abi.encode(WETH, DEPOSIT_TOPIC, uint8(1), COUNT, uint256(1))
        });

        Types.RewardTier[][] memory tiers = new Types.RewardTier[][](3);
        tiers[0] = _tiers();
        tiers[1] = _tiers();
        tiers[2] = _tiers();

        vm.startBroadcast(pk);
        (, campaign) = registry.createCampaign(cfg, kpis, tiers);
        token.approve(address(vault), pool);
        vault.deposit(campaign, pool);
        Campaign(campaign).activate();
        vm.stopBroadcast();
    }

    /// @dev The one ladder every KPI carries. Rewards are cumulative: a promoter past 500 is paid all
    ///      four rungs, 43,800 bUSD.
    /// @return out Four ascending rungs.
    function _tiers() internal pure returns (Types.RewardTier[] memory out) {
        out = new Types.RewardTier[](4);
        out[0] = Types.RewardTier({threshold: 100, reward: 1_000 ether});
        out[1] = Types.RewardTier({threshold: 180, reward: 2_800 ether});
        out[2] = Types.RewardTier({threshold: 250, reward: 15_000 ether});
        out[3] = Types.RewardTier({threshold: 500, reward: 25_000 ether});
    }

    /// @dev Points Boney's verifier at the same three events and routes every guard through Boney
    ///      alone. Runs after creation because the campaign address does not exist until it does.
    ///      Each config must agree with its `KpiSpec.params` on source, topic0, actor, fold and scale
    ///      or the relayer refuses to run; the blob names a topic position and the verifier a
    ///      declaration position, so topics[2] is param 1 and topics[1] is param 0.
    /// @param campaign The campaign just created.
    function _configure(address campaign) internal {
        uint256 closesIn = uint256(DURATION) + Campaign(campaign).CLAIM_GRACE();
        uint256 windowEndBlock = block.number + closesIn / BLOCK_TIME + BLOCK_MARGIN;

        vm.startBroadcast(pk);

        kpiVerifier.setKpiConfig(
            campaign,
            0,
            POOL,
            SWAP_EVENT,
            1, // userParamIndex — `recipient`, which the blob reaches as topics[2]
            IEventMetricKpiVerifier.Aggregation.COUNT,
            0, // valueParamIndex — ignored under COUNT, and `amount0` is signed anyway
            1, // scale — counting swaps, nothing to denominate
            block.number,
            windowEndBlock
        );

        kpiVerifier.setKpiConfig(
            campaign,
            1,
            USDC,
            TRANSFER_EVENT,
            1, // userParamIndex — `to`, the wallet the pool sent the output to
            IEventMetricKpiVerifier.Aggregation.SUM,
            2, // valueParamIndex — `value`, a uint256, which is what SUM requires
            VOLUME_SCALE,
            block.number,
            windowEndBlock
        );

        kpiVerifier.setKpiConfig(
            campaign,
            2,
            WETH,
            DEPOSIT_EVENT,
            0, // userParamIndex — `dst`, which the blob reaches as topics[1]
            IEventMetricKpiVerifier.Aggregation.COUNT,
            0, // valueParamIndex — ignored under COUNT
            1, // scale — counting wraps, nothing to denominate
            block.number,
            windowEndBlock
        );

        // Boney alone on all three. `TouchWindowVerifier` under CAP needs `evidence` and returns 0.
        guardedVerifier.setGuardConfig(campaign, 0, address(0), 0, IGuardedKpiVerifier.Mode.AGREE);
        guardedVerifier.setGuardConfig(campaign, 1, address(0), 0, IGuardedKpiVerifier.Mode.AGREE);
        guardedVerifier.setGuardConfig(campaign, 2, address(0), 0, IGuardedKpiVerifier.Mode.AGREE);

        vm.stopBroadcast();
    }
}
