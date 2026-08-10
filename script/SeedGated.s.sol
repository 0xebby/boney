// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Campaign} from "../src/campaign/Campaign.sol";
import {CampaignRegistry} from "../src/campaign/CampaignRegistry.sol";
import {EscrowVault} from "../src/escrow/EscrowVault.sol";
import {Types} from "../src/libraries/Types.sol";

/// @title SeedGated
/// @notice Adds reputation-gated campaigns to an already-seeded chain.
/// @dev Separate from `SeedLocal` on purpose. That script is a whole-fixture seed: re-running it
///      to add one campaign would deploy a second token and duplicate all five existing campaigns,
///      and `web/src/lib/live.test.ts` pins the fixture it produces. This one only ever appends,
///      and reuses the token already on chain rather than minting a rival currency the existing
///      campaigns do not price in.
///
///      Why a *ladder* of gates rather than one high number: a single gate can only ever show one
///      side of `join()`. Three gates bracketing a known wallet score exercise the pass case, the
///      boundary, and `InsufficientReputation` — the last of which is the one that silently breaks
///      if `scoreOf` regresses, because a gate nobody can clear looks identical to a gate that is
///      wrongly rejecting everyone.
///
///      Usage (Base Sepolia):
///        REGISTRY_ADDRESS=… VAULT_ADDRESS=… TOKEN_ADDRESS=… \
///        forge script script/SeedGated.s.sol:SeedGated --rpc-url … --broadcast --slow
contract SeedGated is Script {
    /// @dev Reward pools are deliberately small. These campaigns exist to exercise the join gate,
    ///      not the payout ladder, and the funding wallet's balance is finite.
    uint256 constant POOL = 5_000 ether;

    uint256 PROJECT_PK;
    CampaignRegistry registry;
    EscrowVault vault;
    IERC20 token;
    address project;

    function run() external {
        PROJECT_PK = vm.envUint("PRIVATE_KEY");
        registry = CampaignRegistry(vm.envAddress("REGISTRY_ADDRESS"));
        vault = EscrowVault(vm.envAddress("VAULT_ADDRESS"));
        token = IERC20(vm.envAddress("TOKEN_ADDRESS"));
        project = vm.addr(PROJECT_PK);

        // Gates chosen against a dev wallet that attests to 24,620 (Ethos 2750 -> 19,250 plus
        // 30,000 followers -> reach 1790 -> 5,370). The composite maximum is 28,000.
        //
        //   20,000 — clears only once *both* schemas are attested. A wallet holding just
        //            ETHOS_SCORE scores 19,250 and is refused, so this is the gate that proves
        //            REACH is actually being counted rather than silently dropped.
        //   24,000 — the boundary case, 620 under a full score. Anything that shaves a few
        //            percent off `scoreOf` — an expired record, a reweighted schema — flips this
        //            one first, which makes it the useful canary.
        //   26,000 — above a full score and below the 28,000 ceiling, so it is unreachable for
        //            this wallet but not absurd. Keeps a live `InsufficientReputation` case in the
        //            fixture; every other seeded campaign is joinable.
        address a = _createFundedGated(20_000);
        address b = _createFundedGated(24_000);
        address c = _createFundedGated(26_000);

        console.log("");
        console.log("Gated campaigns added:");
        console.log("  minRep 20000 (needs reach attested): ", a);
        console.log("  minRep 24000 (boundary):             ", b);
        console.log("  minRep 26000 (always refused):       ", c);
    }

    /// @dev Creates, funds, and activates one gated campaign.
    ///
    ///      Activated rather than left Pending because `join()` accepts both Pending and Active,
    ///      but only an Active campaign exercises the rest of the promoter flow behind the gate.
    ///      A Pending gated campaign already exists in the fixture from `SeedLocal`.
    function _createFundedGated(uint256 minReputation) internal returns (address campaign) {
        Types.CampaignConfig memory cfg = Types.CampaignConfig({
            project: project,
            token: address(token),
            rewardPool: POOL,
            startTime: uint64(block.timestamp),
            endTime: uint64(block.timestamp + 60 days),
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
        tiers[0][0] = Types.RewardTier({threshold: 10, reward: POOL / 20});
        tiers[0][1] = Types.RewardTier({threshold: 50, reward: POOL / 10});
        tiers[0][2] = Types.RewardTier({threshold: 100, reward: POOL / 5});

        vm.startBroadcast(PROJECT_PK);
        (, campaign) = registry.createCampaign(cfg, kpis, tiers);
        token.approve(address(vault), POOL);
        vault.deposit(campaign, POOL);
        Campaign(campaign).activate();
        vm.stopBroadcast();
    }
}
