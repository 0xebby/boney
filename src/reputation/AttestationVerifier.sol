// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IAttestationVerifier} from "../interfaces/IAttestationVerifier.sol";

/// @title AttestationVerifier
/// @notice Verifies k-of-n threshold attestations about a wallet, signed off-chain by a
///         registered attestor set.
/// @dev Deploys with a single attestor and `threshold = 1`; the threshold and attestor set are
///      adjustable with no redeploy.
///
///      Enforced properties: EIP-712 domain binding against chain id and this contract; sequential
///      per-attestor nonces, so each signature is single-use; distinct signers, so one attestor
///      cannot satisfy a k>1 threshold alone; and `ECDSA.tryRecover`, which rejects malleable
///      signatures and never returns `address(0)` as a valid signer.
contract AttestationVerifier is IAttestationVerifier, EIP712, Ownable {
    /// @notice EIP-712 type hash for `Attestation`. Exposed so signers can build the digest
    ///         off-chain without duplicating the struct definition.
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

    /// @notice Deploys the verifier with a single attestor and a threshold of one.
    /// @dev The admin raises the threshold with `setThreshold` after adding attestors.
    /// @param admin Address that may manage the attestor set and the threshold.
    /// @param initialAttestor The first attestor, active immediately.
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
            // The set must not shrink below the threshold.
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

            // The signed payload must match what the caller claims.
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
