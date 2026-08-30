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
import {OpenMintNFT} from "../src/mocks/OpenMintNFT.sol";
import {Types} from "../src/libraries/Types.sol";

/// @title SeedFive
/// @notice The demo fixture: five projects, eleven KPIs, every event source verified against live
///         Base Sepolia logs before it was written down.
/// @dev **Whole-fixture seed for a freshly deployed registry.** Asserts `campaignCount() == 0` for the
///      same reason `SeedDemo` does: `CampaignRegistry` is append-only and `Campaign.cancel()` is
///      reachable only from `Pending`, so an exact list of five is impossible on a registry that has
///      ever held anything else. `DeployBoney` + `pnpm deployments 84532` is part of running this.
///
///      **`SeedDevRep` must run first.** The 08-21 redeploy skipped it, which left `maxScore() == 0`
///      and made every campaign creation with a non-zero reputation gate revert
///      `UnreachableReputation`. The five below gate at 0 so nothing here depends on it, but the demo's
///      *next* step — creating a campaign through the UI with a gate — does.
///
///      ## Why these five, and what each one proves
///
///      Four watch contracts this repo does not control, which is the whole claim: Boney credits real
///      third-party activity without the protocol knowing it exists. The fifth is deployed here because
///      Base Sepolia has no mintable NFT — see `OpenMintNFT`.
///
///      The KPI mix is deliberate rather than decorative. Each of the three readings a KPI can take is
///      represented, because each fails differently:
///
///       - **COUNT** — "how many actions". The only reading available where the amount is not the first
///         non-indexed param (Aave, Sygma, Uniswap's pool event).
///       - **SUM via `dataWord0`** — "how much". Requires the amount to be the first non-indexed word,
///         since `indexerCore.rawAmount` slices it raw with no ABI decoding.
///       - **the same event read both ways** — WETH is counted *and* summed, so the fixture shows two
///         KPIs on one contract disagreeing about units without either being wrong.
///
///      ## Two KPIs are verifier-gated, nine are not
///
///      Sygma's bridge count and Uniswap's swap count route through `GuardedKpiVerifier`, so a claim on
///      them is capped at what the relayer independently observed — the protocol's central claim, and
///      the thing worth showing on camera. The other nine credit the reported figure as-is, which is
///      also worth showing: it is the difference gating makes.
///
///      A consequence to know while demoing: a gated KPI credits **nothing** until `pnpm relay` has
///      observed the activity, and a report that lands first succeeds silently rather than reverting.
///      `dev-up.sh` sequences relay before index for exactly this.
contract SeedFive is Script {
    // ── third-party sources, each verified against live logs ─────────────────────────────────────

    /// @dev Sygma bridge. `Deposit`'s topic0 was matched against a PUSH32 constant in the deployed
    ///      bytecode; the bridge is quiet on testnet, so there were no logs to sample when it was
    ///      first written. It has since processed deposits from this fixture, which confirmed it.
    address public constant SYGMA_BRIDGE = 0x9D5C332Ebe0DaE36e07a4eD552Ad4d8c5067A61F;
    bytes32 public constant SYGMA_DEPOSIT_TOPIC =
        0x17bc3181e17a9620a479c24e6c606e474ba84fc036877b768926872e8cd0e11f;
    string public constant SYGMA_DEPOSIT_EVENT =
        "Deposit(uint8 destinationDomainID, bytes32 resourceID, uint64 depositNonce, address indexed user, bytes data, bytes handlerResponse)";

    /// @dev Aave V3 pool. Both events sampled live: 23 `Supply` and 59 `Withdraw` in 45k blocks, with
    ///      the attributed wallet at `topics[2]` on each.
    address public constant AAVE_POOL = 0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27;
    bytes32 public constant AAVE_SUPPLY_TOPIC =
        0x2b627736bca15cd5381dcf80b0bf11fd197d01a037c52b927a881a10fb73ba61;
    bytes32 public constant AAVE_WITHDRAW_TOPIC =
        0x3115d1449a7b732c986cba18244e897a450f61e1bb8d589cd2e69e6c8924f9f7;

    /// @dev Canonical Base predeploy. `Deposit`'s `wad` is the single data word, which is what makes a
    ///      volume KPI possible here and impossible on Aave.
    address public constant WETH = 0x4200000000000000000000000000000000000006;
    bytes32 public constant WETH_DEPOSIT_TOPIC =
        0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c;
    bytes32 public constant WETH_WITHDRAWAL_TOPIC =
        0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65;

    /// @dev Uniswap V3 WETH/USDC pool and Circle's testnet USDC.
    ///
    ///      The swap's *output* leg is read, not the input. `SwapRouter02` checks its own balance first
    ///      and this router holds stranded ETH on Base Sepolia, so it wraps its own and pays the pool
    ///      from that — the swapper's WETH never moves and a KPI on the WETH leg credits nothing. The
    ///      USDC transfer to the recipient is the leg that actually reflects the swap.
    address public constant UNI_POOL = 0x46880b404CD35c165EDdefF7421019F8dD25F4Ad;
    bytes32 public constant UNI_SWAP_TOPIC =
        0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67;
    string public constant UNI_SWAP_EVENT =
        "Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)";
    address public constant USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    /// @dev ERC-20 and ERC-721 share this topic; the shapes differ only in topic count.
    bytes32 public constant TRANSFER_TOPIC =
        0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef;
    /// @dev `OpenMintNFT.Minted(address indexed minter, uint256 paid, uint256 quantity)`.
    bytes32 public constant MINTED_TOPIC = 0x25b428dfde728ccfaddad7e29e4ac23c24ed7fd1a6e3e3f91894a9a073f5dfff;

    // ── amount modes, mirroring `lib/kpiSource.ts` ───────────────────────────────────────────────

    uint8 internal constant COUNT = 0;
    uint8 internal constant DATA_WORD0 = 1;

    /// @dev One unit of progress per 0.001 of an 18-decimal token.
    uint256 internal constant MILLI = 1e15;
    /// @dev One unit per whole USDC — 6 decimals, not 18.
    uint256 internal constant WHOLE_USDC = 1e6;

    uint64 public constant DURATION = 30 days;
    uint256 public constant BLOCK_TIME = 2;
    uint256 public constant BLOCK_MARGIN = 10_000;

    error RegistryNotEmpty(uint256 existing);
    error VerifierNotOwned(address verifier, address owner, address expected);

    uint256 internal pk;
    address internal project;
    CampaignRegistry internal registry;
    EscrowVault internal vault;
    IERC20 internal token;
    EventMetricKpiVerifier internal kpiVerifier;
    GuardedKpiVerifier internal guardedVerifier;
    OpenMintNFT internal nft;

    function run() external {
        pk = vm.envUint("PRIVATE_KEY");
        project = vm.addr(pk);
        registry = CampaignRegistry(vm.envAddress("REGISTRY_ADDRESS"));
        vault = EscrowVault(vm.envAddress("VAULT_ADDRESS"));
        token = IERC20(vm.envAddress("TOKEN_ADDRESS"));
        kpiVerifier = EventMetricKpiVerifier(vm.envAddress("KPI_VERIFIER_ADDRESS"));
        guardedVerifier = GuardedKpiVerifier(vm.envAddress("GUARDED_VERIFIER_ADDRESS"));

        // Both fail before spending gas rather than producing a fixture that looks right.
        uint256 existing = registry.campaignCount();
        if (existing != 0) revert RegistryNotEmpty(existing);
        if (kpiVerifier.owner() != project) {
            revert VerifierNotOwned(address(kpiVerifier), kpiVerifier.owner(), project);
        }
        if (guardedVerifier.owner() != project) {
            revert VerifierNotOwned(address(guardedVerifier), guardedVerifier.owner(), project);
        }

        uint256 pool = vm.envOr("SEED_POOL", uint256(20_000 ether));

        vm.startBroadcast(pk);
        nft = new OpenMintNFT(project);
        vm.stopBroadcast();

        address sygma = _sygma(pool);
        address aave = _aave(pool);
        address mint = _nft(pool);
        address weth = _weth(pool);
        address uni = _uniswap(pool);

        console.log("");
        console.log("Five projects seeded. Rewards in bUSD; every source verified on chain.");
        console.log("  0 Sygma Bridge  ", sygma);
        console.log("      kpi0 bridge count      GATED (relayer must observe first)");
        console.log("      kpi1 WETH wrap volume  ungated");
        console.log("  1 Aave          ", aave);
        console.log("      kpi0 supply count / kpi1 withdraw count, both ungated");
        console.log("  2 Open Mint NFT ", mint);
        console.log("      watching", address(nft));
        console.log("      kpi0 mint count / kpi1 mint spend, both ungated");
        console.log("  3 WETH          ", weth);
        console.log("      kpi0 wrap volume / kpi1 wrap count / kpi2 unwrap volume, ungated");
        console.log("  4 Uniswap       ", uni);
        console.log("      kpi0 swap count        GATED");
        console.log("      kpi1 USDC received     ungated");
        console.log("");
        console.log("  NFT mint price (wei):", nft.PRICE());
        console.log("  Next: pnpm deployments 84532, then generate activity.");
    }

    // ── the five ─────────────────────────────────────────────────────────────────────────────────

    /// @dev Sygma cannot support a volume KPI — the bridged amount lives inside the `data` bytes, not
    ///      as a top-level param — so its second KPI measures something the project also cares about:
    ///      wrapping, which is what a user does before bridging.
    function _sygma(uint256 pool) internal returns (address campaign) {
        Types.KpiSpec[] memory kpis = new Types.KpiSpec[](2);
        kpis[0] = _kpi(Types.KpiKind.Bridge, SYGMA_BRIDGE, SYGMA_DEPOSIT_TOPIC, 1, COUNT, 1, true);
        kpis[1] = _kpi(Types.KpiKind.Deposit, WETH, WETH_DEPOSIT_TOPIC, 1, DATA_WORD0, MILLI, false);

        Types.RewardTier[][] memory tiers = new Types.RewardTier[][](2);
        tiers[0] = _tiers(pool, 1, 3, 5);
        tiers[1] = _tiers(pool, 1, 5, 20);

        campaign = _create("Sygma Bridge", pool, kpis, tiers);
        _gate(campaign, 0, SYGMA_BRIDGE, SYGMA_DEPOSIT_EVENT, 3);
    }

    /// @dev COUNT on both legs. `Supply(reserve, user, onBehalfOf, amount, referralCode)` puts `user`
    ///      at data word 0 and `amount` at word 1, so `dataWord0` would credit progress equal to a
    ///      wallet address. Counting supplies and withdrawals is the honest reading available.
    function _aave(uint256 pool) internal returns (address campaign) {
        Types.KpiSpec[] memory kpis = new Types.KpiSpec[](2);
        kpis[0] = _kpi(Types.KpiKind.Deposit, AAVE_POOL, AAVE_SUPPLY_TOPIC, 2, COUNT, 1, false);
        kpis[1] = _kpi(Types.KpiKind.withdraw, AAVE_POOL, AAVE_WITHDRAW_TOPIC, 2, COUNT, 1, false);

        Types.RewardTier[][] memory tiers = new Types.RewardTier[][](2);
        tiers[0] = _tiers(pool, 1, 2, 3);
        tiers[1] = _tiers(pool, 1, 2, 3);

        campaign = _create("Aave", pool, kpis, tiers);
    }

    /// @dev `actorTopic: 2` on the ERC-721 `Transfer` is `to`, the minter. The fixture's previous NFT
    ///      campaign used the same topic index against ERC-1155 `TransferSingle`, where position 2 is
    ///      `from` — `address(0)` on a mint — so it could never credit anyone. The shapes differ.
    function _nft(uint256 pool) internal returns (address campaign) {
        Types.KpiSpec[] memory kpis = new Types.KpiSpec[](2);
        kpis[0] = _kpi(Types.KpiKind.Mint, address(nft), TRANSFER_TOPIC, 2, COUNT, 1, false);
        kpis[1] = _kpi(Types.KpiKind.TokenPurchase, address(nft), MINTED_TOPIC, 1, DATA_WORD0, MILLI, false);

        Types.RewardTier[][] memory tiers = new Types.RewardTier[][](2);
        tiers[0] = _tiers(pool, 1, 3, 10);
        tiers[1] = _tiers(pool, 1, 3, 10);

        campaign = _create("Open Mint NFT", pool, kpis, tiers);
    }

    /// @dev The same `Deposit` event read two ways, plus the unwrap. Three KPIs on one contract, which
    ///      is the clearest demonstration that `amountMode` and not the event decides the unit.
    function _weth(uint256 pool) internal returns (address campaign) {
        Types.KpiSpec[] memory kpis = new Types.KpiSpec[](3);
        kpis[0] = _kpi(Types.KpiKind.Deposit, WETH, WETH_DEPOSIT_TOPIC, 1, DATA_WORD0, MILLI, false);
        kpis[1] = _kpi(Types.KpiKind.Deposit, WETH, WETH_DEPOSIT_TOPIC, 1, COUNT, 1, false);
        kpis[2] = _kpi(Types.KpiKind.withdraw, WETH, WETH_WITHDRAWAL_TOPIC, 1, DATA_WORD0, MILLI, false);

        Types.RewardTier[][] memory tiers = new Types.RewardTier[][](3);
        tiers[0] = _tiers(pool, 1, 5, 20);
        tiers[1] = _tiers(pool, 1, 3, 5);
        tiers[2] = _tiers(pool, 1, 5, 20);

        campaign = _create("WETH", pool, kpis, tiers);
    }

    /// @dev `scale` is `1e6` on the USDC leg because USDC has six decimals, not eighteen. Reusing the
    ///      18-decimal scale here would floor every realistic swap to zero progress.
    function _uniswap(uint256 pool) internal returns (address campaign) {
        Types.KpiSpec[] memory kpis = new Types.KpiSpec[](2);
        kpis[0] = _kpi(Types.KpiKind.Swap, UNI_POOL, UNI_SWAP_TOPIC, 2, COUNT, 1, true);
        kpis[1] = _kpi(Types.KpiKind.Volume, USDC, TRANSFER_TOPIC, 2, DATA_WORD0, WHOLE_USDC, false);

        Types.RewardTier[][] memory tiers = new Types.RewardTier[][](2);
        tiers[0] = _tiers(pool, 1, 3, 5);
        tiers[1] = _tiers(pool, 1, 5, 20);

        campaign = _create("Uniswap", pool, kpis, tiers);
        // `userParamIndex` 1 is `recipient` in declaration order (0 is `sender`) — the wallet that
        // receives the output, which is what `actorTopic: 2` credits on the indexer side. Pointing the
        // two halves at different params is the mismatch `describeConfigDrift` exists to catch.
        _gate(campaign, 0, UNI_POOL, UNI_SWAP_EVENT, 1);
    }

    // ── helpers ──────────────────────────────────────────────────────────────────────────────────

    /// @dev One KPI spec. `kind` must describe the event actually watched: the UI renders it beside the
    ///      decoded source, so a contradiction reads as an app bug rather than a fixture choice.
    /// @param gated Route through `GuardedKpiVerifier`, capping a claim at the relayer's observation.
    function _kpi(
        Types.KpiKind kind,
        address source,
        bytes32 topic0,
        uint8 actorTopic,
        uint8 amountMode,
        uint256 scale,
        bool gated
    ) internal view returns (Types.KpiSpec memory) {
        return Types.KpiSpec({
            kind: kind,
            verifier: gated ? address(guardedVerifier) : address(0),
            target: 100,
            aggregate: false,
            params: abi.encode(source, topic0, actorTopic, amountMode, scale)
        });
    }

    /// @dev Three ascending rungs at 1% / 2% / 4% of the pool. Kept well under a third in total so a
    ///      campaign with three KPIs and several promoters cannot exhaust escrow mid-demo — `_settle`
    ///      pays what remains and emits `PoolExhausted` rather than reverting, which is a confusing
    ///      thing to hit on camera.
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

    /// @dev Create, fund and activate. `minReputation` is 0 deliberately: a gate here would only give
    ///      the wallet under test a reason to be turned away, and the demo sets a real gate on the
    ///      campaign it creates through the UI.
    function _create(
        string memory name,
        uint256 pool,
        Types.KpiSpec[] memory kpis,
        Types.RewardTier[][] memory tiers
    ) internal returns (address campaign) {
        Types.CampaignConfig memory cfg = Types.CampaignConfig({
            project: project,
            name: name,
            token: address(token),
            rewardPool: pool,
            startTime: uint64(block.timestamp),
            endTime: uint64(block.timestamp) + DURATION,
            attributionWindow: DURATION,
            minReputation: 0
        });

        vm.startBroadcast(pk);
        (, campaign) = registry.createCampaign(cfg, kpis, tiers);
        token.approve(address(vault), pool);
        vault.deposit(campaign, pool);
        Campaign(campaign).activate();
        vm.stopBroadcast();
    }

    /// @dev Points Boney's verifier at the same event and routes the guard through Boney alone. Runs
    ///      after creation because `kpiIndex` and the campaign's window do not exist until it does.
    ///
    ///      `TouchWindowVerifier` is deliberately not the project verifier under `CAP`: it needs
    ///      `evidence` and returns 0 without it, which would cap every claim at nothing.
    function _gate(
        address campaign,
        uint256 kpiIndex,
        address source,
        string memory signature,
        uint8 userParamIndex
    ) internal {
        uint256 closesIn = uint256(DURATION) + Campaign(campaign).CLAIM_GRACE();
        uint256 windowEndBlock = block.number + closesIn / BLOCK_TIME + BLOCK_MARGIN;

        vm.startBroadcast(pk);
        kpiVerifier.setKpiConfig(
            campaign,
            kpiIndex,
            source,
            signature,
            userParamIndex,
            IEventMetricKpiVerifier.Aggregation.COUNT,
            0, // valueParamIndex — ignored under COUNT
            1, // scale — counting events, nothing to denominate
            block.number,
            windowEndBlock
        );
        guardedVerifier.setGuardConfig(campaign, kpiIndex, address(0), 0, IGuardedKpiVerifier.Mode.AGREE);
        vm.stopBroadcast();
    }
}
