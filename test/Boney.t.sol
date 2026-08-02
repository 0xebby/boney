// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Boney} from "../src/Boney.sol";
import {IBoney} from "../src/IBoney.sol";
import {Campaign} from "../src/campaign/Campaign.sol";
import {CampaignRegistry} from "../src/campaign/CampaignRegistry.sol";
import {EscrowVault} from "../src/escrow/EscrowVault.sol";
import {AttributionRegistry} from "../src/attribution/AttributionRegistry.sol";
import {AttestationVerifier} from "../src/reputation/AttestationVerifier.sol";
import {ReputationRegistry} from "../src/reputation/ReputationRegistry.sol";
import {OracleCoordinator} from "../src/oracle/OracleCoordinator.sol";
import {IOracleCoordinator} from "../src/interfaces/IOracleCoordinator.sol";
import {IAttributionRegistry} from "../src/interfaces/IAttributionRegistry.sol";
import {IAttestationVerifier} from "../src/interfaces/IAttestationVerifier.sol";
import {Types} from "../src/libraries/Types.sol";

contract MockToken is ERC20 {
    constructor() ERC20("Mock", "MOCK") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice End-to-end protocol test: the full KOL-marketplace flow through the facade.
contract BoneyTest is Test {
    uint256 internal constant POOL = 10_000 ether;
    uint256 internal constant MIN_STAKE = 1 ether;
    uint256 internal constant DISPUTE_WINDOW = 1 days;

    MockToken internal token;
    EscrowVault internal vault;
    CampaignRegistry internal registry;
    AttributionRegistry internal attribution;
    AttestationVerifier internal attestations;
    ReputationRegistry internal reputation;
    OracleCoordinator internal coordinator;
    Boney internal boney;

    address internal governor = address(0x60B);
    address internal project = address(0xC0DE);
    address internal kol = address(0xC01);
    address internal outsider = address(0xBAD);

    uint256 internal attestorPk = 0xA77E5;
    uint256 internal userPk = 0x5EED;
    address internal attestor;
    address internal user;

    bytes32 internal followersSchema;
    uint64 internal startTime;
    uint64 internal endTime;

    function setUp() public {
        attestor = vm.addr(attestorPk);
        user = vm.addr(userPk);

        vm.warp(1_000_000);
        startTime = uint64(block.timestamp);
        endTime = uint64(block.timestamp + 30 days);

        token = new MockToken();
        attribution = new AttributionRegistry(30 days);
        attestations = new AttestationVerifier(governor, attestor);
        reputation = new ReputationRegistry(governor, address(attestations));
        coordinator = new OracleCoordinator(governor, MIN_STAKE, DISPUTE_WINDOW, 1 days);

        vault = new EscrowVault(address(this));
        registry = new CampaignRegistry(
            address(vault), address(reputation), address(attribution), address(coordinator)
        );
        vault.setRegistrar(address(registry));
        boney = new Boney(address(registry));

        vm.prank(governor);
        coordinator.setCampaignRegistry(address(registry));
        vm.prank(governor);
        reputation.registerSchema("X_FOLLOWERS", 1);
        followersSchema = reputation.schemaId("X_FOLLOWERS");
    }

    // ── fixtures ─────────────────────────────────────────────────

    function _config(uint256 minReputation) internal view returns (Types.CampaignConfig memory) {
        return Types.CampaignConfig({
            project: project,
            token: address(token),
            rewardPool: POOL,
            startTime: startTime,
            endTime: endTime,
            attributionWindow: 7 days,
            minReputation: minReputation
        });
    }

    function _kpis() internal pure returns (Types.KpiSpec[] memory kpis) {
        kpis = new Types.KpiSpec[](1);
        kpis[0] = Types.KpiSpec({
            kind: Types.KpiKind.Mint,
            verifier: address(0),
            target: 100,
            aggregate: false,
            params: ""
        });
    }

    function _tiers() internal pure returns (Types.RewardTier[][] memory tiers) {
        tiers = new Types.RewardTier[][](1);
        tiers[0] = new Types.RewardTier[](2);
        tiers[0][0] = Types.RewardTier({threshold: 10, reward: 1_000 ether});
        tiers[0][1] = Types.RewardTier({threshold: 50, reward: 4_000 ether});
    }

    function _createViaFacade(uint256 minReputation) internal returns (uint256 id, Campaign c) {
        vm.prank(project);
        (uint256 campaignId, address addr) = boney.createCampaign(_config(minReputation), _kpis(), _tiers());
        return (campaignId, Campaign(addr));
    }

    function _fundViaFacade(uint256 campaignId, uint256 amount) internal {
        token.mint(project, amount);
        vm.startPrank(project);
        token.approve(address(boney), amount);
        boney.fundCampaign(campaignId, amount);
        vm.stopPrank();
    }

    function _attestReputation(address subject, uint256 value) internal {
        IAttestationVerifier.Attestation[] memory as_ = new IAttestationVerifier.Attestation[](1);
        bytes[] memory sigs = new bytes[](1);

        as_[0] = IAttestationVerifier.Attestation({
            attestor: attestor,
            subject: subject,
            schemaId: followersSchema,
            value: value,
            nonce: attestations.nonces(attestor),
            expiresAt: uint64(block.timestamp + 1 hours),
            data: bytes32(0)
        });

        bytes32 structHash = keccak256(
            abi.encode(
                attestations.ATTESTATION_TYPEHASH(),
                as_[0].attestor,
                as_[0].subject,
                as_[0].schemaId,
                as_[0].value,
                as_[0].nonce,
                as_[0].expiresAt,
                as_[0].data
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", attestations.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attestorPk, digest);
        sigs[0] = abi.encodePacked(r, s, v);

        reputation.submitAttestation(subject, followersSchema, value, as_, sigs);
    }

    function _touchViaFacade(uint256 campaignId, Campaign c, bytes32 promoterId) internal {
        IAttributionRegistry.Touch memory t = IAttributionRegistry.Touch({
            campaign: address(c),
            promoterId: promoterId,
            expiresAt: uint64(block.timestamp + 7 days)
        });
        bytes32 structHash =
            keccak256(abi.encode(attribution.TOUCH_TYPEHASH(), t.campaign, t.promoterId, t.expiresAt));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", attribution.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userPk, digest);

        vm.prank(kol);
        boney.registerAttribution(campaignId, user, t, abi.encodePacked(r, s, v));
    }

    // ── the full flow ────────────────────────────────────────────

    /// @notice create → fund → activate → KOL qualifies & joins → user consents → action
    ///         reported → tier auto-paid → end → reclaim.
    function test_EndToEnd_kolMarketplaceFlow() public {
        // 1. Project creates a campaign requiring 5k reputation.
        (uint256 id, Campaign c) = _createViaFacade(5_000);
        assertEq(uint8(c.status()), uint8(Types.CampaignStatus.Pending));

        // 2. Project escrows the reward pool through the facade.
        _fundViaFacade(id, POOL);
        assertEq(vault.balanceOf(address(c)), POOL);

        // 3. Activation requires full funding.
        vm.prank(project);
        c.activate();
        assertEq(uint8(c.status()), uint8(Types.CampaignStatus.Active));

        // 4. KOL cannot join without reputation.
        vm.prank(kol);
        vm.expectRevert(abi.encodeWithSelector(Campaign.InsufficientReputation.selector, 0, 5_000));
        c.join();

        // 5. Attestor vouches for the KOL's follower count; now they qualify.
        _attestReputation(kol, 6_000);
        assertEq(boney.reputationOf(kol), 6_000);

        vm.prank(kol);
        bytes32 promoterId = c.join();

        // 6. A user consents to attribution; the KOL relays the signature.
        _touchViaFacade(id, c, promoterId);
        assertEq(attribution.activePromoter(address(c), user), promoterId);

        // 7. Project reports the user's on-chain actions. Crossing tier 0 pays automatically.
        vm.prank(project);
        c.reportUserAction(0, user, 10, "");

        assertEq(token.balanceOf(kol), 1_000 ether, "tier 0 auto-paid on report");
        assertEq(boney.promoterProgress(id, kol, 0), 10);

        // 8. More conversions cross tier 1.
        vm.prank(project);
        c.reportUserAction(0, user, 50, "");
        assertEq(token.balanceOf(kol), 5_000 ether, "tier 1 paid");

        // 9. Campaign ends; unspent escrow returns to the project after the claim window.
        vm.prank(project);
        c.end();
        skip(c.CLAIM_GRACE() + 1);

        vm.prank(project);
        c.reclaimUnspent();

        assertEq(token.balanceOf(project), POOL - 5_000 ether, "project recovers the remainder");
        assertEq(vault.balanceOf(address(c)), 0);
        assertEq(c.paidOut(), 5_000 ether);
    }

    /// @dev Escrow conservation across the whole lifecycle: every token deposited ends up either
    ///      with promoters or back with the project.
    function test_EndToEnd_escrowConservation() public {
        (uint256 id, Campaign c) = _createViaFacade(0);
        _fundViaFacade(id, POOL);
        vm.prank(project);
        c.activate();

        vm.prank(kol);
        bytes32 promoterId = c.join();
        _touchViaFacade(id, c, promoterId);

        vm.prank(project);
        c.reportUserAction(0, user, 50, "");

        vm.prank(project);
        c.end();
        skip(c.CLAIM_GRACE() + 1);
        vm.prank(project);
        c.reclaimUnspent();

        assertEq(token.balanceOf(kol) + token.balanceOf(project), POOL, "no tokens created or destroyed");
        assertEq(token.balanceOf(address(vault)), 0, "vault fully drained");
    }

    // ── facade routing ───────────────────────────────────────────

    function test_Facade_createCampaign() public {
        (uint256 id, Campaign c) = _createViaFacade(0);

        assertEq(registry.campaignAt(id), address(c));
        assertEq(boney.campaignAddress(id), address(c));
        assertEq(boney.campaignCount(), 1);
    }

    function test_Facade_revertsForeignProject() public {
        Types.CampaignConfig memory cfg = _config(0);
        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(Boney.NotProject.selector, project, outsider));
        boney.createCampaign(cfg, _kpis(), _tiers());
    }

    function test_Facade_fundCampaign() public {
        (uint256 id, Campaign c) = _createViaFacade(0);
        _fundViaFacade(id, POOL);

        assertEq(vault.balanceOf(address(c)), POOL);
        assertEq(token.balanceOf(address(boney)), 0, "facade holds no funds");
    }

    function test_Facade_campaignView() public {
        (uint256 id, Campaign c) = _createViaFacade(1_234);
        IBoney.CampaignView memory v = boney.campaignView(id);

        assertEq(v.campaign, address(c));
        assertEq(v.project, project);
        assertEq(v.token, address(token));
        assertEq(v.rewardPool, POOL);
        assertEq(v.minReputation, 1_234);
        assertEq(v.kpiCount, 1);
        assertEq(uint8(v.status), uint8(Types.CampaignStatus.Pending));
    }

    function test_Facade_browseCampaigns() public {
        _createViaFacade(0);
        _createViaFacade(0);
        _createViaFacade(0);

        IBoney.CampaignView[] memory page = boney.browseCampaigns(1, 2);
        assertEq(page.length, 2);
        assertEq(page[0].campaignId, 1);
        assertEq(page[1].campaignId, 2);

        assertEq(boney.browseCampaigns(99, 10).length, 0, "offset past the end is empty");
        assertEq(boney.browseCampaigns(0, 99).length, 3, "limit clamps to total");
    }

    function test_Facade_registerAttributionRejectsMismatch() public {
        (uint256 id, Campaign c) = _createViaFacade(0);
        _fundViaFacade(id, POOL);
        vm.prank(project);
        c.activate();
        vm.prank(kol);
        bytes32 promoterId = c.join();

        IAttributionRegistry.Touch memory t = IAttributionRegistry.Touch({
            campaign: address(0xDEAD),
            promoterId: promoterId,
            expiresAt: uint64(block.timestamp + 1 days)
        });

        vm.prank(kol);
        vm.expectRevert(abi.encodeWithSelector(Boney.CampaignMismatch.selector, address(c), address(0xDEAD)));
        boney.registerAttribution(id, user, t, "");
    }

    function test_Facade_claimRewards() public {
        (uint256 id, Campaign c) = _createViaFacade(0);
        _fundViaFacade(id, POOL);
        vm.prank(project);
        c.activate();
        vm.prank(kol);
        bytes32 promoterId = c.join();
        _touchViaFacade(id, c, promoterId);

        vm.prank(project);
        c.reportUserAction(0, user, 10, "");
        uint256 afterAuto = token.balanceOf(kol);

        // Settlement is idempotent: the facade path pays nothing extra.
        boney.claimRewards(id, kol, 0);
        assertEq(token.balanceOf(kol), afterAuto);
    }

    // ── oracle path through the full stack ───────────────────────

    function test_EndToEnd_oracleAggregateReport() public {
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
        (uint256 id, address addr) = boney.createCampaign(_config(0), kpis, tiers);
        Campaign c = Campaign(addr);

        _fundViaFacade(id, POOL);
        vm.prank(project);
        c.activate();

        address reporter = address(0x0BAC);
        vm.deal(reporter, MIN_STAKE);
        vm.prank(reporter);
        coordinator.stake{value: MIN_STAKE}();

        vm.prank(reporter);
        bytes32 reportId = coordinator.submitReport(
            IOracleCoordinator.Report({campaign: addr, kpiIndex: 0, amount: 750_000, evidence: ""})
        );

        vm.warp(coordinator.reportDeadline(reportId));
        coordinator.applyReport(reportId);

        assertEq(c.totalProgress(0), 750_000, "oracle aggregate landed on the campaign");
    }
}
