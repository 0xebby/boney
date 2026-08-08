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
///
///      Freshness: credibility is not a constant. An Ethos score moves with vouches, reviews and
///      slashing; a follower count moves when an account is sold, suspended, or inflated. The
///      attestation's own `expiresAt` bounds only when a signed bundle may be *submitted* — it says
///      nothing about how long the resulting value should keep counting. So each schema carries a
///      `maxAge`, and `scoreOf` ignores any record older than it. A KOL who verified once at a high
///      score does not keep clearing gates on it forever; the value decays out of their score and
///      they re-attest to restore it.
///
///      `maxAge = 0` disables expiry for that schema, which is correct for metrics derived from
///      immutable history (a wallet's first-transaction age cannot go down) and is the default so
///      registering a schema never silently expires data.
contract ReputationRegistry is IReputationRegistry, Ownable {
    error UnknownSchema(bytes32 schemaId);
    error SchemaDisabled(bytes32 schemaId);
    error SchemaAlreadyRegistered(bytes32 schemaId);
    error AttestationAlreadyUsed(bytes32 attestationId);
    error StaleValue(uint256 storedAt, uint256 incomingAt);
    error ValueExceedsMax(bytes32 schemaId, uint256 value, uint256 maxValue);
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

        // maxAge 0 == never expires. Registration stays non-expiring by default so adding the
        // freshness gate could not retroactively void data attested before it existed; governance
        // opts a schema in with setSchemaMaxAge.
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
    /// @dev Applies retroactively: lowering `maxAge` can immediately drop records out of every
    ///      score that included them, which is the point — governance can tighten a stale metric
    ///      without waiting for anyone to re-attest. Raising it brings expired records back, so it
    ///      is not a way to erase data.
    ///
    ///      Tightening this shrinks scores, and `Campaign.minReputation` is immutable. A promoter
    ///      who has already joined keeps their membership — `join()` reads the score once — but one
    ///      who has not may find a previously-clearable gate now out of reach until they re-attest.
    function setSchemaMaxAge(bytes32 id, uint64 maxAge) external onlyOwner {
        if (!_schemas[id].exists) revert UnknownSchema(id);
        _schemas[id].maxAge = maxAge;
        emit SchemaMaxAgeSet(id, maxAge);
    }

    /// @inheritdoc IReputationRegistry
    /// @dev Bounds what an attestor may report, which is what makes a composite ceiling definable
    ///      at all: with unbounded values `scoreOf` has no maximum, and no `minReputation` a
    ///      project sets can be shown to be unreachable. Enforced on write only — lowering it does
    ///      not retroactively shrink values already stored, because a stored value that silently
    ///      changed meaning would be worse than one that is merely out of date. Re-attesting
    ///      applies the new bound.
    ///
    ///      Defaults to 0 (unbounded) at registration for the same reason `maxAge` does: adding
    ///      this must not retroactively make an existing schema unwritable.
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
    /// @dev Returns `type(uint256).max` to mean "no knowable ceiling", which happens when any
    ///      weighted schema is unbounded. That sentinel rather than 0 because 0 is a legitimate
    ///      answer — a registry whose every schema carries weight 0 genuinely has a maximum score
    ///      of 0 — and callers gating on it must be able to tell the two apart. It also makes the
    ///      consumer's check degrade correctly: `minReputation > type(uint256).max` is false for
    ///      every uint256, so an unbounded registry imposes no constraint rather than blocking
    ///      everything.
    ///
    ///      Unweighted schemas are skipped: they contribute nothing to `scoreOf`, so an unbounded
    ///      display-only metric like X_FOLLOWERS must not poison the ceiling for everyone else.
    function maxScore() external view returns (uint256 max) {
        uint256 len = _schemaIds.length;
        for (uint256 i; i < len; ++i) {
            Schema storage s = _schemas[_schemaIds[i]];
            uint256 weight = s.weight;
            if (weight == 0) continue;
            uint256 cap = s.maxValue;
            if (cap == 0) return type(uint256).max;

            // Saturate rather than revert. This sits under `Campaign`'s constructor, and a
            // registry configured into an overflow would otherwise block every campaign creation
            // protocol-wide — a far worse failure than reporting a ceiling nobody can reach.
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
    /// @dev Retained for the `IReputationRegistry` surface: a trusted owner path for migrations
    ///      and for metrics sourced from on-chain history rather than a signed attestation.
    ///
    ///      Bound by `maxValue` exactly as the signed path is. The owner is trusted, but the
    ///      ceiling `maxScore` reports is only sound if *every* write respects it — an owner-stored
    ///      value above the bound would make a gate that campaign creation certified as reachable
    ///      quietly reachable by a different amount than advertised.
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
    /// @dev O(number of registered schemas). The schema set is governance-controlled and small;
    ///      campaigns read this at join time only.
    ///
    ///      Stale records contribute nothing. A value that has aged past its schema's `maxAge` is
    ///      skipped rather than reverted on, so an expired attestation lowers a score instead of
    ///      making the wallet unscoreable — `join()` must still be able to tell a promoter what
    ///      their score *is* when refusing them.
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
    /// @dev Subtracts rather than adding: `updatedAt + maxAge` overflows for a large `maxAge`, and
    ///      because this sits under `scoreOf` an overflow would revert `Campaign.join()` — a gate
    ///      nobody could pass. `block.timestamp >= updatedAt` always holds (records are stamped on
    ///      write), so the subtraction cannot underflow.
    ///
    ///      A never-attested record is stale by definition, checked before `maxAge` so the answer
    ///      does not depend on chain age: `block.timestamp - 0 > maxAge` is false on a young chain,
    ///      which would report an absent record as fresh. Scoring cannot tell the difference (the
    ///      value is 0 either way) but `isValueFresh` exists precisely to tell those states apart.
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
    /// @dev Distinct from "has a value": a wallet can hold a large attested value that contributes
    ///      nothing because it aged out. Without this the UI can only show the raw `valueOf` and a
    ///      score that silently disagrees with it, which reads as a bug rather than an expiry.
    /// @param wallet The wallet to query.
    /// @param id The schema id.
    /// @return True when the record is within its schema's `maxAge`, or the schema never expires.
    function isValueFresh(address wallet, bytes32 id) external view returns (bool) {
        return !_isStale(_records[wallet][id].updatedAt, _schemas[id].maxAge);
    }

    /// @notice When `wallet`'s value for `id` stops counting. 0 when it never expires or was never
    ///         attested.
    /// @dev Lets a promoter be told "re-verify before <date>" instead of discovering the drop when a
    ///      join reverts.
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
    /// @dev Deliberately unchanged when `maxAge` was added: this tuple is destructured positionally
    ///      by callers (`SeedLocal.s.sol` reads the third element to decide whether to register),
    ///      and widening it would break every one of them silently. `schemaMaxAge` is separate.
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
