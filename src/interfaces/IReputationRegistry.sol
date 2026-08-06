// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title IReputationRegistry
/// @notice Wallet-based reputation built from attested metrics (e.g. X followers, Kaito yaps,
///         ENS history). Projects see scores and attestation hashes, never social handles.
interface IReputationRegistry {
    /// @notice Emitted when a new metric becomes attestable.
    /// @param schemaId Stable id derived from the name.
    /// @param name Human-readable name (e.g. "X_FOLLOWERS").
    /// @param weight Initial contribution to the composite score.
    event SchemaRegistered(bytes32 indexed schemaId, string name, uint256 weight);

    /// @notice Emitted when a schema's weight changes, which retroactively reprices every score
    ///         that includes it. A weight of 0 retires the schema without erasing its data.
    /// @param schemaId The schema repriced.
    /// @param weight New weight.
    event SchemaWeightSet(bytes32 indexed schemaId, uint256 weight);

    /// @notice Emitted when a subject's value for a schema is recorded, replacing any prior value.
    /// @param subject Wallet the data is about.
    /// @param schemaId Metric attested.
    /// @param value The attested value.
    /// @param attestationId Id of the attestation, used to reject replays.
    event AttestationStored(
        address indexed subject, bytes32 indexed schemaId, uint256 value, bytes32 attestationId
    );

    /// @notice Register a reputation schema (a metric that can be attested).
    /// @param name Stable human-readable name (e.g. "X_FOLLOWERS").
    /// @param weight How much this schema contributes to the composite score. 0 disables it.
    function registerSchema(string calldata name, uint256 weight) external;

    /// @notice Set the weight of an existing schema. Callable only by the schema registrar.
    /// @param schemaId The schema to reweight.
    /// @param weight New contribution to the composite score. 0 disables the schema without
    ///        erasing data already attested against it.
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
    /// @param wallet The wallet to score.
    /// @return The weighted sum of the wallet's attested values.
    function scoreOf(address wallet) external view returns (uint256);

    /// @notice Whether `wallet`'s score meets `minScore`.
    /// @param wallet The wallet to check.
    /// @param minScore Bar to clear; 0 means everyone qualifies.
    /// @return True if the wallet's score is at or above `minScore`.
    function qualifies(address wallet, uint256 minScore) external view returns (bool);

    /// @notice Latest attested value of `schemaId` for `wallet`.
    /// @param wallet The wallet to query.
    /// @param schemaId The schema id.
    /// @return The attested value, or 0 if never attested.
    function valueOf(address wallet, bytes32 schemaId) external view returns (uint256);

    /// @notice Whether `schemaId` is a registered, enabled schema.
    /// @param schemaId The schema id.
    /// @return True if the schema exists and carries a non-zero weight.
    function isSchemaEnabled(bytes32 schemaId) external view returns (bool);

    /// @notice The schema registrar (may register schemas / set weights).
    /// @return The registrar address.
    function schemaRegistrar() external view returns (address);
}
