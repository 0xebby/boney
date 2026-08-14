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

/// @title Attribution attack regressions
/// @notice Two exploits that used to work, exercised end-to-end through a real campaign so the
///         impact is measured in rewards rather than registry state. Both are now closed; these
///         tests exist to keep them closed.
///
///         1. Promoter-id squatting bricked `join()`. Ids are `keccak256(campaign, promoter)` and
///            so precomputable, and registration was global-first-writer-wins with no unregister
///            path — anyone could claim a KOL's slot from an EOA and lock them out permanently.
///            Fixed by namespacing registration under the registrant.
///
///         2. Stale-signature replay stole reward credit. A `Touch` carried no ordering field and
///            `storeTouch` overwrote unconditionally, so a displaced promoter could re-relay the
///            user's earlier signature and take the attribution back without fresh consent.
///            Fixed by ordering on the signed `signedAt`.
contract AttributionPoCTest is Test {
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
    address internal kol2 = address(0xC02);
    address internal attacker = address(0xBAD);

    uint256 internal userPk = 0x5EED;
    address internal user;

    function setUp() public {
        user = vm.addr(userPk);

        vm.warp(1_000_000);

        token = new MockToken();
        attribution = new AttributionRegistry(MAX_TOUCH);
        verifier = new AttestationVerifier(admin, admin);
        reputation = new ReputationRegistry(admin, address(verifier));

        vault = new EscrowVault(address(this));
        registry = new CampaignRegistry(address(vault), address(reputation), address(attribution), oracle);
        vault.setRegistrar(address(registry));

        campaign = _createCampaign();
    }

    // ── fixtures ─────────────────────────────────────────────────

    function _createCampaign() internal returns (Campaign) {
        Types.CampaignConfig memory cfg = Types.CampaignConfig({
            project: project,
            name: "Attribution PoC",
            token: address(token),
            rewardPool: POOL,
            startTime: uint64(block.timestamp),
            endTime: uint64(block.timestamp + 30 days),
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
        tiers[0] = new Types.RewardTier[](1);
        tiers[0][0] = Types.RewardTier({threshold: 10, reward: 1_000 ether});

        vm.prank(project);
        (, address addr) = registry.createCampaign(cfg, kpis, tiers);
        return Campaign(addr);
    }

    function _activate() internal {
        token.mint(project, POOL);
        vm.startPrank(project);
        token.approve(address(vault), POOL);
        vault.deposit(address(campaign), POOL);
        campaign.activate();
        vm.stopPrank();
    }

    function _signTouch(uint256 pk, bytes32 promoterId, uint64 signedAt, uint64 expiresAt)
        internal
        view
        returns (IAttributionRegistry.Touch memory t, bytes memory sig)
    {
        t = IAttributionRegistry.Touch({
            campaign: address(campaign),
            promoterId: promoterId,
            signedAt: signedAt,
            expiresAt: expiresAt
        });
        bytes32 structHash = keccak256(
            abi.encode(attribution.TOUCH_TYPEHASH(), t.campaign, t.promoterId, t.signedAt, t.expiresAt)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", attribution.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        sig = abi.encodePacked(r, s, v);
    }

    /// @dev Signs "now", the way a frontend would.
    function _signNow(uint256 pk, bytes32 promoterId, uint64 ttl)
        internal
        view
        returns (IAttributionRegistry.Touch memory, bytes memory)
    {
        return _signTouch(pk, promoterId, uint64(block.timestamp), uint64(block.timestamp) + ttl);
    }

    function _join(address promoter) internal returns (bytes32) {
        vm.prank(promoter);
        return campaign.join();
    }

    // ── 1. promoter-id squatting ─────────────────────────────────

    /// @dev Squatting a precomputed id from an EOA must not affect the campaign's own namespace.
    function test_SquattedPromoterIdDoesNotBlockJoin() public {
        _activate();

        bytes32 victimId = keccak256(abi.encode(address(campaign), kol));

        vm.prank(attacker);
        attribution.registerPromoter(victimId);

        // The squat lands only in the attacker's own namespace.
        assertTrue(attribution.isRegistered(attacker, victimId), "attacker's namespace");
        assertFalse(attribution.isRegistered(address(campaign), victimId), "campaign's is untouched");

        // The KOL joins regardless.
        vm.prank(kol);
        bytes32 id = campaign.join();

        assertEq(id, victimId);
        assertTrue(attribution.isRegistered(address(campaign), id), "registered by the campaign");
    }

    /// @dev The squat is inert for attribution too: a touch naming the campaign is checked against
    ///      the campaign's namespace, never the attacker's.
    function test_SquattedPromoterIdCannotAttribute() public {
        _activate();

        bytes32 victimId = keccak256(abi.encode(address(campaign), kol));

        vm.prank(attacker);
        attribution.registerPromoter(victimId);

        (IAttributionRegistry.Touch memory t, bytes memory sig) = _signNow(userPk, victimId, 7 days);

        vm.expectRevert(
            abi.encodeWithSelector(
                AttributionRegistry.PromoterNotRegistered.selector, address(campaign), victimId
            )
        );
        attribution.storeTouch(user, t, sig, attacker);
    }

    /// @dev Mass pre-squatting every prospective promoter is equally powerless.
    function test_MassSquattingDoesNotBlockJoins() public {
        _activate();

        address[] memory victims = new address[](3);
        victims[0] = kol;
        victims[1] = kol2;
        victims[2] = address(0xC03);

        for (uint256 i = 0; i < victims.length; i++) {
            vm.prank(attacker);
            attribution.registerPromoter(keccak256(abi.encode(address(campaign), victims[i])));
        }

        for (uint256 i = 0; i < victims.length; i++) {
            vm.prank(victims[i]);
            campaign.join();
        }
    }

    // ── 2. stale-signature replay ────────────────────────────────

    /// @dev The headline exploit: a displaced promoter re-relaying the user's earlier signature to
    ///      recapture attribution, and with it the tier reward.
    function test_ReplayedTouchCannotStealRewardCredit() public {
        _activate();

        bytes32 kolId = _join(kol);
        bytes32 kol2Id = _join(kol2);

        // 1. User endorses kol.
        (IAttributionRegistry.Touch memory first, bytes memory firstSig) = _signNow(userPk, kolId, 7 days);
        attribution.storeTouch(user, first, firstSig, kol);
        assertEq(attribution.activePromoter(address(campaign), user), kolId);

        // 2. User changes their mind and endorses kol2 instead.
        skip(1 days);
        (IAttributionRegistry.Touch memory second, bytes memory secondSig) = _signNow(userPk, kol2Id, 7 days);
        attribution.storeTouch(user, second, secondSig, kol2);
        assertEq(attribution.activePromoter(address(campaign), user), kol2Id, "user intent: kol2");

        // 3. kol replays the stale signature. Rejected — it is not newer than what is stored.
        vm.prank(kol);
        vm.expectRevert(
            abi.encodeWithSelector(
                AttributionRegistry.TouchNotNewer.selector, first.signedAt, second.signedAt
            )
        );
        attribution.storeTouch(user, first, firstSig, kol);

        assertEq(attribution.activePromoter(address(campaign), user), kol2Id, "attribution held");

        // 4. The user's activity pays kol2, as intended.
        vm.prank(project);
        campaign.reportUserAction(0, user, 10, "");

        assertEq(campaign.progressOf(kol2, 0), 10, "kol2 credited");
        assertEq(campaign.progressOf(kol, 0), 0, "kol gets nothing");
        assertEq(token.balanceOf(kol2), 1_000 ether, "kol2 paid the tier reward");
        assertEq(token.balanceOf(kol), 0);
    }

    /// @dev Replay stays dead however long the attacker waits, for the whole life of the stale
    ///      signature — not merely on the first attempt.
    function test_ReplayStaysRejectedForTheLifeOfTheSignature() public {
        _activate();

        bytes32 kolId = _join(kol);
        bytes32 kol2Id = _join(kol2);

        (IAttributionRegistry.Touch memory stale, bytes memory staleSig) = _signNow(userPk, kolId, 7 days);
        attribution.storeTouch(user, stale, staleSig, kol);

        skip(1 hours);
        (IAttributionRegistry.Touch memory fresh, bytes memory freshSig) = _signNow(userPk, kol2Id, 7 days);
        attribution.storeTouch(user, fresh, freshSig, kol2);

        for (uint256 i = 0; i < 3; i++) {
            skip(1 hours);

            vm.prank(kol);
            vm.expectRevert(
                abi.encodeWithSelector(
                    AttributionRegistry.TouchNotNewer.selector, stale.signedAt, fresh.signedAt
                )
            );
            attribution.storeTouch(user, stale, staleSig, kol);

            assertEq(attribution.activePromoter(address(campaign), user), kol2Id, "kol2 holds");
        }
    }

    /// @dev The fix must not cost the user their ability to change their mind back. Ordering is on
    ///      `signedAt`, so a genuinely fresh endorsement of the earlier promoter still lands.
    function test_UserCanStillReturnToAnEarlierPromoter() public {
        _activate();

        bytes32 kolId = _join(kol);
        bytes32 kol2Id = _join(kol2);

        (IAttributionRegistry.Touch memory a, bytes memory aSig) = _signNow(userPk, kolId, 7 days);
        attribution.storeTouch(user, a, aSig, kol);

        skip(1 days);
        (IAttributionRegistry.Touch memory b, bytes memory bSig) = _signNow(userPk, kol2Id, 7 days);
        attribution.storeTouch(user, b, bSig, kol2);
        assertEq(attribution.activePromoter(address(campaign), user), kol2Id);

        // A new signature, not the old one.
        skip(1 days);
        (IAttributionRegistry.Touch memory c, bytes memory cSig) = _signNow(userPk, kolId, 7 days);
        attribution.storeTouch(user, c, cSig, kol);

        assertEq(attribution.activePromoter(address(campaign), user), kolId, "back to kol");
    }

    /// @dev A future `signedAt` would be a signature that dominates every later touch forever, so
    ///      it must be rejected outright rather than merely ordered.
    function test_FutureSignedAtIsRejected() public {
        _activate();

        bytes32 kolId = _join(kol);

        uint64 future = uint64(block.timestamp) + 1;
        (IAttributionRegistry.Touch memory t, bytes memory sig) =
            _signTouch(userPk, kolId, future, uint64(block.timestamp) + 7 days);

        vm.expectRevert(
            abi.encodeWithSelector(
                AttributionRegistry.TouchNotYetValid.selector, future, uint64(block.timestamp)
            )
        );
        attribution.storeTouch(user, t, sig, kol);
    }
}
