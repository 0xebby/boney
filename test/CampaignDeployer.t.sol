// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test, Vm} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Campaign} from "../src/campaign/Campaign.sol";
import {CampaignDeployer} from "../src/campaign/CampaignDeployer.sol";
import {CampaignRegistry} from "../src/campaign/CampaignRegistry.sol";
import {EscrowVault} from "../src/escrow/EscrowVault.sol";
import {ICampaign} from "../src/interfaces/ICampaign.sol";
import {ICampaignDeployer} from "../src/interfaces/ICampaignDeployer.sol";
import {IEscrowVault} from "../src/interfaces/IEscrowVault.sol";
import {Types} from "../src/libraries/Types.sol";

contract DeployerToken is ERC20 {
    constructor() ERC20("Mock", "MOCK") {}
}

contract DeployerReputation {
    function maxScore() external pure returns (uint256) {
        return type(uint256).max;
    }
}

/// @title CampaignDeployerTest
/// @notice Covers registry-bound deployment and registry state transitions.
contract CampaignDeployerTest is Test {
    uint256 internal constant EIP170_LIMIT = 24_576;

    address internal project = address(0xC0DE);
    address internal attribution = address(0xA771);
    address internal oracle = address(0x0BAC);

    DeployerToken internal token;
    DeployerReputation internal reputation;
    EscrowVault internal vault;
    CampaignRegistry internal registry;
    CampaignDeployer internal deployer;

    function setUp() public {
        vm.warp(1_000_000);
        token = new DeployerToken();
        reputation = new DeployerReputation();
        vault = new EscrowVault(address(this));
        registry = new CampaignRegistry(address(vault), address(reputation), attribution, oracle);
        deployer = CampaignDeployer(registry.campaignDeployer());
        vault.setRegistrar(address(registry));
    }

    function test_BindsRegistryAndCampaignDependencies() public view {
        assertEq(deployer.registry(), address(registry));
        assertEq(deployer.escrowVault(), address(vault));
        assertEq(deployer.attributionRegistry(), attribution);
        assertEq(deployer.reputationRegistry(), address(reputation));
        assertEq(deployer.oracleCoordinator(), oracle);
    }

    function test_RejectsDirectDeployment() public {
        Types.CampaignConfig memory cfg = _config("Unauthorized");
        Types.KpiSpec[] memory kpis = _kpis();
        Types.RewardTier[][] memory campaignTiers = _tiers();

        vm.expectRevert(abi.encodeWithSelector(ICampaignDeployer.NotRegistry.selector, address(this)));
        deployer.deployCampaign(cfg, kpis, campaignTiers);
    }

    function test_RegistryCreatesAndIndexesConfiguredCampaign() public {
        Types.CampaignConfig memory cfg = _config("Deployer campaign");
        Types.KpiSpec[] memory kpis = _kpis();
        Types.RewardTier[][] memory campaignTiers = _tiers();

        vm.recordLogs();
        (uint256 campaignId, address campaignAddress) = registry.createCampaign(cfg, kpis, campaignTiers);

        Vm.Log[] memory entries = vm.getRecordedLogs();
        bytes32 createdSignature = keccak256("CampaignCreated(uint256,address,address,address,string)");
        bool foundCreated;
        for (uint256 i; i < entries.length; ++i) {
            if (entries[i].emitter == address(registry) && entries[i].topics[0] == createdSignature) {
                foundCreated = true;
                assertEq(uint256(entries[i].topics[1]), 0);
                assertEq(address(uint160(uint256(entries[i].topics[2]))), campaignAddress);
                assertEq(address(uint160(uint256(entries[i].topics[3]))), project);
                (address emittedToken, string memory emittedName) =
                    abi.decode(entries[i].data, (address, string));
                assertEq(emittedToken, address(token));
                assertEq(emittedName, cfg.name);
            }
        }
        assertTrue(foundCreated);

        Campaign campaign = Campaign(campaignAddress);
        assertEq(campaignId, 0);
        assertEq(registry.campaignAt(0), campaignAddress);
        assertTrue(registry.isCampaign(campaignAddress));
        assertEq(registry.campaignsOf(project)[0], campaignAddress);
        assertEq(registry.campaignByName(keccak256("deployer campaign")), campaignAddress);
        assertEq(vault.tokenOf(campaignAddress), address(token));
        assertEq(campaign.getProject(), project);
        assertEq(address(campaign.escrowVault()), address(vault));
        assertEq(address(campaign.attributionRegistry()), attribution);
        assertEq(address(campaign.reputationRegistry()), address(reputation));
        assertEq(campaign.getOracle(), oracle);
        assertEq(campaign.kpiCount(), 1);
        assertEq(campaign.tiers(0).length, 1);
    }

    function test_ConstructorRevertLeavesRegistryAndNameUnchanged() public {
        Types.CampaignConfig memory cfg = _config("Broken campaign");
        Types.KpiSpec[] memory kpis = new Types.KpiSpec[](0);
        Types.RewardTier[][] memory campaignTiers = new Types.RewardTier[][](0);

        vm.expectRevert(ICampaign.NoKpis.selector);
        registry.createCampaign(cfg, kpis, campaignTiers);

        assertEq(registry.campaignCount(), 0);
        assertEq(registry.campaignByName(keccak256("broken campaign")), address(0));
        assertEq(registry.campaignsOf(project).length, 0);
    }

    function test_VaultRegistrationRevertRollsBackCampaignState() public {
        EscrowVault unwiredVault = new EscrowVault(address(this));
        CampaignRegistry unwired =
            new CampaignRegistry(address(unwiredVault), address(reputation), attribution, oracle);
        Types.CampaignConfig memory cfg = _config("Unwired vault");

        vm.expectRevert(IEscrowVault.RegistrarNotSet.selector);
        unwired.createCampaign(cfg, _kpis(), _tiers());

        assertEq(unwired.campaignCount(), 0);
        assertEq(unwired.campaignByName(keccak256("unwired vault")), address(0));
        assertEq(unwired.campaignsOf(project).length, 0);
    }

    function test_RuntimeSizesRemainWithinEip170() public view {
        assertLe(address(registry).code.length, EIP170_LIMIT);
        assertLe(address(deployer).code.length, EIP170_LIMIT);
    }

    function _config(string memory name) private view returns (Types.CampaignConfig memory) {
        return Types.CampaignConfig({
            project: project,
            name: name,
            token: address(token),
            rewardPool: 1 ether,
            startTime: uint64(block.timestamp),
            endTime: uint64(block.timestamp + 30 days),
            attributionWindow: 7 days,
            minReputation: 0
        });
    }

    function _kpis() private pure returns (Types.KpiSpec[] memory kpis) {
        kpis = new Types.KpiSpec[](1);
        kpis[0] = Types.KpiSpec({
            kind: Types.KpiKind.Mint,
            verifier: address(0),
            target: 1,
            aggregate: false,
            params: ""
        });
    }

    function _tiers() private pure returns (Types.RewardTier[][] memory campaignTiers) {
        campaignTiers = new Types.RewardTier[][](1);
        campaignTiers[0] = new Types.RewardTier[](1);
        campaignTiers[0][0] = Types.RewardTier({threshold: 1, reward: 1 ether});
    }
}
