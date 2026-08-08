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
        registry.registerSchema("FOLLOWERS", 1);
        registry.registerSchema("KAITO_YAPS", 10);
        vm.stopPrank();

        followersId = registry.schemaId("FOLLOWERS");
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
        assertEq(name, "FOLLOWERS");
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
        registry.registerSchema("FOLLOWERS", 2);
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
        assertEq(name, "FOLLOWERS", "schema names describe metrics, not identities");
        assertEq(registry.valueOf(kol, followersId), 5_230);
    }

    // ── value ceilings & maxScore ────────────────────────────────

    function test_SetSchemaMaxValue() public {
        vm.prank(admin);
        registry.setSchemaMaxValue(followersId, 2_800);
        assertEq(registry.schemaMaxValue(followersId), 2_800);
    }

    function test_SetSchemaMaxValue_onlyOwner() public {
        vm.prank(rogue);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, rogue));
        registry.setSchemaMaxValue(followersId, 2_800);
    }

    function test_SetSchemaMaxValue_revertsUnknown() public {
        bytes32 unknown = keccak256("NOPE");
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(ReputationRegistry.UnknownSchema.selector, unknown));
        registry.setSchemaMaxValue(unknown, 2_800);
    }

    /// @dev Schemas register unbounded so adding this could not retroactively make an existing
    ///      schema unwritable.
    function test_SchemaMaxValue_defaultsToUnbounded() public view {
        assertEq(registry.schemaMaxValue(followersId), 0);
    }

    function test_SubmitAttestation_revertsAboveMaxValue() public {
        vm.prank(admin);
        registry.setSchemaMaxValue(followersId, 2_800);

        (IAttestationVerifier.Attestation[] memory as_, bytes[] memory sigs) =
            _bundle(kol, followersId, 2_801, 0);
        vm.expectRevert(
            abi.encodeWithSelector(ReputationRegistry.ValueExceedsMax.selector, followersId, 2_801, 2_800)
        );
        registry.submitAttestation(kol, followersId, 2_801, as_, sigs);
    }

    function test_SubmitAttestation_acceptsExactlyMaxValue() public {
        vm.prank(admin);
        registry.setSchemaMaxValue(followersId, 2_800);

        _submit(kol, followersId, 2_800, 0);
        assertEq(registry.valueOf(kol, followersId), 2_800, "the bound is inclusive");
    }

    /// @dev The owner path is trusted but not exempt: `maxScore` is only sound if every write
    ///      respects the bound.
    function test_StoreAttestation_revertsAboveMaxValue() public {
        vm.startPrank(admin);
        registry.setSchemaMaxValue(followersId, 2_800);
        vm.expectRevert(
            abi.encodeWithSelector(ReputationRegistry.ValueExceedsMax.selector, followersId, 9_999, 2_800)
        );
        registry.storeAttestation(kol, followersId, 9_999, keccak256("over"));
        vm.stopPrank();
    }

    function test_MaxScore_sumsWeightTimesCeiling() public {
        vm.startPrank(admin);
        registry.setSchemaMaxValue(followersId, 2_800);
        registry.setSchemaMaxValue(yapsId, 2_800);
        vm.stopPrank();

        // weights are 1 and 10 from setUp
        assertEq(registry.maxScore(), 1 * 2_800 + 10 * 2_800);
    }

    /// @dev The sentinel has to be distinguishable from a real ceiling of 0, which is why it is
    ///      type(uint256).max rather than 0.
    function test_MaxScore_unboundedWhenAnyWeightedSchemaIsUnbounded() public {
        vm.prank(admin);
        registry.setSchemaMaxValue(followersId, 2_800);
        // yapsId is still unbounded and carries weight 10.
        assertEq(registry.maxScore(), type(uint256).max);
    }

    /// @dev A display-only metric must not poison the ceiling for the schemas that actually score.
    function test_MaxScore_ignoresUnweightedSchemas() public {
        vm.startPrank(admin);
        registry.setSchemaWeight(followersId, 0);
        registry.setSchemaMaxValue(yapsId, 2_800);
        vm.stopPrank();

        assertEq(registry.maxScore(), 10 * 2_800, "unweighted and unbounded FOLLOWERS is skipped");
    }

    function test_MaxScore_zeroWhenNothingIsWeighted() public {
        vm.startPrank(admin);
        registry.setSchemaWeight(followersId, 0);
        registry.setSchemaWeight(yapsId, 0);
        vm.stopPrank();

        assertEq(registry.maxScore(), 0, "a registry that cannot score anything maxes out at 0");
    }

    /// @dev Saturates instead of reverting: this sits under Campaign's constructor, so an
    ///      overflowing configuration must not block campaign creation protocol-wide.
    function test_MaxScore_saturatesRatherThanOverflowing() public {
        vm.startPrank(admin);
        registry.setSchemaMaxValue(followersId, type(uint256).max);
        registry.setSchemaMaxValue(yapsId, type(uint256).max);
        vm.stopPrank();

        assertEq(registry.maxScore(), type(uint256).max);
    }

    /// @dev Enforced on write, not on read — so lowering a ceiling leaves stored values alone.
    function test_SetSchemaMaxValue_doesNotRewriteStoredValues() public {
        _submit(kol, followersId, 9_999, 0);
        assertEq(registry.scoreOf(kol), 9_999);

        vm.prank(admin);
        registry.setSchemaMaxValue(followersId, 2_800);

        assertEq(registry.valueOf(kol, followersId), 9_999, "an existing record is left intact");
        assertEq(registry.scoreOf(kol), 9_999, "and still counts until re-attested");
    }

    // ── freshness ────────────────────────────────────────────────

    function test_SetSchemaMaxAge() public {
        vm.prank(admin);
        registry.setSchemaMaxAge(followersId, 30 days);
        assertEq(registry.schemaMaxAge(followersId), 30 days);
    }

    function test_SetSchemaMaxAge_onlyOwner() public {
        vm.prank(rogue);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, rogue));
        registry.setSchemaMaxAge(followersId, 30 days);
    }

    function test_SetSchemaMaxAge_revertsUnknown() public {
        bytes32 unknown = keccak256("NOPE");
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(ReputationRegistry.UnknownSchema.selector, unknown));
        registry.setSchemaMaxAge(unknown, 30 days);
    }

    /// @dev Schemas register non-expiring so that adding the freshness gate could not retroactively
    ///      void values attested before it existed.
    function test_SchemaMaxAge_defaultsToNeverExpires() public {
        assertEq(registry.schemaMaxAge(followersId), 0);

        _submit(kol, followersId, 5_000, 0);
        skip(3650 days);

        assertEq(registry.scoreOf(kol), 5_000, "a non-expiring schema still counts after a decade");
        assertTrue(registry.isValueFresh(kol, followersId));
        assertEq(registry.expiresAtOf(kol, followersId), 0, "never expires has no expiry date");
    }

    /// @dev The gate this whole change exists for: a KOL who verified once at a high score must not
    ///      keep clearing gates on it forever.
    function test_ScoreOf_staleValueStopsCounting() public {
        vm.prank(admin);
        registry.setSchemaMaxAge(followersId, 30 days);

        _submit(kol, followersId, 5_000, 0);
        assertEq(registry.scoreOf(kol), 5_000);

        skip(30 days);
        assertEq(registry.scoreOf(kol), 5_000, "exactly at maxAge is still fresh");

        skip(1);
        assertEq(registry.scoreOf(kol), 0, "one second past maxAge stops counting");
        assertEq(registry.valueOf(kol, followersId), 5_000, "underlying data is preserved");
    }

    function test_ScoreOf_staleValueIsSkippedNotReverted() public {
        vm.prank(admin);
        registry.setSchemaMaxAge(followersId, 30 days);

        _submit(kol, followersId, 5_000, 0);
        _submit(kol, yapsId, 300, 1); // yaps never expires

        skip(31 days);

        // The stale schema drops out; the non-expiring one is untouched. scoreOf must stay callable
        // so a rejected join can still report what the score actually is.
        assertEq(registry.scoreOf(kol), 3_000);
    }

    function test_ScoreOf_reattestationRestoresScore() public {
        vm.prank(admin);
        registry.setSchemaMaxAge(followersId, 30 days);

        _submit(kol, followersId, 5_000, 0);
        skip(31 days);
        assertEq(registry.scoreOf(kol), 0);

        _submit(kol, followersId, 4_200, 1);
        assertEq(registry.scoreOf(kol), 4_200, "re-attesting restores the score at the new value");
        assertTrue(registry.isValueFresh(kol, followersId));
    }

    function test_Qualifies_followsFreshness() public {
        vm.prank(admin);
        registry.setSchemaMaxAge(followersId, 30 days);
        _submit(kol, followersId, 5_000, 0);

        assertTrue(registry.qualifies(kol, 5_000));
        skip(31 days);
        assertFalse(registry.qualifies(kol, 5_000), "an expired attestation stops clearing the gate");
    }

    /// @dev Tightening the window re-scores retroactively, so governance can retire a stale metric
    ///      without waiting for anyone to re-attest.
    function test_SetSchemaMaxAge_appliesRetroactively() public {
        _submit(kol, followersId, 5_000, 0);
        skip(90 days);
        assertEq(registry.scoreOf(kol), 5_000);

        vm.prank(admin);
        registry.setSchemaMaxAge(followersId, 30 days);
        assertEq(registry.scoreOf(kol), 0, "tightening drops already-aged values immediately");

        vm.prank(admin);
        registry.setSchemaMaxAge(followersId, 0);
        assertEq(registry.scoreOf(kol), 5_000, "widening is not a way to erase data");
    }

    function test_ExpiresAtOf() public {
        vm.prank(admin);
        registry.setSchemaMaxAge(followersId, 30 days);

        assertEq(registry.expiresAtOf(kol, followersId), 0, "never attested has no expiry");

        _submit(kol, followersId, 5_000, 0);
        assertEq(registry.expiresAtOf(kol, followersId), uint64(block.timestamp) + 30 days);
    }

    /// @dev A wallet can hold a large value that contributes nothing. Without a freshness view the
    ///      UI can only show `valueOf` beside a score that disagrees with it.
    function test_IsValueFresh_distinguishesExpiredFromAbsent() public {
        vm.prank(admin);
        registry.setSchemaMaxAge(followersId, 30 days);

        assertFalse(registry.isValueFresh(address(0xDEAD), followersId), "never attested reads stale");

        _submit(kol, followersId, 5_000, 0);
        assertTrue(registry.isValueFresh(kol, followersId));

        skip(31 days);
        assertFalse(registry.isValueFresh(kol, followersId));
        assertEq(registry.valueOf(kol, followersId), 5_000, "still holds a value it cannot score on");
    }

    /// @dev `_isStale` subtracts instead of adding because `updatedAt + maxAge` overflows for a
    ///      large `maxAge`, and an overflow under `scoreOf` would revert `Campaign.join()` — a gate
    ///      nobody could pass.
    function test_ScoreOf_extremeMaxAgeDoesNotOverflow() public {
        vm.prank(admin);
        registry.setSchemaMaxAge(followersId, type(uint64).max);

        _submit(kol, followersId, 5_000, 0);
        skip(3650 days);

        assertEq(registry.scoreOf(kol), 5_000);
        assertTrue(registry.isValueFresh(kol, followersId));
    }

    // ── fuzz ─────────────────────────────────────────────────────

    function testFuzz_ScoreIsWeightedSum(uint96 followers, uint96 yaps) public {
        _submit(kol, followersId, followers, 0);
        _submit(kol, yapsId, yaps, 1);

        assertEq(registry.scoreOf(kol), uint256(followers) + uint256(yaps) * 10);
    }

    /// @dev The boundary is inclusive at `maxAge` and `scoreOf` never reverts, whatever the window.
    ///      Both bounds stay a long way inside uint64 so `skip` itself cannot overflow — the
    ///      extreme-window case is pinned separately in `test_ScoreOf_extremeMaxAgeDoesNotOverflow`.
    function testFuzz_FreshnessBoundary(uint64 maxAge, uint64 elapsed) public {
        uint64 century = 100 * 365 days;
        maxAge = uint64(bound(maxAge, 1, century));
        elapsed = uint64(bound(elapsed, 0, 2 * century));

        vm.prank(admin);
        registry.setSchemaMaxAge(followersId, maxAge);
        _submit(kol, followersId, 5_000, 0);

        skip(elapsed);

        bool fresh = elapsed <= maxAge;
        assertEq(registry.isValueFresh(kol, followersId), fresh);
        assertEq(registry.scoreOf(kol), fresh ? 5_000 : 0);
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
