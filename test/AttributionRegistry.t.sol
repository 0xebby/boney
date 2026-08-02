// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {AttributionRegistry} from "../src/attribution/AttributionRegistry.sol";
import {IAttributionRegistry} from "../src/interfaces/IAttributionRegistry.sol";

contract AttributionRegistryTest is Test {
    AttributionRegistry internal attribution;

    uint64 internal constant MAX_DURATION = 30 days;

    address internal campaign = address(0xCA11);
    address internal otherCampaign = address(0xCA22);
    address internal promoter = address(0xC01);
    address internal relayer = address(0xBEEF);

    uint256 internal userPk = 0x5EED;
    uint256 internal strangerPk = 0xBADBEEF;
    address internal user;
    address internal stranger;

    bytes32 internal promoterId;
    bytes32 internal rivalId;

    function setUp() public {
        user = vm.addr(userPk);
        stranger = vm.addr(strangerPk);
        attribution = new AttributionRegistry(MAX_DURATION);
        vm.warp(1_000_000);

        promoterId = keccak256(abi.encode(campaign, promoter));
        rivalId = keccak256(abi.encode(campaign, address(0xC02)));

        vm.startPrank(campaign);
        attribution.registerPromoter(promoterId);
        attribution.registerPromoter(rivalId);
        vm.stopPrank();
    }

    // ── helpers ──────────────────────────────────────────────────

    function _touch(address campaign_, bytes32 id, uint64 expiresAt)
        internal
        pure
        returns (IAttributionRegistry.Touch memory)
    {
        return IAttributionRegistry.Touch({campaign: campaign_, promoterId: id, expiresAt: expiresAt});
    }

    function _sign(uint256 pk, IAttributionRegistry.Touch memory t) internal view returns (bytes memory) {
        bytes32 structHash =
            keccak256(abi.encode(attribution.TOUCH_TYPEHASH(), t.campaign, t.promoterId, t.expiresAt));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", attribution.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _storeTouch(uint256 pk, address signer, IAttributionRegistry.Touch memory t) internal {
        attribution.storeTouch(signer, t, _sign(pk, t), relayer);
    }

    // ── promoter registration ────────────────────────────────────

    function test_RegisterPromoter() public view {
        assertEq(attribution.campaignOf(promoterId), campaign);
    }

    function test_RegisterPromoter_idempotentForSameCampaign() public {
        vm.prank(campaign);
        attribution.registerPromoter(promoterId);
        assertEq(attribution.campaignOf(promoterId), campaign);
    }

    /// @dev A different campaign must not be able to hijack an existing promoter id.
    function test_RegisterPromoter_revertsCrossCampaignHijack() public {
        vm.prank(otherCampaign);
        vm.expectRevert(
            abi.encodeWithSelector(AttributionRegistry.PromoterAlreadyRegistered.selector, promoterId)
        );
        attribution.registerPromoter(promoterId);
    }

    function test_RegisterPromoter_revertsZeroId() public {
        vm.prank(campaign);
        vm.expectRevert(AttributionRegistry.ZeroPromoterId.selector);
        attribution.registerPromoter(bytes32(0));
    }

    // ── happy path ───────────────────────────────────────────────

    function test_StoreTouch() public {
        uint64 expiresAt = uint64(block.timestamp + 7 days);
        _storeTouch(userPk, user, _touch(campaign, promoterId, expiresAt));

        assertEq(attribution.activePromoter(campaign, user), promoterId);
    }

    function test_StoreTouch_isRelayable() public {
        uint64 expiresAt = uint64(block.timestamp + 7 days);
        IAttributionRegistry.Touch memory t = _touch(campaign, promoterId, expiresAt);
        bytes memory sig = _sign(userPk, t);

        // The promoter (not the user) pays gas; authority is the user's signature.
        vm.prank(promoter);
        attribution.storeTouch(user, t, sig, promoter);

        assertEq(attribution.activePromoter(campaign, user), promoterId);
    }

    // ── consent ──────────────────────────────────────────────────

    /// @dev The core anti-fraud property: a promoter cannot attribute a wallet it does not have
    ///      a signature from.
    function test_StoreTouch_revertsWithoutUserConsent() public {
        IAttributionRegistry.Touch memory t = _touch(campaign, promoterId, uint64(block.timestamp + 7 days));

        // Promoter signs on the user's behalf.
        bytes memory forged = _sign(strangerPk, t);

        vm.expectRevert(AttributionRegistry.InvalidSignature.selector);
        attribution.storeTouch(user, t, forged, relayer);

        assertEq(attribution.activePromoter(campaign, user), bytes32(0));
    }

    function test_StoreTouch_revertsMutatedPayload() public {
        IAttributionRegistry.Touch memory t = _touch(campaign, promoterId, uint64(block.timestamp + 7 days));
        bytes memory sig = _sign(userPk, t);

        // Relayer tries to redirect the signed touch to a rival promoter.
        t.promoterId = rivalId;

        vm.expectRevert(AttributionRegistry.InvalidSignature.selector);
        attribution.storeTouch(user, t, sig, relayer);
    }

    // ── expiry ───────────────────────────────────────────────────

    function test_ActivePromoter_expires() public {
        uint64 expiresAt = uint64(block.timestamp + 1 days);
        _storeTouch(userPk, user, _touch(campaign, promoterId, expiresAt));
        assertEq(attribution.activePromoter(campaign, user), promoterId);

        vm.warp(expiresAt);
        assertEq(attribution.activePromoter(campaign, user), bytes32(0), "expired at boundary");
    }

    function test_StoreTouch_revertsAlreadyExpired() public {
        uint64 expiresAt = uint64(block.timestamp);
        IAttributionRegistry.Touch memory t = _touch(campaign, promoterId, expiresAt);
        // Sign before `expectRevert`: `_sign` makes external view calls, which would otherwise
        // consume the expectation.
        bytes memory sig = _sign(userPk, t);

        vm.expectRevert(
            abi.encodeWithSelector(
                AttributionRegistry.TouchExpired.selector, expiresAt, uint64(block.timestamp)
            )
        );
        attribution.storeTouch(user, t, sig, relayer);
    }

    /// @dev A user must not be able to sign away attribution effectively forever.
    function test_StoreTouch_revertsBeyondMaxDuration() public {
        uint64 tooLong = uint64(block.timestamp) + MAX_DURATION + 1;
        IAttributionRegistry.Touch memory t = _touch(campaign, promoterId, tooLong);
        bytes memory sig = _sign(userPk, t);

        vm.expectRevert(
            abi.encodeWithSelector(
                AttributionRegistry.TouchTooLong.selector, tooLong, uint64(block.timestamp) + MAX_DURATION
            )
        );
        attribution.storeTouch(user, t, sig, relayer);
    }

    function test_StoreTouch_acceptsExactlyMaxDuration() public {
        uint64 atLimit = uint64(block.timestamp) + MAX_DURATION;
        _storeTouch(userPk, user, _touch(campaign, promoterId, atLimit));
        assertEq(attribution.activePromoter(campaign, user), promoterId);
    }

    // ── LAST_TOUCH ───────────────────────────────────────────────

    function test_LastTouchWins() public {
        _storeTouch(userPk, user, _touch(campaign, promoterId, uint64(block.timestamp + 7 days)));
        assertEq(attribution.activePromoter(campaign, user), promoterId);

        skip(1 days);
        _storeTouch(userPk, user, _touch(campaign, rivalId, uint64(block.timestamp + 7 days)));

        assertEq(attribution.activePromoter(campaign, user), rivalId, "newer touch replaces older");
    }

    /// @dev A replayed older signature still overwrites, which is the accepted LAST_TOUCH
    ///      trade-off: whoever relays most recently wins, and the user consented to both.
    function test_LastTouch_replayOfOlderSignatureOverwrites() public {
        IAttributionRegistry.Touch memory first =
            _touch(campaign, promoterId, uint64(block.timestamp + 7 days));
        bytes memory firstSig = _sign(userPk, first);

        attribution.storeTouch(user, first, firstSig, relayer);
        _storeTouch(userPk, user, _touch(campaign, rivalId, uint64(block.timestamp + 7 days)));
        assertEq(attribution.activePromoter(campaign, user), rivalId);

        attribution.storeTouch(user, first, firstSig, relayer);
        assertEq(attribution.activePromoter(campaign, user), promoterId);
    }

    // ── campaign scoping ─────────────────────────────────────────

    function test_StoreTouch_revertsUnregisteredPromoter() public {
        bytes32 unknown = keccak256("unknown-promoter");
        IAttributionRegistry.Touch memory t = _touch(campaign, unknown, uint64(block.timestamp + 1 days));
        bytes memory sig = _sign(userPk, t);

        vm.expectRevert(abi.encodeWithSelector(AttributionRegistry.PromoterNotRegistered.selector, unknown));
        attribution.storeTouch(user, t, sig, relayer);
    }

    /// @dev A promoter id from campaign A must not farm attribution inside campaign B.
    function test_StoreTouch_revertsCampaignMismatch() public {
        IAttributionRegistry.Touch memory t =
            _touch(otherCampaign, promoterId, uint64(block.timestamp + 1 days));
        bytes memory sig = _sign(userPk, t);

        vm.expectRevert(
            abi.encodeWithSelector(
                AttributionRegistry.PromoterCampaignMismatch.selector, promoterId, campaign, otherCampaign
            )
        );
        attribution.storeTouch(user, t, sig, relayer);
    }

    function test_AttributionIsPerCampaign() public {
        _storeTouch(userPk, user, _touch(campaign, promoterId, uint64(block.timestamp + 7 days)));

        assertEq(attribution.activePromoter(campaign, user), promoterId);
        assertEq(
            attribution.activePromoter(otherCampaign, user),
            bytes32(0),
            "no attribution leaks across campaigns"
        );
    }

    function test_AttributionIsPerUser() public {
        _storeTouch(userPk, user, _touch(campaign, promoterId, uint64(block.timestamp + 7 days)));

        assertEq(attribution.activePromoter(campaign, stranger), bytes32(0));
    }

    // ── input validation ─────────────────────────────────────────

    function test_StoreTouch_revertsZeroUser() public {
        IAttributionRegistry.Touch memory t = _touch(campaign, promoterId, uint64(block.timestamp + 1 days));
        bytes memory sig = _sign(userPk, t);

        vm.expectRevert(AttributionRegistry.ZeroAddress.selector);
        attribution.storeTouch(address(0), t, sig, relayer);
    }

    function test_StoreTouch_revertsZeroPromoterId() public {
        IAttributionRegistry.Touch memory t = _touch(campaign, bytes32(0), uint64(block.timestamp + 1 days));
        bytes memory sig = _sign(userPk, t);

        vm.expectRevert(AttributionRegistry.ZeroPromoterId.selector);
        attribution.storeTouch(user, t, sig, relayer);
    }

    function test_Constructor_revertsZeroWindow() public {
        vm.expectRevert(AttributionRegistry.ZeroWindow.selector);
        new AttributionRegistry(0);
    }

    // ── domain binding ───────────────────────────────────────────

    /// @dev A touch signed for one deployment must not verify against another (chain/contract
    ///      binding via EIP-712).
    function test_DomainSeparator_bindsDeployment() public {
        AttributionRegistry other = new AttributionRegistry(MAX_DURATION);
        vm.prank(campaign);
        other.registerPromoter(promoterId);

        assertTrue(attribution.DOMAIN_SEPARATOR() != other.DOMAIN_SEPARATOR());

        IAttributionRegistry.Touch memory t = _touch(campaign, promoterId, uint64(block.timestamp + 1 days));
        bytes memory sig = _sign(userPk, t);

        vm.expectRevert(AttributionRegistry.InvalidSignature.selector);
        other.storeTouch(user, t, sig, relayer);
    }

    // ── fuzz ─────────────────────────────────────────────────────

    function testFuzz_TouchLifecycle(uint64 ttl, uint64 elapsed) public {
        ttl = uint64(bound(ttl, 1, MAX_DURATION));
        elapsed = uint64(bound(elapsed, 0, MAX_DURATION * 2));

        uint64 expiresAt = uint64(block.timestamp) + ttl;
        _storeTouch(userPk, user, _touch(campaign, promoterId, expiresAt));

        uint64 checkAt = uint64(block.timestamp) + elapsed;
        vm.warp(checkAt);

        bytes32 active = attribution.activePromoter(campaign, user);
        if (checkAt < expiresAt) {
            assertEq(active, promoterId, "live before expiry");
        } else {
            assertEq(active, bytes32(0), "dead at/after expiry");
        }
    }
}
