// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IAttestationVerifier} from "../interfaces/IAttestationVerifier.sol";

/// @title AttestationVerifier
/// @notice Verifies k-of-n threshold attestations about a wallet, signed off-chain by a
///         registered attestor set.
/// @dev Roadmap phase 1 runs with a single attestor (`threshold = 1`); phase 2 raises the
///      threshold and adds attestors, with no redeploy required.
///
///      Security properties:
///      - EIP-712 domain binding (chain id + this contract) prevents cross-chain and
///        cross-deployment replay. OZ's `EIP712` recomputes the separator after a fork.
///      - Sequential per-attestor nonces make each signature single-use.
///      - Distinct-signer enforcement stops one attestor satisfying a k>1 threshold by
///        submitting several signatures with consecutive nonces.
///      - `ECDSA.tryRecover` rejects malleable (high-s) signatures and never returns
///        `address(0)` as a valid signer.
contract AttestationVerifier is IAttestationVerifier, EIP712, Ownable {
    error LengthMismatch();
    error BelowThreshold(uint256 provided, uint256 required);
    error TooManyAttestations();
    error AttestationMismatch(uint256 index);
    error AttestationExpired(uint256 index);
    error NotAnAttestor(address attestor);
    error DuplicateAttestor(address attestor);
    error InvalidNonce(address attestor, uint256 expected, uint256 provided);
    error InvalidSignature(uint256 index);
    error InvalidThreshold(uint256 threshold, uint256 attestorCount);
    error ZeroAddress();

    bytes32 public constant ATTESTATION_TYPEHASH = keccak256(
        "Attestation(address attestor,address subject,bytes32 schemaId,uint256 value,uint256 nonce,uint64 expiresAt,bytes32 data)"
    );

    /// @dev Bounds the O(n^2) distinctness scan.
    uint256 public constant MAX_ATTESTATIONS = 16;

    /// @inheritdoc IAttestationVerifier
    uint256 public threshold;

    /// @notice Number of currently active attestors.
    uint256 public attestorCount;

    /// @inheritdoc IAttestationVerifier
    mapping(address => bool) public isAttestor;

    /// @inheritdoc IAttestationVerifier
    mapping(address => uint256) public nonces;

    constructor(address admin, address initialAttestor) EIP712("Boney Attestations", "1") Ownable(admin) {
        if (admin == address(0) || initialAttestor == address(0)) revert ZeroAddress();
        isAttestor[initialAttestor] = true;
        attestorCount = 1;
        threshold = 1;
        emit AttestorAdded(initialAttestor);
        emit ThresholdSet(1);
    }

    /// @inheritdoc IAttestationVerifier
    function setAttestor(address attestor, bool active) external onlyOwner {
        if (attestor == address(0)) revert ZeroAddress();
        if (isAttestor[attestor] == active) return;

        isAttestor[attestor] = active;
        if (active) {
            attestorCount += 1;
            emit AttestorAdded(attestor);
        } else {
            uint256 newCount = attestorCount - 1;
            // Never let the set shrink below the threshold: that would brick verification.
            if (newCount < threshold) revert InvalidThreshold(threshold, newCount);
            attestorCount = newCount;
            emit AttestorRemoved(attestor);
        }
    }

    /// @inheritdoc IAttestationVerifier
    function setThreshold(uint256 newThreshold) external onlyOwner {
        if (newThreshold == 0 || newThreshold > attestorCount) {
            revert InvalidThreshold(newThreshold, attestorCount);
        }
        threshold = newThreshold;
        emit ThresholdSet(newThreshold);
    }

    /// @inheritdoc IAttestationVerifier
    function verifyAttestations(
        address subject,
        bytes32 schemaId,
        uint256 value,
        Attestation[] calldata attestations,
        bytes[] calldata signatures
    ) external returns (bytes32 attestationId) {
        uint256 n = attestations.length;
        if (n != signatures.length) revert LengthMismatch();
        if (n > MAX_ATTESTATIONS) revert TooManyAttestations();

        uint256 required = threshold;
        if (n < required) revert BelowThreshold(n, required);

        bytes32 acc;
        for (uint256 i; i < n; ++i) {
            Attestation calldata a = attestations[i];

            // The signed payload must be about exactly what the caller claims.
            if (a.subject != subject || a.schemaId != schemaId || a.value != value) {
                revert AttestationMismatch(i);
            }
            if (a.expiresAt <= block.timestamp) revert AttestationExpired(i);
            if (!isAttestor[a.attestor]) revert NotAnAttestor(a.attestor);

            for (uint256 j; j < i; ++j) {
                if (attestations[j].attestor == a.attestor) revert DuplicateAttestor(a.attestor);
            }

            uint256 expected = nonces[a.attestor];
            if (a.nonce != expected) revert InvalidNonce(a.attestor, expected, a.nonce);

            bytes32 structHash = keccak256(
                abi.encode(
                    ATTESTATION_TYPEHASH,
                    a.attestor,
                    a.subject,
                    a.schemaId,
                    a.value,
                    a.nonce,
                    a.expiresAt,
                    a.data
                )
            );
            (address signer, ECDSA.RecoverError err,) =
                ECDSA.tryRecover(_hashTypedDataV4(structHash), signatures[i]);
            if (err != ECDSA.RecoverError.NoError || signer != a.attestor) revert InvalidSignature(i);

            nonces[a.attestor] = expected + 1;
            acc = keccak256(abi.encode(acc, structHash));
        }

        attestationId = keccak256(abi.encode(subject, schemaId, value, acc));
        emit AttestationVerified(attestationId);
    }

    /// @inheritdoc IAttestationVerifier
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }
}
