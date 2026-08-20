// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {AttributionRegistry} from "../src/attribution/AttributionRegistry.sol";
import {IAttributionRegistry} from "../src/interfaces/IAttributionRegistry.sol";
import {IKpiVerifier} from "../src/interfaces/IKpiVerifier.sol";
import {EventMetricKpiVerifier} from "../src/verifiers/EventMetricKpiVerifier.sol";
import {IEventMetricKpiVerifier} from "../src/interfaces/IEventMetricKpiVerifier.sol";
import {GuardedKpiVerifier} from "../src/verifiers/GuardedKpiVerifier.sol";
import {IGuardedKpiVerifier} from "../src/interfaces/IGuardedKpiVerifier.sol";
import {TouchWindowVerifier} from "../src/verifiers/TouchWindowVerifier.sol";

/// @dev A project verifier whose answer the test controls, for exercising the agreement arithmetic
///      without dragging a second real measurement pipeline into it.
contract StubVerifier is IKpiVerifier {
    uint256 public value;

    function set(uint256 v) external {
        value = v;
    }

    function verify(address, uint256, address, uint256, bytes calldata, bytes calldata)
        external
        view
        returns (uint256)
    {
        return value;
    }
}

/// @dev The minimum a campaign has to expose for `TouchWindowVerifier` to read attribution from it:
///      the registry, plus the ability to register promoter ids in its own namespace.
contract MockCampaign {
    IAttributionRegistry public attributionRegistry;

    constructor(IAttributionRegistry registry_) {
        attributionRegistry = registry_;
    }

    function register(bytes32 promoterId) external {
        attributionRegistry.registerPromoter(promoterId);
    }
}

