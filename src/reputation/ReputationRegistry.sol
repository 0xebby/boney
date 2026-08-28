// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IReputationRegistry} from "../interfaces/IReputationRegistry.sol";
import {IAttestationVerifier} from "../interfaces/IAttestationVerifier.sol";

/// @title ReputationRegistry
/// @notice Wallet-based reputation assembled from attested metrics.
/// @dev Stores only `(wallet, schemaId) => value`; no social handles. Replays are rejected twice:
///      the verifier consumes a per-attestor nonce, and a previously seen `attestationId` is
///      refused here. Each schema carries a `maxAge`, and `scoreOf` skips records older than it.
contract ReputationRegistry is IReputationRegistry, Ownable {
    /// @notice Cap on registered schemas.
    /// @dev `scoreOf` iterates every schema, so the set is bounded.
    uint256 public constant MAX_SCHEMAS = 64;

    /// @notice A registered metric that can be attested against.
    /// @param name Stable human-readable name (e.g. "FOLLOWERS").
    /// @param weight Contribution to the composite score; 0 disables the schema without erasing
    ///        data already attested against it.
    /// @param maxAge Seconds an attested value stays countable. 0 means it never expires.
    /// @param exists Whether the schema has been registered. Distinguishes a disabled schema from
    ///        an unknown one, since both carry zero weight.
    /// @param maxValue Largest value an attestor may report for a schema. 0 means unbounded.
    struct Schema {
        string name;
        uint256 weight;
        uint64 maxAge;
        bool exists;
        /// @dev Largest value an attestor may report. 0 means unbounded — see `setSchemaMaxValue`.
        uint256 maxValue;
    }

    /// @notice The latest attested value for one `(wallet, schema)` pair.
    /// @param value The attested value.
    /// @param updatedAt When it was last attested.
    struct Record {
        uint256 value;
        uint64 updatedAt;
    }

    /// @notice Verifier used to authenticate attestation bundles.
    IAttestationVerifier public immutable verifier;

    /// @dev schemaId => schema definition.
    mapping(bytes32 => Schema) private _schemas;
    /// @dev Enumerable list of registered schema ids, for score computation.
    bytes32[] private _schemaIds;
    /// @dev wallet => schemaId => latest attested record.
    mapping(address => mapping(bytes32 => Record)) private _records;
    /// @dev Consumed attestation bundle ids.
    mapping(bytes32 => bool) public usedAttestations;

    /// @notice Deploys the reputation registry with a designated admin and verifier.
    /// @param admin Address that can register schemas and set weights.
    /// @param verifier_ Verifier used to authenticate attestation bundles.
    constructor(address admin, address verifier_) Ownable(admin) {
        if (admin == address(0) || verifier_ == address(0)) revert ZeroAddress();
        verifier = IAttestationVerifier(verifier_);
    }

    /// @inheritdoc IReputationRegistry
    function schemaRegistrar() external view returns (address) {
        return owner();
    }

    /// @notice Deterministic id for a schema name.
    /// @param name The schema name.
    /// @return The schema id derived from the name.
    function schemaId(string memory name) public pure returns (bytes32) {
        return keccak256(bytes(name));
    }

    /// @inheritdoc IReputationRegistry
    function registerSchema(string calldata name, uint256 weight) external onlyOwner {
        if (bytes(name).length == 0) revert EmptyName();
        if (_schemaIds.length >= MAX_SCHEMAS) revert TooManySchemas(MAX_SCHEMAS);
        bytes32 id = schemaId(name);
        if (_schemas[id].exists) revert SchemaAlreadyRegistered(id);

        // maxAge 0 == never expires; governance opts a schema in with setSchemaMaxAge.
        _schemas[id] = Schema({name: name, weight: weight, maxAge: 0, exists: true, maxValue: 0});
        _schemaIds.push(id);
        emit SchemaRegistered(id, name, weight);
    }

    /// @inheritdoc IReputationRegistry
    /// @dev Setting weight to 0 disables a schema's contribution without erasing attested data.
    function setSchemaWeight(bytes32 id, uint256 weight) external onlyOwner {
        if (!_schemas[id].exists) revert UnknownSchema(id);
        _schemas[id].weight = weight;
        emit SchemaWeightSet(id, weight);
    }

    /// @inheritdoc IReputationRegistry
    /// @dev Applies retroactively in both directions: lowering `maxAge` drops records out of scores
    ///      immediately, raising it brings expired records back.
    function setSchemaMaxAge(bytes32 id, uint64 maxAge) external onlyOwner {
        if (!_schemas[id].exists) revert UnknownSchema(id);
        _schemas[id].maxAge = maxAge;
        emit SchemaMaxAgeSet(id, maxAge);
    }

    /// @inheritdoc IReputationRegistry
    /// @dev Enforced on write only; values already stored are not shrunk. Re-attesting applies the
    ///      new bound. Defaults to 0 (unbounded) at registration.
    function setSchemaMaxValue(bytes32 id, uint256 maxValue) external onlyOwner {
        if (!_schemas[id].exists) revert UnknownSchema(id);
        _schemas[id].maxValue = maxValue;
        emit SchemaMaxValueSet(id, maxValue);
    }

    /// @notice Largest value an attestor may report for `id`. 0 means unbounded.
    /// @param id The schema id.
    /// @return The schema's value ceiling.
    function schemaMaxValue(bytes32 id) external view returns (uint256) {
        return _schemas[id].maxValue;
    }

    /// @inheritdoc IReputationRegistry
    /// @dev Returns `type(uint256).max` for "no knowable ceiling", which happens when any weighted
    ///      schema is unbounded or the arithmetic would overflow. Unweighted schemas are skipped.
    function maxScore() external view returns (uint256 max) {
        uint256 len = _schemaIds.length;
        for (uint256 i; i < len; ++i) {
            Schema storage s = _schemas[_schemaIds[i]];
            uint256 weight = s.weight;
            if (weight == 0) continue;
            uint256 cap = s.maxValue;
            if (cap == 0) return type(uint256).max;

            // Saturate rather than revert.
            unchecked {
                uint256 term = cap * weight;
                if (term / cap != weight) return type(uint256).max;
                uint256 next = max + term;
                if (next < max) return type(uint256).max;
                max = next;
            }
        }
    }

    /// @notice Verify an attestation bundle and store the attested value.
    /// @dev Permissionless: authority comes from the signatures, not the caller.
    /// @param subject The wallet the attested value belongs to.
    /// @param id Registered schema the value is attested against.
    /// @param value The attested value.
    /// @param attestations The attestation payloads, one per signature.
    /// @param signatures EIP-712 signatures, aligned to `attestations`.
    /// @return attestationId Unique id of the verified bundle, consumed to block replays.
    function submitAttestation(
        address subject,
        bytes32 id,
        uint256 value,
        IAttestationVerifier.Attestation[] calldata attestations,
        bytes[] calldata signatures
    ) external returns (bytes32 attestationId) {
        Schema storage s = _schemas[id];
        if (!s.exists) revert UnknownSchema(id);
        if (s.maxValue != 0 && value > s.maxValue) {
            revert ValueExceedsMax(id, value, s.maxValue);
        }

        attestationId = verifier.verifyAttestations(subject, id, value, attestations, signatures);
        if (usedAttestations[attestationId]) revert AttestationAlreadyUsed(attestationId);
        usedAttestations[attestationId] = true;

        _records[subject][id] = Record({value: value, updatedAt: uint64(block.timestamp)});
        emit AttestationStored(subject, id, value, attestationId);
    }

    /// @inheritdoc IReputationRegistry
    /// @dev Trusted owner path, for migrations and metrics sourced from on-chain history. Bound by
    ///      `maxValue` exactly as the signed path is.
    function storeAttestation(address subject, bytes32 id, uint256 value, bytes32 attestationId)
        external
        onlyOwner
    {
        Schema storage s = _schemas[id];
        if (!s.exists) revert UnknownSchema(id);
        if (s.maxValue != 0 && value > s.maxValue) {
            revert ValueExceedsMax(id, value, s.maxValue);
        }
        if (usedAttestations[attestationId]) revert AttestationAlreadyUsed(attestationId);
        usedAttestations[attestationId] = true;

        _records[subject][id] = Record({value: value, updatedAt: uint64(block.timestamp)});
        emit AttestationStored(subject, id, value, attestationId);
    }

    /// @inheritdoc IReputationRegistry
    /// @dev O(number of registered schemas). Records past their schema's `maxAge` are skipped, not
    ///      reverted on.
    function scoreOf(address wallet) public view returns (uint256 score) {
        uint256 len = _schemaIds.length;
        for (uint256 i; i < len; ++i) {
            bytes32 id = _schemaIds[i];
            Schema storage s = _schemas[id];
            uint256 weight = s.weight;
            if (weight == 0) continue;

            Record storage r = _records[wallet][id];
            if (_isStale(r.updatedAt, s.maxAge)) continue;

            score += r.value * weight;
        }
    }

    /// @notice Whether a record written at `updatedAt` has aged out of a `maxAge` window.
    /// @dev Subtracts rather than adding, so a large `maxAge` cannot overflow. A never-attested
    ///      record is stale, checked before `maxAge`.
    /// @param updatedAt When the record was written; 0 if never.
    /// @param maxAge The schema's freshness window; 0 means never expires.
    /// @return True when the record no longer counts.
    function _isStale(uint64 updatedAt, uint64 maxAge) private view returns (bool) {
        if (updatedAt == 0) return true;
        if (maxAge == 0) return false;
        return block.timestamp - updatedAt > maxAge;
    }

    /// @inheritdoc IReputationRegistry
    function qualifies(address wallet, uint256 minScore) external view returns (bool) {
        if (minScore == 0) return true;
        return scoreOf(wallet) >= minScore;
    }

    /// @inheritdoc IReputationRegistry
    function valueOf(address wallet, bytes32 id) external view returns (uint256) {
        return _records[wallet][id].value;
    }

    /// @notice When `wallet`'s value for `id` was last attested.
    /// @param wallet The wallet to query.
    /// @param id The schema id.
    /// @return Timestamp of the last update, or 0 if never attested.
    function updatedAtOf(address wallet, bytes32 id) external view returns (uint64) {
        return _records[wallet][id].updatedAt;
    }

    /// @notice Whether `wallet`'s value for `id` still counts toward `scoreOf`.
    /// @dev Distinct from "has a value": an aged-out record still reads non-zero from `valueOf`.
    /// @param wallet The wallet to query.
    /// @param id The schema id.
    /// @return True when the record is within its schema's `maxAge`, or the schema never expires.
    function isValueFresh(address wallet, bytes32 id) external view returns (bool) {
        return !_isStale(_records[wallet][id].updatedAt, _schemas[id].maxAge);
    }

    /// @notice When `wallet`'s value for `id` stops counting. 0 when it never expires or was never
    ///         attested.
    /// @param wallet The wallet to query.
    /// @param id The schema id.
    /// @return Unix timestamp the record goes stale at, or 0 if it never does.
    function expiresAtOf(address wallet, bytes32 id) external view returns (uint64) {
        uint64 updatedAt = _records[wallet][id].updatedAt;
        uint64 maxAge = _schemas[id].maxAge;
        if (maxAge == 0 || updatedAt == 0) return 0;
        return updatedAt + maxAge;
    }

    /// @inheritdoc IReputationRegistry
    function isSchemaEnabled(bytes32 id) external view returns (bool) {
        return _schemas[id].exists && _schemas[id].weight > 0;
    }

    /// @notice Full schema definition.
    /// @dev Fixed three-element tuple; callers destructure it positionally. `maxAge` and `maxValue`
    ///      have their own getters.
    /// @param id The schema id.
    /// @return name Human-readable schema name.
    /// @return weight Contribution to the composite score; 0 means disabled.
    /// @return exists Whether the schema is registered.
    function schemaInfo(bytes32 id) external view returns (string memory name, uint256 weight, bool exists) {
        Schema storage s = _schemas[id];
        return (s.name, s.weight, s.exists);
    }

    /// @notice How long an attested value for `id` keeps counting, in seconds. 0 means never expires.
    /// @param id The schema id.
    /// @return The schema's freshness window.
    function schemaMaxAge(bytes32 id) external view returns (uint64) {
        return _schemas[id].maxAge;
    }

    /// @notice Number of registered schemas.
    /// @return The schema count.
    function schemaCount() external view returns (uint256) {
        return _schemaIds.length;
    }

    /// @notice Registered schema id at `index`.
    /// @param index Position in the schema list.
    /// @return The schema id.
    function schemaIdAt(uint256 index) external view returns (bytes32) {
        return _schemaIds[index];
    }
}
