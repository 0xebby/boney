// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title IReputationRegistry
/// @notice Wallet-based reputation built from attested metrics (e.g. X followers, Kaito yaps,
///         ENS history). Projects see scores and attestation hashes, never social handles.
interface IReputationRegistry {
    /// @notice Emitted when a new metric becomes attestable.
    /// @param schemaId Stable id derived from the name.
    /// @param name Human-readable name (e.g. "FOLLOWERS").
    /// @param weight Initial contribution to the composite score.
    event SchemaRegistered(bytes32 indexed schemaId, string name, uint256 weight);

    /// @notice Emitted when a schema's weight changes, which retroactively reprices every score
    ///         that includes it. A weight of 0 retires the schema without erasing its data.
    /// @param schemaId The schema repriced.
    /// @param weight New weight.
    event SchemaWeightSet(bytes32 indexed schemaId, uint256 weight);

    /// @notice Emitted when a schema's freshness window changes, which retroactively re-scores every
    ///         wallet holding data for it — tightening the window can drop values out of scores
    ///         immediately, widening it can bring expired values back.
    /// @param schemaId The schema whose window changed.
    /// @param maxAge Seconds an attested value stays countable. 0 means it never expires.
    event SchemaMaxAgeSet(bytes32 indexed schemaId, uint64 maxAge);

    /// @notice Emitted when a schema's value ceiling changes, which changes the composite maximum
    ///         `maxScore` reports and therefore which `minReputation` gates a campaign may set.
    /// @param schemaId The schema whose ceiling changed.
    /// @param maxValue Largest value an attestor may report. 0 means unbounded.
    event SchemaMaxValueSet(bytes32 indexed schemaId, uint256 maxValue);

    /// @notice Emitted when a subject's value for a schema is recorded, replacing any prior value.
    /// @param subject Wallet the data is about.
    /// @param schemaId Metric attested.
    /// @param value The attested value.
    /// @param attestationId Id of the attestation, used to reject replays.
    event AttestationStored(
        address indexed subject, bytes32 indexed schemaId, uint256 value, bytes32 attestationId
    );

    /// @notice Register a reputation schema (a metric that can be attested).
    /// @param name Stable human-readable name (e.g. "FOLLOWERS").
    /// @param weight How much this schema contributes to the composite score. 0 disables it.
    function registerSchema(string calldata name, uint256 weight) external;

    /// @notice Set the weight of an existing schema. Callable only by the schema registrar.
    /// @param schemaId The schema to reweight.
    /// @param weight New contribution to the composite score. 0 disables the schema without
    ///        erasing data already attested against it.
    function setSchemaWeight(bytes32 schemaId, uint256 weight) external;

    /// @notice Set how long an attested value for `schemaId` keeps counting. Callable only by the
    ///         schema registrar.
    /// @dev Reputation is not a constant — an Ethos score moves with vouches and slashing, a
    ///      follower count moves when an account changes hands. The attestation's own `expiresAt`
    ///      only bounds when a bundle may be submitted, so without this a value attested once
    ///      counts forever. Schemas default to 0 (never expires) so registering one cannot silently
    ///      expire data; governance opts each metric in.
    /// @param schemaId The schema to set a freshness window on.
    /// @param maxAge Seconds a value stays countable after it is attested. 0 disables expiry.
    function setSchemaMaxAge(bytes32 schemaId, uint64 maxAge) external;

    /// @notice Set the largest value an attestor may report for `schemaId`. Callable only by the
    ///         schema registrar.
    /// @dev Without a bound the composite score has no maximum, so nothing can distinguish a
    ///      demanding `minReputation` from an impossible one. Bounding each weighted schema is
    ///      what makes `maxScore` meaningful, and therefore what lets `Campaign` reject a gate no
    ///      wallet could ever clear.
    ///
    ///      Enforced when a value is written, not when it is read, so lowering a ceiling leaves
    ///      existing records intact until they are re-attested.
    /// @param schemaId The schema to bound.
    /// @param maxValue Largest reportable value. 0 disables the bound.
    function setSchemaMaxValue(bytes32 schemaId, uint256 maxValue) external;

    /// @notice Highest composite score any wallet could attain under the current configuration.
    /// @dev The sum of `weight * maxValue` across weighted schemas. Returns `type(uint256).max`
    ///      when any weighted schema is unbounded, meaning no ceiling can be derived — callers must
    ///      treat that as "no constraint" rather than as a real maximum.
    ///
    ///      Not a constant: governance moves it with `setSchemaWeight`, `setSchemaMaxValue`, and
    ///      `registerSchema`. A consumer that stored a bound derived from this can therefore find
    ///      it out of date, which is why `Campaign` reads it at construction and treats the result
    ///      as a point-in-time check rather than a permanent guarantee.
    /// @return The maximum attainable score, or `type(uint256).max` if unbounded.
    function maxScore() external view returns (uint256);

    /// @notice Store an attested metric value for a wallet. Callable only by an attestor.
    /// @param subject The wallet the metric belongs to.
    /// @param schemaId Registered schema.
    /// @param value Attested value (already scaled; e.g. follower count).
    /// @param attestationId Unique id of the source attestation; prevents a single attestation
    ///        from being applied twice.
    function storeAttestation(address subject, bytes32 schemaId, uint256 value, bytes32 attestationId)
        external;

    /// @notice Composite reputation score for a wallet, computed from all schemas it has data for.
    /// @dev Counts only fresh values. A record older than its schema's `maxAge` is skipped, so this
    ///      can fall over time with no transaction touching the wallet. Do not cache it as a
    ///      constant, and do not assume it equals the sum of `valueOf` reads.
    /// @param wallet The wallet to score.
    /// @return The weighted sum of the wallet's attested values that are still within their
    ///         freshness windows.
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
