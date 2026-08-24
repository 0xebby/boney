// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {AttestationVerifier} from "../src/reputation/AttestationVerifier.sol";
import {IAttestationVerifier} from "../src/interfaces/IAttestationVerifier.sol";

contract AttestationVerifierTest is Test {
    AttestationVerifier internal verifier;

    address internal admin = address(0xA11CE);
    address internal subject = address(0x5AB1);

    uint256 internal attestorPk = 0xA77E5;
    uint256 internal secondPk = 0xB0B;
    uint256 internal roguePk = 0xDEAD;

    address internal attestor;
    address internal second;
    address internal rogue;

    bytes32 internal constant SCHEMA = keccak256("FOLLOWERS");

    function setUp() public {
        attestor = vm.addr(attestorPk);
        second = vm.addr(secondPk);
        rogue = vm.addr(roguePk);
        verifier = new AttestationVerifier(admin, attestor);
        vm.warp(1_000_000);
    }

    // ── helpers ──────────────────────────────────────────────────

    function _attestation(address who, uint256 value, uint256 nonce, uint64 expiresAt)
        internal
        view
        returns (IAttestationVerifier.Attestation memory)
    {
        return IAttestationVerifier.Attestation({
            attestor: who,
            subject: subject,
            schemaId: SCHEMA,
            value: value,
            nonce: nonce,
            expiresAt: expiresAt,
            data: bytes32(0)
        });
    }

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

    function _single(IAttestationVerifier.Attestation memory a, bytes memory sig)
        internal
        pure
        returns (IAttestationVerifier.Attestation[] memory as_, bytes[] memory sigs)
    {
        as_ = new IAttestationVerifier.Attestation[](1);
        sigs = new bytes[](1);
        as_[0] = a;
        sigs[0] = sig;
    }

    // ── construction ─────────────────────────────────────────────

    function test_InitialState() public view {
        assertTrue(verifier.isAttestor(attestor));
        assertEq(verifier.threshold(), 1);
        assertEq(verifier.attestorCount(), 1);
        assertEq(verifier.owner(), admin);
        assertEq(verifier.nonces(attestor), 0);
    }

    // ── happy path ───────────────────────────────────────────────

    function test_VerifySingleAttestation() public {
        IAttestationVerifier.Attestation memory a =
            _attestation(attestor, 5230, 0, uint64(block.timestamp + 1 hours));
        (IAttestationVerifier.Attestation[] memory as_, bytes[] memory sigs) =
            _single(a, _sign(attestorPk, a));

        bytes32 id = verifier.verifyAttestations(subject, SCHEMA, 5230, as_, sigs);

        assertTrue(id != bytes32(0));
        assertEq(verifier.nonces(attestor), 1, "nonce must be consumed");
    }

    // ── replay protection ────────────────────────────────────────

    function test_Verify_revertsOnReplay() public {
        IAttestationVerifier.Attestation memory a =
            _attestation(attestor, 5230, 0, uint64(block.timestamp + 1 hours));
        (IAttestationVerifier.Attestation[] memory as_, bytes[] memory sigs) =
            _single(a, _sign(attestorPk, a));

        verifier.verifyAttestations(subject, SCHEMA, 5230, as_, sigs);

        vm.expectRevert(abi.encodeWithSelector(IAttestationVerifier.InvalidNonce.selector, attestor, 1, 0));
        verifier.verifyAttestations(subject, SCHEMA, 5230, as_, sigs);
    }

    function test_Verify_sequentialNoncesSucceed() public {
        for (uint256 i; i < 3; ++i) {
            IAttestationVerifier.Attestation memory a =
                _attestation(attestor, 100 + i, i, uint64(block.timestamp + 1 hours));
            (IAttestationVerifier.Attestation[] memory as_, bytes[] memory sigs) =
                _single(a, _sign(attestorPk, a));
            verifier.verifyAttestations(subject, SCHEMA, 100 + i, as_, sigs);
        }
        assertEq(verifier.nonces(attestor), 3);
    }

    // ── expiry ───────────────────────────────────────────────────

    function test_Verify_revertsExpired() public {
        IAttestationVerifier.Attestation memory a = _attestation(attestor, 1, 0, uint64(block.timestamp - 1));
        (IAttestationVerifier.Attestation[] memory as_, bytes[] memory sigs) =
            _single(a, _sign(attestorPk, a));

        vm.expectRevert(abi.encodeWithSelector(IAttestationVerifier.AttestationExpired.selector, 0));
        verifier.verifyAttestations(subject, SCHEMA, 1, as_, sigs);
    }

    // ── authorization ────────────────────────────────────────────

    function test_Verify_revertsUnregisteredSigner() public {
        IAttestationVerifier.Attestation memory a =
            _attestation(rogue, 1, 0, uint64(block.timestamp + 1 hours));
        (IAttestationVerifier.Attestation[] memory as_, bytes[] memory sigs) = _single(a, _sign(roguePk, a));

        vm.expectRevert(abi.encodeWithSelector(IAttestationVerifier.NotAnAttestor.selector, rogue));
        verifier.verifyAttestations(subject, SCHEMA, 1, as_, sigs);
    }

    /// @dev A valid attestor's payload signed by somebody else must not verify.
    function test_Verify_revertsWrongSigner() public {
        IAttestationVerifier.Attestation memory a =
            _attestation(attestor, 1, 0, uint64(block.timestamp + 1 hours));
        (IAttestationVerifier.Attestation[] memory as_, bytes[] memory sigs) = _single(a, _sign(roguePk, a));

        vm.expectRevert(abi.encodeWithSelector(IAttestationVerifier.InvalidSignature.selector, 0));
        verifier.verifyAttestations(subject, SCHEMA, 1, as_, sigs);
    }

    // ── payload binding ──────────────────────────────────────────

    function test_Verify_revertsTamperedValue() public {
        IAttestationVerifier.Attestation memory a =
            _attestation(attestor, 5230, 0, uint64(block.timestamp + 1 hours));
        (IAttestationVerifier.Attestation[] memory as_, bytes[] memory sigs) =
            _single(a, _sign(attestorPk, a));

        // Caller claims a different value than the one signed.
        vm.expectRevert(abi.encodeWithSelector(IAttestationVerifier.AttestationMismatch.selector, 0));
        verifier.verifyAttestations(subject, SCHEMA, 999_999, as_, sigs);
    }

    function test_Verify_revertsWrongSubject() public {
        IAttestationVerifier.Attestation memory a =
            _attestation(attestor, 5230, 0, uint64(block.timestamp + 1 hours));
        (IAttestationVerifier.Attestation[] memory as_, bytes[] memory sigs) =
            _single(a, _sign(attestorPk, a));

        vm.expectRevert(abi.encodeWithSelector(IAttestationVerifier.AttestationMismatch.selector, 0));
        verifier.verifyAttestations(address(0xBEEF), SCHEMA, 5230, as_, sigs);
    }

    /// @dev Mutating a signed field after signing must break recovery.
    function test_Verify_revertsMutatedExpiry() public {
        IAttestationVerifier.Attestation memory a =
            _attestation(attestor, 5230, 0, uint64(block.timestamp + 1 hours));
        bytes memory sig = _sign(attestorPk, a);
        a.expiresAt = uint64(block.timestamp + 30 days);
        (IAttestationVerifier.Attestation[] memory as_, bytes[] memory sigs) = _single(a, sig);

        vm.expectRevert(abi.encodeWithSelector(IAttestationVerifier.InvalidSignature.selector, 0));
        verifier.verifyAttestations(subject, SCHEMA, 5230, as_, sigs);
    }

    // ── threshold (k-of-n) ───────────────────────────────────────

    function _enableSecondAttestor() internal {
        vm.prank(admin);
        verifier.setAttestor(second, true);
        vm.prank(admin);
        verifier.setThreshold(2);
    }

    function test_Threshold_twoOfTwoSucceeds() public {
        _enableSecondAttestor();

        IAttestationVerifier.Attestation[] memory as_ = new IAttestationVerifier.Attestation[](2);
        bytes[] memory sigs = new bytes[](2);
        as_[0] = _attestation(attestor, 42, 0, uint64(block.timestamp + 1 hours));
        as_[1] = _attestation(second, 42, 0, uint64(block.timestamp + 1 hours));
        sigs[0] = _sign(attestorPk, as_[0]);
        sigs[1] = _sign(secondPk, as_[1]);

        verifier.verifyAttestations(subject, SCHEMA, 42, as_, sigs);
        assertEq(verifier.nonces(attestor), 1);
        assertEq(verifier.nonces(second), 1);
    }

    function test_Threshold_revertsBelowThreshold() public {
        _enableSecondAttestor();

        IAttestationVerifier.Attestation memory a =
            _attestation(attestor, 42, 0, uint64(block.timestamp + 1 hours));
        (IAttestationVerifier.Attestation[] memory as_, bytes[] memory sigs) =
            _single(a, _sign(attestorPk, a));

        vm.expectRevert(abi.encodeWithSelector(IAttestationVerifier.BelowThreshold.selector, 1, 2));
        verifier.verifyAttestations(subject, SCHEMA, 42, as_, sigs);
    }

    /// @dev One attestor must not satisfy k=2 by signing twice with consecutive nonces.
    function test_Threshold_revertsDuplicateSigner() public {
        _enableSecondAttestor();

        IAttestationVerifier.Attestation[] memory as_ = new IAttestationVerifier.Attestation[](2);
        bytes[] memory sigs = new bytes[](2);
        as_[0] = _attestation(attestor, 42, 0, uint64(block.timestamp + 1 hours));
        as_[1] = _attestation(attestor, 42, 1, uint64(block.timestamp + 1 hours));
        sigs[0] = _sign(attestorPk, as_[0]);
        sigs[1] = _sign(attestorPk, as_[1]);

        vm.expectRevert(abi.encodeWithSelector(IAttestationVerifier.DuplicateAttestor.selector, attestor));
        verifier.verifyAttestations(subject, SCHEMA, 42, as_, sigs);
    }

    // ── admin surface ────────────────────────────────────────────

    function test_SetAttestor_onlyOwner() public {
        vm.prank(rogue);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, rogue));
        verifier.setAttestor(second, true);
    }

    function test_SetThreshold_onlyOwner() public {
        vm.prank(rogue);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, rogue));
        verifier.setThreshold(1);
    }

    function test_SetThreshold_revertsAboveAttestorCount() public {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IAttestationVerifier.InvalidThreshold.selector, 2, 1));
        verifier.setThreshold(2);
    }

    function test_SetThreshold_revertsZero() public {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IAttestationVerifier.InvalidThreshold.selector, 0, 1));
        verifier.setThreshold(0);
    }

    /// @dev Removing an attestor must not strand the threshold above the remaining set.
    function test_SetAttestor_revertsRemovalBelowThreshold() public {
        _enableSecondAttestor();

        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IAttestationVerifier.InvalidThreshold.selector, 2, 1));
        verifier.setAttestor(second, false);
    }

    function test_SetAttestor_removalRevokesVerification() public {
        vm.prank(admin);
        verifier.setAttestor(second, true);

        IAttestationVerifier.Attestation memory a =
            _attestation(second, 7, 0, uint64(block.timestamp + 1 hours));
        (IAttestationVerifier.Attestation[] memory as_, bytes[] memory sigs) = _single(a, _sign(secondPk, a));

        vm.prank(admin);
        verifier.setAttestor(second, false);

        vm.expectRevert(abi.encodeWithSelector(IAttestationVerifier.NotAnAttestor.selector, second));
        verifier.verifyAttestations(subject, SCHEMA, 7, as_, sigs);
    }

    function test_SetAttestor_idempotent() public {
        vm.prank(admin);
        verifier.setAttestor(attestor, true);
        assertEq(verifier.attestorCount(), 1, "no double count");
    }

    // ── input validation ─────────────────────────────────────────

    function test_Verify_revertsLengthMismatch() public {
        IAttestationVerifier.Attestation[] memory as_ = new IAttestationVerifier.Attestation[](1);
        bytes[] memory sigs = new bytes[](2);
        as_[0] = _attestation(attestor, 1, 0, uint64(block.timestamp + 1 hours));

        vm.expectRevert(IAttestationVerifier.LengthMismatch.selector);
        verifier.verifyAttestations(subject, SCHEMA, 1, as_, sigs);
    }

    function test_Verify_revertsEmptyWhenThresholdOne() public {
        IAttestationVerifier.Attestation[] memory as_ = new IAttestationVerifier.Attestation[](0);
        bytes[] memory sigs = new bytes[](0);

        vm.expectRevert(abi.encodeWithSelector(IAttestationVerifier.BelowThreshold.selector, 0, 1));
        verifier.verifyAttestations(subject, SCHEMA, 1, as_, sigs);
    }

    // ── domain binding ───────────────────────────────────────────

    /// @dev A signature is bound to this deployment; an identical one elsewhere must not verify.
    function test_DomainSeparator_bindsDeployment() public {
        AttestationVerifier other = new AttestationVerifier(admin, attestor);
        assertTrue(verifier.DOMAIN_SEPARATOR() != other.DOMAIN_SEPARATOR());

        IAttestationVerifier.Attestation memory a =
            _attestation(attestor, 5230, 0, uint64(block.timestamp + 1 hours));
        (IAttestationVerifier.Attestation[] memory as_, bytes[] memory sigs) =
            _single(a, _sign(attestorPk, a));

        vm.expectRevert(abi.encodeWithSelector(IAttestationVerifier.InvalidSignature.selector, 0));
        other.verifyAttestations(subject, SCHEMA, 5230, as_, sigs);
    }

    // ── fuzz ─────────────────────────────────────────────────────

    function testFuzz_VerifyAnyValue(uint256 value, uint64 ttl) public {
        ttl = uint64(bound(ttl, 1, 365 days));

        IAttestationVerifier.Attestation memory a =
            _attestation(attestor, value, 0, uint64(block.timestamp) + ttl);
        (IAttestationVerifier.Attestation[] memory as_, bytes[] memory sigs) =
            _single(a, _sign(attestorPk, a));

        verifier.verifyAttestations(subject, SCHEMA, value, as_, sigs);
        assertEq(verifier.nonces(attestor), 1);
    }
}
