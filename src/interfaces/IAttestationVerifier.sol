// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title IAttestationVerifier
/// @notice Verifies k-of-n threshold attestations signed by a registered set of attestors.
/// @dev Phase 1 uses a single attestor (`threshold = 1`). The contract is threshold-ready so
///      moving to multi-attestor operation only requires `setThreshold`.
interface IAttestationVerifier {
    event AttestorAdded(address indexed attestor);
    event AttestorRemoved(address indexed attestor);
    event ThresholdSet(uint256 threshold);
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
    function setAttestor(address attestor, bool active) external;

    /// @notice Set the required number of distinct signatures. Callable only by the admin.
    function setThreshold(uint256 threshold) external;

    /// @notice Verify that `signatures` contains `threshold` distinct, valid, non-replayed
    ///         attestations for `subject`/`schemaId`/`value`. Consumes each signer's nonce.
    /// @return attestationId Unique id of the verified aggregate (may be used as a receipt).
    function verifyAttestations(
        address subject,
        bytes32 schemaId,
        uint256 value,
        Attestation[] calldata attestations,
        bytes[] calldata signatures
    ) external returns (bytes32 attestationId);

    /// @notice The domain separator over which attestations are signed.
    function DOMAIN_SEPARATOR() external view returns (bytes32);

    function threshold() external view returns (uint256);

    function isAttestor(address who) external view returns (bool);

    /// @notice Next expected nonce for `signer`.
    function nonces(address signer) external view returns (uint256);
}
