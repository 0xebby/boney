// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Campaign} from "../src/campaign/Campaign.sol";
import {CampaignRegistry} from "../src/campaign/CampaignRegistry.sol";
import {EscrowVault} from "../src/escrow/EscrowVault.sol";
import {AttributionRegistry} from "../src/attribution/AttributionRegistry.sol";
import {AttestationVerifier} from "../src/reputation/AttestationVerifier.sol";
import {ReputationRegistry} from "../src/reputation/ReputationRegistry.sol";
import {IAttributionRegistry} from "../src/interfaces/IAttributionRegistry.sol";
import {Types} from "../src/libraries/Types.sol";

contract MockToken is ERC20 {
    constructor() ERC20("Mock", "MOCK") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @title RejoinAttackTest
/// @notice Proves that a KOL cannot double-dip by leaving and rejoining after progress accrues.
/// @dev Attack scenario: KOL joins → link A → progress → leave → rejoin → link B → if progress
///      resets, re-cross tiers and claim the same reward twice.
///
///      Defense in depth:
///      1. No leave() exists — once joined, the promoter cannot exit
///      2. promoterId is deterministic (keccak256(campaign, promoter)), so "rejoining" would yield
///         the exact same id, not a fresh one
///      3. AlreadyJoined guard at Campaign.sol:279 — join() reverts if `_promoterIdOf[msg.sender]`
///         is already set
///      4. Progress is keyed by promoter address, never reset
contract RejoinAttackTest is Test {
    uint256 internal constant POOL = 10_000 ether;
    uint64 internal constant MAX_TOUCH = 30 days;

    MockToken internal token;
    EscrowVault internal vault;
    CampaignRegistry internal registry;
    AttributionRegistry internal attribution;
    AttestationVerifier internal verifier;
    ReputationRegistry internal reputation;
    Campaign internal campaign;

    address internal admin = address(0xA11CE);
    address internal project = address(0xC0DE);
    address internal oracle = address(0x0BAC);
    address internal kol = address(0xC01);

    uint256 internal userPk = 0x5EED;
    address internal user;

    uint64 internal startTime;
    uint64 internal endTime;

    function setUp() public {
        user = vm.addr(userPk);

        vm.warp(1_000_000);
        startTime = uint64(block.timestamp);
        endTime = uint64(block.timestamp + 30 days);

        token = new MockToken();
        attribution = new AttributionRegistry(MAX_TOUCH);
        verifier = new AttestationVerifier(admin, admin);
        reputation = new ReputationRegistry(admin, address(verifier));

        vault = new EscrowVault(address(this));
        registry = new CampaignRegistry(address(vault), address(reputation), address(attribution), oracle);
        vault.setRegistrar(address(registry));

        campaign = _createCampaign();
        _fund(campaign, POOL);
        vm.prank(project);
        campaign.activate();
    }

    function _createCampaign() internal returns (Campaign) {
        Types.CampaignConfig memory cfg = Types.CampaignConfig({
            project: project,
            name: "Rejoin Attack Test",
            token: address(token),
            rewardPool: POOL,
            startTime: startTime,
            endTime: endTime,
            attributionWindow: 7 days,
            minReputation: 0
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
        tiers[0][0] = Types.RewardTier({threshold: 10, reward: 1_000 ether});
        tiers[0][1] = Types.RewardTier({threshold: 50, reward: 2_000 ether});
        tiers[0][2] = Types.RewardTier({threshold: 100, reward: 5_000 ether});

        vm.prank(project);
        (, address addr) = registry.createCampaign(cfg, kpis, tiers);
        return Campaign(addr);
    }

    function _fund(Campaign c, uint256 amount) internal {
        token.mint(project, amount);
        vm.startPrank(project);
        token.approve(address(vault), amount);
        vault.deposit(address(c), amount);
        vm.stopPrank();
    }

    /// @notice Defense layer 1: Campaign exposes no leave/exit/quit entrypoint.
    /// @dev Asserted at the ABI level rather than by comment: a low-level call to each plausible
    ///      selector must hit the fallback and revert. If someone later adds `leave()`, this test
    ///      fails and forces a re-think of the reset semantics rather than silently opening the
    ///      double-dip path.
    function test_NoLeaveEntrypointExists() public {
        vm.prank(kol);
        campaign.join();

        string[4] memory sigs = ["leave()", "exit()", "quit()", "unjoin()"];
        for (uint256 i = 0; i < sigs.length; i++) {
            vm.prank(kol);
            (bool ok,) = address(campaign).call(abi.encodeWithSignature(sigs[i]));
            assertFalse(ok, string.concat("unexpected entrypoint: ", sigs[i]));
        }

        // The absence is deliberate. Allowing leave() would require either resetting progress and
        // settled tiers — which is exactly the double-dip — or keeping them, which makes the
        // function pointless.
    }

    /// @notice Defense layer 2: promoterId is deterministic, so "rejoining" yields the same id.
    function test_PromoterIdIsDeterministic() public {
        vm.prank(kol);
        bytes32 firstId = campaign.join();

        // Hypothetically, if the KOL could somehow clear `_promoterIdOf[kol]` and rejoin, the
        // promoterId would be byte-identical to the first one.
        bytes32 expectedId = keccak256(abi.encode(address(campaign), kol));
        assertEq(firstId, expectedId, "promoterId is keccak256(campaign, promoter)");

        // So even if the state were reset, attribution would still resolve to the same promoter,
        // and the user's Touch would bind to the same id. No "new link" is generated.
    }

    /// @notice Defense layer 3: AlreadyJoined guard blocks a second join().
    function test_RejoinReverts() public {
        vm.prank(kol);
        campaign.join();

        // Attempt to join again — this is the actual attack step
        vm.prank(kol);
        vm.expectRevert(Campaign.AlreadyJoined.selector);
        campaign.join();
    }

    /// @notice Defense layer 4: Progress and settledTiers are never reset, keyed by address.
    function test_ProgressPersistsIndefinitely() public {
        vm.prank(kol);
        bytes32 promoterId = campaign.join();

        // User signs a Touch
        _touch(kol, user, promoterId);

        // Progress is credited
        vm.prank(project);
        campaign.reportUserAction(0, user, 10, "");

        // Tier 1 settles
        uint256 progressBefore = campaign.progressOf(kol, 0);
        uint256 settledBefore = campaign.settledTiersOf(kol, 0);
        uint256 paidBefore = token.balanceOf(kol);

        assertEq(progressBefore, 10, "progress credited");
        assertEq(settledBefore, 1, "tier 1 settled");
        assertEq(paidBefore, 1_000 ether, "tier 1 paid");

        // There is no way to reset these mappings. `_progress[kol][0]` and `_settledTiers[kol][0]`
        // are storage that never gets deleted. Even if the KOL could rejoin (they cannot, per
        // test_RejoinReverts), the same promoter address would carry the same progress.

        // Warp forward a month — progress still there
        vm.warp(block.timestamp + 31 days);

        assertEq(campaign.progressOf(kol, 0), 10, "progress immutable");
        assertEq(campaign.settledTiersOf(kol, 0), 1, "settled tiers immutable");
    }

    /// @notice The variant the AlreadyJoined guard does NOT cover: a second promoter wallet.
    /// @dev `AlreadyJoined` is keyed on `msg.sender`, so it stops one wallet rejoining — it does
    ///      not stop the same human joining from a fresh address. Under LAST_TOUCH the user can
    ///      re-point attribution at that new wallet, and `_settle` walks the *new* promoter's
    ///      ladder from rung zero, because `_settledTiers` is keyed by promoter address.
    ///
    ///      This test measures what that actually costs the pool rather than assuming it is safe.
    function test_SecondWalletRewalksLadder() public {
        address kolB = address(0xC02);

        // ── wallet A: user reaches 10, crossing tier 0 ──
        vm.prank(kol);
        bytes32 idA = campaign.join();
        _touch(kol, user, idA);

        vm.prank(project);
        campaign.reportUserAction(0, user, 10, "");

        assertEq(token.balanceOf(kol), 1_000 ether, "A paid tier 0");

        // ── wallet B joins: a different msg.sender, so AlreadyJoined does not fire ──
        vm.prank(kolB);
        bytes32 idB = campaign.join();
        assertTrue(idA != idB, "distinct promoter ids");

        // The user re-points attribution at B with a strictly newer touch.
        vm.warp(block.timestamp + 1);
        _touch(kolB, user, idB);

        // Genuinely new user activity: cumulative 10 -> 50, so delta 40 is credited to B.
        vm.prank(project);
        campaign.reportUserAction(0, user, 50, "");

        uint256 paidB = token.balanceOf(kolB);
        uint256 totalPaid = token.balanceOf(kol) + paidB;

        // B's progress is 40, which clears tier 0 (10) but not tier 1 (50).
        assertEq(campaign.progressOf(kolB, 0), 40, "B credited the delta only");

        // A single promoter holding attribution throughout would be at progress 50 and would have
        // been paid tier 0 + tier 1 = 3000 ether. Compare that against the split.
        uint256 singlePromoterCost = 1_000 ether + 2_000 ether;

        emit log_named_uint("paid to A            ", token.balanceOf(kol));
        emit log_named_uint("paid to B            ", paidB);
        emit log_named_uint("total paid (split)   ", totalPaid);
        emit log_named_uint("total paid (one KOL) ", singlePromoterCost);

        // Tier 0 is paid once per promoter wallet, so the same 50 units of user activity pays the
        // cheapest rung twice. The ladder is per-promoter by design (each KOL earns their own
        // tiers), which is exactly what makes it re-walkable by a sybil.
        assertEq(paidB, 1_000 ether, "B re-earned tier 0 on the same user's activity");
        assertEq(totalPaid, 2_000 ether, "tier 0 paid twice across two wallets");
        assertLt(totalPaid, singlePromoterCost, "splitting is cheaper here, not more expensive");
    }

    /// @notice Whether repeated sybil wallets can extract more than one honest promoter.
    /// @dev The previous test shows one split is *cheaper* than a single promoter climbing high.
    ///      The question that matters for the pool is whether N wallets each farming the bottom
    ///      rung beats one wallet climbing the ladder. This drives that to its conclusion.
    function test_SybilFarmingBottomRung() public {
        uint256 pooledBefore = token.balanceOf(address(vault));

        // Five sybil wallets, each taking the user from k*10 to (k+1)*10 — every one of them
        // clears tier 0 (threshold 10) and nothing higher.
        uint256 sybils = 5;
        uint256 extracted;

        for (uint256 i = 0; i < sybils; i++) {
            address sybil = address(uint160(0xD000 + i));

            vm.prank(sybil);
            bytes32 id = campaign.join();

            vm.warp(block.timestamp + 1);
            _touch(sybil, user, id);

            vm.prank(project);
            campaign.reportUserAction(0, user, (i + 1) * 10, "");

            extracted += token.balanceOf(sybil);
        }

        emit log_named_uint("sybil wallets        ", sybils);
        emit log_named_uint("user progress total  ", campaign.userCreditedOf(user, 0));
        emit log_named_uint("extracted by sybils  ", extracted);

        // 50 units of user activity. One honest promoter would hold progress 50 and earn
        // tier 0 + tier 1 = 3000 ether.
        uint256 honestCost = 3_000 ether;
        emit log_named_uint("honest promoter cost ", honestCost);

        assertEq(extracted, sybils * 1_000 ether, "each wallet re-earned the bottom rung");
        assertGt(extracted, honestCost, "sybil farming beats the honest path");

        assertEq(token.balanceOf(address(vault)), pooledBefore - extracted, "drawn from escrow");
    }

    function test_FullAttackScenarioFails() public {
        // 1. KOL joins, generates link
        vm.prank(kol);
        bytes32 promoterId = campaign.join();

        // 2. User signs the Touch
        _touch(kol, user, promoterId);

        // 3. Progress accrues, tier 1 crosses
        vm.prank(project);
        campaign.reportUserAction(0, user, 10, "");

        uint256 balanceAfterTier1 = token.balanceOf(kol);
        assertEq(balanceAfterTier1, 1_000 ether, "tier 1 paid once");

        // 4. KOL attempts to "cancel link" — no such function exists, so skip

        // 5. KOL attempts to rejoin to generate a "new link"
        vm.prank(kol);
        vm.expectRevert(Campaign.AlreadyJoined.selector);
        campaign.join();

        // Attack blocked. Even if the above succeeded, the promoterId would be identical (layer 2)
        // and progress would remain at 10 (layer 4), so re-reporting 10 would be a no-op at
        // Campaign.sol:316 (delta == 0).
    }

    /// @notice Even if attribution expires, settled tiers stay settled.
    /// @dev A Touch expires after `maxTouchDuration`, but that only stops *new* progress from
    ///      being attributed to this KOL. It does not reset already-settled tiers.
    function test_ExpiredAttributionDoesNotResetProgress() public {
        vm.prank(kol);
        bytes32 promoterId = campaign.join();

        _touch(kol, user, promoterId);

        vm.prank(project);
        campaign.reportUserAction(0, user, 10, "");

        assertEq(campaign.progressOf(kol, 0), 10);
        assertEq(campaign.settledTiersOf(kol, 0), 1);

        // Warp past the Touch expiry
        vm.warp(block.timestamp + MAX_TOUCH + 1);

        // Attribution is now stale: activePromoter returns bytes32(0)
        bytes32 active = attribution.activePromoter(address(campaign), user);
        assertEq(active, bytes32(0), "touch expired");

        // But the KOL's progress and settled tiers are unchanged
        assertEq(campaign.progressOf(kol, 0), 10, "progress persists after expiry");
        assertEq(campaign.settledTiersOf(kol, 0), 1, "settled tiers persist after expiry");

        // Future progress for this user would go unattributed (NoAttribution revert), not to a
        // different KOL, because the user would need to sign a fresh Touch.
    }

    function _touch(address promoter, address signer, bytes32 promoterId) internal {
        IAttributionRegistry.Touch memory t = IAttributionRegistry.Touch({
            campaign: address(campaign),
            promoterId: promoterId,
            signedAt: uint64(block.timestamp),
            expiresAt: uint64(block.timestamp) + 7 days
        });

        bytes32 structHash = keccak256(
            abi.encode(attribution.TOUCH_TYPEHASH(), t.campaign, t.promoterId, t.signedAt, t.expiresAt)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", attribution.DOMAIN_SEPARATOR(), structHash));

        // Sign as the user with userPk
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userPk, digest);
        attribution.storeTouch(signer, t, abi.encodePacked(r, s, v), promoter);
    }
}
