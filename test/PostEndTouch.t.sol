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

/// @dev Answers `endTime` normally but reports a status outside the enum, standing in for a
///      hostile or buggy registrant. Decoding that into `Types.CampaignStatus` would panic; the
///      registry compares numerically so it fails closed instead.
contract GarbageStatusCampaign {
    uint64 public attributionWindow = 7 days;
    uint64 public immutable endTime;

    constructor(uint64 endTime_) {
        endTime = endTime_;
    }

    function status() external pure returns (uint256) {
        return 255;
    }
}

/// @title Post-end attribution — closed
/// @notice A promoter who did no work could take another promoter's payout by having the referral
///         re-sign after the campaign was over.
///
///         `Campaign._resolvePromoterId` honours the *stored* touch during `CLAIM_GRACE` even when
///         it has expired — without that, every withheld report filed in the grace window would
///         revert `NoAttribution` and hand the project back the escrow the window exists to
///         protect. The safety argument for that relaxation was that the stored touch is always
///         the referral's latest signed intent. But `storeTouch` read only the campaign's
///         `attributionWindow`, which caps a touch's duration relative to `block.timestamp` and
///         says nothing about where that sits relative to the campaign. So a touch could be
///         created after the campaign closed, and "latest intent" could be manufactured for work
///         that never happened in-campaign.
///
///         `storeTouch` now bounds touch creation to the campaign's life, on two axes that are
///         both needed:
///          1. `CampaignOver` — past `endTime`. Reports are already refused there, but a touch
///             stored in that state goes live the moment the permissionless `end()` lands.
///          2. `CampaignTerminal` — Ended or Cancelled. A project may end early, in which case
///             `block.timestamp` never reaches `endTime` and bound 1 never fires.
contract PostEndTouchTest is Test {
    uint256 internal constant POOL = 10_000 ether;
    uint64 internal constant MAX_TOUCH = 30 days;
    uint256 internal constant THRESHOLD = 10;
    uint256 internal constant TIER_REWARD = 1_000 ether;
    uint256 internal constant DELIVERED = 50;

    MockToken internal token;
    EscrowVault internal vault;
    CampaignRegistry internal registry;
    AttributionRegistry internal attribution;
    AttestationVerifier internal attestation;
    ReputationRegistry internal reputation;
    Campaign internal campaign;

    address internal admin = address(0xA11CE);
    address internal project = address(0xC0DE);
    address internal promoter = address(0xC01);
    address internal promoter2 = address(0xC02);
    address internal oracle = address(0x04AC);

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

        campaign = _createCampaign("Post End Touch");
        _activate(campaign);
    }

    // ── the vector, now closed ───────────────────────────────────

    /// @dev The steal, end to end. Same setup as before the fix; the overwrite is what now fails,
    ///      so the promoter who delivered the referral keeps the payout.
    function test_LatecomerCannotStealDuringGrace() public {
        vm.prank(promoter);
        bytes32 id1 = campaign.join();
        vm.prank(promoter2);
        bytes32 id2 = campaign.join();

        // The honest promoter delivers the referral, inside the window.
        (IAttributionRegistry.Touch memory t1, bytes memory s1) = _signNow(id1, 7 days);
        attribution.storeTouch(user, t1, s1, promoter);
        assertEq(attribution.activePromoter(address(campaign), user), id1, "earner is attributed");

        // The window closes and the campaign ends. The project has still reported nothing.
        vm.warp(endTime + 1);
        campaign.end();

        // Inside CLAIM_GRACE, the latecomer tries to buy the referral with a fresh signature.
        (IAttributionRegistry.Touch memory t2, bytes memory s2) = _signNow(id2, 7 days);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAttributionRegistry.CampaignOver.selector, endTime, uint64(block.timestamp)
            )
        );
        attribution.storeTouch(user, t2, s2, promoter2);

        // The withheld report lands on the promoter who actually earned it.
        vm.prank(project);
        campaign.reportUserAction(0, user, DELIVERED, "");

        assertEq(token.balanceOf(promoter), TIER_REWARD, "earner is paid");
        assertEq(token.balanceOf(promoter2), 0, "latecomer gets nothing");
    }

    /// @dev Bound 1 in isolation: past `endTime`, with nobody having called `end()` yet. The
    ///      campaign is still Active here, so the terminal check does not fire — this is the case
    ///      that would otherwise leave a touch primed to go live on the next `end()`.
    function test_TouchRejectedPastEndTimeWhileStillActive() public {
        vm.prank(promoter);
        bytes32 id = campaign.join();

        vm.warp(endTime + 10 days);
        assertEq(uint8(campaign.status()), uint8(Types.CampaignStatus.Active), "never ended");

        (IAttributionRegistry.Touch memory t, bytes memory sig) = _signNow(id, 7 days);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAttributionRegistry.CampaignOver.selector, endTime, uint64(block.timestamp)
            )
        );
        attribution.storeTouch(user, t, sig, promoter);
    }

    /// @dev Bound 2 in isolation: an early `end()`, so `block.timestamp` is still well inside the
    ///      configured window and `CampaignOver` cannot fire. An endTime-only guard would miss the
    ///      steal entirely here, since `Campaign` opens CLAIM_GRACE on `end()` regardless of when.
    function test_TouchRejectedAfterEarlyEndWithTimestampInsideWindow() public {
        vm.prank(promoter);
        bytes32 id = campaign.join();

        skip(1 days);
        vm.prank(project);
        campaign.end();
        assertLt(block.timestamp, campaign.endTime(), "still inside the configured window");

        (IAttributionRegistry.Touch memory t, bytes memory sig) = _signNow(id, 7 days);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAttributionRegistry.CampaignTerminal.selector, uint256(Types.CampaignStatus.Ended)
            )
        );
        attribution.storeTouch(user, t, sig, promoter);
    }

    /// @dev Cancelled is terminal too. A cancelled campaign pays nobody, so attribution against it
    ///      is meaningless rather than merely late.
    function test_TouchRejectedOnceCancelled() public {
        Campaign pending = _createCampaign("Cancelled Campaign");

        vm.prank(promoter);
        bytes32 id = pending.join(); // joining is allowed while Pending

        vm.prank(project);
        pending.cancel();

        (IAttributionRegistry.Touch memory t, bytes memory sig) = _signNowFor(pending, id, 7 days);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAttributionRegistry.CampaignTerminal.selector, uint256(Types.CampaignStatus.Cancelled)
            )
        );
        attribution.storeTouch(user, t, sig, promoter);
    }

    // ── boundaries ───────────────────────────────────────────────

    /// @dev `endTime` itself is inclusive, matching `Campaign._requireWindow` — which rejects on
    ///      `block.timestamp > endTime`, so a report can still land on that second. Attribution
    ///      closing one second early would strand a referral the campaign would still credit.
    function test_TouchAcceptedOnTheFinalSecondOfTheWindow() public {
        vm.prank(promoter);
        bytes32 id = campaign.join();

        vm.warp(endTime);
        (IAttributionRegistry.Touch memory t, bytes memory sig) = _signNow(id, 7 days);
        attribution.storeTouch(user, t, sig, promoter);

        assertEq(attribution.activePromoter(address(campaign), user), id, "the boundary second lands");

        vm.prank(project);
        campaign.reportUserAction(0, user, DELIVERED, "");
        assertEq(token.balanceOf(promoter), TIER_REWARD, "and the report on that second pays");
    }

    /// @dev One second later it is shut, so the two boundaries cannot drift apart unnoticed.
    function test_TouchRejectedOneSecondPastTheWindow() public {
        vm.prank(promoter);
        bytes32 id = campaign.join();

        vm.warp(uint256(endTime) + 1);
        (IAttributionRegistry.Touch memory t, bytes memory sig) = _signNow(id, 7 days);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAttributionRegistry.CampaignOver.selector, endTime, uint64(block.timestamp)
            )
        );
        attribution.storeTouch(user, t, sig, promoter);
    }

    // ── what the fix must not break ──────────────────────────────

    /// @dev The report-withholding fix depends on a touch stored *before* the end still paying
    ///      during CLAIM_GRACE, expired or not. Only touch creation is bounded, not resolution.
    function test_StoredTouchStillPaysAfterEnd() public {
        vm.prank(promoter);
        bytes32 id = campaign.join();

        (IAttributionRegistry.Touch memory t, bytes memory sig) = _signNow(id, 1 days);
        attribution.storeTouch(user, t, sig, promoter);

        vm.warp(endTime + 1);
        campaign.end();
        assertEq(attribution.activePromoter(address(campaign), user), bytes32(0), "touch long expired");

        vm.prank(project);
        campaign.reportUserAction(0, user, DELIVERED, "");
        assertEq(token.balanceOf(promoter), TIER_REWARD, "the promoter who earned it is still paid");
    }

    /// @dev The registry does not require a registrant to be a campaign — registration is
    ///      namespaced by sender, so an EOA registrant lives in a namespace no campaign reads.
    ///      It answers neither `endTime` nor `status`, so it is unbounded here, exactly as it is
    ///      for `_effectiveMaxDuration`. A typed call would have turned that into a hard revert.
    function test_NonCampaignRegistrantIsUnbounded() public {
        address notACampaign = address(0xE0A);

        vm.prank(notACampaign);
        attribution.registerPromoter(bytes32("id"));

        IAttributionRegistry.Touch memory t = IAttributionRegistry.Touch({
            campaign: notACampaign,
            promoterId: bytes32("id"),
            signedAt: uint64(block.timestamp),
            expiresAt: uint64(block.timestamp) + MAX_TOUCH
        });
        attribution.storeTouch(user, t, _sign(t), notACampaign);

        assertEq(attribution.activePromoter(notACampaign, user), bytes32("id"), "still stored");
    }

    /// @dev A registrant reporting a status outside the enum fails closed rather than panicking on
    ///      the decode, so it cannot brick or bypass the guard.
    function test_OutOfRangeStatusIsTreatedAsTerminal() public {
        GarbageStatusCampaign hostile = new GarbageStatusCampaign(endTime);

        vm.prank(address(hostile));
        attribution.registerPromoter(bytes32("id"));

        IAttributionRegistry.Touch memory t = IAttributionRegistry.Touch({
            campaign: address(hostile),
            promoterId: bytes32("id"),
            signedAt: uint64(block.timestamp),
            expiresAt: uint64(block.timestamp) + 7 days
        });
        // Signed before `expectRevert`: the helper reads the registry, and that read would
        // otherwise be the "next call" the expectation attaches to.
        bytes memory sig = _sign(t);

        vm.expectRevert(abi.encodeWithSelector(IAttributionRegistry.CampaignTerminal.selector, 255));
        attribution.storeTouch(user, t, sig, address(hostile));
    }

    // ── fixtures ─────────────────────────────────────────────────

    function _createCampaign(string memory campaignName) internal returns (Campaign) {
        Types.CampaignConfig memory cfg = Types.CampaignConfig({
            project: project,
            name: campaignName,
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

    function _activate(Campaign c) internal {
        token.mint(project, POOL);
        vm.startPrank(project);
        token.approve(address(vault), POOL);
        vault.deposit(address(c), POOL);
        c.activate();
        vm.stopPrank();
    }

    function _signNow(bytes32 promoterId, uint64 ttl)
        internal
        view
        returns (IAttributionRegistry.Touch memory t, bytes memory sig)
    {
        return _signNowFor(campaign, promoterId, ttl);
    }

    function _signNowFor(Campaign c, bytes32 promoterId, uint64 ttl)
        internal
        view
        returns (IAttributionRegistry.Touch memory t, bytes memory sig)
    {
        t = IAttributionRegistry.Touch({
            campaign: address(c),
            promoterId: promoterId,
            signedAt: uint64(block.timestamp),
            expiresAt: uint64(block.timestamp) + ttl
        });
        sig = _sign(t);
    }

    function _sign(IAttributionRegistry.Touch memory t) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(attribution.TOUCH_TYPEHASH(), t.campaign, t.promoterId, t.signedAt, t.expiresAt)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", attribution.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userPk, digest);
        return abi.encodePacked(r, s, v);
    }
}
