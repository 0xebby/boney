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
///          2. **What happens to actions A already drove but nobody reported yet?** They follow B.
///             `reportUserAction` resolves the payee when the report *lands*, and the chain cannot
///             see when an action happened, so on a KPI with no verifier the whole un-reported
///             delta goes to whoever holds the touch at report time. This is the reporting-cadence
///             gap `TouchWindowVerifier` exists to close — and it can only *deny* B the slice, never
///             award it to A (`test_CreditsOnlyTheQualifyingSubset`).
///
///         The practical consequence: reporting cadence is an attribution parameter, not just an
///         ops detail. The longer the gap between reports, the more of A's work a later B can take.
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

    /// @dev Q2, the expensive half. A drives 50 units, nobody reports, B takes over, and the first
    ///      report credits **all 50 to B** — including everything that happened before B existed in
    ///      the picture. A is paid nothing.
    function test_UnreportedWorkFollowsTheNewPromoter() public {
        bytes32 idA = _join(promoterA);
        bytes32 idB = _join(promoterB);

        _touch(idA, 7 days);
        // A drives 50 units of activity here. The project does not report it.

        skip(1 days);
        _touch(idB, 7 days);

        vm.prank(project);
        campaign.reportUserAction(0, user, 50, "");

        assertEq(campaign.progressOf(promoterA, 0), 0, "A gets nothing for work they drove");
        assertEq(campaign.progressOf(promoterB, 0), 50, "B is credited for all of it");
        assertEq(token.balanceOf(promoterB), TIER_REWARD, "and paid");
    }

    /// @dev The mitigation available today with no new contract code: report before the switch.
    ///      Credit already banked is A's permanently, and cumulative `newTotal` means B only ever
    ///      receives the delta after that point.
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
            abi.encodeWithSelector(AttributionRegistry.TouchNotNewer.selector, t.signedAt, t.signedAt)
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
                AttributionRegistry.TouchTooLong.selector, tooLong, uint64(block.timestamp) + 7 days
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
}
