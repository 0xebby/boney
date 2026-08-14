// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IAttributionRegistry} from "../interfaces/IAttributionRegistry.sol";

/// @dev The one thing this registry reads back from a campaign. Declared locally, and read through
///      a low-level staticcall rather than a typed call, so the registry keeps working for
///      registrants that are not campaigns at all — see `_effectiveMaxDuration`.
interface ICampaignWindow {
    /// @notice The campaign's configured attribution horizon, in seconds.
    function attributionWindow() external view returns (uint64);
}

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

    /// @notice EIP-712 type hash for `Touch`. Exposed so wallets and frontends can build the
    ///         digest a user signs without duplicating the struct definition.
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

    /// @notice Deploys the attribution registry with a maximum touch duration.
    /// @param maxTouchDuration_ Longest attribution horizon a single touch may claim.
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

        // The campaign's own window binds here, not just in the client that builds the touch.
        uint64 maxExpiresAt = nowTs + _effectiveMaxDuration(touch.campaign);
        if (touch.expiresAt > maxExpiresAt) {
            revert TouchTooLong(touch.expiresAt, maxExpiresAt);
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
    function effectiveMaxDuration(address campaign) external view returns (uint64) {
        return _effectiveMaxDuration(campaign);
    }

    /// @dev The horizon a touch for `campaign` may actually claim: the campaign's own
    ///      `attributionWindow`, floored by this registry's global `maxTouchDuration`.
    ///
    ///      Read through a low-level staticcall rather than a typed interface call on purpose.
    ///      Registration is namespaced by registrant (see `registerPromoter`), so the registry
    ///      deliberately does not require a registrant to be a `Campaign` — a typed call would
    ///      revert on an EOA registrant and turn that documented independence into a hard
    ///      dependency. A target that does not answer simply has no window of its own, and the
    ///      global cap stands.
    ///
    ///      The global cap is a floor on the *max*, never bypassed: a campaign returning a huge
    ///      window still clamps to `maxTouchDuration`, so a hostile or buggy campaign contract
    ///      cannot widen its own horizon. It can only narrow it, which is the campaign's own
    ///      prerogative — `attributionWindow` is immutable and set at creation.
    function _effectiveMaxDuration(address campaign) private view returns (uint64) {
        (bool ok, bytes memory data) =
            campaign.staticcall(abi.encodeCall(ICampaignWindow.attributionWindow, ()));

        // A non-campaign returns no data; a conforming campaign returns exactly one word.
        if (!ok || data.length != 32) return maxTouchDuration;

        uint64 window = abi.decode(data, (uint64));
        // Campaign.sol rejects a zero window at construction, so zero here means "not a campaign"
        // rather than "no attribution allowed" — falling through to the cap keeps a decoding
        // surprise from bricking every touch for that address.
        if (window == 0 || window > maxTouchDuration) return maxTouchDuration;
        return window;
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

    function domain()
        external
        view
        returns (
            bytes1 fields,
            string memory name,
            string memory version,
            uint256 chainId,
            address verifyingContract,
            bytes32 salt,
            uint256[] memory extensions
        )
    {
        return eip712Domain();
    }
}
