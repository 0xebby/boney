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
///      Promoter ids are registered by the campaign itself (`registerPromoter` is called by the
///      campaign when a KOL joins). A touch naming an id that no campaign registered is rejected,
///      and the id is checked against the campaign in the signed payload, so a promoter id from
///      one campaign cannot be used to farm attribution in another.
contract AttributionRegistry is IAttributionRegistry, EIP712 {
    using ECDSA for bytes32;

    error ZeroAddress();
    error ZeroPromoterId();
    error TouchExpired(uint64 expiresAt, uint64 timestamp);
    error TouchTooLong(uint64 expiresAt, uint64 maxExpiresAt);
    error InvalidSignature();
    error PromoterNotRegistered(bytes32 promoterId);
    error PromoterCampaignMismatch(bytes32 promoterId, address expected, address provided);
    error PromoterAlreadyRegistered(bytes32 promoterId);
    error ZeroWindow();

    bytes32 public constant TOUCH_TYPEHASH =
        keccak256("Touch(address campaign,bytes32 promoterId,uint64 expiresAt)");

    /// @notice Longest attribution horizon a single touch may claim. Prevents a user signing an
    ///         effectively permanent attribution, and bounds how stale a relayed touch can be.
    uint64 public immutable maxTouchDuration;

    /// @dev user => campaign => live touch.
    mapping(address => mapping(address => Touch)) private _touches;

    /// @dev promoterId => campaign that registered it.
    mapping(bytes32 => address) private _campaignOf;

    constructor(uint64 maxTouchDuration_) EIP712("Boney Attribution", "1") {
        if (maxTouchDuration_ == 0) revert ZeroWindow();
        maxTouchDuration = maxTouchDuration_;
    }

    /// @inheritdoc IAttributionRegistry
    /// @dev `msg.sender` is the campaign. Permissionless by design: a non-campaign caller can
    ///      only ever bind ids under its own address, which no campaign will ever read.
    function registerPromoter(bytes32 promoterId) external {
        if (promoterId == bytes32(0)) revert ZeroPromoterId();
        address existing = _campaignOf[promoterId];
        if (existing != address(0)) {
            if (existing != msg.sender) revert PromoterAlreadyRegistered(promoterId);
            return; // idempotent re-registration by the same campaign
        }

        _campaignOf[promoterId] = msg.sender;
        emit PromoterRegistered(msg.sender, promoterId);
    }

    /// @inheritdoc IAttributionRegistry
    function storeTouch(address user, Touch calldata touch, bytes calldata signature, address relayer)
        external
    {
        if (user == address(0) || touch.campaign == address(0)) revert ZeroAddress();
        if (touch.promoterId == bytes32(0)) revert ZeroPromoterId();

        uint64 nowTs = uint64(block.timestamp);
        if (touch.expiresAt <= nowTs) revert TouchExpired(touch.expiresAt, nowTs);
        if (touch.expiresAt > nowTs + maxTouchDuration) {
            revert TouchTooLong(touch.expiresAt, nowTs + maxTouchDuration);
        }

        // The promoter id must belong to the campaign named in the signed payload.
        address boundCampaign = _campaignOf[touch.promoterId];
        if (boundCampaign == address(0)) revert PromoterNotRegistered(touch.promoterId);
        if (boundCampaign != touch.campaign) {
            revert PromoterCampaignMismatch(touch.promoterId, boundCampaign, touch.campaign);
        }

        bytes32 structHash =
            keccak256(abi.encode(TOUCH_TYPEHASH, touch.campaign, touch.promoterId, touch.expiresAt));
        address recovered = _hashTypedDataV4(structHash).recover(signature);
        if (recovered != user) revert InvalidSignature();

        // LAST_TOUCH: overwrite whatever attribution this user had for this campaign.
        _touches[user][touch.campaign] = touch;

        emit TouchStored(touch.campaign, user, touch.promoterId, touch.expiresAt, relayer);
    }

    /// @inheritdoc IAttributionRegistry
    function activePromoter(address campaign, address user) external view returns (bytes32) {
        Touch storage t = _touches[user][campaign];
        if (t.expiresAt <= block.timestamp) return bytes32(0);
        return t.promoterId;
    }

    /// @notice The live touch for a user in a campaign, expired or not.
    function touchOf(address campaign, address user) external view returns (Touch memory) {
        return _touches[user][campaign];
    }

    /// @inheritdoc IAttributionRegistry
    function campaignOf(bytes32 promoterId) external view returns (address) {
        return _campaignOf[promoterId];
    }

    /// @inheritdoc IAttributionRegistry
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }
}
