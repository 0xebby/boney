// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title IAttestationVerifier
/// @notice Verifies k-of-n threshold attestations signed by a registered set of attestors.
/// @dev Phase 1 uses a single attestor (`threshold = 1`). The contract is threshold-ready so
///      moving to multi-attestor operation only requires `setThreshold`.
interface IAttestationVerifier {
    /// @notice Emitted when an attestor becomes authorized to sign.
    /// @param attestor The attestor added.
    event AttestorAdded(address indexed attestor);

    /// @notice Emitted when an attestor loses authorization.
    /// @param attestor The attestor removed.
    event AttestorRemoved(address indexed attestor);

    /// @notice Emitted when the signature threshold changes.
    /// @param threshold Signatures now required per attestation.
    event ThresholdSet(uint256 threshold);

    /// @notice Emitted when an attestation clears the threshold. Also the replay guard: an id that
    ///         has appeared here once cannot be accepted again.
    /// @param attestationId Id of the verified attestation.
    event AttestationVerified(bytes32 indexed attestationId);

    /// @notice Domain-separated attestation payload.
    /// @param attestor Must be the signer.
    /// @param subject The wallet the attested data is about.
    /// @param schemaId Stable id of the attested metric.
    /// @param value The attested value (e.g. follower count).
    /// @param nonce Replay counter; must be the signer's next nonce.
    /// @param expiresAt Must be in the future.
    /// @param data Optional payload hash (e.g. off-chain evidence). Not interpreted on-chain.
    struct Attestation {
        address attestor;
        address subject;
        bytes32 schemaId;
        uint256 value;
        uint256 nonce;
        uint64 expiresAt;
        bytes32 data;
    }

    /// @notice Add or remove an attestor. Callable only by the admin.
    /// @param attestor The attestor to activate or deactivate.
    /// @param active True to add, false to remove. Removal that would drop the attestor count
    ///        below the current threshold is rejected.
    function setAttestor(address attestor, bool active) external;

    /// @notice Set the required number of distinct signatures. Callable only by the admin.
    /// @param threshold New threshold; must be non-zero and no greater than the attestor count.
    function setThreshold(uint256 threshold) external;

    /// @notice Verify that `signatures` contains `threshold` distinct, valid, non-replayed
    ///         attestations for `subject`/`schemaId`/`value`. Consumes each signer's nonce.
    /// @param subject The wallet the attestations are about.
    /// @param schemaId Stable id of the attested metric.
    /// @param value The attested value; every attestation must agree on it.
    /// @param attestations The signed payloads, one per signature.
    /// @param signatures EIP-712 signatures, aligned to `attestations`.
    /// @return attestationId Unique id of the verified aggregate (may be used as a receipt).
    function verifyAttestations(
        address subject,
        bytes32 schemaId,
        uint256 value,
        Attestation[] calldata attestations,
        bytes[] calldata signatures
    ) external returns (bytes32 attestationId);

    /// @notice The domain separator over which attestations are signed.
    /// @return The EIP-712 domain separator.
    function DOMAIN_SEPARATOR() external view returns (bytes32);

    /// @notice Number of distinct attestor signatures a bundle must carry.
    /// @return The current threshold.
    function threshold() external view returns (uint256);

    /// @notice Whether `who` is an active attestor.
    /// @param who Address to check.
    /// @return True if the address may sign attestations.
    function isAttestor(address who) external view returns (bool);

    /// @notice Next expected nonce for `signer`.
    /// @param signer The attestor to query.
    /// @return The nonce their next signature must carry.
    function nonces(address signer) external view returns (uint256);
}