/// @title GuardedKpiVerifierTest
/// @notice Covers the guard's two composition modes, and the concrete case that made a second mode
///         necessary rather than a nicety.
contract GuardedKpiVerifierTest is Test {
    string internal constant SIG = "Deposit(address indexed user, uint256 amount)";
    uint256 internal constant KPI = 0;
    uint64 internal constant MAX_TOUCH = 30 days;

    EventMetricKpiVerifier internal boney;
    GuardedKpiVerifier internal guard;
    StubVerifier internal stub;

    address internal owner = address(0xA11CE);
    address internal reporter = address(0xBEEF);
    address internal campaign = address(0xCAFE);
    address internal alice = address(0xA1);

    function setUp() public {
        vm.warp(1_000_000);

        boney = new EventMetricKpiVerifier(owner, reporter);
        guard = new GuardedKpiVerifier(owner, address(boney));
        stub = new StubVerifier();

        vm.prank(owner);
        boney.setKpiConfig(
            campaign, KPI, address(0xDEAD), SIG, 0, IEventMetricKpiVerifier.Aggregation.SUM, 1, 1, 1, 1_000
        );
    }

    // ── construction and configuration ───────────────────────────

    function test_Constructor_revertsZeroBoneyVerifier() public {
        vm.expectRevert(IGuardedKpiVerifier.ZeroAddress.selector);
        new GuardedKpiVerifier(owner, address(0));
    }

    function test_SetGuardConfig_stores() public {
        _guard(address(stub), 25, IGuardedKpiVerifier.Mode.AGREE);

        GuardedKpiVerifier.GuardConfig memory cfg = guard.guardOf(campaign, KPI);
        assertTrue(cfg.configured);
        assertEq(cfg.projectVerifier, address(stub));
        assertEq(cfg.toleranceBps, 25);
        assertEq(uint8(cfg.mode), uint8(IGuardedKpiVerifier.Mode.AGREE));
    }

    function test_SetGuardConfig_onlyOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        guard.setGuardConfig(campaign, KPI, address(stub), 0, IGuardedKpiVerifier.Mode.AGREE);
    }

    function test_SetGuardConfig_revertsBpsAboveOneHundredPercent() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IGuardedKpiVerifier.BpsOutOfRange.selector, uint16(10_001)));
        guard.setGuardConfig(campaign, KPI, address(stub), 10_001, IGuardedKpiVerifier.Mode.AGREE);
    }

    function test_Verify_revertsUnconfiguredKpi() public {
        vm.expectRevert(abi.encodeWithSelector(IGuardedKpiVerifier.NotConfigured.selector, campaign, KPI));
        guard.verify(campaign, KPI, alice, 10, "", "");
    }

    // ── Boney alone ──────────────────────────────────────────────

    function test_Verify_noProjectVerifierForwardsBoney() public {
        _report(alice, 8);
        _guard(address(0), 0, IGuardedKpiVerifier.Mode.AGREE);

        assertEq(guard.verify(campaign, KPI, alice, 100, "", ""), 8);
    }

    /// @dev The guard adds a second opinion; it never loosens the first one.
    function test_Verify_stillCapsAtBoneyWithNoProjectVerifier() public {
        _report(alice, 3);
        _guard(address(0), 0, IGuardedKpiVerifier.Mode.AGREE);

        assertEq(guard.verify(campaign, KPI, alice, 500, "", ""), 3);
    }

    // ── AGREE ────────────────────────────────────────────────────

    function test_Verify_agreeExactMatch() public {
        _report(alice, 20);
        stub.set(20);
        _guard(address(stub), 0, IGuardedKpiVerifier.Mode.AGREE);

        assertEq(guard.verify(campaign, KPI, alice, 20, "", ""), 20);
    }

    /// @dev 100 vs 99 is 100 bps of the larger value, so a 100 bps tolerance admits it exactly.
    function test_Verify_agreeWithinTolerance() public {
        _report(alice, 100);
        stub.set(99);
        _guard(address(stub), 100, IGuardedKpiVerifier.Mode.AGREE);

        // Boney's number stays canonical on success, not the project's.
        assertEq(guard.verify(campaign, KPI, alice, 100, "", ""), 100);
    }

    function test_Verify_agreeBeyondToleranceReverts() public {
        _report(alice, 100);
        stub.set(80);
        _guard(address(stub), 100, IGuardedKpiVerifier.Mode.AGREE);

        vm.expectRevert(
            abi.encodeWithSelector(IGuardedKpiVerifier.VerifierDisagreement.selector, 80, 100, 20, 1)
        );
        guard.verify(campaign, KPI, alice, 100, "", "");
    }

    /// @dev Divergence is rejected in both directions: a project reporting *more* than Boney observed
    ///      is as much a signal that something is wrong as reporting less.
    function test_Verify_agreeRevertsWhenProjectExceedsBoney() public {
        _report(alice, 50);
        stub.set(90);
        _guard(address(stub), 0, IGuardedKpiVerifier.Mode.AGREE);

        vm.expectRevert(
            abi.encodeWithSelector(IGuardedKpiVerifier.VerifierDisagreement.selector, 90, 50, 40, 0)
        );
        guard.verify(campaign, KPI, alice, 100, "", "");
    }

    // ── CAP ──────────────────────────────────────────────────────

    function test_Verify_capTakesProjectWhenLower() public {
        _report(alice, 100);
        stub.set(40);
        _guard(address(stub), 0, IGuardedKpiVerifier.Mode.CAP);

        assertEq(guard.verify(campaign, KPI, alice, 100, "", ""), 40);
    }

    function test_Verify_capTakesBoneyWhenLower() public {
        _report(alice, 30);
        stub.set(90);
        _guard(address(stub), 0, IGuardedKpiVerifier.Mode.CAP);

        assertEq(guard.verify(campaign, KPI, alice, 100, "", ""), 30);
    }

    function testFuzz_Verify_capNeverExceedsEitherReadingOrTheClaim(
        uint256 observed,
        uint256 projectValue,
        uint256 claim
    ) public {
        _report(alice, observed);
        stub.set(projectValue);
        _guard(address(stub), 0, IGuardedKpiVerifier.Mode.CAP);

        uint256 credited = guard.verify(campaign, KPI, alice, claim, "", "");
        assertLe(credited, claim);
        assertLe(credited, observed);
        assertLe(credited, projectValue);
    }

    // ── the case that motivated Mode ─────────────────────────────

    /// @notice Composing the real `TouchWindowVerifier` after a promoter switch.
    /// @dev The two verifiers measure deliberately different things. Boney's totals accumulate across
    ///      relayer runs, so they retain activity from the era when an *earlier* promoter held
    ///      attribution. `TouchWindowVerifier` floors at the *current* touch's `signedAt`, so it
    ///      discards exactly that activity on purpose.
    ///
    ///      So they disagree by construction, not by fault, and `AGREE` would revert every legitimate
    ///      report after any switch — which is why `CAP` exists. This test pins both halves of that
    ///      claim, because a future change that "simplifies" the guard back to one mode would break
    ///      promoter switching and pass every other test in this file.
    function test_Verify_touchWindowUnderCapSurvivesPromoterSwitch() public {
        (MockCampaign mock, TouchWindowVerifier touch, bytes memory evidence) = _promoterSwitchFixture();

        vm.prank(owner);
        boney.setKpiConfig(
            address(mock),
            KPI,
            address(0xDEAD),
            SIG,
            0,
            IEventMetricKpiVerifier.Aggregation.SUM,
            1,
            1,
            1,
            1_000
        );
        // Boney saw all 100 units: 60 under the first promoter, 40 under the second.
        address[] memory users = new address[](1);
        uint256[] memory totals = new uint256[](1);
        users[0] = alice;
        totals[0] = 100;
        vm.prank(reporter);
        boney.reportBatch(address(mock), KPI, users, totals, 500);

        // CAP credits only the 40 units the current promoter actually held attribution for.
        vm.prank(owner);
        guard.setGuardConfig(address(mock), KPI, address(touch), 0, IGuardedKpiVerifier.Mode.CAP);
        assertEq(guard.verify(address(mock), KPI, alice, 100, evidence, abi.encode(uint64(0))), 40);

        // The same configuration under AGREE rejects the report outright.
        vm.prank(owner);
        guard.setGuardConfig(address(mock), KPI, address(touch), 0, IGuardedKpiVerifier.Mode.AGREE);
        vm.expectRevert(
            abi.encodeWithSelector(IGuardedKpiVerifier.VerifierDisagreement.selector, 40, 100, 60, 0)
        );
        guard.verify(address(mock), KPI, alice, 100, evidence, abi.encode(uint64(0)));
    }

    // ── helpers ──────────────────────────────────────────────────

    /// @dev Builds a user attributed to one promoter, active, then re-attributed to another and active
    ///      again — with evidence covering both eras, as a cumulative reporter would send.
    function _promoterSwitchFixture()
        internal
        returns (MockCampaign mock, TouchWindowVerifier touch, bytes memory evidence)
    {
        AttributionRegistry attribution = new AttributionRegistry(MAX_TOUCH);
        touch = new TouchWindowVerifier();
        mock = new MockCampaign(IAttributionRegistry(address(attribution)));

        bytes32 first = keccak256("promoter-a");
        bytes32 second = keccak256("promoter-b");
        mock.register(first);
        mock.register(second);

        uint256 alicePk = 0x5EED;
        alice = vm.addr(alicePk);

        uint64 firstSignedAt = uint64(block.timestamp);
        _storeTouch(attribution, mock, alicePk, first, firstSignedAt);

        // The switch. `signedAt` must be strictly newer, and it becomes the floor below which
        // `TouchWindowVerifier` credits nothing.
        vm.warp(block.timestamp + 1 days);
        uint64 secondSignedAt = uint64(block.timestamp);
        _storeTouch(attribution, mock, alicePk, second, secondSignedAt);

        TouchWindowVerifier.Action[] memory actions = new TouchWindowVerifier.Action[](2);
        actions[0] = TouchWindowVerifier.Action({timestamp: firstSignedAt + 1 hours, amount: 60});
        actions[1] = TouchWindowVerifier.Action({timestamp: secondSignedAt + 1 hours, amount: 40});

        // Actions must not be future-dated or the adapter rejects the evidence outright.
        vm.warp(block.timestamp + 2 hours);

        evidence = abi.encode(actions);
    }

    function _storeTouch(
        AttributionRegistry attribution,
        MockCampaign mock,
        uint256 pk,
        bytes32 promoterId,
        uint64 signedAt
    ) internal {
        IAttributionRegistry.Touch memory t = IAttributionRegistry.Touch({
            campaign: address(mock),
            promoterId: promoterId,
            signedAt: signedAt,
            expiresAt: uint64(block.timestamp) + 7 days
        });
        bytes32 structHash = keccak256(
            abi.encode(attribution.TOUCH_TYPEHASH(), t.campaign, t.promoterId, t.signedAt, t.expiresAt)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", attribution.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        attribution.storeTouch(vm.addr(pk), t, abi.encodePacked(r, s, v), vm.addr(pk));
    }

    function _guard(address projectVerifier, uint16 toleranceBps, IGuardedKpiVerifier.Mode mode) internal {
        vm.prank(owner);
        guard.setGuardConfig(campaign, KPI, projectVerifier, toleranceBps, mode);
    }

    function _report(address user, uint256 total) internal {
        address[] memory users = new address[](1);
        uint256[] memory totals = new uint256[](1);
        users[0] = user;
        totals[0] = total;

        vm.prank(reporter);
        boney.reportBatch(campaign, KPI, users, totals, 500);
    }
}
