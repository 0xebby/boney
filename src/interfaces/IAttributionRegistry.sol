// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title IAttributionRegistry
/// @notice Tracks which promoter (KOL) gets credit for which end-user wallet, per campaign.
/// @dev Attribution is a user-signed touch: the end user signs a typed message binding their wallet
///      to a promoter id within a campaign, and a relayer submits it. Model is LAST_TOUCH, with
///      "newer" decided by the signed `signedAt` rather than relay order.
interface IAttributionRegistry {
    // ── errors ───────────────────────────────────────────────────

    error ZeroAddress();
    error ZeroPromoterId();
    error TouchExpired(uint64 expiresAt, uint64 timestamp);
    error TouchTooLong(uint64 expiresAt, uint64 maxExpiresAt);
    error TouchNotYetValid(uint64 signedAt, uint64 timestamp);
    error TouchNotNewer(uint64 signedAt, uint64 storedSignedAt);
    error InvalidSignature();
    error PromoterNotRegistered(address campaign, bytes32 promoterId);
    error ZeroWindow();
    /// @dev `endTime` is the full 32-byte word the campaign answered with, not a `uint64`, since it
    ///      comes from an untyped staticcall. Same for `CampaignTerminal`.
    error CampaignOver(uint256 endTime, uint64 timestamp);
    error CampaignTerminal(uint256 status);

    // ── events ───────────────────────────────────────────────────

    /// @notice Emitted when a promoter is issued their campaign-scoped attribution id.
    /// @param campaign The campaign they joined.
    /// @param promoterId The id issued.
    event PromoterRegistered(address indexed campaign, bytes32 indexed promoterId);

    /// @notice Emitted when a user signs attribution to a promoter. A later touch overwrites an
    ///         earlier one, so the most recent event for a `(campaign, user)` pair is the live one.
    /// @param campaign Campaign the touch applies to.
    /// @param user End user who signed.
    /// @param promoterId Promoter now credited for this user.
    /// @param signedAt When the user signed. Also the reference point for KPI lookback windows.
    /// @param expiresAt When the touch stops crediting.
    /// @param relayer Whoever submitted the signature, which is usually not the user.
    event TouchStored(
        address indexed campaign,
        address indexed user,
        bytes32 indexed promoterId,
        uint64 signedAt,
        uint64 expiresAt,
        address relayer
    );

    /// @notice Domain-separated typed data signed by the end user.
    /// @param campaign Campaign the user is engaging with.
    /// @param promoterId Opaque id of the promoter (KOL) the user endorses.
    /// @param signedAt Timestamp the user signed at. Orders touches against each other: a touch
    ///        must be strictly newer than the stored one to take effect. Must not be in the
    ///        future, so a single signature cannot claim precedence over every later touch.
    /// @param expiresAt Timestamp after which this touch must be ignored.
    struct Touch {
        address campaign;
        bytes32 promoterId;
        uint64 signedAt;
        uint64 expiresAt;
    }

    /// @notice Bind a promoter id under the calling campaign. Called by a campaign when a promoter
    ///         joins; touches naming an id the campaign has not registered are rejected.
    /// @dev Registration is namespaced by `msg.sender`, so registering an id grants nothing
    ///      outside the caller's own namespace and cannot deny it to anyone else.
    /// @param promoterId The campaign-bound promoter id to register.
    function registerPromoter(bytes32 promoterId) external;

    /// @notice Validate a user-signed touch and store the attribution mapping.
    /// @dev Refused once the named campaign is past its `endTime` or has reached a terminal status.
    /// @param user The end user (signer of `touch`).
    /// @param touch The attribution message.
    /// @param signature EIP-712 signature over `touch` by `user`.
    /// @param relayer The account credited for relaying the touch (may be the promoter).
    function storeTouch(address user, Touch calldata touch, bytes calldata signature, address relayer)
        external;

    /// @notice Which promoter currently holds attribution for `user` in `campaign`, if any.
    ///         Returns `bytes32(0)` when there is no live touch.
    /// @param campaign The campaign to query.
    /// @param user The end user.
    /// @return promoterId attributed promoter id, or `bytes32(0)` if none is live.
    function activePromoter(address campaign, address user) external view returns (bytes32 promoterId);

    /// @notice The stored touch for a user in a campaign, expired or not. Exposes `signedAt` so
    ///         verifier adapters can tell which actions predate the current attribution.
    /// @param campaign The campaign to query.
    /// @param user The end user.
    /// @return The stored touch; zero-valued if the user never signed one here.
    function touchOf(address campaign, address user) external view returns (Touch memory);

    /// @notice The longest horizon a touch for `campaign` may claim right now.
    /// @dev `min(campaign.attributionWindow, maxTouchDuration)`, falling back to the global cap for
    ///      a registrant that is not a campaign. This is the bound `storeTouch` enforces, so a
    ///      frontend should build `expiresAt` against this rather than the global cap alone.
    /// @param campaign The campaign the touch names.
    /// @return Seconds; add to the current timestamp for the maximum `expiresAt`.
    function effectiveMaxDuration(address campaign) external view returns (uint64);

    /// @notice Whether `campaign` has registered `promoterId` in its own namespace.
    /// @param campaign The registering campaign.
    /// @param promoterId The promoter id to check.
    /// @return True if the campaign registered that id.
    function isRegistered(address campaign, bytes32 promoterId) external view returns (bool);

    /// @notice Domain separator used for touch signatures.
    /// @return The EIP-712 domain separator.
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}
