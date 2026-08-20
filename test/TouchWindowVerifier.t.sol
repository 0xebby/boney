// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Campaign} from "../src/campaign/Campaign.sol";
import {CampaignRegistry} from "../src/campaign/CampaignRegistry.sol";
import {EscrowVault} from "../src/escrow/EscrowVault.sol";
import {AttributionRegistry} from "../src/attribution/AttributionRegistry.sol";
import {AttestationVerifier} from "../src/reputation/AttestationVerifier.sol";
import {ReputationRegistry} from "../src/reputation/ReputationRegistry.sol";
import {TouchWindowVerifier} from "../src/verifiers/TouchWindowVerifier.sol";
import {IAttributionRegistry} from "../src/interfaces/IAttributionRegistry.sol";
import {Types} from "../src/libraries/Types.sol";
import {ITouchWindowVerifier} from "../src/interfaces/ITouchWindowVerifier.sol";

contract MockToken is ERC20 {
    constructor() ERC20("Mock", "MOCK") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @title TouchWindowVerifier
/// @notice Exercised through a real campaign, because the behaviour that matters is which promoter
///         ends up paid — not what the adapter returns in isolation.
contract TouchWindowVerifierTest is Test {
    uint256 internal constant POOL = 10_000 ether;
    uint64 internal constant MAX_TOUCH = 30 days;
    uint64 internal constant LOOKBACK = 15 minutes;

    MockToken internal token;
    EscrowVault internal vault;
    CampaignRegistry internal registry;
    AttributionRegistry internal attribution;
    AttestationVerifier internal attestor;
    ReputationRegistry internal reputation;
    TouchWindowVerifier internal verifier;
    Campaign internal campaign;

    /// @dev Names are unique per registry, so each fixture campaign needs its own. A storage counter
    ///      rather than an external read: an external call in an argument list would consume the
    ///      pending `vm.prank`/`vm.expectRevert` before the call under test.
    uint256 private _nameNonce;

    address internal admin = address(0xA11CE);
    address internal project = address(0xC0DE);
    address internal oracle = address(0x0BAC);
    address internal kol = address(0xC01);
    address internal kol2 = address(0xC02);

    uint256 internal userPk = 0x5EED;
    address internal user;

    function setUp() public {
        user = vm.addr(userPk);
        vm.warp(1_000_000);

        token = new MockToken();
        attribution = new AttributionRegistry(MAX_TOUCH);
        attestor = new AttestationVerifier(admin, admin);
        reputation = new ReputationRegistry(admin, address(attestor));
        verifier = new TouchWindowVerifier();

        vault = new EscrowVault(address(this));
        registry = new CampaignRegistry(address(vault), address(reputation), address(attribution), oracle);
        vault.setRegistrar(address(registry));

        campaign = _createCampaign(abi.encode(LOOKBACK));
        _activate(campaign);
    }

    // ── fixtures ─────────────────────────────────────────────────

    function _createCampaign(bytes memory params) internal returns (Campaign) {
        Types.CampaignConfig memory cfg = Types.CampaignConfig({
            project: project,
            name: string.concat("Touch Window Test ", vm.toString(_nameNonce++)),
            token: address(token),
            rewardPool: POOL,
            startTime: uint64(block.timestamp),
            endTime: uint64(block.timestamp + 30 days),
            attributionWindow: 7 days,
            minReputation: 0
        });

        Types.KpiSpec[] memory kpis = new Types.KpiSpec[](1);
        kpis[0] = Types.KpiSpec({
            kind: Types.KpiKind.Mint,
            verifier: address(verifier),
            target: 100,
            aggregate: false,
            params: params
        });

        Types.RewardTier[][] memory tiers = new Types.RewardTier[][](1);
        tiers[0] = new Types.RewardTier[](1);
        tiers[0][0] = Types.RewardTier({threshold: 10, reward: 1_000 ether});

        vm.prank(project);
        (, address addr) = registry.createCampaign(cfg, kpis, tiers);
        return Campaign(addr);
    }

    function _activate(Campaign c) internal {
        token.mint(project, POOL);
        vm.startPrank(project);
        token.approve(address(vault), POOL);
        vault.deposit(address(c), POOL);
        c.activate();
        vm.stopPrank();
    }

    function _join(Campaign c, address promoter) internal returns (bytes32) {
        vm.prank(promoter);
        return c.join();
    }

    function _touch(Campaign c, bytes32 promoterId) internal {
        IAttributionRegistry.Touch memory t = IAttributionRegistry.Touch({
            campaign: address(c),
            promoterId: promoterId,
            signedAt: uint64(block.timestamp),
            expiresAt: uint64(block.timestamp) + 7 days
        });
        bytes32 structHash = keccak256(
            abi.encode(attribution.TOUCH_TYPEHASH(), t.campaign, t.promoterId, t.signedAt, t.expiresAt)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", attribution.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userPk, digest);
        attribution.storeTouch(user, t, abi.encodePacked(r, s, v), user);
    }

    function _evidence(TouchWindowVerifier.Action[] memory actions) internal pure returns (bytes memory) {
        return abi.encode(actions);
    }

    function _one(uint64 ts, uint256 amount) internal pure returns (bytes memory) {
        TouchWindowVerifier.Action[] memory a = new TouchWindowVerifier.Action[](1);
        a[0] = TouchWindowVerifier.Action({timestamp: ts, amount: amount});
        return _evidence(a);
    }

    function _report(Campaign c, address u, uint256 total, bytes memory evidence) internal {
        vm.prank(project);
        c.reportUserAction(0, u, total, evidence);
    }

    // ── the gap this adapter exists to close ─────────────────────

    /// @dev Without the adapter, all 10 follow the later touch (see
    ///      `CampaignTest.test_Report_unreportedProgressFollowsTheLaterTouch`). With it, actions
    ///      that predate kol2's touch are not credited to kol2.
    function test_DeniesActionsPredatingTheLiveTouch() public {
        bytes32 id1 = _join(campaign, kol);
        bytes32 id2 = _join(campaign, kol2);

        _touch(campaign, id1);
        uint64 actedAt = uint64(block.timestamp);

        // The user acts under kol, then kol2 gets a touch signed before the report lands.
        skip(1 days);
        _touch(campaign, id2);

        _report(campaign, user, 10, _one(actedAt, 10));

        assertEq(campaign.progressOf(kol2, 0), 0, "kol2 cannot capture pre-touch activity");
        assertEq(campaign.progressOf(kol, 0), 0, "and a verifier cannot redirect it to kol either");
        assertEq(campaign.paidOut(), 0, "no tier crossed, nothing paid");
    }

    /// @dev The denied progress is not burned: `_userCredited` never advanced, so once the right
    ///      promoter is attributed again the same cumulative report lands and pays out.
    function test_DeniedProgressIsRecoverableByTheRightPromoter() public {
        bytes32 id1 = _join(campaign, kol);
        bytes32 id2 = _join(campaign, kol2);

        _touch(campaign, id1);
        uint64 actedAt = uint64(block.timestamp);

        skip(1 days);
        _touch(campaign, id2);
        _report(campaign, user, 10, _one(actedAt, 10));
        assertEq(campaign.progressOf(kol2, 0), 0);

        // The user re-signs for kol, whose window now covers the original action's lookback.
        skip(1 days);
        _touch(campaign, id1);
        _report(campaign, user, 10, _one(uint64(block.timestamp), 10));

        assertEq(campaign.progressOf(kol, 0), 10, "credited once the right promoter is live");
        assertEq(token.balanceOf(kol), 1_000 ether, "tier paid");
    }

    /// @dev Actions inside the window are credited normally — the adapter must not tax the happy
    ///      path.
    function test_CreditsActionsInsideTheWindow() public {
        bytes32 id = _join(campaign, kol);
        _touch(campaign, id);

        skip(1 hours);
        _report(campaign, user, 10, _one(uint64(block.timestamp), 10));

        assertEq(campaign.progressOf(kol, 0), 10);
        assertEq(token.balanceOf(kol), 1_000 ether);
    }

    /// @dev Users routinely click a link, act, and only then sign. `lookback` is what keeps that
    ///      ordering creditable.
    function test_LookbackCreditsActionJustBeforeTheSignature() public {
        bytes32 id = _join(campaign, kol);

        uint64 actedAt = uint64(block.timestamp);
        skip(LOOKBACK - 1);
        _touch(campaign, id);

        _report(campaign, user, 10, _one(actedAt, 10));

        assertEq(campaign.progressOf(kol, 0), 10, "act-then-sign is still credited");
    }

    function test_LookbackBoundaryIsInclusive() public {
        bytes32 id = _join(campaign, kol);

        uint64 actedAt = uint64(block.timestamp);
        skip(LOOKBACK);
        _touch(campaign, id);

        _report(campaign, user, 10, _one(actedAt, 10));

        assertEq(campaign.progressOf(kol, 0), 10, "exactly at the floor counts");
    }

    function test_JustOutsideLookbackIsDenied() public {
        bytes32 id = _join(campaign, kol);

        uint64 actedAt = uint64(block.timestamp);
        skip(LOOKBACK + 1);
        _touch(campaign, id);

        _report(campaign, user, 10, _one(actedAt, 10));

        assertEq(campaign.progressOf(kol, 0), 0, "one second past the floor is out");
    }

    // ── partial credit ───────────────────────────────────────────

    /// @dev A report spanning a re-attribution credits only the qualifying slice.
    function test_CreditsOnlyTheQualifyingSubset() public {
        bytes32 id1 = _join(campaign, kol);
        bytes32 id2 = _join(campaign, kol2);

        _touch(campaign, id1);
        uint64 early = uint64(block.timestamp);

        skip(1 days);
        _touch(campaign, id2);
        uint64 late = uint64(block.timestamp);

        TouchWindowVerifier.Action[] memory actions = new TouchWindowVerifier.Action[](2);
        actions[0] = TouchWindowVerifier.Action({timestamp: early, amount: 6});
        actions[1] = TouchWindowVerifier.Action({timestamp: late, amount: 4});

        _report(campaign, user, 10, _evidence(actions));

        assertEq(campaign.progressOf(kol2, 0), 4, "only post-touch activity");
        assertEq(campaign.progressOf(kol, 0), 0);
    }

    // ── fail-closed behaviour ────────────────────────────────────

    /// @dev A KPI wired to this adapter requires evidence. Absent it, nothing is credited — and
    ///      `Campaign` treats a zero credit as a no-op rather than a revert, so the report can be
    ///      resubmitted with evidence.
    function test_MissingEvidenceCreditsNothing() public {
        bytes32 id = _join(campaign, kol);
        _touch(campaign, id);

        _report(campaign, user, 10, "");
        assertEq(campaign.progressOf(kol, 0), 0, "no evidence, no credit");

        _report(campaign, user, 10, _one(uint64(block.timestamp), 10));
        assertEq(campaign.progressOf(kol, 0), 10, "resubmitting with evidence still works");
    }

    /// @dev A future-dated action would clear any floor, so it is rejected outright rather than
    ///      silently skipped.
    function test_RevertsOnFutureDatedAction() public {
        bytes32 id = _join(campaign, kol);
        _touch(campaign, id);

        uint64 future = uint64(block.timestamp) + 1;

        vm.prank(project);
        vm.expectRevert(
            abi.encodeWithSelector(
                ITouchWindowVerifier.FutureAction.selector, future, uint64(block.timestamp)
            )
        );
        campaign.reportUserAction(0, user, 10, _one(future, 10));
    }

    /// @dev Evidence claiming more than the report means the two disagree about what happened.
    function test_RevertsWhenEvidenceExceedsTheClaim() public {
        bytes32 id = _join(campaign, kol);
        _touch(campaign, id);

        vm.prank(project);
        vm.expectRevert(abi.encodeWithSelector(ITouchWindowVerifier.EvidenceExceedsClaim.selector, 11, 10));
        campaign.reportUserAction(0, user, 10, _one(uint64(block.timestamp), 11));
    }

    /// @dev Evidence covering less than the claim is a discount, not an error — the remainder is
    ///      simply uncredited and can be substantiated later.
    function test_EvidenceBelowClaimIsADiscount() public {
        bytes32 id = _join(campaign, kol);
        _touch(campaign, id);

        _report(campaign, user, 10, _one(uint64(block.timestamp), 6));

        assertEq(campaign.progressOf(kol, 0), 6);
    }

    // ── params ───────────────────────────────────────────────────

    /// @dev An unconfigured KPI is strict, which is the safe reading of "unset".
    function test_MissingParamsMeansZeroLookback() public {
        Campaign strict = _createCampaign("");
        _activate(strict);

        bytes32 id = _join(strict, kol);
        uint64 actedAt = uint64(block.timestamp);
        skip(1);
        _touch(strict, id);

        _report(strict, user, 10, _one(actedAt, 10));

        assertEq(strict.progressOf(kol, 0), 0, "no lookback configured, nothing before the touch");
    }

    function test_WindowFloorReflectsLookback() public {
        bytes32 id = _join(campaign, kol);
        _touch(campaign, id);

        assertEq(
            verifier.windowFloor(address(campaign), user, abi.encode(LOOKBACK)),
            uint64(block.timestamp) - LOOKBACK
        );
        assertEq(verifier.windowFloor(address(campaign), user, ""), uint64(block.timestamp));
    }

    /// @dev A lookback longer than the chain's history must not underflow.
    function test_WindowFloorClampsAtZero() public {
        bytes32 id = _join(campaign, kol);
        _touch(campaign, id);

        assertEq(verifier.windowFloor(address(campaign), user, abi.encode(type(uint64).max)), 0);
    }

    /// @dev A user with no touch at all credits nothing rather than reverting inside the adapter.
    function test_NoTouchCreditsNothing() public view {
        assertEq(
            verifier.verify(address(campaign), 0, address(0xDEAD), 10, _one(uint64(block.timestamp), 10), ""),
            0
        );
    }

    // ── fuzz ─────────────────────────────────────────────────────

    /// @dev Whatever the timings, the adapter credits an action exactly when it lands at or after
    ///      the floor — and never more than was claimed.
    function testFuzz_CreditsIffInsideWindow(uint64 lookback, uint64 gap, uint256 amount) public {
        lookback = uint64(bound(lookback, 0, 3 days));
        gap = uint64(bound(gap, 0, 7 days));
        amount = bound(amount, 1, 1_000);

        bytes32 id = _join(campaign, kol);

        uint64 actedAt = uint64(block.timestamp);
        skip(gap);
        _touch(campaign, id);

        uint256 credited =
            verifier.verify(address(campaign), 0, user, amount, _one(actedAt, amount), abi.encode(lookback));

        assertEq(credited, gap <= lookback ? amount : 0);
        assertLe(credited, amount, "a verifier may only discount");
    }
}
