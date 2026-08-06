// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IAttributionRegistry} from "../interfaces/IAttributionRegistry.sol";

/// @title AttributionRegistry
/// @notice Attributes end users to promoters within a campaign.
/// @dev Model: LAST_TOUCH. A promoter's tracking link encodes an opaque, campaign-bound
///      `promoterId`; the *end user* signs a `Touch` binding their wallet to that id, and anyone
///      (typically the promoter) relays it on-chain. A newer touch for the same user replaces an
///      older one, so the most recent promoter a user engaged with gets the credit.
///
///      This is the anti-abuse primitive: a promoter cannot attribute a wallet without that
///      wallet's consent, and consent expires — so a KOL who goes quiet loses attribution for
///      users who stop interacting.
///
///      Recency is taken from the signed `signedAt`, not from relay order. Relayers are the
///      promoters competing for the credit, so whoever transacts last would otherwise win: a
///      displaced promoter could re-submit the user's earlier signature and take the attribution
///      back without fresh consent. Ordering therefore has to live inside the signature, and a
///      touch only lands if it is strictly newer than the one already stored.
///
///      Promoter ids are registered by the campaign itself (`registerPromoter` is called by the
///      campaign when a KOL joins). Registration is namespaced by the registrant, so a touch is
///      only valid if the campaign named in the signed payload registered that id itself — a
///      promoter id from one campaign cannot be used to farm attribution in another, and no one
///      can deny a campaign an id by claiming it first.
contract AttributionRegistry is IAttributionRegistry, EIP712 {
    using ECDSA for bytes32;

    error ZeroAddress();
    error ZeroPromoterId();
    error TouchExpired(uint64 expiresAt, uint64 timestamp);
    error TouchTooLong(uint64 expiresAt, uint64 maxExpiresAt);
    error TouchNotYetValid(uint64 signedAt, uint64 timestamp);
    error TouchNotNewer(uint64 signedAt, uint64 storedSignedAt);
    error InvalidSignature();
    error PromoterNotRegistered(address campaign, bytes32 promoterId);
    error ZeroWindow();

    bytes32 public constant TOUCH_TYPEHASH =
        keccak256("Touch(address campaign,bytes32 promoterId,uint64 signedAt,uint64 expiresAt)");

    /// @notice Longest attribution horizon a single touch may claim. Prevents a user signing an
    ///         effectively permanent attribution, and bounds how stale a relayed touch can be.
    uint64 public immutable maxTouchDuration;

    /// @dev user => campaign => live touch.
    mapping(address => mapping(address => Touch)) private _touches;

    /// @dev campaign => promoterId => registered. Namespaced by registrant: an id claimed by a
    ///      non-campaign sits in that sender's own namespace, which no campaign ever reads.
    mapping(address => mapping(bytes32 => bool)) private _registered;

    constructor(uint64 maxTouchDuration_) EIP712("Boney Attribution", "1") {
        if (maxTouchDuration_ == 0) revert ZeroWindow();
        maxTouchDuration = maxTouchDuration_;
    }

    /// @inheritdoc IAttributionRegistry
    /// @dev `msg.sender` is the campaign. Permissionless and idempotent by design: a registration
    ///      only ever writes the caller's own namespace, so it can neither grant a non-campaign
    ///      anything readable nor block a campaign from registering the same id.
    function registerPromoter(bytes32 promoterId) external {
        if (promoterId == bytes32(0)) revert ZeroPromoterId();
        if (_registered[msg.sender][promoterId]) return;

        _registered[msg.sender][promoterId] = true;
        emit PromoterRegistered(msg.sender, promoterId);
    }

    /// @inheritdoc IAttributionRegistry
    function storeTouch(address user, Touch calldata touch, bytes calldata signature, address relayer)
        external
    {
        if (user == address(0) || touch.campaign == address(0)) revert ZeroAddress();
        if (touch.promoterId == bytes32(0)) revert ZeroPromoterId();

        uint64 nowTs = uint64(block.timestamp);
        if (touch.signedAt > nowTs) revert TouchNotYetValid(touch.signedAt, nowTs);
        if (touch.expiresAt <= nowTs) revert TouchExpired(touch.expiresAt, nowTs);
        if (touch.expiresAt > nowTs + maxTouchDuration) {
            revert TouchTooLong(touch.expiresAt, nowTs + maxTouchDuration);
        }

        // The campaign named in the signed payload must have registered the id itself.
        if (!_registered[touch.campaign][touch.promoterId]) {
            revert PromoterNotRegistered(touch.campaign, touch.promoterId);
        }

        bytes32 structHash = keccak256(
            abi.encode(TOUCH_TYPEHASH, touch.campaign, touch.promoterId, touch.signedAt, touch.expiresAt)
        );
        address recovered = _hashTypedDataV4(structHash).recover(signature);
        if (recovered != user) revert InvalidSignature();

        // LAST_TOUCH, ordered by the user's own clock. Replaying a superseded signature is a
        // no-op, so a displaced promoter cannot buy back attribution the user moved away.
        Touch storage prev = _touches[user][touch.campaign];
        if (touch.signedAt <= prev.signedAt) revert TouchNotNewer(touch.signedAt, prev.signedAt);

        _touches[user][touch.campaign] = touch;

        emit TouchStored(touch.campaign, user, touch.promoterId, touch.signedAt, touch.expiresAt, relayer);
    }

    /// @inheritdoc IAttributionRegistry
    function activePromoter(address campaign, address user) external view returns (bytes32) {
        Touch storage t = _touches[user][campaign];
        if (t.expiresAt <= block.timestamp) return bytes32(0);
        return t.promoterId;
    }

    /// @inheritdoc IAttributionRegistry
    function touchOf(address campaign, address user) external view returns (Touch memory) {
        return _touches[user][campaign];
    }

    /// @inheritdoc IAttributionRegistry
    function isRegistered(address campaign, bytes32 promoterId) external view returns (bool) {
        return _registered[campaign][promoterId];
    }

    /// @inheritdoc IAttributionRegistry
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }
}
