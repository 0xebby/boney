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
import {IKpiVerifier} from "../src/interfaces/IKpiVerifier.sol";
import {Types} from "../src/libraries/Types.sol";
import {Vm} from "lib/forge-std/src/Vm.sol";
import {ICampaign} from "../src/interfaces/ICampaign.sol";

contract MockToken is ERC20 {
    constructor() ERC20("Mock", "MOCK") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Credits only half of any claim, to prove the verifier adapter can discount a report.
contract HalvingVerifier is IKpiVerifier {
    function verify(address, uint256, address, uint256 amount, bytes calldata, bytes calldata)
        external
        pure
        returns (uint256)
    {
        return amount / 2;
    }
}

/// @dev Tries to credit more than claimed; the campaign must reject this.
contract InflatingVerifier is IKpiVerifier {
    function verify(address, uint256, address, uint256 amount, bytes calldata, bytes calldata)
        external
        pure
        returns (uint256)
    {
        return amount * 2;
    }
}

contract CampaignTest is Test {
    uint256 internal constant POOL = 10_000 ether;
    uint64 internal constant MAX_TOUCH = 30 days;

    MockToken internal token;
    EscrowVault internal vault;
    CampaignRegistry internal registry;
    AttributionRegistry internal attribution;
    AttestationVerifier internal verifier;
    ReputationRegistry internal reputation;
    Campaign internal campaign;

    /// @dev Campaign names are unique per registry, so fixtures cannot share one. Incremented per
    ///      config built. A plain storage counter rather than `registry.campaignCount()`: that would
    ///      be an external call, and an external call inside an argument list consumes the pending
    ///      `vm.prank` or `vm.expectRevert` before the call under test ever runs.
    uint256 private _nameNonce;

    address internal admin = address(0xA11CE);
    address internal project = address(0xC0DE);
    address internal oracle = address(0x0BAC);
    address internal kol = address(0xC01);
    address internal kol2 = address(0xC02);
    address internal outsider = address(0xBAD);

    uint256 internal userPk = 0x5EED;
    uint256 internal user2Pk = 0x5EED2;
    address internal user;
    address internal user2;

    uint64 internal startTime;
    uint64 internal endTime;

    function setUp() public {
        user = vm.addr(userPk);
        user2 = vm.addr(user2Pk);

        vm.warp(1_000_000);
        startTime = uint64(block.timestamp);
        endTime = uint64(block.timestamp + 30 days);

        token = new MockToken();
        attribution = new AttributionRegistry(MAX_TOUCH);
        verifier = new AttestationVerifier(admin, admin);
        reputation = new ReputationRegistry(admin, address(verifier));

        vault = new EscrowVault(address(this));
        registry = new CampaignRegistry(address(vault), address(reputation), address(attribution), oracle);
        vault.setRegistrar(address(registry));

        campaign = _createCampaign(0);
    }

    // ── fixtures ─────────────────────────────────────────────────

    function _defaultConfig(uint256 minReputation) internal returns (Types.CampaignConfig memory) {
        return Types.CampaignConfig({
            project: project,
            name: string.concat("Campaign Test ", vm.toString(_nameNonce++)),
            token: address(token),
            rewardPool: POOL,
            startTime: startTime,
            endTime: endTime,
            attributionWindow: 7 days,
            minReputation: minReputation
        });
    }

    /// @dev One mint KPI with a 3-rung ladder: 10 → 1000, 50 → 2000, 100 → 5000.
    function _defaultKpis() internal pure returns (Types.KpiSpec[] memory kpis) {
        kpis = new Types.KpiSpec[](1);
        kpis[0] = Types.KpiSpec({
            kind: Types.KpiKind.Mint,
            verifier: address(0),
            target: 100,
            aggregate: false,
            params: ""
        });
    }

    function _defaultTiers() internal pure returns (Types.RewardTier[][] memory tiers) {
        tiers = new Types.RewardTier[][](1);
        tiers[0] = new Types.RewardTier[](3);
        tiers[0][0] = Types.RewardTier({threshold: 10, reward: 1_000 ether});
        tiers[0][1] = Types.RewardTier({threshold: 50, reward: 2_000 ether});
        tiers[0][2] = Types.RewardTier({threshold: 100, reward: 5_000 ether});
    }

    /// @dev Registers the two scoring schemas with real weights and ceilings, so `maxScore` is
    ///      answerable. Mirrors SeedLocal: 7*2800 + 3*2800 = 28,000.
    function _boundReputationSchemas() internal returns (uint256 cap) {
        vm.startPrank(admin);
        reputation.registerSchema("ETHOS_SCORE", 7);
        reputation.registerSchema("REACH", 3);
        reputation.setSchemaMaxValue(reputation.schemaId("ETHOS_SCORE"), 2_800);
        reputation.setSchemaMaxValue(reputation.schemaId("REACH"), 2_800);
        vm.stopPrank();
        return reputation.maxScore();
    }

    function _createCampaign(uint256 minReputation) internal returns (Campaign) {
        vm.prank(project);
        (, address addr) =
            registry.createCampaign(_defaultConfig(minReputation), _defaultKpis(), _defaultTiers());
        return Campaign(addr);
    }

    function _fund(Campaign c, uint256 amount) internal {
        token.mint(project, amount);
        vm.startPrank(project);
        token.approve(address(vault), amount);
        vault.deposit(address(c), amount);
        vm.stopPrank();
    }

    function _activate(Campaign c) internal {
        _fund(c, POOL);
        vm.prank(project);
        c.activate();
    }

    function _join(Campaign c, address promoter) internal returns (bytes32) {
        vm.prank(promoter);
        return c.join();
    }

    function _touch(Campaign c, uint256 pk, address signer, bytes32 promoterId, uint64 ttl) internal {
        IAttributionRegistry.Touch memory t = IAttributionRegistry.Touch({
            campaign: address(c),
            promoterId: promoterId,
            signedAt: uint64(block.timestamp),
            expiresAt: uint64(block.timestamp) + ttl
        });
        bytes32 structHash = keccak256(
            abi.encode(attribution.TOUCH_TYPEHASH(), t.campaign, t.promoterId, t.signedAt, t.expiresAt)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", attribution.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        attribution.storeTouch(signer, t, abi.encodePacked(r, s, v), signer);
    }

    function _report(Campaign c, address reporter, address u, uint256 total) internal {
        vm.prank(reporter);
        c.reportUserAction(0, u, total, "");
    }

    // ── construction & validation ────────────────────────────────

    function test_InitialState() public view {
        assertEq(uint8(campaign.status()), uint8(Types.CampaignStatus.Pending));
        assertEq(campaign.project(), project);
        assertEq(campaign.token(), address(token));
        assertEq(campaign.rewardPool(), POOL);
        assertEq(campaign.kpiCount(), 1);
        assertEq(campaign.tiers(0).length, 3);
        assertEq(campaign.paidOut(), 0);
        assertEq(campaign.remainingPool(), POOL);
        assertEq(vault.tokenOf(address(campaign)), address(token), "registered with vault");
        assertTrue(registry.isCampaign(address(campaign)));
    }

    /// @dev The registry allows creating a campaign that names another address as the project,
    ///      because doing so grants the creator nothing: only `project` can fund, activate, or
    ///      reclaim. Caller-binding is a facade-level concern (see BoneyTest).
    function test_Create_thirdPartyCampaignIsInert() public {
        Types.CampaignConfig memory cfg = _defaultConfig(0);
        vm.prank(outsider);
        (, address addr) = registry.createCampaign(cfg, _defaultKpis(), _defaultTiers());
        Campaign c = Campaign(addr);

        assertEq(c.project(), project, "project is whoever the config names");
        _fund(c, POOL);

        // The creator cannot drive it.
        vm.prank(outsider);
        vm.expectRevert(ICampaign.NotProject.selector);
        c.activate();

        vm.prank(outsider);
        vm.expectRevert(ICampaign.NotProject.selector);
        c.cancel();

        vm.prank(project);
        c.activate();

        //vm.warp(block.timestamp + 100 days);

        bytes32 id = _join(campaign, kol);
        _touch(campaign, userPk, user, id, 7 days);

        vm.prank(project);
        c.end();

        vm.warp(block.timestamp + 100 days);

        vm.prank(project);
        c.reclaimUnspent();
    }

    function test_Create_revertsNonAscendingTiers() public {
        Types.RewardTier[][] memory tiers = new Types.RewardTier[][](1);
        tiers[0] = new Types.RewardTier[](2);
        tiers[0][0] = Types.RewardTier({threshold: 50, reward: 1 ether});
        tiers[0][1] = Types.RewardTier({threshold: 10, reward: 1 ether});

        Types.CampaignConfig memory cfg = _defaultConfig(0);
        Types.KpiSpec[] memory kpis = _defaultKpis();

        vm.prank(project);
        vm.expectRevert(abi.encodeWithSelector(ICampaign.TiersNotAscending.selector, 0, 1));
        registry.createCampaign(cfg, kpis, tiers);
    }

    function test_Create_revertsCustomKpiWithoutVerifier() public {
        Types.KpiSpec[] memory kpis = new Types.KpiSpec[](1);
        kpis[0] = Types.KpiSpec({
            kind: Types.KpiKind.Custom,
            verifier: address(0),
            target: 1,
            aggregate: false,
            params: ""
        });
        Types.CampaignConfig memory cfg = _defaultConfig(0);
        Types.RewardTier[][] memory tiers = _defaultTiers();

        vm.prank(project);
        vm.expectRevert(abi.encodeWithSelector(ICampaign.CustomKpiNeedsVerifier.selector, 0));
        registry.createCampaign(cfg, kpis, tiers);
    }

    function test_Create_revertsZeroRewardPool() public {
        Types.CampaignConfig memory cfg = _defaultConfig(0);
        cfg.rewardPool = 0;
        Types.KpiSpec[] memory kpis = _defaultKpis();
        Types.RewardTier[][] memory tiers = _defaultTiers();

        vm.prank(project);
        vm.expectRevert(ICampaign.ZeroRewardPool.selector);
        registry.createCampaign(cfg, kpis, tiers);
    }

    function test_Create_revertsBadWindow() public {
        Types.CampaignConfig memory cfg = _defaultConfig(0);
        cfg.endTime = cfg.startTime;
        Types.KpiSpec[] memory kpis = _defaultKpis();
        Types.RewardTier[][] memory tiers = _defaultTiers();

        vm.prank(project);
        vm.expectRevert(ICampaign.InvalidWindow.selector);
        registry.createCampaign(cfg, kpis, tiers);
    }

    /// @dev Settlement walks the tier ladder, so an unbounded ladder could exceed the block gas
    ///      limit and strand promoters who already earned. Rejected at construction.
    function test_Create_revertsTooManyTiers() public {
        uint256 max = campaign.MAX_TIERS_PER_KPI();
        Types.RewardTier[][] memory tiers = new Types.RewardTier[][](1);
        tiers[0] = new Types.RewardTier[](max + 1);
        for (uint256 i; i <= max; ++i) {
            tiers[0][i] = Types.RewardTier({threshold: i + 1, reward: 1 ether});
        }

        Types.CampaignConfig memory cfg = _defaultConfig(0);
        Types.KpiSpec[] memory kpis = _defaultKpis();

        vm.prank(project);
        vm.expectRevert(abi.encodeWithSelector(ICampaign.TooManyTiers.selector, 0, max + 1, max));
        registry.createCampaign(cfg, kpis, tiers);
    }

    function test_Create_revertsTooManyKpis() public {
        uint256 max = campaign.MAX_KPIS();
        Types.KpiSpec[] memory kpis = new Types.KpiSpec[](max + 1);
        Types.RewardTier[][] memory tiers = new Types.RewardTier[][](max + 1);
        for (uint256 i; i <= max; ++i) {
            kpis[i] = Types.KpiSpec({
                kind: Types.KpiKind.Mint,
                verifier: address(0),
                target: 1,
                aggregate: false,
                params: ""
            });
            tiers[i] = new Types.RewardTier[](1);
            tiers[i][0] = Types.RewardTier({threshold: 1, reward: 1 ether});
        }

        Types.CampaignConfig memory cfg = _defaultConfig(0);
        vm.prank(project);
        vm.expectRevert(abi.encodeWithSelector(ICampaign.TooManyKpis.selector, max + 1, max));
        registry.createCampaign(cfg, kpis, tiers);
    }

    function test_Create_acceptsMaxTiers() public {
        uint256 max = campaign.MAX_TIERS_PER_KPI();
        Types.RewardTier[][] memory tiers = new Types.RewardTier[][](1);
        tiers[0] = new Types.RewardTier[](max);
        for (uint256 i; i < max; ++i) {
            tiers[0][i] = Types.RewardTier({threshold: i + 1, reward: 1 ether});
        }

        Types.CampaignConfig memory cfg = _defaultConfig(0);
        Types.KpiSpec[] memory kpis = _defaultKpis();

        vm.prank(project);
        (, address addr) = registry.createCampaign(cfg, kpis, tiers);
        assertEq(Campaign(addr).tiers(0).length, max);
    }

    // ── activation ───────────────────────────────────────────────

    function test_Activate() public {
        _fund(campaign, POOL);
        vm.prank(project);
        campaign.activate();
        assertEq(uint8(campaign.status()), uint8(Types.CampaignStatus.Active));
    }

    /// @dev Promoters must never work against a partially funded campaign.
    function test_Activate_revertsUnderfunded() public {
        _fund(campaign, POOL - 1);
        vm.prank(project);
        vm.expectRevert(abi.encodeWithSelector(ICampaign.NotFunded.selector, POOL - 1, POOL));
        campaign.activate();
    }

    function test_Activate_onlyProject() public {
        _fund(campaign, POOL);
        vm.prank(outsider);
        vm.expectRevert(ICampaign.NotProject.selector);
        campaign.activate();
    }

    function test_Activate_revertsTwice() public {
        _activate(campaign);
        vm.prank(project);
        vm.expectRevert(abi.encodeWithSelector(ICampaign.WrongStatus.selector, Types.CampaignStatus.Active));
        campaign.activate();
    }

    // ── joining ──────────────────────────────────────────────────

    function test_Join() public {
        _activate(campaign);
        bytes32 id = _join(campaign, kol);

        assertTrue(id != bytes32(0));
        assertEq(campaign.promoterIdOf(kol), id);
        assertEq(campaign.promoterOf(id), kol);
        assertTrue(attribution.isRegistered(address(campaign), id), "id bound in attribution registry");
    }

    function test_Join_allowedWhilePending() public {
        bytes32 id = _join(campaign, kol);
        assertEq(campaign.promoterOf(id), kol, "KOLs can prepare links before launch");
    }

    function test_Join_revertsTwice() public {
        _activate(campaign);
        _join(campaign, kol);
        vm.prank(kol);
        vm.expectRevert(ICampaign.AlreadyJoined.selector);
        campaign.join();
    }

    function test_Join_promoterIdsAreDistinct() public {
        _activate(campaign);
        assertTrue(_join(campaign, kol) != _join(campaign, kol2));
    }

    // ── reputation gate ──────────────────────────────────────────

    function test_Join_revertsBelowMinReputation() public {
        // The gate has to be *reachable* for this test to be about the wallet rather than the
        // config: `Campaign`'s constructor rejects a `minReputation` above `maxScore`, and a
        // registry with no weighted schema has a maximum score of 0. Registering a bounded schema
        // puts 5,000 within reach; `kol` simply has nothing attested against it.
        vm.startPrank(admin);
        reputation.registerSchema("FOLLOWERS", 1);
        reputation.setSchemaMaxValue(reputation.schemaId("FOLLOWERS"), 10_000);
        vm.stopPrank();

        Campaign gated = _createCampaign(5_000);
        _activate(gated);

        vm.prank(kol);
        vm.expectRevert(abi.encodeWithSelector(ICampaign.InsufficientReputation.selector, 0, 5_000));
        gated.join();
    }

    function test_Join_succeedsWithReputation() public {
        vm.startPrank(admin);
        reputation.registerSchema("FOLLOWERS", 1);
        reputation.storeAttestation(kol, reputation.schemaId("FOLLOWERS"), 6_000, keccak256("a1"));
        vm.stopPrank();

        Campaign gated = _createCampaign(5_000);
        _activate(gated);

        vm.prank(kol);
        gated.join();
        assertTrue(gated.promoterIdOf(kol) != bytes32(0));
    }

    // ── unreachable eligibility gate ─────────────────────────────

    /// @dev A gate above the maximum attainable score produces a campaign that deploys, escrows,
    ///      reports Active and admits nobody — permanently, since config is immutable. Rejected at
    ///      construction because that is the last moment it can be fixed.
    function test_Create_revertsUnreachableMinReputation() public {
        uint256 cap = _boundReputationSchemas();

        vm.prank(project);
        vm.expectRevert(abi.encodeWithSelector(ICampaign.UnreachableReputation.selector, cap + 1, cap));
        registry.createCampaign(_defaultConfig(cap + 1), _defaultKpis(), _defaultTiers());
    }

    function test_Create_acceptsMinReputationExactlyAtCap() public {
        uint256 cap = _boundReputationSchemas();

        vm.prank(project);
        (, address addr) = registry.createCampaign(_defaultConfig(cap), _defaultKpis(), _defaultTiers());
        assertEq(Campaign(addr).minReputation(), cap, "the ceiling itself is a legal gate");
    }

    /// @dev An unbounded registry cannot say what is unreachable, so it must not block creation.
    function test_Create_allowsAnyGateWhenRegistryIsUnbounded() public {
        // A *weighted* schema with no ceiling is what makes the maximum unknowable. Note this is a
        // different state from the empty registry `setUp` leaves behind, which reports 0 because
        // nothing is attainable at all.
        vm.prank(admin);
        reputation.registerSchema("ETHOS_SCORE", 7);

        assertEq(reputation.maxScore(), type(uint256).max, "weighted and unbounded");

        vm.prank(project);
        (, address addr) =
            registry.createCampaign(_defaultConfig(type(uint256).max), _defaultKpis(), _defaultTiers());
        assertEq(Campaign(addr).minReputation(), type(uint256).max);
    }

    function test_Create_allowsOpenCampaignRegardlessOfCap() public {
        _boundReputationSchemas();
        vm.startPrank(admin);
        reputation.setSchemaWeight(reputation.schemaId("ETHOS_SCORE"), 0);
        reputation.setSchemaWeight(reputation.schemaId("REACH"), 0);
        vm.stopPrank();

        assertEq(reputation.maxScore(), 0, "nothing is weighted, so nothing is attainable");

        vm.prank(project);
        (, address addr) = registry.createCampaign(_defaultConfig(0), _defaultKpis(), _defaultTiers());
        assertEq(Campaign(addr).minReputation(), 0, "an ungated campaign is always creatable");
    }

    // ── reporting & attribution ──────────────────────────────────

    function test_Report_creditsAttributedPromoter() public {
        _activate(campaign);
        bytes32 id = _join(campaign, kol);
        _touch(campaign, userPk, user, id, 7 days);

        _report(campaign, project, user, 5);

        assertEq(campaign.progressOf(kol, 0), 5);
        assertEq(campaign.totalProgress(0), 5);
        assertEq(campaign.userCreditedOf(user, 0), 5);
    }

    /// @dev Core anti-fraud property: no attribution means no credit and no payout.
    function test_Report_revertsWithoutAttribution() public {
        _activate(campaign);
        _join(campaign, kol);

        vm.prank(project);
        vm.expectRevert(abi.encodeWithSelector(ICampaign.NoAttribution.selector, user));
        campaign.reportUserAction(0, user, 5, "");
    }

    function test_Report_revertsAfterAttributionExpires() public {
        _activate(campaign);
        bytes32 id = _join(campaign, kol);
        _touch(campaign, userPk, user, id, 1 days);

        skip(1 days + 1);

        vm.prank(project);
        vm.expectRevert(abi.encodeWithSelector(ICampaign.NoAttribution.selector, user));
        campaign.reportUserAction(0, user, 5, "");
    }

    /// @dev An expired touch reverts the whole report rather than skipping the user, so the
    ///      activity is not burned — it is merely unbanked. A fresh touch from the same promoter makes
    ///      the same cumulative report land, and because `_userCredited` never advanced, the full total
    ///      is still owed.
    function test_Report_recoverableAfterAttributionExpires() public {
        _activate(campaign);
        bytes32 id1 = _join(campaign, kol);
        _join(campaign, kol2);

        _touch(campaign, userPk, user, id1, 1 days);
        skip(1 days + 1);

        vm.prank(project);
        vm.expectRevert(abi.encodeWithSelector(ICampaign.NoAttribution.selector, user));
        campaign.reportUserAction(0, user, 5, "");

        // The same KOL re-engages the user and the same report now succeeds.
        _touch(campaign, userPk, user, id1, 7 days);
        _report(campaign, project, user, 5);

        assertEq(campaign.progressOf(kol, 0), 5, "the lapse only deferred it");
        assertEq(campaign.progressOf(kol2, 0), 0);
    }

    /// @dev A lapse no longer hands everything to whoever the user signs for next: the span the report
    ///      covers held two promoters, so it is refused until evidence says which actions were whose.
    function test_Report_lapseDoesNotHandTheBacklogToTheNextPromoter() public {
        _activate(campaign);
        bytes32 id1 = _join(campaign, kol);
        bytes32 id2 = _join(campaign, kol2);

        _touch(campaign, userPk, user, id1, 1 days);
        skip(1 days + 1);
        _touch(campaign, userPk, user, id2, 7 days);

        vm.prank(project);
        vm.expectRevert(abi.encodeWithSelector(ICampaign.AmbiguousAttribution.selector, user, 0));
        campaign.reportUserAction(0, user, 5, "");

        assertEq(campaign.progressOf(kol2, 0), 0, "kol's backlog is not kol2's to take");
    }

    function test_Report_onlyReporters() public {
        _activate(campaign);
        bytes32 id = _join(campaign, kol);
        _touch(campaign, userPk, user, id, 7 days);

        vm.prank(outsider);
        vm.expectRevert(ICampaign.NotReporter.selector);
        campaign.reportUserAction(0, user, 5, "");
    }

    function test_Report_oracleMayReport() public {
        _activate(campaign);
        bytes32 id = _join(campaign, kol);
        _touch(campaign, userPk, user, id, 7 days);

        _report(campaign, oracle, user, 5);
        assertEq(campaign.progressOf(kol, 0), 5);
    }

    /// @dev Cumulative reporting makes a replay a no-op instead of double-crediting.
    function test_Report_replayIsNoop() public {
        _activate(campaign);
        bytes32 id = _join(campaign, kol);
        _touch(campaign, userPk, user, id, 7 days);

        _report(campaign, project, user, 5);
        _report(campaign, project, user, 5);
        _report(campaign, project, user, 5);

        assertEq(campaign.progressOf(kol, 0), 5, "no inflation from replays");
    }

    function test_Report_creditsOnlyTheDelta() public {
        _activate(campaign);
        bytes32 id = _join(campaign, kol);
        _touch(campaign, userPk, user, id, 7 days);

        _report(campaign, project, user, 5);
        _report(campaign, project, user, 8);

        assertEq(campaign.progressOf(kol, 0), 8);
        assertEq(campaign.userCreditedOf(user, 0), 8);
    }

    function test_Report_revertsNonMonotonic() public {
        _activate(campaign);
        bytes32 id = _join(campaign, kol);
        _touch(campaign, userPk, user, id, 7 days);
        _report(campaign, project, user, 10);

        vm.prank(project);
        vm.expectRevert(abi.encodeWithSelector(ICampaign.NonMonotonic.selector, 10, 9));
        campaign.reportUserAction(0, user, 9, "");
    }

    function test_Report_revertsUnknownKpi() public {
        _activate(campaign);
        vm.prank(project);
        vm.expectRevert(abi.encodeWithSelector(ICampaign.UnknownKpi.selector, 7));
        campaign.reportUserAction(7, user, 1, "");
    }

    function test_Report_revertsWhenPaused() public {
        _activate(campaign);
        bytes32 id = _join(campaign, kol);
        _touch(campaign, userPk, user, id, 7 days);

        vm.prank(project);
        campaign.pause();

        vm.prank(project);
        vm.expectRevert(abi.encodeWithSelector(ICampaign.WrongStatus.selector, Types.CampaignStatus.Paused));
        campaign.reportUserAction(0, user, 5, "");
    }

    function test_Report_revertsAfterEndTime() public {
        _activate(campaign);
        bytes32 id = _join(campaign, kol);
        _touch(campaign, userPk, user, id, 7 days);

        vm.warp(endTime + 1);
        vm.prank(project);
        vm.expectRevert(abi.encodeWithSelector(ICampaign.OutsideWindow.selector, startTime, endTime));
        campaign.reportUserAction(0, user, 5, "");
    }

    // ── LAST_TOUCH re-attribution ────────────────────────────────

    /// @dev Progress already credited to one promoter stays with them; only new progress follows
    ///      the new attribution.
    function test_Report_lastTouchRedirectsFutureCreditOnly() public {
        _activate(campaign);
        bytes32 id1 = _join(campaign, kol);
        bytes32 id2 = _join(campaign, kol2);

        _touch(campaign, userPk, user, id1, 7 days);
        _report(campaign, project, user, 5);
        assertEq(campaign.progressOf(kol, 0), 5);

        // Touches are ordered by their signed timestamp, so a re-attribution has to be genuinely
        // later than the one it replaces.
        skip(1 hours);
        _touch(campaign, userPk, user, id2, 7 days);
        _report(campaign, project, user, 12);

        assertEq(campaign.progressOf(kol, 0), 5, "earned credit is not clawed back");
        assertEq(campaign.progressOf(kol2, 0), 7, "only the delta moves");
    }

    /// @dev A report carrying no `evidence` has no per-action timing, so a switch inside the span it
    ///      covers leaves the payee unknowable. Refused with `AmbiguousAttribution` rather than handed
    ///      to whoever holds the touch — which is what closes the farm-the-cadence gap, since signing
    ///      just before a batch now blocks the batch instead of capturing it.
    function test_Report_unreportedProgressCannotFollowTheLaterTouch() public {
        _activate(campaign);
        bytes32 id1 = _join(campaign, kol);
        bytes32 id2 = _join(campaign, kol2);

        // The user acts entirely under kol's attribution — but nothing is reported yet.
        _touch(campaign, userPk, user, id1, 7 days);

        // kol2 gets the user to sign before the project's next report lands.
        skip(1 hours);
        _touch(campaign, userPk, user, id2, 7 days);

        vm.prank(project);
        vm.expectRevert(abi.encodeWithSelector(ICampaign.AmbiguousAttribution.selector, user, 0));
        campaign.reportUserAction(0, user, 10, "");

        assertEq(campaign.progressOf(kol, 0), 0, "nothing is credited either way");
        assertEq(campaign.progressOf(kol2, 0), 0, "and the later touch takes nothing");
    }

    /// @dev The corollary: reporting more often shrinks the window. Same activity, same touches,
    ///      but a report in between locks kol's share in.
    function test_Report_frequentReportingLimitsTheWindow() public {
        _activate(campaign);
        bytes32 id1 = _join(campaign, kol);
        bytes32 id2 = _join(campaign, kol2);

        _touch(campaign, userPk, user, id1, 7 days);
        _report(campaign, project, user, 10);

        skip(1 hours);
        _touch(campaign, userPk, user, id2, 7 days);
        _report(campaign, project, user, 10);

        assertEq(campaign.progressOf(kol, 0), 10, "banked before the switch");
        assertEq(campaign.progressOf(kol2, 0), 0, "nothing left to redirect");
    }

    // ── tier settlement ──────────────────────────────────────────

    function test_Settle_paysCrossedTier() public {
        _activate(campaign);
        bytes32 id = _join(campaign, kol);
        _touch(campaign, userPk, user, id, 7 days);
        //
        _report(campaign, project, user, 10);

        assertEq(token.balanceOf(kol), 1_000 ether, "tier 0 auto-paid");
        assertEq(campaign.paidOut(), 1_000 ether);
        assertEq(campaign.settledTiersOf(kol, 0), 1);
    }

    function test_Settle_paysMultipleTiersInOneReport() public {
        _activate(campaign);
        bytes32 id = _join(campaign, kol);
        _touch(campaign, userPk, user, id, 7 days);

        // Jump straight past the first two rungs.
        _report(campaign, project, user, 50);

        assertEq(token.balanceOf(kol), 3_000 ether, "tiers 0 and 1");
        assertEq(campaign.settledTiersOf(kol, 0), 2);
    }

    function test_Settle_noDoublePay() public {
        _activate(campaign);
        bytes32 id = _join(campaign, kol);
        _touch(campaign, userPk, user, id, 7 days);
        _report(campaign, project, user, 10);

        campaign.settle(kol, 0);
        campaign.settle(kol, 0);

        assertEq(token.balanceOf(kol), 1_000 ether, "tier pays exactly once");
    }

    function test_Settle_belowThresholdPaysNothing() public {
        _activate(campaign);
        bytes32 id = _join(campaign, kol);
        _touch(campaign, userPk, user, id, 7 days);

        _report(campaign, project, user, 9);

        assertEq(token.balanceOf(kol), 0);
        assertEq(campaign.settledTiersOf(kol, 0), 0);
    }

    function test_Settle_revertsNotJoined() public {
        _activate(campaign);
        vm.expectRevert(ICampaign.NotJoined.selector);
        campaign.settle(outsider, 0);
    }

    function test_Settle_fullLadder() public {
        _activate(campaign);
        bytes32 id = _join(campaign, kol);
        _touch(campaign, userPk, user, id, 7 days);

        _report(campaign, project, user, 100);

        assertEq(token.balanceOf(kol), 8_000 ether, "1000 + 2000 + 5000");
        assertEq(campaign.settledTiersOf(kol, 0), 3);
        assertEq(campaign.remainingPool(), POOL - 8_000 ether);
    }

    // ── shared pool exhaustion (D3) ──────────────────────────────

    /// @dev Two promoters both complete the ladder but the pool only covers 10k: the second is
    ///      paid what remains and `PoolExhausted` is emitted, rather than reverting.
    function test_Settle_poolExhaustedPaysPartial() public {
        _activate(campaign);
        bytes32 id1 = _join(campaign, kol);
        bytes32 id2 = _join(campaign, kol2);

        _touch(campaign, userPk, user, id1, 7 days);
        _report(campaign, project, user, 100);
        assertEq(token.balanceOf(kol), 8_000 ether);

        _touch(campaign, user2Pk, user2, id2, 7 days);
        _report(campaign, project, user2, 100);

        assertEq(token.balanceOf(kol2), 2_000 ether, "paid what remained");
        assertEq(campaign.paidOut(), POOL, "pool fully drained, never over");
        assertEq(campaign.remainingPool(), 0);
    }

    /// @dev The invariant that matters most: payouts can never exceed the escrowed pool.
    function test_Settle_neverOverpaysPool() public {
        _activate(campaign);

        address[3] memory kols = [kol, kol2, address(0xC03)];
        uint256[3] memory pks = [userPk, user2Pk, 0x5EED3];

        for (uint256 i; i < 3; ++i) {
            bytes32 id = _join(campaign, kols[i]);
            address u = vm.addr(pks[i]);
            _touch(campaign, pks[i], u, id, 7 days);
            _report(campaign, project, u, 100);
        }

        assertLe(campaign.paidOut(), POOL, "paidOut <= rewardPool");
        assertEq(token.balanceOf(address(vault)), POOL - campaign.paidOut());
    }

    // ── verifier adapters (D1 extensibility) ─────────────────────

    function _createWithVerifier(address kpiVerifier) internal returns (Campaign) {
        Types.KpiSpec[] memory kpis = new Types.KpiSpec[](1);
        kpis[0] = Types.KpiSpec({
            kind: Types.KpiKind.Custom,
            verifier: kpiVerifier,
            target: 100,
            aggregate: false,
            params: ""
        });

        vm.prank(project);
        (, address addr) = registry.createCampaign(_defaultConfig(0), kpis, _defaultTiers());
        return Campaign(addr);
    }

    function test_Verifier_canDiscountClaim() public {
        Campaign c = _createWithVerifier(address(new HalvingVerifier()));
        _activate(c);
        bytes32 id = _join(c, kol);
        _touch(c, userPk, user, id, 7 days);

        _report(c, project, user, 20);

        assertEq(c.progressOf(kol, 0), 10, "verifier halved the claim");
        assertEq(token.balanceOf(kol), 1_000 ether, "tier 0 still reached");
    }

    /// @dev A malicious or buggy adapter must not be able to mint progress out of thin air.
    function test_Verifier_cannotInflateClaim() public {
        Campaign c = _createWithVerifier(address(new InflatingVerifier()));
        _activate(c);
        bytes32 id = _join(c, kol);
        _touch(c, userPk, user, id, 7 days);

        vm.prank(project);
        vm.expectRevert(abi.encodeWithSelector(ICampaign.VerifierOvercredit.selector, 20, 10));
        c.reportUserAction(0, user, 10, "");
    }

    // ── aggregate KPIs (D7) ──────────────────────────────────────

    function _createAggregateCampaign() internal returns (Campaign) {
        Types.KpiSpec[] memory kpis = new Types.KpiSpec[](1);
        kpis[0] = Types.KpiSpec({
            kind: Types.KpiKind.Tvl,
            verifier: address(0),
            target: 1_000_000,
            aggregate: true,
            params: ""
        });
        Types.RewardTier[][] memory tiers = new Types.RewardTier[][](1);
        tiers[0] = new Types.RewardTier[](0);

        vm.prank(project);
        (, address addr) = registry.createCampaign(_defaultConfig(0), kpis, tiers);
        return Campaign(addr);
    }

    function test_Aggregate_oracleUpdatesTotal() public {
        Campaign c = _createAggregateCampaign();
        _activate(c);

        vm.prank(oracle);
        c.applyAggregateUpdate(0, 500_000);

        assertEq(c.totalProgress(0), 500_000);
    }

    function test_Aggregate_onlyOracle() public {
        Campaign c = _createAggregateCampaign();
        _activate(c);

        vm.prank(project);
        vm.expectRevert(ICampaign.NotOracle.selector);
        c.applyAggregateUpdate(0, 1);
    }

    function test_Aggregate_revertsNonMonotonic() public {
        Campaign c = _createAggregateCampaign();
        _activate(c);

        vm.prank(oracle);
        c.applyAggregateUpdate(0, 500_000);

        vm.prank(oracle);
        vm.expectRevert(abi.encodeWithSelector(ICampaign.NonMonotonic.selector, 500_000, 400_000));
        c.applyAggregateUpdate(0, 400_000);
    }

    /// @dev The two reporting paths must not be interchangeable.
    function test_Aggregate_rejectsUserPath() public {
        Campaign c = _createAggregateCampaign();
        _activate(c);
        bytes32 id = _join(c, kol);
        _touch(c, userPk, user, id, 7 days);

        vm.prank(project);
        vm.expectRevert(abi.encodeWithSelector(ICampaign.AggregateKpi.selector, 0));
        c.reportUserAction(0, user, 5, "");
    }

    function test_Aggregate_userKpiRejectsAggregatePath() public {
        _activate(campaign);
        vm.prank(oracle);
        vm.expectRevert(abi.encodeWithSelector(ICampaign.NotAggregateKpi.selector, 0));
        campaign.applyAggregateUpdate(0, 100);
    }

    // ── pause / end / cancel ─────────────────────────────────────

    function test_PauseUnpause() public {
        _activate(campaign);
        vm.prank(project);
        campaign.pause();
        assertEq(uint8(campaign.status()), uint8(Types.CampaignStatus.Paused));

        vm.prank(project);
        campaign.unpause();
        assertEq(uint8(campaign.status()), uint8(Types.CampaignStatus.Active));
    }

    function test_Pause_onlyProject() public {
        _activate(campaign);
        vm.prank(outsider);
        vm.expectRevert(ICampaign.NotProject.selector);
        campaign.pause();
    }

    function test_End_byProjectEarly() public {
        _activate(campaign);
        vm.prank(project);
        campaign.end();
        assertEq(uint8(campaign.status()), uint8(Types.CampaignStatus.Ended));
    }

    /// @dev Anyone may end an expired campaign, so a project cannot stall the claim window.
    function test_End_permissionlessAfterEndTime() public {
        _activate(campaign);
        vm.warp(endTime);

        vm.prank(outsider);
        campaign.end();
        assertEq(uint8(campaign.status()), uint8(Types.CampaignStatus.Ended));
    }

    function test_End_revertsOutsiderBeforeEndTime() public {
        _activate(campaign);
        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(ICampaign.OutsideWindow.selector, startTime, endTime));
        campaign.end();
    }

    function test_Cancel_onlyWhilePending() public {
        vm.prank(project);
        campaign.cancel();
        assertEq(uint8(campaign.status()), uint8(Types.CampaignStatus.Cancelled));
    }

    /// @dev Cancelling an active campaign would rug promoters who already earned.
    function test_Cancel_revertsWhenActive() public {
        _activate(campaign);
        vm.prank(project);
        vm.expectRevert(abi.encodeWithSelector(ICampaign.WrongStatus.selector, Types.CampaignStatus.Active));
        campaign.cancel();
    }

    // ── claim grace & reclaim ────────────────────────────────────

    function test_Settle_allowedDuringClaimGrace() public {
        _activate(campaign);
        bytes32 id = _join(campaign, kol);
        _touch(campaign, userPk, user, id, 7 days);
        _report(campaign, project, user, 10);

        vm.prank(project);
        campaign.pause();
        vm.prank(project);
        campaign.end();

        // Progress beyond tier 0 was credited before the end; settle after ending.
        // Derived from CLAIM_GRACE rather than a fixed duration so the test still lands *inside*
        // the grace window when the constant is shortened for testing.
        skip(campaign.CLAIM_GRACE() / 2);
        campaign.settle(kol, 0);
        assertEq(token.balanceOf(kol), 1_000 ether);
    }

    function test_Reclaim_revertsDuringClaimGrace() public {
        _activate(campaign);
        vm.prank(project);
        campaign.end();
        uint64 until = uint64(block.timestamp) + campaign.CLAIM_GRACE();

        vm.prank(project);
        vm.expectRevert(abi.encodeWithSelector(ICampaign.ClaimWindowOpen.selector, until));
        campaign.reclaimUnspent();
    }

    function test_Reclaim_afterGraceReturnsUnspent() public {
        _activate(campaign);
        bytes32 id = _join(campaign, kol);
        _touch(campaign, userPk, user, id, 7 days);
        _report(campaign, project, user, 10); // pays 1000

        vm.prank(project);
        campaign.end();
        skip(campaign.CLAIM_GRACE() + 1);

        uint256 before = token.balanceOf(project);
        vm.prank(project);
        campaign.reclaimUnspent();

        assertEq(token.balanceOf(project) - before, POOL - 1_000 ether);
        assertEq(vault.balanceOf(address(campaign)), 0);
    }

    function test_Reclaim_immediateAfterCancel() public {
        _fund(campaign, POOL);
        vm.prank(project);
        campaign.cancel();

        uint256 before = token.balanceOf(project);
        vm.prank(project);
        campaign.reclaimUnspent();

        assertEq(token.balanceOf(project) - before, POOL, "nobody earned anything");
    }

    function test_Reclaim_onlyProject() public {
        _fund(campaign, POOL);
        vm.prank(project);
        campaign.cancel();

        vm.prank(outsider);
        vm.expectRevert(ICampaign.NotProject.selector);
        campaign.reclaimUnspent();
    }

    function test_Reclaim_revertsWhenActive() public {
        _activate(campaign);
        vm.prank(project);
        vm.expectRevert(abi.encodeWithSelector(ICampaign.WrongStatus.selector, Types.CampaignStatus.Active));
        campaign.reclaimUnspent();
    }

    // ── fuzz / invariants ────────────────────────────────────────

    function testFuzz_PaidOutNeverExceedsPool(uint256 amount) public {
        amount = bound(amount, 0, 1_000_000);

        _activate(campaign);
        bytes32 id = _join(campaign, kol);
        _touch(campaign, userPk, user, id, 7 days);

        if (amount > 0) _report(campaign, project, user, amount);

        assertLe(campaign.paidOut(), POOL);
        assertEq(campaign.paidOut() + campaign.remainingPool(), POOL);
        assertLe(token.balanceOf(kol), POOL);
    }

    function testFuzz_ProgressIsMonotonic(uint256 a, uint256 b) public {
        a = bound(a, 1, 1_000);
        b = bound(b, a, 2_000);

        _activate(campaign);
        bytes32 id = _join(campaign, kol);
        _touch(campaign, userPk, user, id, 7 days);

        _report(campaign, project, user, a);
        uint256 first = campaign.progressOf(kol, 0);
        _report(campaign, project, user, b);

        assertGe(campaign.progressOf(kol, 0), first, "progress never decreases");
        assertEq(campaign.progressOf(kol, 0), b);
    }
}
