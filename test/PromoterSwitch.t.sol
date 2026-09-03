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
import {IAttributionRegistry} from "../src/interfaces/IAttributionRegistry.sol";
import {ICampaign} from "../src/interfaces/ICampaign.sol";
import {Types} from "../src/libraries/Types.sol";

contract MockToken is ERC20 {
    constructor() ERC20("Mock", "MOCK") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @title Promoter switching mid-campaign
/// @notice What happens to promoter A when the same referral signs a link from promoter B.
///
///         Two separate questions that are easy to conflate:
///
///          1. **Does the switch take effect immediately, or is A protected until their touch
///             expires?** Immediately. `storeTouch` orders on `signedAt` alone and never checks
///             whether the stored touch is still live, and `_touches[user][campaign]` is a single
///             slot — so B overwrites A outright. `attributionWindow` / `expiresAt` govern how long
///             a touch keeps crediting *absent a replacement*; they do not reserve the user.
///
///          2. **What happens to actions A already drove but nobody reported yet?** They stay with
///             A. The registry keeps every superseded touch, so `reportUserAction` can ask who held
///             the user at each action's block and split one report across promoters. A report
///             carrying no per-action evidence has nothing to split, so it is only accepted while one
///             promoter held the user for the whole span since the last report.
///
///         So reporting cadence is an ops detail again rather than an attribution parameter — as long
///         as the reporter sends evidence.
contract PromoterSwitchTest is Test {
    uint256 internal constant POOL = 10_000 ether;
    uint64 internal constant MAX_TOUCH = 30 days;
    uint256 internal constant THRESHOLD = 10;
    uint256 internal constant TIER_REWARD = 1_000 ether;

    MockToken internal token;
    EscrowVault internal vault;
    CampaignRegistry internal registry;
    AttributionRegistry internal attribution;
    AttestationVerifier internal attestation;
    ReputationRegistry internal reputation;
    Campaign internal campaign;

    address internal admin = address(0xA11CE);
    address internal project = address(0xC0DE);
    address internal oracle = address(0x0BAC);
    address internal promoterA = address(0xC01);
    address internal promoterB = address(0xC02);

    uint256 internal userPk = 0x5EED;
    address internal user;

    uint64 internal startTime;
    uint64 internal endTime;

    function setUp() public {
        user = vm.addr(userPk);
        vm.warp(1_000_000);
        startTime = uint64(block.timestamp);
        endTime = uint64(block.timestamp + 30 days);

        token = new MockToken();
        attribution = new AttributionRegistry(MAX_TOUCH);
        attestation = new AttestationVerifier(admin, admin);
        reputation = new ReputationRegistry(admin, address(attestation));
        vault = new EscrowVault(address(this));
        registry = new CampaignRegistry(address(vault), address(reputation), address(attribution), oracle);
        vault.setRegistrar(address(registry));

        campaign = _createCampaign();
        _activate();
    }

    // ── the two questions ────────────────────────────────────────

    /// @dev Q1. A's touch is live for another 6 days when B's lands, and B still takes over on the
    ///      spot. There is no lockout period.
    function test_SwitchTakesEffectImmediatelyWhileTheOldTouchIsStillLive() public {
        bytes32 idA = _join(promoterA);
        bytes32 idB = _join(promoterB);

        _touch(idA, 7 days);
        uint64 aExpires = attribution.touchOf(address(campaign), user).expiresAt;

        skip(1 days);
        _touch(idB, 7 days);

        assertGt(aExpires, block.timestamp, "A's touch had not expired");
        assertEq(attribution.activePromoter(address(campaign), user), idB, "B holds attribution now");
    }

    /// @dev Q2. A drives 30 units, nobody reports, B takes over and drives 20 more. One report
    ///      carrying both actions pays each promoter for their own.
    function test_UnreportedWorkStaysWithTheOriginalPromoter() public {
        bytes32 idA = _join(promoterA);
        bytes32 idB = _join(promoterB);

        Types.Action[] memory actions = new Types.Action[](2);

        _touch(idA, 7 days);
        _advance(1 hours);
        actions[0] = _act(30);

        _advance(1 days);
        _touch(idB, 7 days);
        _advance(1 hours);
        actions[1] = _act(20);

        _report(50, _evidence(actions));

        assertEq(campaign.progressOf(promoterA, 0), 30, "A keeps what A drove");
        assertEq(campaign.progressOf(promoterB, 0), 20, "B receives only their own");
        assertEq(campaign.creditedToOf(user, 0, idA), 30);
        assertEq(campaign.creditedToOf(user, 0, idB), 20);
        assertEq(token.balanceOf(promoterA), TIER_REWARD, "A is paid");
        assertEq(token.balanceOf(promoterB), TIER_REWARD, "and so is B");
    }

    /// @dev With no per-action evidence there is nothing to split the delta by, and a switch inside
    ///      the unreported span means the work's own promoter is unknowable. Refused, not guessed.
    function test_EmptyEvidenceAfterASwitchIsRejected() public {
        bytes32 idA = _join(promoterA);
        bytes32 idB = _join(promoterB);

        _touch(idA, 7 days);
        // A drives 50 units of activity here. The project does not report it.

        skip(1 days);
        _touch(idB, 7 days);

        vm.prank(project);
        vm.expectRevert(abi.encodeWithSelector(ICampaign.AmbiguousAttribution.selector, user, 0));
        campaign.reportUserAction(0, user, 50, "");

        assertEq(campaign.progressOf(promoterA, 0), 0, "nothing moves either way");
        assertEq(campaign.progressOf(promoterB, 0), 0);
    }

    /// @dev The fallback itself is unchanged: one promoter across the span has nothing to confuse, so
    ///      an evidence-free report still credits the touch holder.
    function test_EmptyEvidenceWithOnePromoterStillCredits() public {
        bytes32 idA = _join(promoterA);
        _join(promoterB);

        _touch(idA, 7 days);
        _advance(1 hours);

        vm.prank(project);
        campaign.reportUserAction(0, user, 50, "");

        assertEq(campaign.progressOf(promoterA, 0), 50, "A held the whole span");
        assertEq(campaign.progressOf(promoterB, 0), 0);
        assertEq(token.balanceOf(promoterA), TIER_REWARD, "and is paid");
    }

    /// @dev A promoter re-signing the same user is not a switch, so the span stays unambiguous.
    function test_EmptyEvidenceSurvivesARetouchByTheSamePromoter() public {
        bytes32 idA = _join(promoterA);

        _touch(idA, 1 days);
        skip(2 days); // lapses, which is what lets the same promoter touch again
        _advance(1 hours);
        _touch(idA, 7 days);
        _advance(1 hours);

        vm.prank(project);
        campaign.reportUserAction(0, user, 50, "");

        assertEq(campaign.progressOf(promoterA, 0), 50, "two touches, one promoter");
    }

    /// @dev The span starts at the last report, not at the campaign, so a switch already accounted
    ///      for does not block evidence-free reports forever.
    function test_EmptyEvidenceIsAcceptedOnceTheSwitchIsBehindTheLastReport() public {
        bytes32 idA = _join(promoterA);
        bytes32 idB = _join(promoterB);

        _touch(idA, 7 days);
        _advance(1 hours);
        Types.Action[] memory actions = new Types.Action[](1);
        actions[0] = _act(10);

        _advance(1 hours);
        _touch(idB, 7 days);
        _advance(1 hours);
        _report(10, _evidence(actions));

        assertEq(campaign.progressOf(promoterA, 0), 10, "A's action is A's");
        assertEq(campaign.lastReportBlockOf(user, 0), uint64(block.number), "the span is closed here");

        _advance(1 hours);
        vm.prank(project);
        campaign.reportUserAction(0, user, 40, "");

        assertEq(campaign.progressOf(promoterB, 0), 30, "and the rest is B's alone to take");
    }

    // ── boundaries of the split ──────────────────────────────────

    /// @dev A touch stored in the action's own block does not capture it: the registry takes the
    ///      newest touch already on chain *before* that block, so ties go to the older promoter.
    function test_TouchSharingAnActionsBlockCreditsTheOlderPromoter() public {
        bytes32 idA = _join(promoterA);
        bytes32 idB = _join(promoterB);

        _touch(idA, 7 days);
        _advance(1 hours);

        // B's touch and the action land in the same block.
        _touch(idB, 7 days);
        Types.Action[] memory actions = new Types.Action[](1);
        actions[0] = _act(10);

        _advance(1 hours);
        _report(10, _evidence(actions));

        assertEq(campaign.progressOf(promoterA, 0), 10, "the block A still held is A's");
        assertEq(campaign.progressOf(promoterB, 0), 0);
        assertEq(token.balanceOf(promoterA), TIER_REWARD);
    }

    /// @dev A report the verifier's ceiling cut short finishes on the next one without moving credit
    ///      off its promoter. The oldest work is covered first, so B's slice is deferred, not lost.
    function test_CeilingLimitedReportCompletesOnTheRightPromoter() public {
        bytes32 idA = _join(promoterA);
        bytes32 idB = _join(promoterB);

        Types.Action[] memory actions = new Types.Action[](2);

        _touch(idA, 7 days);
        _advance(1 hours);
        actions[0] = _act(30);

        _advance(1 days);
        _touch(idB, 7 days);
        _advance(1 hours);
        actions[1] = _act(20);

        // The evidence covers both actions, but the reported total has only caught up to A's.
        _report(30, _evidence(actions));
        assertEq(campaign.progressOf(promoterA, 0), 30);
        assertEq(campaign.progressOf(promoterB, 0), 0, "B's slice is deferred");

        _report(50, _evidence(actions));
        assertEq(campaign.progressOf(promoterA, 0), 30, "A is not credited twice");
        assertEq(campaign.progressOf(promoterB, 0), 20, "the remainder lands on the promoter who drove it");
        assertEq(campaign.userCreditedOf(user, 0), 50);
    }

    /// @dev An action performed after a touch lapsed with no successor credits nobody, rather than
    ///      falling to whoever appears next. The report writes nothing, so it stays reportable.
    function test_ActionInAnAttributionGapCreditsNobody() public {
        bytes32 idA = _join(promoterA);
        _join(promoterB);

        _touch(idA, 1 days);
        _advance(2 days);

        Types.Action[] memory actions = new Types.Action[](1);
        actions[0] = _act(10);

        _advance(1 hours);
        _report(10, _evidence(actions));

        assertEq(campaign.progressOf(promoterA, 0), 0, "an expired touch credits nothing");
        assertEq(campaign.progressOf(promoterB, 0), 0, "and it does not fall to the next promoter");
        assertEq(campaign.userCreditedOf(user, 0), 0, "nothing was written off");
    }

    /// @dev Two spells for the same promoter are one tally, and the per-promoter ledger always sums
    ///      back to the user's watermark.
    function test_SplitReportKeepsTheLedgerConsistent() public {
        bytes32 idA = _join(promoterA);
        bytes32 idB = _join(promoterB);

        Types.Action[] memory actions = new Types.Action[](4);

        _touch(idA, 7 days);
        _advance(1 hours);
        actions[0] = _act(5);

        _advance(1 hours);
        _touch(idB, 7 days);
        _advance(1 hours);
        actions[1] = _act(7);

        _advance(1 hours);
        _touch(idA, 7 days);
        _advance(1 hours);
        actions[2] = _act(3);
        _advance(1 hours);
        actions[3] = _act(4);

        _report(19, _evidence(actions));

        assertEq(campaign.progressOf(promoterA, 0), 12, "A's two spells are one tally");
        assertEq(campaign.progressOf(promoterB, 0), 7);
        assertEq(campaign.totalProgress(0), 19, "the campaign total is the sum of the parts");
        assertEq(
            campaign.creditedToOf(user, 0, idA) + campaign.creditedToOf(user, 0, idB),
            campaign.userCreditedOf(user, 0),
            "the per-promoter ledger sums to the watermark"
        );
    }

    /// @dev The oldest-first walk relies on block order, so evidence that goes backwards is rejected
    ///      rather than mis-split.
    function test_OutOfOrderEvidenceIsRejected() public {
        bytes32 idA = _join(promoterA);
        _touch(idA, 7 days);

        Types.Action[] memory actions = new Types.Action[](2);
        _advance(1 hours);
        actions[1] = _act(5);
        _advance(1 hours);
        actions[0] = _act(5);

        vm.prank(project);
        vm.expectRevert(abi.encodeWithSelector(ICampaign.UnorderedEvidence.selector, 1));
        campaign.reportUserAction(0, user, 10, _evidence(actions));
    }

    /// @dev The walk is bounded, so one report cannot be made arbitrarily expensive.
    function test_TooManyActionsIsRejected() public {
        bytes32 idA = _join(promoterA);
        _touch(idA, 7 days);
        _advance(1 hours);

        uint256 max = campaign.MAX_EVIDENCE_ACTIONS();
        Types.Action[] memory actions = new Types.Action[](max + 1);
        for (uint256 i; i < actions.length; ++i) {
            actions[i] = _act(1);
        }

        vm.prank(project);
        vm.expectRevert(abi.encodeWithSelector(ICampaign.TooManyActions.selector, max + 1, max));
        campaign.reportUserAction(0, user, max + 1, _evidence(actions));
    }

    /// @dev What still works on the no-evidence path: report before the switch. Credit already banked
    ///      is A's permanently, and cumulative `newTotal` means B only ever receives the delta after
    ///      that point.
    function test_ReportingBeforeTheSwitchBanksItForA() public {
        bytes32 idA = _join(promoterA);
        bytes32 idB = _join(promoterB);

        _touch(idA, 7 days);
        vm.prank(project);
        campaign.reportUserAction(0, user, 50, "");

        skip(1 days);
        _touch(idB, 7 days);

        // The user keeps going under B; the report is cumulative, so B receives 70 - 50.
        vm.prank(project);
        campaign.reportUserAction(0, user, 70, "");

        assertEq(campaign.progressOf(promoterA, 0), 50, "A keeps what was banked");
        assertEq(campaign.progressOf(promoterB, 0), 20, "B receives only the delta");
        assertEq(token.balanceOf(promoterA), TIER_REWARD, "A is paid");
        assertEq(token.balanceOf(promoterB), TIER_REWARD, "B is paid too");

        attribution.domain();
    }

    /// @dev A lapse with no replacement is different from a switch: the stored touch is still A's,
    ///      so post-end resolution still pays A. Only a *newer touch* moves the payee.
    function test_LapseWithoutReplacementStillPaysAAfterEnd() public {
        bytes32 idA = _join(promoterA);
        _join(promoterB);

        _touch(idA, 1 days);
        skip(2 days);
        assertEq(attribution.activePromoter(address(campaign), user), bytes32(0), "A's touch lapsed");

        vm.warp(endTime + 1);
        campaign.end();

        vm.prank(project);
        campaign.reportUserAction(0, user, 50, "");

        assertEq(campaign.progressOf(promoterA, 0), 50, "no replacement, so A still earns it");
        assertEq(campaign.progressOf(promoterB, 0), 0, "B never touched this user");
    }

    /// @dev Two touches in the same second cannot both land: ordering is strict, so the second
    ///      reverts rather than silently winning. A promoter racing another in one block loses.
    function test_SameSecondSwitchIsRejected() public {
        bytes32 idA = _join(promoterA);
        bytes32 idB = _join(promoterB);

        _touch(idA, 7 days);

        (IAttributionRegistry.Touch memory t, bytes memory sig) = _sign(idB, 7 days);
        vm.expectRevert(
            abi.encodeWithSelector(IAttributionRegistry.TouchNotNewer.selector, t.signedAt, t.signedAt)
        );
        attribution.storeTouch(user, t, sig, promoterB);

        assertEq(attribution.activePromoter(address(campaign), user), idA, "A holds it");
    }

    /// @dev The campaign's `attributionWindow` is enforced by the registry, not just honoured by
    ///      the client that builds the touch. This campaign is configured for 7 days, so a promoter
    ///      hand-rolling a 30-day touch (the registry's global cap) is rejected — before this the
    ///      advertised window was advisory and a promoter could unilaterally outlive it.
    function test_CampaignWindowIsEnforcedAgainstAHandRolledTouch() public {
        bytes32 idA = _join(promoterA);

        assertEq(campaign.attributionWindow(), 7 days, "campaign asks for 7 days");
        assertEq(attribution.maxTouchDuration(), MAX_TOUCH, "registry caps at 30");
        assertEq(attribution.effectiveMaxDuration(address(campaign)), 7 days, "the tighter one binds");

        uint64 tooLong = uint64(block.timestamp) + 7 days + 1;
        (IAttributionRegistry.Touch memory t, bytes memory sig) = _signUntil(idA, tooLong);

        vm.expectRevert(
            abi.encodeWithSelector(
                IAttributionRegistry.TouchTooLong.selector, tooLong, uint64(block.timestamp) + 7 days
            )
        );
        attribution.storeTouch(user, t, sig, promoterA);

        // The window the campaign advertises is exactly what a referral can grant.
        _touch(idA, 7 days);
        assertEq(attribution.activePromoter(address(campaign), user), idA, "at the limit is fine");
    }

    // ── fixtures ─────────────────────────────────────────────────

    function _createCampaign() internal returns (Campaign) {
        Types.CampaignConfig memory cfg = Types.CampaignConfig({
            project: project,
            name: "Promoter Switch Test",
            token: address(token),
            rewardPool: POOL,
            startTime: startTime,
            endTime: endTime,
            attributionWindow: 7 days,
            minReputation: 0
        });

        Types.KpiSpec[] memory kpis = new Types.KpiSpec[](1);
        kpis[0] = Types.KpiSpec({
            kind: Types.KpiKind.Mint,
            verifier: address(0),
            target: 100,
            aggregate: false,
            params: ""
        });

        Types.RewardTier[][] memory tiers = new Types.RewardTier[][](1);
        tiers[0] = new Types.RewardTier[](1);
        tiers[0][0] = Types.RewardTier({threshold: THRESHOLD, reward: TIER_REWARD});

        vm.prank(project);
        (, address addr) = registry.createCampaign(cfg, kpis, tiers);
        return Campaign(addr);
    }

    function _activate() internal {
        token.mint(project, POOL);
        vm.startPrank(project);
        token.approve(address(vault), POOL);
        vault.deposit(address(campaign), POOL);
        campaign.activate();
        vm.stopPrank();
    }

    function _join(address promoter) internal returns (bytes32) {
        vm.prank(promoter);
        return campaign.join();
    }

    function _sign(bytes32 promoterId, uint64 ttl)
        internal
        view
        returns (IAttributionRegistry.Touch memory t, bytes memory sig)
    {
        return _signUntil(promoterId, uint64(block.timestamp) + ttl);
    }

    function _signUntil(bytes32 promoterId, uint64 expiresAt)
        internal
        view
        returns (IAttributionRegistry.Touch memory t, bytes memory sig)
    {
        t = IAttributionRegistry.Touch({
            campaign: address(campaign),
            promoterId: promoterId,
            signedAt: uint64(block.timestamp),
            expiresAt: expiresAt
        });
        bytes32 structHash = keccak256(
            abi.encode(attribution.TOUCH_TYPEHASH(), t.campaign, t.promoterId, t.signedAt, t.expiresAt)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", attribution.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userPk, digest);
        sig = abi.encodePacked(r, s, v);
    }

    function _touch(bytes32 promoterId, uint64 ttl) internal {
        (IAttributionRegistry.Touch memory t, bytes memory sig) = _sign(promoterId, ttl);
        attribution.storeTouch(user, t, sig, address(this));
    }

    /// @dev Foundry's `skip` only moves the clock. The block has to be rolled too, or evidence shares
    ///      a block with its own touch and resolves to the promoter before it.
    function _advance(uint256 seconds_) internal {
        skip(seconds_);
        vm.roll(block.number + 1);
    }

    function _act(uint256 amount) internal view returns (Types.Action memory) {
        return Types.Action({
            blockNumber: uint64(block.number),
            timestamp: uint64(block.timestamp),
            amount: amount
        });
    }

    function _evidence(Types.Action[] memory actions) internal pure returns (bytes memory) {
        return abi.encode(actions);
    }

    function _report(uint256 newTotal, bytes memory evidence) internal {
        vm.prank(project);
        campaign.reportUserAction(0, user, newTotal, evidence);
    }
}
