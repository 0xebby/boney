// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title IReputationRegistry
/// @notice Wallet-based reputation built from attested metrics (e.g. X followers, Kaito yaps,
///         ENS history). Projects see scores and attestation hashes, never social handles.
interface IReputationRegistry {
    event SchemaRegistered(bytes32 indexed schemaId, string name, uint256 weight);
    event SchemaWeightSet(bytes32 indexed schemaId, uint256 weight);
    event AttestationStored(
        address indexed subject, bytes32 indexed schemaId, uint256 value, bytes32 attestationId
    );

    /// @notice Register a reputation schema (a metric that can be attested).
    /// @param name Stable human-readable name (e.g. "X_FOLLOWERS").
    /// @param weight How much this schema contributes to the composite score. 0 disables it.
    function registerSchema(string calldata name, uint256 weight) external;

    /// @notice Set the weight of an existing schema. Callable only by the schema registrar.
    function setSchemaWeight(bytes32 schemaId, uint256 weight) external;

    /// @notice Store an attested metric value for a wallet. Callable only by an attestor.
    /// @param subject The wallet the metric belongs to.
    /// @param schemaId Registered schema.
    /// @param value Attested value (already scaled; e.g. follower count).
    /// @param attestationId Unique id of the source attestation; prevents a single attestation
    ///        from being applied twice.
    function storeAttestation(address subject, bytes32 schemaId, uint256 value, bytes32 attestationId)
        external;

    /// @notice Composite reputation score for a wallet, computed from all schemas it has data for.
    function scoreOf(address wallet) external view returns (uint256);

    /// @notice Whether `wallet`'s score meets `minScore`.
    function qualifies(address wallet, uint256 minScore) external view returns (bool);

    /// @notice Latest attested value of `schemaId` for `wallet`.
    function valueOf(address wallet, bytes32 schemaId) external view returns (uint256);

    /// @notice Whether `schemaId` is a registered, enabled schema.
    function isSchemaEnabled(bytes32 schemaId) external view returns (bool);

    /// @notice The schema registrar (may register schemas / set weights).
    function schemaRegistrar() external view returns (address);
}
