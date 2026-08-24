// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IAttributionRegistry} from "../interfaces/IAttributionRegistry.sol";
import {Types} from "../libraries/Types.sol";

/// @dev What this registry reads back from a campaign. Declared locally, and read through
///      low-level staticcalls rather than typed calls, so the registry keeps working for
///      registrants that are not campaigns at all — see `_effectiveMaxDuration`.
interface ICampaignWindow {
    /// @notice The campaign's configured attribution horizon, in seconds.
    function attributionWindow() external view returns (uint64);

    /// @notice Timestamp after which the campaign accepts no further reports.
    function endTime() external view returns (uint64);

    /// @notice The campaign's lifecycle state.
    function status() external view returns (Types.CampaignStatus);
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
///      Consent is also bounded to the campaign's life. A touch may only be created while the
///      campaign named in it can still accrue creditable work — see `_requireCampaignOpen`, which
///      is what keeps `Campaign`'s post-end attribution fallback from being farmable.
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

        // A touch records in-campaign work, so it cannot be created once the campaign can no
        // longer accrue any.
        _requireCampaignOpen(touch.campaign, nowTs);

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

        // Decoded as uint256, not uint64: `abi.decode` into the narrower type reverts on a dirty
        // upper word, which would let a registrant returning a full 32-byte value brick every touch
        // naming it. Comparing numerically instead means an oversized answer simply clamps to the cap,
        // which is the documented reading — see `_requireCampaignOpen` for the same decision.
        uint256 window = abi.decode(data, (uint256));
        // Campaign.sol rejects a zero window at construction, so zero here means "not a campaign"
        // rather than "no attribution allowed" — falling through to the cap keeps a decoding
        // surprise from bricking every touch for that address.
        if (window == 0 || window > maxTouchDuration) return maxTouchDuration;
        return uint64(window);
    }

    /// @dev Reverts unless `campaign` can still accrue creditable work.
    ///
    ///      Two bounds, and both are load-bearing. `endTime` catches a campaign whose window has
    ///      closed but which nobody has called `end()` on yet — reports are refused in that state,
    ///      but a touch stored there goes live the instant the permissionless `end()` lands. The
    ///      terminal-status check catches the opposite case: a project may `end()` early, and then
    ///      `block.timestamp` never reaches `endTime` at all.
    ///
    ///      Without both, `Campaign`'s post-end attribution fallback is a credit-stealing vector.
    ///      That fallback honours the stored touch during `CLAIM_GRACE` even when expired, so a
    ///      promoter who did nothing could have the user sign a fresh touch after the campaign was
    ///      over, displace the promoter who actually delivered them, and collect a withheld
    ///      report's payout. Bounding touch *creation* to the campaign's life is what makes that
    ///      fallback safe: the stored touch is not just the user's latest intent, it is their
    ///      latest intent from while the campaign was running.
    ///
    ///      Read through low-level staticcalls for the same reason as `_effectiveMaxDuration`: a
    ///      registrant need not be a `Campaign`, and one that answers neither call is simply
    ///      unbounded here rather than unusable.
    /// @param campaign The campaign named in the touch.
    /// @param nowTs The current block timestamp, narrowed once by the caller.
    function _requireCampaignOpen(address campaign, uint64 nowTs) private view {
        (bool okEnd, bytes memory endData) = campaign.staticcall(abi.encodeCall(ICampaignWindow.endTime, ()));
        if (okEnd && endData.length == 32) {
            // Decoded as uint256, not as the declared uint64, for the same reason `status` below is
            // not decoded as its enum: `abi.decode` into the narrower type reverts on a non-zero
            // upper word, so a registrant answering with a full 32-byte value could brick every touch
            // naming it — the opposite of the "answers neither call is simply unbounded" reading
            // above. Comparing numerically keeps an oversized answer merely far in the future, and
            // the error carries the full word so it cannot report a garbage endTime as a plausible one.
            uint256 end = abi.decode(endData, (uint256));
            // Campaign.sol rejects `endTime <= block.timestamp` at construction, so zero is "not a
            // campaign" rather than "already over" — the same reading as a zero window above.
            if (end != 0 && uint256(nowTs) > end) revert CampaignOver(end, nowTs);
        }

        (bool okStatus, bytes memory statusData) =
            campaign.staticcall(abi.encodeCall(ICampaignWindow.status, ()));
        if (okStatus && statusData.length == 32) {
            // Decoded as uint256, not as the enum: `abi.decode` into an enum panics on an
            // out-of-range value, which would let a hostile campaign brick every touch naming it.
            // Comparing numerically instead means any unknown value above the terminal ones fails
            // closed, and `Ended`/`Cancelled` are the last two members by construction. The error
            // carries the full word for the same reason — a truncated one could report a garbage
            // status as `Pending`.
            uint256 state = abi.decode(statusData, (uint256));
            if (state >= uint256(Types.CampaignStatus.Ended)) revert CampaignTerminal(state);
        }
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
