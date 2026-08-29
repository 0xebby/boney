// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Campaign} from "../src/campaign/Campaign.sol";
import {CampaignRegistry} from "../src/campaign/CampaignRegistry.sol";
import {EscrowVault} from "../src/escrow/EscrowVault.sol";
import {OpenMintNFT} from "../src/mocks/OpenMintNFT.sol";
import {Types} from "../src/libraries/Types.sol";

/// @title SeedTwo
/// @notice Two campaigns: Venus on canonical WETH behind a reputation gate, Sdy Labs on a freshly
///         deployed NFT, open to anyone.
/// @dev Whole-fixture seed for a freshly deployed registry — asserts `campaignCount() == 0`, since
///      `CampaignRegistry` is append-only and an activated campaign can never be retired.
///
///      Every KPI here carries `verifier == address(0)`, so a claim is credited as reported and no
///      relayer pass is needed before the indexer runs. The gate on Venus is a *joining* gate, not a
///      KPI one, and so adds nothing for the relayer to do.
contract SeedTwo is Script {
    /// @dev Canonical Base predeploy. `Deposit`'s `wad` is the single data word, which is what makes
    ///      both a volume and a count reading possible on one event.
    address public constant WETH = 0x4200000000000000000000000000000000000006;
    bytes32 public constant WETH_DEPOSIT_TOPIC =
        0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c;

    /// @dev ERC-20 and ERC-721 share this topic; the shapes differ only in topic count.
    bytes32 public constant TRANSFER_TOPIC =
        0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef;
    /// @dev `OpenMintNFT.Minted(address indexed minter, uint256 paid, uint256 quantity)`.
    bytes32 public constant MINTED_TOPIC = 0x25b428dfde728ccfaddad7e29e4ac23c24ed7fd1a6e3e3f91894a9a073f5dfff;

    /// @dev Amount modes, mirroring `web/src/lib/kpiSource.ts`.
    uint8 internal constant COUNT = 0;
    uint8 internal constant DATA_WORD0 = 1;

    /// @dev One unit of progress per 0.001 of an 18-decimal token.
    uint256 internal constant MILLI = 1e15;

    uint64 public constant DURATION = 30 days;

    /// @dev BoneyScore a promoter must hold to join Venus. It sits between the dev wallet's seeded
    ///      24,620 and `maxScore()`'s 28,000 ceiling, so `SeedDevRep` must have run first or
    ///      `Campaign`'s constructor rejects it with `UnreachableReputation`.
    uint256 public constant VENUS_GATE = 19_500;

    error RegistryNotEmpty(uint256 existing);

    uint256 internal pk;
    address internal project;
    CampaignRegistry internal registry;
    EscrowVault internal vault;
    IERC20 internal token;
    OpenMintNFT internal nft;

    /// @notice Deploys the NFT source, then creates, funds and activates both campaigns.
    function run() external {
        pk = vm.envUint("PRIVATE_KEY");
        project = vm.addr(pk);
        registry = CampaignRegistry(vm.envAddress("REGISTRY_ADDRESS"));
        vault = EscrowVault(vm.envAddress("VAULT_ADDRESS"));
        token = IERC20(vm.envAddress("TOKEN_ADDRESS"));

        uint256 existing = registry.campaignCount();
        if (existing != 0) revert RegistryNotEmpty(existing);

        uint256 pool = vm.envOr("SEED_POOL", uint256(20_000 ether));

        vm.startBroadcast(pk);
        nft = new OpenMintNFT(project);
        vm.stopBroadcast();

        address venus = _venus(pool);
        address sdy = _sdyLabs(pool);

        console.log("");
        console.log("Two campaigns seeded. Rewards in bUSD.");
        console.log("  0 Venus    ", venus);
        console.log("      watching", WETH);
        console.log("      kpi0 wrap volume / kpi1 wrap count, both ungated KPIs");
        console.log("      joining gated at BoneyScore", VENUS_GATE);
        console.log("  1 Sdy Labs ", sdy);
        console.log("      watching", address(nft));
        console.log("      kpi0 mint count / kpi1 mint spend, both ungated KPIs");
        console.log("      joining open to anyone");
        console.log("");
        console.log("  NFT mint price (wei):", nft.PRICE());
        console.log("  Next: cd web && pnpm deployments 84532");
    }

    /// @dev The same `Deposit` event read two ways, so the fixture shows `amountMode` and not the
    ///      event deciding the unit.
    /// @param pool Reward pool, in the escrow token's smallest unit.
    /// @return campaign The created campaign's address.
    function _venus(uint256 pool) internal returns (address campaign) {
        Types.KpiSpec[] memory kpis = new Types.KpiSpec[](2);
        kpis[0] = _kpi(Types.KpiKind.Deposit, WETH, WETH_DEPOSIT_TOPIC, 1, DATA_WORD0, MILLI);
        kpis[1] = _kpi(Types.KpiKind.Deposit, WETH, WETH_DEPOSIT_TOPIC, 1, COUNT, 1);

        Types.RewardTier[][] memory tiers = new Types.RewardTier[][](2);
        tiers[0] = _tiers(pool, 1, 5, 20);
        tiers[1] = _tiers(pool, 1, 3, 5);

        campaign = _create("Venus", pool, VENUS_GATE, kpis, tiers);
    }

    /// @dev `actorTopic: 2` on the ERC-721 `Transfer` is `to`, the minter; `Minted` carries what the
    ///      minter paid as its first data word.
    /// @param pool Reward pool, in the escrow token's smallest unit.
    /// @return campaign The created campaign's address.
    function _sdyLabs(uint256 pool) internal returns (address campaign) {
        Types.KpiSpec[] memory kpis = new Types.KpiSpec[](2);
        kpis[0] = _kpi(Types.KpiKind.Mint, address(nft), TRANSFER_TOPIC, 2, COUNT, 1);
        kpis[1] = _kpi(Types.KpiKind.TokenPurchase, address(nft), MINTED_TOPIC, 1, DATA_WORD0, MILLI);

        Types.RewardTier[][] memory tiers = new Types.RewardTier[][](2);
        tiers[0] = _tiers(pool, 1, 3, 10);
        tiers[1] = _tiers(pool, 1, 3, 10);

        campaign = _create("Sdy Labs", pool, 0, kpis, tiers);
    }

    /// @dev One ungated KPI spec. `kind` must describe the event actually watched, since the UI
    ///      renders it beside the decoded source.
    /// @param kind KPI kind rendered by the UI.
    /// @param source Contract whose logs are watched.
    /// @param topic0 Event signature hash to match.
    /// @param actorTopic Topic index carrying the credited wallet.
    /// @param amountMode How the amount is read: count of events, or the first data word.
    /// @param scale Divisor applied to the summed amount.
    /// @return The KPI spec.
    function _kpi(
        Types.KpiKind kind,
        address source,
        bytes32 topic0,
        uint8 actorTopic,
        uint8 amountMode,
        uint256 scale
    ) internal pure returns (Types.KpiSpec memory) {
        return Types.KpiSpec({
            kind: kind,
            verifier: address(0),
            target: 100,
            aggregate: false,
            params: abi.encode(source, topic0, actorTopic, amountMode, scale)
        });
    }

    /// @dev Three ascending rungs at 1% / 2% / 4% of the pool, so escrow cannot be exhausted
    ///      mid-demo.
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

    /// @dev Create, fund and activate.
    /// @param name Campaign name, carried by `CampaignCreated`.
    /// @param pool Reward pool, in the escrow token's smallest unit.
    /// @param minReputation BoneyScore required to join; 0 leaves the campaign open.
    /// @param kpis KPI specs, in index order.
    /// @param tiers Reward ladder per KPI.
    /// @return campaign The created campaign's address.
    function _create(
        string memory name,
        uint256 pool,
        uint256 minReputation,
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
            minReputation: minReputation
        });

        vm.startBroadcast(pk);
        (, campaign) = registry.createCampaign(cfg, kpis, tiers);
        token.approve(address(vault), pool);
        vault.deposit(campaign, pool);
        Campaign(campaign).activate();
        vm.stopBroadcast();
    }
}
