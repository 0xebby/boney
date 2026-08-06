// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IReputationRegistry} from "../interfaces/IReputationRegistry.sol";
import {IAttestationVerifier} from "../interfaces/IAttestationVerifier.sol";

/// @title ReputationRegistry
/// @notice Wallet-based reputation assembled from attested metrics.
/// @dev Privacy model: this contract stores only `(wallet, schemaId) => value`. Social handles
///      never touch the chain — the attestor sees them off-chain and signs a number. Projects
///      read `scoreOf` / `qualifies`, so a KOL proves they clear a bar without revealing which
///      accounts back it.
///
///      Anti-replay is layered: the AttestationVerifier consumes a per-attestor nonce, and this
///      contract additionally rejects a previously seen `attestationId`, so the same verified
///      bundle cannot be applied twice even if routed through a different caller.
contract ReputationRegistry is IReputationRegistry, Ownable {
    error UnknownSchema(bytes32 schemaId);
    error SchemaDisabled(bytes32 schemaId);
    error SchemaAlreadyRegistered(bytes32 schemaId);
    error AttestationAlreadyUsed(bytes32 attestationId);
    error StaleValue(uint256 storedAt, uint256 incomingAt);
    error ZeroAddress();
    error EmptyName();
    error TooManySchemas(uint256 max);

    /// @notice Cap on registered schemas.
    /// @dev `scoreOf` iterates every schema and is called from `Campaign.join()`. An unbounded
    ///      schema set would let governance make joining prohibitively expensive, or impossible.
    ///      Schemas are governance-controlled and few in practice; this is a backstop.
    uint256 public constant MAX_SCHEMAS = 64;

    /// @notice A registered metric that can be attested against.
    /// @param name Stable human-readable name (e.g. "X_FOLLOWERS").
    /// @param weight Contribution to the composite score; 0 disables the schema without erasing
    ///        data already attested against it.
    /// @param exists Whether the schema has been registered. Distinguishes a disabled schema from
    ///        an unknown one, since both carry zero weight.
    struct Schema {
        string name;
        uint256 weight;
        bool exists;
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

        _schemas[id] = Schema({name: name, weight: weight, exists: true});
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

    /// @notice Verify an attestation bundle and store the attested value.
    /// @dev Permissionless to call: authority comes from the signatures, not the caller. This is
    ///      what lets a KOL (or a relayer) submit their own reputation proof.
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

        attestationId = verifier.verifyAttestations(subject, id, value, attestations, signatures);
        if (usedAttestations[attestationId]) revert AttestationAlreadyUsed(attestationId);
        usedAttestations[attestationId] = true;

        _records[subject][id] = Record({value: value, updatedAt: uint64(block.timestamp)});
        emit AttestationStored(subject, id, value, attestationId);
    }

    /// @inheritdoc IReputationRegistry
    /// @dev Retained for the `IReputationRegistry` surface: a trusted owner path for migrations
    ///      and for metrics sourced from on-chain history rather than a signed attestation.
    function storeAttestation(address subject, bytes32 id, uint256 value, bytes32 attestationId)
        external
        onlyOwner
    {
        if (!_schemas[id].exists) revert UnknownSchema(id);
        if (usedAttestations[attestationId]) revert AttestationAlreadyUsed(attestationId);
        usedAttestations[attestationId] = true;

        _records[subject][id] = Record({value: value, updatedAt: uint64(block.timestamp)});
        emit AttestationStored(subject, id, value, attestationId);
    }

    /// @inheritdoc IReputationRegistry
    /// @dev O(number of registered schemas). The schema set is governance-controlled and small;
    ///      campaigns read this at join time only.
    function scoreOf(address wallet) public view returns (uint256 score) {
        uint256 len = _schemaIds.length;
        for (uint256 i; i < len; ++i) {
            bytes32 id = _schemaIds[i];
            uint256 weight = _schemas[id].weight;
            if (weight == 0) continue;
            score += _records[wallet][id].value * weight;
        }
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

    /// @inheritdoc IReputationRegistry
    function isSchemaEnabled(bytes32 id) external view returns (bool) {
        return _schemas[id].exists && _schemas[id].weight > 0;
    }

    /// @notice Full schema definition.
    /// @param id The schema id.
    /// @return name Human-readable schema name.
    /// @return weight Contribution to the composite score; 0 means disabled.
    /// @return exists Whether the schema is registered.
    function schemaInfo(bytes32 id) external view returns (string memory name, uint256 weight, bool exists) {
        Schema storage s = _schemas[id];
        return (s.name, s.weight, s.exists);
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
