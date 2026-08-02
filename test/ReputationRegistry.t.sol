// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReputationRegistry} from "../src/reputation/ReputationRegistry.sol";
import {AttestationVerifier} from "../src/reputation/AttestationVerifier.sol";
import {IAttestationVerifier} from "../src/interfaces/IAttestationVerifier.sol";

contract ReputationRegistryTest is Test {
    AttestationVerifier internal verifier;
    ReputationRegistry internal registry;

    address internal admin = address(0xA11CE);
    address internal kol = address(0xC0FFEE);
    address internal rogue = address(0xBAD);

    uint256 internal attestorPk = 0xA77E5;
    address internal attestor;

    bytes32 internal followersId;
    bytes32 internal yapsId;

    function setUp() public {
        attestor = vm.addr(attestorPk);
        verifier = new AttestationVerifier(admin, attestor);
        registry = new ReputationRegistry(admin, address(verifier));
        vm.warp(1_000_000);

        vm.startPrank(admin);
        registry.registerSchema("X_FOLLOWERS", 1);
        registry.registerSchema("KAITO_YAPS", 10);
        vm.stopPrank();

        followersId = registry.schemaId("X_FOLLOWERS");
        yapsId = registry.schemaId("KAITO_YAPS");
    }

    // ── helpers ──────────────────────────────────────────────────

    function _sign(uint256 pk, IAttestationVerifier.Attestation memory a)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                verifier.ATTESTATION_TYPEHASH(),
                a.attestor,
                a.subject,
                a.schemaId,
                a.value,
                a.nonce,
                a.expiresAt,
                a.data
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", verifier.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _bundle(address subject, bytes32 id, uint256 value, uint256 nonce)
        internal
        view
        returns (IAttestationVerifier.Attestation[] memory as_, bytes[] memory sigs)
    {
        as_ = new IAttestationVerifier.Attestation[](1);
        sigs = new bytes[](1);
        as_[0] = IAttestationVerifier.Attestation({
            attestor: attestor,
            subject: subject,
            schemaId: id,
            value: value,
            nonce: nonce,
            expiresAt: uint64(block.timestamp + 1 hours),
            data: bytes32(0)
        });
        sigs[0] = _sign(attestorPk, as_[0]);
    }

    function _submit(address subject, bytes32 id, uint256 value, uint256 nonce) internal returns (bytes32) {
        (IAttestationVerifier.Attestation[] memory as_, bytes[] memory sigs) =
            _bundle(subject, id, value, nonce);
        return registry.submitAttestation(subject, id, value, as_, sigs);
    }

    // ── schema registration ──────────────────────────────────────

    function test_RegisterSchema() public view {
        (string memory name, uint256 weight, bool exists) = registry.schemaInfo(followersId);
        assertEq(name, "X_FOLLOWERS");
        assertEq(weight, 1);
        assertTrue(exists);
        assertEq(registry.schemaCount(), 2);
        assertTrue(registry.isSchemaEnabled(followersId));
    }

    function test_RegisterSchema_onlyOwner() public {
        vm.prank(rogue);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, rogue));
        registry.registerSchema("FARCASTER", 5);
    }

    function test_RegisterSchema_revertsDuplicate() public {
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(ReputationRegistry.SchemaAlreadyRegistered.selector, followersId)
        );
        registry.registerSchema("X_FOLLOWERS", 2);
    }

    function test_RegisterSchema_revertsEmptyName() public {
        vm.prank(admin);
        vm.expectRevert(ReputationRegistry.EmptyName.selector);
        registry.registerSchema("", 1);
    }

    /// @dev `scoreOf` iterates every schema and runs on the campaign join path, so the schema
    ///      set is bounded to keep joining affordable.
    function test_RegisterSchema_revertsAboveCap() public {
        uint256 max = registry.MAX_SCHEMAS();
        vm.startPrank(admin);
        for (uint256 i = registry.schemaCount(); i < max; ++i) {
            registry.registerSchema(string(abi.encodePacked("SCHEMA_", vm.toString(i))), 1);
        }
        assertEq(registry.schemaCount(), max);

        vm.expectRevert(abi.encodeWithSelector(ReputationRegistry.TooManySchemas.selector, max));
        registry.registerSchema("ONE_TOO_MANY", 1);
        vm.stopPrank();
    }

    function test_SetSchemaWeight() public {
        vm.prank(admin);
        registry.setSchemaWeight(followersId, 3);
        (, uint256 weight,) = registry.schemaInfo(followersId);
        assertEq(weight, 3);
    }

    function test_SetSchemaWeight_revertsUnknown() public {
        bytes32 unknown = keccak256("NOPE");
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(ReputationRegistry.UnknownSchema.selector, unknown));
        registry.setSchemaWeight(unknown, 1);
    }

    function test_SetSchemaWeight_zeroDisables() public {
        _submit(kol, followersId, 5_000, 0);
        assertEq(registry.scoreOf(kol), 5_000);

        vm.prank(admin);
        registry.setSchemaWeight(followersId, 0);

        assertFalse(registry.isSchemaEnabled(followersId));
        assertEq(registry.scoreOf(kol), 0, "disabled schema stops contributing");
        assertEq(registry.valueOf(kol, followersId), 5_000, "underlying data is preserved");
    }

    // ── attestation submission ───────────────────────────────────

    function test_SubmitAttestation() public {
        bytes32 id = _submit(kol, followersId, 5_230, 0);

        assertTrue(id != bytes32(0));
        assertEq(registry.valueOf(kol, followersId), 5_230);
        assertEq(registry.updatedAtOf(kol, followersId), uint64(block.timestamp));
        assertTrue(registry.usedAttestations(id));
    }

    function test_SubmitAttestation_isPermissionless() public {
        (IAttestationVerifier.Attestation[] memory as_, bytes[] memory sigs) =
            _bundle(kol, followersId, 5_230, 0);

        // A relayer with no privileges may submit: authority is in the signature.
        vm.prank(rogue);
        registry.submitAttestation(kol, followersId, 5_230, as_, sigs);

        assertEq(registry.valueOf(kol, followersId), 5_230);
    }

    function test_SubmitAttestation_revertsUnknownSchema() public {
        bytes32 unknown = keccak256("NOPE");
        (IAttestationVerifier.Attestation[] memory as_, bytes[] memory sigs) = _bundle(kol, unknown, 1, 0);

        vm.expectRevert(abi.encodeWithSelector(ReputationRegistry.UnknownSchema.selector, unknown));
        registry.submitAttestation(kol, unknown, 1, as_, sigs);
    }

    /// @dev The verifier's nonce consumption must block a straight replay.
    function test_SubmitAttestation_revertsReplay() public {
        (IAttestationVerifier.Attestation[] memory as_, bytes[] memory sigs) =
            _bundle(kol, followersId, 5_230, 0);
        registry.submitAttestation(kol, followersId, 5_230, as_, sigs);

        vm.expectRevert(abi.encodeWithSelector(AttestationVerifier.InvalidNonce.selector, attestor, 1, 0));
        registry.submitAttestation(kol, followersId, 5_230, as_, sigs);
    }

    function test_SubmitAttestation_revertsBadSignature() public {
        (IAttestationVerifier.Attestation[] memory as_, bytes[] memory sigs) =
            _bundle(kol, followersId, 5_230, 0);

        // Claim a higher value than was signed.
        vm.expectRevert(abi.encodeWithSelector(AttestationVerifier.AttestationMismatch.selector, 0));
        registry.submitAttestation(kol, followersId, 999_999, as_, sigs);
    }

    function test_SubmitAttestation_reattestationUpdatesValue() public {
        _submit(kol, followersId, 5_000, 0);
        skip(30 days);
        _submit(kol, followersId, 12_000, 1);

        assertEq(registry.valueOf(kol, followersId), 12_000);
        assertEq(registry.updatedAtOf(kol, followersId), uint64(block.timestamp));
    }

    // ── owner-path storage ───────────────────────────────────────

    function test_StoreAttestation_onlyOwner() public {
        vm.prank(rogue);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, rogue));
        registry.storeAttestation(kol, followersId, 1, keccak256("x"));
    }

    function test_StoreAttestation_revertsReusedId() public {
        bytes32 attId = keccak256("migration-1");
        vm.prank(admin);
        registry.storeAttestation(kol, followersId, 100, attId);

        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(ReputationRegistry.AttestationAlreadyUsed.selector, attId));
        registry.storeAttestation(kol, followersId, 200, attId);
    }

    function test_StoreAttestation_revertsUnknownSchema() public {
        bytes32 unknown = keccak256("NOPE");
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(ReputationRegistry.UnknownSchema.selector, unknown));
        registry.storeAttestation(kol, unknown, 1, keccak256("x"));
    }

    // ── scoring ──────────────────────────────────────────────────

    function test_ScoreOf_weightedSum() public {
        _submit(kol, followersId, 5_000, 0); //  5_000 * 1
        _submit(kol, yapsId, 300, 1); //           300 * 10
        assertEq(registry.scoreOf(kol), 5_000 + 3_000);
    }

    function test_ScoreOf_unknownWalletIsZero() public view {
        assertEq(registry.scoreOf(address(0xDEAD)), 0);
    }

    function test_Qualifies() public {
        _submit(kol, followersId, 5_000, 0);

        assertTrue(registry.qualifies(kol, 5_000), "exact threshold qualifies");
        assertTrue(registry.qualifies(kol, 4_999));
        assertFalse(registry.qualifies(kol, 5_001));
    }

    function test_Qualifies_zeroMinAlwaysTrue() public view {
        assertTrue(registry.qualifies(address(0xDEAD), 0), "open campaigns admit anyone");
    }

    // ── privacy ──────────────────────────────────────────────────

    /// @dev Only numbers are stored; nothing links a wallet to a social handle on-chain.
    function test_Privacy_onlyNumericValuesStored() public {
        _submit(kol, followersId, 5_230, 0);

        (string memory name,,) = registry.schemaInfo(followersId);
        assertEq(name, "X_FOLLOWERS", "schema names describe metrics, not identities");
        assertEq(registry.valueOf(kol, followersId), 5_230);
    }

    // ── fuzz ─────────────────────────────────────────────────────

    function testFuzz_ScoreIsWeightedSum(uint96 followers, uint96 yaps) public {
        _submit(kol, followersId, followers, 0);
        _submit(kol, yapsId, yaps, 1);

        assertEq(registry.scoreOf(kol), uint256(followers) + uint256(yaps) * 10);
    }

    function testFuzz_QualifiesMatchesScore(uint96 followers, uint256 minScore) public {
        _submit(kol, followersId, followers, 0);
        uint256 score = registry.scoreOf(kol);

        if (minScore == 0) {
            assertTrue(registry.qualifies(kol, minScore));
        } else {
            assertEq(registry.qualifies(kol, minScore), score >= minScore);
        }
    }
}
