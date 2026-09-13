// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IAttributionRegistry} from "../interfaces/IAttributionRegistry.sol";
import {Types} from "../libraries/Types.sol";

/// @dev What this registry reads back from a campaign. Read through low-level staticcalls rather than
///      typed calls, so registrants that are not campaigns still work.
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
/// @dev Model: LAST_TOUCH. The end user signs a `Touch` binding their wallet to a campaign-bound
///      `promoterId`, and anyone may relay it. Recency comes from the signed `signedAt`, not relay
///      order, and a touch only lands if it is strictly newer than the one stored.
///
///      Touches may only be created while the named campaign can still accrue creditable work, and
///      only for a `promoterId` that campaign registered itself. Registration is namespaced by
///      registrant.
///
///      Every touch is also appended to an append-only per-`(user, campaign)` history, which
///      `promoterAt` reads to say who held a user at a past block.
contract AttributionRegistry is IAttributionRegistry, EIP712 {
    using ECDSA for bytes32;

    /// @notice EIP-712 type hash for `Touch`. Exposed so wallets and frontends can build the
    ///         digest a user signs without duplicating the struct definition.
    bytes32 public constant TOUCH_TYPEHASH =
        keccak256("Touch(address campaign,bytes32 promoterId,uint64 signedAt,uint64 expiresAt)");

    /// @notice Maximum lifetime of a single attribution touch.
    uint64 public constant MAX_TOUCH_DURATION = 360 days;

    /// @notice Longest attribution horizon a single touch may claim. Prevents a user signing an
    ///         effectively permanent attribution, and bounds how stale a relayed touch can be.
    uint64 public immutable maxTouchDuration;

    /// @dev user => campaign => live touch.
    mapping(address => mapping(address => Touch)) private _touches;

    /// @dev user => campaign => every touch that ever landed, oldest first.
    mapping(address => mapping(address => TouchRecord[])) private _history;

    /// @dev campaign => promoterId => registered. Namespaced by registrant: an id claimed by a
    ///      non-campaign sits in that sender's own namespace, which no campaign ever reads.
    mapping(address => mapping(bytes32 => bool)) private _registered;

    /// @notice Deploys the attribution registry with a maximum touch duration.
    /// @param maxTouchDuration_ Longest attribution horizon a single touch may claim.
    constructor(uint64 maxTouchDuration_) EIP712("Boney Attribution", "1") {
        if (maxTouchDuration_ == 0) revert ZeroWindow();
        if (maxTouchDuration_ > MAX_TOUCH_DURATION) {
            revert TouchDurationTooLong(MAX_TOUCH_DURATION, maxTouchDuration_);
        }
        maxTouchDuration = maxTouchDuration_;
    }

    /// @inheritdoc IAttributionRegistry
    /// @dev `msg.sender` is the campaign. Permissionless and idempotent; a registration only writes
    ///      the caller's own namespace.
    function registerPromoter(bytes32 promoterId) external {
        if (promoterId == bytes32(0)) revert InvalidPromoterId();
        if (_registered[msg.sender][promoterId]) return;

        _registered[msg.sender][promoterId] = true;
        emit PromoterRegistered(msg.sender, promoterId);
    }

    /// @inheritdoc IAttributionRegistry
    function storeTouch(address user, Touch calldata touch, bytes calldata signature, address relayer)
        external
    {
        if (user == address(0) || touch.campaign == address(0)) revert ZeroAddress();
        if (touch.promoterId == bytes32(0)) revert InvalidPromoterId();

        uint64 nowTs = uint64(block.timestamp);
        if (touch.signedAt > nowTs) revert TouchNotYetValid(touch.signedAt, nowTs);
        if (touch.expiresAt <= nowTs) revert TouchExpired(touch.expiresAt, nowTs);

        // The campaign's own window binds here.
        uint64 maxExpiresAt = nowTs + _effectiveMaxDuration(touch.campaign);
        if (touch.expiresAt > maxExpiresAt) {
            revert TouchTooLong(touch.expiresAt, maxExpiresAt);
        }

        // A touch cannot be created once the campaign can no longer accrue creditable work.
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

        // LAST_TOUCH, ordered by the user's own clock. Replaying a superseded signature reverts.
        Touch storage prev = _touches[user][touch.campaign];
        if (touch.signedAt <= prev.signedAt) revert TouchNotNewer(touch.signedAt, prev.signedAt);

        // The promoter already holding a live touch cannot be re-attributed;
        // only a switch or a lapsed window admits a new one.
        if (prev.expiresAt > nowTs && touch.promoterId == prev.promoterId) {
            revert TouchAlreadyActive(prev.promoterId, prev.expiresAt);
        }

        _touches[user][touch.campaign] = touch;

        _history[user][touch.campaign].push(
            TouchRecord({
                promoterId: touch.promoterId,
                signedAt: touch.signedAt,
                expiresAt: touch.expiresAt,
                storedAtBlock: uint64(block.number)
            })
        );

        emit TouchStored(touch.campaign, user, touch.promoterId, touch.signedAt, touch.expiresAt, relayer);
    }

    /// @inheritdoc IAttributionRegistry
    function effectiveMaxDuration(address campaign) external view returns (uint64) {
        return _effectiveMaxDuration(campaign);
    }

    /// @dev The campaign's own `attributionWindow`, clamped to this registry's `maxTouchDuration`.
    /// @param campaign The campaign named in the touch.
    /// @return The longest horizon a touch for that campaign may claim.
    function _effectiveMaxDuration(address campaign) private view returns (uint64) {
        (bool ok, bytes memory data) =
            campaign.staticcall(abi.encodeCall(ICampaignWindow.attributionWindow, ()));

        // A non-campaign returns no data; a conforming campaign returns exactly one word.
        if (!ok || data.length != 32) return maxTouchDuration;

        // Decoded as uint256, not uint64, so a dirty upper word clamps to the cap instead of reverting.
        uint256 window = abi.decode(data, (uint256));
        // Zero means "not a campaign", not "no attribution allowed".
        if (window == 0 || window > maxTouchDuration) return maxTouchDuration;
        return uint64(window);
    }

    /// @dev Reverts unless `campaign` can still accrue creditable work. Checks both `endTime` and a
    ///      terminal status, since a campaign may be ended early or left past its window uncalled.
    /// @param campaign The campaign named in the touch.
    /// @param nowTs The current block timestamp, narrowed once by the caller.
    function _requireCampaignOpen(address campaign, uint64 nowTs) private view {
        (bool hasEnded, bytes memory endData) =
            campaign.staticcall(abi.encodeCall(ICampaignWindow.endTime, ()));
        if (hasEnded && endData.length == 32) {
            // Decoded as uint256, not uint64, so a dirty upper word reads as far-future not a revert.
            uint256 end = abi.decode(endData, (uint256));
            // Zero means "not a campaign", not "already over".
            if (end != 0 && uint256(nowTs) > end) revert CampaignOver(end, nowTs);
        }

        (bool okStatus, bytes memory statusData) =
            campaign.staticcall(abi.encodeCall(ICampaignWindow.status, ()));
        if (okStatus && statusData.length == 32) {
            // Decoded as uint256, not the enum, so an out-of-range value fails closed instead of
            // panicking. `Ended`/`Cancelled` are the last two members.
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
    function promoterAt(address campaign, address user, uint64 atBlock, uint64 atTimestamp)
        external
        view
        returns (bytes32)
    {
        return _promoterAt(_history[user][campaign], atBlock, atTimestamp);
    }

    /// @inheritdoc IAttributionRegistry
    function promotersAt(
        address campaign,
        address user,
        uint64[] calldata atBlocks,
        uint64[] calldata atTimestamps
    ) external view returns (bytes32[] memory promoterIds) {
        if (atBlocks.length != atTimestamps.length) {
            revert LengthMismatch(atBlocks.length, atTimestamps.length);
        }

        TouchRecord[] storage history = _history[user][campaign];
        promoterIds = new bytes32[](atBlocks.length);
        for (uint256 i; i < atBlocks.length; ++i) {
            promoterIds[i] = _promoterAt(history, atBlocks[i], atTimestamps[i]);
        }
    }

    /// @inheritdoc IAttributionRegistry
    function soleAttributionSince(address campaign, address user, uint64 sinceBlock)
        external
        view
        returns (bytes32)
    {
        TouchRecord[] storage history = _history[user][campaign];
        uint256 len = history.length;
        if (len == 0) return bytes32(0);

        // Any later stored touch is a boundary: a switch changes the payee, while a same-promoter
        // re-touch can only follow an expired attribution.
        if (len > 1 && history[len - 1].storedAtBlock > sinceBlock) return bytes32(0);
        return history[len - 1].promoterId;
    }

    /// @inheritdoc IAttributionRegistry
    function touchHistoryLength(address campaign, address user) external view returns (uint256) {
        return _history[user][campaign].length;
    }

    /// @inheritdoc IAttributionRegistry
    function touchHistoryAt(address campaign, address user, uint256 index)
        external
        view
        returns (TouchRecord memory)
    {
        return _history[user][campaign][index];
    }

    /// @dev Newest-first walk taking the first record already on chain before `atBlock`, which makes
    ///      a touch landing in the action's own block belong to the previous promoter.
    /// @param history The user's touch history for one campaign, oldest first.
    /// @param atBlock Block the action being attributed was observed in.
    /// @param atTimestamp Timestamp of that block.
    /// @return The promoter attributed then, or `bytes32(0)` if nobody was.
    function _promoterAt(TouchRecord[] storage history, uint64 atBlock, uint64 atTimestamp)
        private
        view
        returns (bytes32)
    {
        for (uint256 i = history.length; i > 0; --i) {
            TouchRecord storage record = history[i - 1];
            if (record.storedAtBlock >= atBlock) continue;
            if (atTimestamp >= record.expiresAt) return bytes32(0);
            return record.promoterId;
        }
        return bytes32(0);
    }

    /// @inheritdoc IAttributionRegistry
    function isRegistered(address campaign, bytes32 promoterId) external view returns (bool) {
        return _registered[campaign][promoterId];
    }

    /// @inheritdoc IAttributionRegistry
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @notice The EIP-712 domain this registry signs under.
    /// @return fields Bitmap of which domain fields are used.
    /// @return name Domain name.
    /// @return version Domain version.
    /// @return chainId Chain the domain is bound to.
    /// @return verifyingContract This registry's address.
    /// @return salt Domain salt; unused.
    /// @return extensions Domain extensions; unused.
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
