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

/// @title SeedSwapKpi
/// @notice One campaign paying promoters for WETH → USDC swaps on Uniswap V3, Base Sepolia: two KPIs,
///         five tiers each, thresholds low enough to cross by hand in a testing session.
/// @dev **Verified against the chain, not assumed.** The 0.3% WETH/USDC pool
///      `0x46880b404CD35c165EDdefF7421019F8dD25F4Ad` (from `UniswapV3Factory.getPool`) holds
///      ~4.8e14 liquidity and its `Swap` logs were sampled at blocks 45826233 and 45826335. In those
///      logs `topics[1]` is SwapRouter02 `0x94cC…2bc4` and `topics[2]` is the end user, which is why
///      the swap KPI credits **topic 2**: crediting `sender` would pay for every swap the router ever
///      routes, to whoever happened to be attributed.
///
///      **Why volume is sourced from the USDC leg.** The pool's own amounts are the honest place to
///      read volume and this machinery cannot read them. `Swap` declares `int256 amount0, int256
///      amount1`, and for a WETH → USDC swap on this pool (token0 is USDC, whose address sorts below
///      WETH's) `amount0` is *negative* — USDC leaving the pool. The indexer's half can only "count
///      each log" or "read the first 32-byte word of `data`" (`KpiSpec.params.amountMode`), so that
///      word decodes as ~1.15e77 rather than a volume, and the WETH amount it should read sits in the
///      *second* word, which the encoding cannot name. `EventMetricKpiVerifier` could address
///      `amount1` by declaration index, but `validateParamIndexes` rejects a non-`uint` value param —
///      correctly, since a signed magnitude has no meaning under SUM.
///
///      So volume reads the **USDC** `Transfer` with `to` as the actor: the pool sends the output
///      straight to the swap's `recipient`, in a `uint256` first data word both halves read identically.
///
///      **Not the WETH leg, which the first attempt used and which cannot work.** A swap through
///      SwapRouter02 does not necessarily move the swapper's WETH at all. `PeripheryPayments.pay`
///      checks `address(this).balance >= value` *first*, and this router holds ~0.19 ETH stranded on
///      Base Sepolia — so it wraps its own ETH and pays the pool from that, leaving the user's WETH and
///      even their approval untouched. Verified on tx
///      `0x3a406382d9811276cfe6cd5132da8cf4f7d7d2b45d7a004bde12da9720e43f91`: four logs, and the WETH
///      `Transfer` is `router → pool`, not `user → pool`. A volume KPI keyed to the user's WETH credits
///      nothing there, and `KpiSpec.params` is written in the constructor with no setter, so campaign 7
///      (`0x2535adF6…`) keeps that dead KPI permanently — hence this second campaign rather than a fix.
///
///      What the USDC leg costs, stated rather than hidden: **any** USDC the referral receives counts,
///      not only swap output — a faucet drip would credit. The swap-count KPI is the one pinned to
///      Uniswap itself; read the two together.
///
///      **Both KPIs are gated through `GuardedKpiVerifier`**, so a claim is capped at what Boney
///      independently observed. That means `pnpm relay` must run before `pnpm index` credits anything,
///      and the reporter key must equal the project key — see the fixture notes in the repo.
///
///      Usage (Base Sepolia):
///        PRIVATE_KEY=… REGISTRY_ADDRESS=… VAULT_ADDRESS=… TOKEN_ADDRESS=… \
///        KPI_VERIFIER_ADDRESS=… GUARDED_VERIFIER_ADDRESS=… \
///        forge script script/SeedSwapKpi.s.sol:SeedSwapKpi --rpc-url "$RPC_URL" --broadcast --slow
contract SeedSwapKpi is Script {
    /// @dev Raised when the seeding key does not own the verifiers, whose setters are `onlyOwner`.
    error VerifierNotOwned(address verifier, address owner, address seeder);

    /// @notice Uniswap V3 WETH/USDC 0.3% pool on Base Sepolia — `getPool(WETH, USDC, 3000)`.
    /// @dev The deepest of the four fee tiers that exist here (0.01%, 0.05%, 0.3%, 1%), and the only
    ///      one with swaps in recent history. A campaign pointed at an idle pool is untestable.
    address public constant POOL = 0x46880b404CD35c165EDdefF7421019F8dD25F4Ad;

    /// @notice Base's canonical WETH predeploy — what a promoter's referral swaps in. No KPI watches
    ///         it: see the note above on the router paying from its own ETH.
    address public constant WETH = 0x4200000000000000000000000000000000000006;

    /// @notice Circle's test USDC on Base Sepolia — the swap output, and the volume KPI's source.
    address public constant USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    /// @notice `keccak256("Swap(address,address,int256,int256,uint160,uint128,int24)")`.
    /// @dev Matched against live pool logs, not derived on faith.
    bytes32 public constant SWAP_TOPIC = 0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67;

    /// @notice `keccak256("Transfer(address,address,uint256)")` — ERC-20, so fixed by the standard.
    bytes32 public constant TRANSFER_TOPIC =
        0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef;

    /// @notice Uniswap V3's swap event, full declaration order.
    /// @dev `recipient` is the attributed wallet: param 1, and the second indexed param, so
    ///      `topics[2]`. `sender` is the router on every routed swap.
    string public constant SWAP_EVENT =
        "Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)";

    /// @notice ERC-20 transfer. `to` is the attributed wallet: param 1, `topics[2]`.
    string public constant TRANSFER_EVENT =
        "Transfer(address indexed from, address indexed to, uint256 value)";

    /// @dev 30 days. Equal to `AttributionRegistry.maxTouchDuration()` on this deployment, which is
    ///      the ceiling a touch may carry, so the attribution never lapses inside the campaign.
    uint64 public constant DURATION = 30 days;

    /// @dev Seconds per block on Base Sepolia, for projecting the reporting close onto a block.
    uint256 public constant BLOCK_TIME = 2;

    /// @dev Slack on that projection, so a slow chain cannot close the window before the campaign.
    uint256 public constant BLOCK_MARGIN = 10_000;

    /// @dev 1e5 USDC units = 0.1 USDC per unit of progress. USDC carries 6 decimals, not 18.
    ///
    ///      Set against what a tester can actually spend rather than against a market: this pool trades
    ///      at ~150 USDC per WETH, so 0.1 USDC of progress is about 0.0007 WETH, the first tier costs
    ///      a fraction of a cent of testnet value, and the top one is 2 USDC (~0.013 WETH) across as
    ///      many swaps as it takes. Integer division drops the remainder, so a swap yielding 0.19 USDC
    ///      credits 1.
    uint256 public constant VOLUME_SCALE = 1e5;

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

        // 20,000 bUSD covers three promoters running both ladders to the top (6,500 each) with room
        // over. A fourth would hit `PoolExhausted`, which is a real state worth being able to reach.
        uint256 pool = vm.envOr("SEED_POOL", uint256(20_000 ether));
        string memory name = vm.envOr("SEED_NAME", string("Uniswap WETH to USDC"));

        address campaign = _create(name, pool);
        _configure(campaign);

        console.log("");
        console.log("Uniswap swap campaign seeded (rewards in bUSD, activity tracked on chain)");
        console.log("  campaign :", campaign);
        console.log("  project  :", project);
        console.log("  pool     :", pool / 1e18, "bUSD");
        console.log("");
        console.log("  KPI 0  Swaps  - Uniswap V3 Swap on", POOL);
        console.log("         actor topics[2] (recipient), COUNT, tiers 1/2/3/5/8 swaps");
        console.log("  KPI 1  Volume - USDC Transfer on", USDC);
        console.log("         actor topics[2] (to), SUM / 1e5, tiers at 0.1/0.3/0.5/1/2 USDC out");
        console.log("");
        console.log("  To test: join as a promoter, sign a touch for a referral wallet, then have that");
        console.log("  wallet swap WETH for USDC through SwapRouter02 0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4.");
        console.log("  Then `pnpm relay` (observe as Boney) before `pnpm index` (claim as the project).");
    }

    /// @dev The campaign, funded and activated, carrying both event-source blobs the indexer reads.
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
            // Equal to the campaign's length, so a touch never lapses out from under a promoter.
            attributionWindow: DURATION,
            // Ungated: this fixture exists to be swapped against, and a reputation gate would only
            // add a reason for the wallet under test to be turned away.
            minReputation: 0
        });

        Types.KpiSpec[] memory kpis = new Types.KpiSpec[](2);

        // KPI 0 — how many swaps. `amountMode` 0 is COUNT and scale 1 is no scaling, matching
        // `Aggregation.COUNT` on the verifier so the claim and the observation are one quantity.
        kpis[0] = Types.KpiSpec({
            kind: Types.KpiKind.Swap,
            verifier: address(guardedVerifier),
            // The top rung, so the panel's "target" is a figure the ladder actually pays out at.
            target: 8,
            aggregate: false,
            params: abi.encode(POOL, SWAP_TOPIC, uint8(2), uint8(0), uint256(1))
        });

        // KPI 1 — how much came out. `amountMode` 1 is dataWord0, which for `Transfer` is `value`.
        kpis[1] = Types.KpiSpec({
            kind: Types.KpiKind.Volume,
            verifier: address(guardedVerifier),
            target: 20,
            aggregate: false,
            params: abi.encode(USDC, TRANSFER_TOPIC, uint8(2), uint8(1), VOLUME_SCALE)
        });

        Types.RewardTier[][] memory tiers = new Types.RewardTier[][](2);

        // Both ladders open at one action's worth, so a single swap proves settlement end to end, and
        // both top out inside what a testnet wallet can spend. Rewards rise faster than thresholds:
        // the fifth swap is worth more than the first, which is the shape a real campaign wants.
        tiers[0] = new Types.RewardTier[](5);
        tiers[0][0] = Types.RewardTier({threshold: 1, reward: 200 ether});
        tiers[0][1] = Types.RewardTier({threshold: 2, reward: 300 ether});
        tiers[0][2] = Types.RewardTier({threshold: 3, reward: 500 ether});
        tiers[0][3] = Types.RewardTier({threshold: 5, reward: 800 ether});
        tiers[0][4] = Types.RewardTier({threshold: 8, reward: 1_200 ether});

        // Thresholds in units of 0.1 USDC out: 0.1 / 0.3 / 0.5 / 1.0 / 2.0.
        tiers[1] = new Types.RewardTier[](5);
        tiers[1][0] = Types.RewardTier({threshold: 1, reward: 200 ether});
        tiers[1][1] = Types.RewardTier({threshold: 3, reward: 300 ether});
        tiers[1][2] = Types.RewardTier({threshold: 5, reward: 500 ether});
        tiers[1][3] = Types.RewardTier({threshold: 10, reward: 1_000 ether});
        tiers[1][4] = Types.RewardTier({threshold: 20, reward: 1_500 ether});

        vm.startBroadcast(pk);
        (, campaign) = registry.createCampaign(cfg, kpis, tiers);
        token.approve(address(vault), pool);
        vault.deposit(campaign, pool);
        Campaign(campaign).activate();
        vm.stopBroadcast();
    }

    /// @dev Points Boney's verifier at the same two events and routes both guards through Boney alone.
    ///      Runs after creation because `startTime`, `endTime` and the campaign address do not exist
    ///      until it does.
    ///
    ///      Each config must agree with its `KpiSpec.params` on all five of source, topic0, actor,
    ///      fold and scale, or the relayer refuses to run (`relayCore.describeConfigDrift`). The actor
    ///      is the subtle one: the blob names a *topic* position and the verifier names a *declaration*
    ///      position, so `topics[2]` is param 1 on both events here — `recipient` on `Swap`, and `to`
    ///      on `Transfer`.
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

        // Boney alone on both. `TouchWindowVerifier` under CAP would credit nothing here, because it
        // needs `evidence` and returns 0 without it.
        guardedVerifier.setGuardConfig(campaign, 0, address(0), 0, IGuardedKpiVerifier.Mode.AGREE);
        guardedVerifier.setGuardConfig(campaign, 1, address(0), 0, IGuardedKpiVerifier.Mode.AGREE);

        vm.stopBroadcast();
    }
}
