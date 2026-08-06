// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title IAttributionRegistry
/// @notice Tracks which promoter (KOL) gets credit for which end-user wallet, per campaign.
/// @dev Attribution is a user-signed touch: the end user signs a typed message binding their
///      wallet to a promoter id within a campaign. A relayer submits it; this contract stores
///      the mapping and its expiry. Model is LAST_TOUCH — a newer touch replaces an older one.
///
///      "Newer" is decided by the signed `signedAt`, never by relay order. Relayers are
///      adversarial promoters, so the order transactions land in says nothing about what the user
///      intended; only the timestamp inside the signature does.
interface IAttributionRegistry {
    event PromoterRegistered(address indexed campaign, bytes32 indexed promoterId);
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
    function registerPromoter(bytes32 promoterId) external;

    /// @notice Validate a user-signed touch and store the attribution mapping.
    /// @param user The end user (signer of `touch`).
    /// @param touch The attribution message.
    /// @param signature EIP-712 signature over `touch` by `user`.
    /// @param relayer The account credited for relaying the touch (may be the promoter).
    function storeTouch(address user, Touch calldata touch, bytes calldata signature, address relayer)
        external;

    /// @notice Which promoter currently holds attribution for `user` in `campaign`, if any.
    ///         Returns `bytes32(0)` when there is no live touch.
    function activePromoter(address campaign, address user) external view returns (bytes32);

    /// @notice The stored touch for a user in a campaign, expired or not. Exposes `signedAt` so
    ///         verifier adapters can tell which actions predate the current attribution.
    function touchOf(address campaign, address user) external view returns (Touch memory);

    /// @notice Whether `campaign` has registered `promoterId` in its own namespace.
    function isRegistered(address campaign, bytes32 promoterId) external view returns (bool);

    /// @notice Domain separator used for touch signatures.
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}
