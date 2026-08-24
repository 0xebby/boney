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

    /// @dev A touch signed "now", the way a frontend would produce one.
    function _touch(address campaign_, bytes32 id, uint64 expiresAt)
        internal
        view
        returns (IAttributionRegistry.Touch memory)
    {
        return _touchAt(campaign_, id, uint64(block.timestamp), expiresAt);
    }

    function _touchAt(address campaign_, bytes32 id, uint64 signedAt, uint64 expiresAt)
        internal
        pure
        returns (IAttributionRegistry.Touch memory)
    {
        return IAttributionRegistry.Touch({
            campaign: campaign_,
            promoterId: id,
            signedAt: signedAt,
            expiresAt: expiresAt
        });
    }

    function _sign(uint256 pk, IAttributionRegistry.Touch memory t) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(attribution.TOUCH_TYPEHASH(), t.campaign, t.promoterId, t.signedAt, t.expiresAt)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", attribution.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _storeTouch(uint256 pk, address signer, IAttributionRegistry.Touch memory t) internal {
        attribution.storeTouch(signer, t, _sign(pk, t), relayer);
    }

    // ── promoter registration ────────────────────────────────────

    function test_RegisterPromoter() public view {
        assertTrue(attribution.isRegistered(campaign, promoterId));
    }

    function test_RegisterPromoter_idempotentForSameCampaign() public {
        vm.prank(campaign);
        attribution.registerPromoter(promoterId);
        assertTrue(attribution.isRegistered(campaign, promoterId));
    }

    /// @dev Registration is namespaced by the registrant, so claiming an id grants nothing in
    ///      anyone else's namespace — and, critically, cannot deny it to them either. Promoter ids
    ///      are `keccak256(campaign, promoter)` and therefore precomputable by anyone; a
    ///      first-writer-wins global map would let a squatter brick `Campaign.join()` outright.
    function test_RegisterPromoter_isNamespacedNotFirstComeFirstServed() public {
        vm.prank(otherCampaign);
        attribution.registerPromoter(promoterId);

        assertTrue(attribution.isRegistered(campaign, promoterId), "original binding intact");
        assertTrue(attribution.isRegistered(otherCampaign, promoterId), "squatter's own namespace");
    }

    /// @dev And the squatted id stays unusable for attribution against the real campaign.
    function test_RegisterPromoter_squatCannotAttributeElsewhere() public {
        bytes32 unclaimed = keccak256("not-yet-registered");

        vm.prank(address(0xBAD));
        attribution.registerPromoter(unclaimed);

        IAttributionRegistry.Touch memory t = _touch(campaign, unclaimed, uint64(block.timestamp + 1 days));
        bytes memory sig = _sign(userPk, t);

        vm.expectRevert(
            abi.encodeWithSelector(IAttributionRegistry.PromoterNotRegistered.selector, campaign, unclaimed)
        );
        attribution.storeTouch(user, t, sig, relayer);
    }

    function test_RegisterPromoter_revertsZeroId() public {
        vm.prank(campaign);
        vm.expectRevert(IAttributionRegistry.ZeroPromoterId.selector);
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

        vm.expectRevert(IAttributionRegistry.InvalidSignature.selector);
        attribution.storeTouch(user, t, forged, relayer);

        assertEq(attribution.activePromoter(campaign, user), bytes32(0));
    }

    function test_StoreTouch_revertsMutatedPayload() public {
        IAttributionRegistry.Touch memory t = _touch(campaign, promoterId, uint64(block.timestamp + 7 days));
        bytes memory sig = _sign(userPk, t);

        // Relayer tries to redirect the signed touch to a rival promoter.
        t.promoterId = rivalId;

        vm.expectRevert(IAttributionRegistry.InvalidSignature.selector);
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
                IAttributionRegistry.TouchExpired.selector, expiresAt, uint64(block.timestamp)
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
                IAttributionRegistry.TouchTooLong.selector, tooLong, uint64(block.timestamp) + MAX_DURATION
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

    /// @dev Relayers are the promoters competing for the credit, so relay order cannot be allowed
    ///      to decide recency: a displaced promoter would just re-submit the user's earlier
    ///      signature and take the attribution — and the rewards — back without fresh consent.
    ///      Ordering is on the signed `signedAt`, so a superseded signature is permanently dead.
    function test_LastTouch_replayOfOlderSignatureIsRejected() public {
        IAttributionRegistry.Touch memory first =
            _touch(campaign, promoterId, uint64(block.timestamp + 7 days));
        bytes memory firstSig = _sign(userPk, first);

        attribution.storeTouch(user, first, firstSig, relayer);

        skip(1 days);
        IAttributionRegistry.Touch memory second = _touch(campaign, rivalId, uint64(block.timestamp + 7 days));
        _storeTouch(userPk, user, second);
        assertEq(attribution.activePromoter(campaign, user), rivalId);

        vm.expectRevert(
            abi.encodeWithSelector(
                IAttributionRegistry.TouchNotNewer.selector, first.signedAt, second.signedAt
            )
        );
        attribution.storeTouch(user, first, firstSig, relayer);

        assertEq(attribution.activePromoter(campaign, user), rivalId, "attribution held");
    }

    /// @dev Re-relaying the *current* touch is equally a no-op — ordering is strict.
    function test_LastTouch_replayOfCurrentTouchIsRejected() public {
        IAttributionRegistry.Touch memory t = _touch(campaign, promoterId, uint64(block.timestamp + 7 days));
        bytes memory sig = _sign(userPk, t);

        attribution.storeTouch(user, t, sig, relayer);

        vm.expectRevert(
            abi.encodeWithSelector(IAttributionRegistry.TouchNotNewer.selector, t.signedAt, t.signedAt)
        );
        attribution.storeTouch(user, t, sig, relayer);
    }

    /// @dev Ordering must not cost the user the ability to change their mind back: a genuinely
    ///      fresh endorsement of an earlier promoter still wins.
    function test_LastTouch_userCanReturnToAnEarlierPromoter() public {
        _storeTouch(userPk, user, _touch(campaign, promoterId, uint64(block.timestamp + 7 days)));

        skip(1 days);
        _storeTouch(userPk, user, _touch(campaign, rivalId, uint64(block.timestamp + 7 days)));
        assertEq(attribution.activePromoter(campaign, user), rivalId);

        skip(1 days);
        _storeTouch(userPk, user, _touch(campaign, promoterId, uint64(block.timestamp + 7 days)));
        assertEq(attribution.activePromoter(campaign, user), promoterId, "back to the first promoter");
    }

    /// @dev A touch signed in the future would outrank every later touch for as long as it lived,
    ///      which is the same capture the ordering check exists to prevent.
    function test_StoreTouch_revertsFutureSignedAt() public {
        uint64 future = uint64(block.timestamp) + 1;
        IAttributionRegistry.Touch memory t =
            _touchAt(campaign, promoterId, future, uint64(block.timestamp + 7 days));
        bytes memory sig = _sign(userPk, t);

        vm.expectRevert(
            abi.encodeWithSelector(
                IAttributionRegistry.TouchNotYetValid.selector, future, uint64(block.timestamp)
            )
        );
        attribution.storeTouch(user, t, sig, relayer);
    }

    /// @dev Ordering is per user and per campaign, not global — one user's newer touch must not
    ///      shut another user out.
    function test_LastTouch_orderingIsScopedPerUser() public {
        skip(1 days);
        _storeTouch(userPk, user, _touch(campaign, promoterId, uint64(block.timestamp + 7 days)));

        // The stranger signs an older touch; it is still their first, so it lands.
        IAttributionRegistry.Touch memory older =
            _touchAt(campaign, rivalId, uint64(block.timestamp) - 1 hours, uint64(block.timestamp + 7 days));
        _storeTouch(strangerPk, stranger, older);

        assertEq(attribution.activePromoter(campaign, stranger), rivalId);
    }

    // ── campaign scoping ─────────────────────────────────────────

    function test_StoreTouch_revertsUnregisteredPromoter() public {
        bytes32 unknown = keccak256("unknown-promoter");
        IAttributionRegistry.Touch memory t = _touch(campaign, unknown, uint64(block.timestamp + 1 days));
        bytes memory sig = _sign(userPk, t);

        vm.expectRevert(
            abi.encodeWithSelector(IAttributionRegistry.PromoterNotRegistered.selector, campaign, unknown)
        );
        attribution.storeTouch(user, t, sig, relayer);
    }

    /// @dev A promoter id from campaign A must not farm attribution inside campaign B.
    function test_StoreTouch_revertsCampaignMismatch() public {
        IAttributionRegistry.Touch memory t =
            _touch(otherCampaign, promoterId, uint64(block.timestamp + 1 days));
        bytes memory sig = _sign(userPk, t);

        vm.expectRevert(
            abi.encodeWithSelector(
                IAttributionRegistry.PromoterNotRegistered.selector, otherCampaign, promoterId
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

        vm.expectRevert(IAttributionRegistry.ZeroAddress.selector);
        attribution.storeTouch(address(0), t, sig, relayer);
    }

    function test_StoreTouch_revertsZeroPromoterId() public {
        IAttributionRegistry.Touch memory t = _touch(campaign, bytes32(0), uint64(block.timestamp + 1 days));
        bytes memory sig = _sign(userPk, t);

        vm.expectRevert(IAttributionRegistry.ZeroPromoterId.selector);
        attribution.storeTouch(user, t, sig, relayer);
    }

    function test_Constructor_revertsZeroWindow() public {
        vm.expectRevert(IAttributionRegistry.ZeroWindow.selector);
        new AttributionRegistry(0);
    }

    // ── campaign window enforcement ──────────────────────────────

    /// @dev A campaign's `attributionWindow` is enforced by this registry, not merely honoured by
    ///      whichever client built the touch. Before this, `buildTouch` clamped to the campaign's
    ///      window but nothing stopped a promoter hand-rolling a touch for the full global cap, so
    ///      the window a project advertised was advisory.
    function test_EffectiveMax_campaignWindowBindsBelowTheGlobalCap() public {
        WindowStub c = new WindowStub(1 days);
        vm.prank(address(c));
        attribution.registerPromoter(promoterId);

        assertEq(attribution.effectiveMaxDuration(address(c)), 1 days, "campaign window wins");

        uint64 tooLong = uint64(block.timestamp) + 1 days + 1;
        IAttributionRegistry.Touch memory t = _touch(address(c), promoterId, tooLong);
        // Signed before `expectRevert`: `_sign` itself calls the registry, and expectRevert binds
        // to the next call of any kind.
        bytes memory sig = _sign(userPk, t);

        vm.expectRevert(
            abi.encodeWithSelector(
                IAttributionRegistry.TouchTooLong.selector, tooLong, uint64(block.timestamp) + 1 days
            )
        );
        attribution.storeTouch(user, t, sig, relayer);
    }

    function test_EffectiveMax_acceptsExactlyTheCampaignWindow() public {
        WindowStub c = new WindowStub(1 days);
        vm.prank(address(c));
        attribution.registerPromoter(promoterId);

        _storeTouch(userPk, user, _touch(address(c), promoterId, uint64(block.timestamp) + 1 days));
        assertEq(attribution.activePromoter(address(c), user), promoterId, "the boundary is inclusive");
    }

    /// @dev The global cap is a ceiling the campaign cannot raise. A hostile or buggy campaign
    ///      reporting a huge window still clamps, so this can only ever narrow a horizon.
    function test_EffectiveMax_campaignCannotExceedTheGlobalCap() public {
        WindowStub c = new WindowStub(type(uint64).max);
        vm.prank(address(c));
        attribution.registerPromoter(promoterId);

        assertEq(attribution.effectiveMaxDuration(address(c)), MAX_DURATION, "clamped to the cap");

        uint64 tooLong = uint64(block.timestamp) + MAX_DURATION + 1;
        IAttributionRegistry.Touch memory t = _touch(address(c), promoterId, tooLong);
        bytes memory sig = _sign(userPk, t);

        vm.expectRevert(
            abi.encodeWithSelector(
                IAttributionRegistry.TouchTooLong.selector, tooLong, uint64(block.timestamp) + MAX_DURATION
            )
        );
        attribution.storeTouch(user, t, sig, relayer);
    }

    /// @dev Registration is namespaced by registrant and deliberately does not require a campaign
    ///      contract, so a target that cannot answer must fall back to the global cap rather than
    ///      reverting. An EOA registrant is the case every other test in this file relies on.
    function test_EffectiveMax_fallsBackForANonCampaign() public view {
        assertEq(attribution.effectiveMaxDuration(campaign), MAX_DURATION, "EOA falls back");
        assertEq(attribution.effectiveMaxDuration(address(0xDEAD)), MAX_DURATION, "unknown falls back");
    }

    /// @dev A contract at the address that does not expose `attributionWindow()` is the same case
    ///      as an EOA — no window of its own, so the global cap stands.
    function test_EffectiveMax_fallsBackForANonConformingContract() public {
        NoWindowStub c = new NoWindowStub();
        assertEq(attribution.effectiveMaxDuration(address(c)), MAX_DURATION, "no window, global cap");
    }

    /// @dev Zero cannot mean "no attribution allowed": `Campaign` rejects a zero window at
    ///      construction, so a zero here is a decoding surprise, and bricking every touch for that
    ///      campaign would be a worse failure than falling through to the cap.
    function test_EffectiveMax_zeroWindowFallsBackRatherThanBricking() public {
        WindowStub c = new WindowStub(0);
        vm.prank(address(c));
        attribution.registerPromoter(promoterId);

        assertEq(attribution.effectiveMaxDuration(address(c)), MAX_DURATION, "zero falls back");
        _storeTouch(userPk, user, _touch(address(c), promoterId, uint64(block.timestamp) + 1 days));
        assertEq(attribution.activePromoter(address(c), user), promoterId, "touches still work");
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

        vm.expectRevert(IAttributionRegistry.InvalidSignature.selector);
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

/// @dev Minimal stand-in for a `Campaign`, exposing only the one function the registry reads back.
contract WindowStub {
    uint64 public attributionWindow;

    constructor(uint64 window) {
        attributionWindow = window;
    }
}

/// @dev A contract that is not a campaign at all — the registry must tolerate it, since promoter
///      registration is namespaced by registrant and never required a campaign.
contract NoWindowStub {}
