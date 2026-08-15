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
import {Types} from "../src/libraries/Types.sol";
import {Names} from "../src/libraries/Names.sol";

contract NameToken is ERC20 {
    constructor() ERC20("Mock", "MOCK") {}
}

/// @dev `Names` functions are `internal`, so a revert from one is not an external call and
///      `vm.expectRevert` cannot see it. This wrapper gives each one an external frame.
contract NamesHarness {
    function validate(string calldata name) external pure {
        Names.validate(name);
    }

    function key(string calldata name) external pure returns (bytes32) {
        return Names.key(name);
    }

    function normalize(string calldata name) external pure returns (string memory) {
        return string(Names.normalize(name));
    }
}

/// @title CampaignNamesTest
/// @notice Covers the campaign name rules: shape validation in `Names`, and uniqueness in
///         `CampaignRegistry`.
/// @dev Two layers, deliberately tested separately. `Names` decides what a *well-formed* name is and
///      what two names being "the same" means; the registry decides who holds one. A bug in the first
///      shows up as an unrenderable name, a bug in the second as two campaigns claiming one Campaign Title,
///      and only the second needs a full protocol fixture.
contract CampaignNamesTest is Test {
    uint256 internal constant POOL = 10_000 ether;

    NamesHarness internal names;
    NameToken internal token;
    EscrowVault internal vault;
    CampaignRegistry internal registry;
    AttributionRegistry internal attribution;
    ReputationRegistry internal reputation;

    address internal admin = address(0xA11CE);
    address internal project = address(0xC0DE);
    address internal oracle = address(0x0BAC);

    function setUp() public {
        vm.warp(1_000_000);

        names = new NamesHarness();
        token = new NameToken();
        attribution = new AttributionRegistry(30 days);
        reputation = new ReputationRegistry(admin, address(new AttestationVerifier(admin, admin)));
        vault = new EscrowVault(address(this));
        registry = new CampaignRegistry(address(vault), address(reputation), address(attribution), oracle);
        vault.setRegistrar(address(registry));
    }

    // ── shape: Names.validate ────────────────────────────────────

    function test_Validate_acceptsOrdinaryName() public view {
        names.validate("Aave");
    }

    function test_Validate_acceptsExactlyMaxLength() public view {
        // 32 characters, the documented ceiling.
        string memory atMax = "12345678901234567890123456789012";
        assertEq(bytes(atMax).length, Names.MAX_NAME_BYTES, "fixture is not exactly at the cap");
        names.validate(atMax);
    }

    function test_Validate_revertsOneOverMaxLength() public {
        string memory tooLong = "123456789012345678901234567890123"; // 33
        assertEq(bytes(tooLong).length, 33);
        vm.expectRevert(abi.encodeWithSelector(Names.NameTooLong.selector, 33, Names.MAX_NAME_BYTES));
        names.validate(tooLong);
    }

    function test_Validate_revertsEmpty() public {
        vm.expectRevert(Names.EmptyName.selector);
        names.validate("");
    }

    /// A name of nothing but spaces normalizes to the empty string, so it would otherwise claim the
    /// key every other all-spaces name produces.
    function test_Validate_revertsAllSpaces() public {
        vm.expectRevert(Names.EmptyName.selector);
        names.validate("    ");
    }

    function test_Validate_revertsControlCharacter() public {
        string memory withTab = string(abi.encodePacked("Aa", hex"09", "ve"));
        vm.expectRevert(abi.encodeWithSelector(Names.InvalidNameChar.selector, 2, bytes1(hex"09")));
        names.validate(withTab);
    }

    /// The impersonation case the charset restriction exists for: Cyrillic А (U+0410) renders like a
    /// Latin A but is two bytes, neither of which is printable ASCII.
    function test_Validate_revertsNonAscii() public {
        string memory cyrillic = string(abi.encodePacked(hex"d090", "ave"));
        vm.expectRevert(abi.encodeWithSelector(Names.InvalidNameChar.selector, 0, bytes1(hex"d0")));
        names.validate(cyrillic);
    }

    function test_Validate_revertsZeroWidthJoiner() public {
        // U+200D, invisible in every UI, would otherwise mint a fresh key for an identical-looking
        // name.
        string memory joined = string(abi.encodePacked("Aa", hex"e2808d", "ve"));
        vm.expectRevert(abi.encodeWithSelector(Names.InvalidNameChar.selector, 2, bytes1(hex"e2")));
        names.validate(joined);
    }

    function test_Validate_acceptsPunctuationAndDigits() public view {
        names.validate("Aave v3 (Base) - 2026!");
    }

    // ── sameness: Names.normalize / key ──────────────────────────

    function test_Normalize_trimsCollapsesAndLowercases() public view {
        assertEq(names.normalize("  Aave   Protocol  "), "aave protocol");
        assertEq(names.normalize("AAVE"), "aave");
        assertEq(names.normalize("aave"), "aave");
    }

    function test_Normalize_leavesAnAlreadyNormalName() public view {
        assertEq(names.normalize("aave protocol"), "aave protocol");
    }

    function test_Key_collidesAcrossCaseAndWhitespace() public view {
        bytes32 want = names.key("Aave Protocol");
        assertEq(names.key("aave protocol"), want, "case must not distinguish names");
        assertEq(names.key("AAVE PROTOCOL"), want, "case must not distinguish names");
        assertEq(names.key(" Aave Protocol "), want, "surrounding space must not distinguish names");
        assertEq(names.key("Aave    Protocol"), want, "inner space runs must not distinguish names");
    }

    function test_Key_separatesGenuinelyDifferentNames() public view {
        assertTrue(names.key("Aave") != names.key("Aavee"));
        assertTrue(names.key("Aave") != names.key("Aave v3"));
        // Space is a character, not decoration: "aa ve" is not "aave".
        assertTrue(names.key("Aa ve") != names.key("Aave"));
    }

    // ── ownership: CampaignRegistry ──────────────────────────────

    function test_Create_storesTheNameVerbatim() public {
        Campaign c = _create("Aave Protocol");
        assertEq(c.name(), "Aave Protocol", "display name must keep its capitalisation");
        assertEq(c.config().name, "Aave Protocol", "config() must round-trip the name");
    }

    function test_Create_indexesTheCampaignByName() public {
        Campaign c = _create("Aave");
        assertEq(registry.campaignByName(names.key("Aave")), address(c));
        // The index is keyed on the normalized form, so a variant resolves to the same campaign.
        assertEq(registry.campaignByName(names.key("  aAvE ")), address(c));
    }

    function test_Create_revertsOnExactDuplicate() public {
        Campaign first = _create("Aave");
        vm.expectRevert(abi.encodeWithSelector(CampaignRegistry.NameTaken.selector, "Aave", address(first)));
        _create("Aave");
    }

    function test_Create_revertsOnCaseVariant() public {
        Campaign first = _create("Aave");
        vm.expectRevert(abi.encodeWithSelector(CampaignRegistry.NameTaken.selector, "AAVE", address(first)));
        _create("AAVE");
    }

    function test_Create_revertsOnWhitespaceVariant() public {
        Campaign first = _create("Aave Protocol");
        vm.expectRevert(
            abi.encodeWithSelector(CampaignRegistry.NameTaken.selector, "  Aave   Protocol  ", address(first))
        );
        _create("  Aave   Protocol  ");
    }

    function test_Create_acceptsDistinctNames() public {
        _create("Aave");
        _create("Moonwell");
        _create("Aave v3");
        assertEq(registry.campaignCount(), 3);
    }

    function test_Create_revertsMalformedNameBeforeDeploying() public {
        uint256 before = registry.campaignCount();
        vm.expectRevert(Names.EmptyName.selector);
        _create("");
        assertEq(registry.campaignCount(), before, "no campaign may exist after a rejected name");
    }

    /// A name is claimed by a campaign that exists. A creation that reverts for an unrelated reason
    /// must not burn the name on the way out.
    function test_Create_failedCreationLeavesTheNameFree() public {
        Types.CampaignConfig memory cfg = _config("Aave");
        cfg.rewardPool = 0; // Campaign's constructor: ZeroRewardPool

        vm.prank(project);
        vm.expectRevert(Campaign.ZeroRewardPool.selector);
        registry.createCampaign(cfg, _kpis(), _tiers());

        assertTrue(registry.isNameAvailable("Aave"), "a name must survive a failed creation");
        assertEq(address(_create("Aave")).code.length > 0, true, "and must still be claimable");
    }

    /// Ending a campaign does not release its name: recycling one would repoint every link and
    /// indexer row that already referred to the campaign it used to mean.
    function test_Create_endedCampaignKeepsItsName() public {
        Campaign c = _create("Aave");
        _fundAndActivate(c);
        vm.prank(project);
        c.end();

        assertFalse(registry.isNameAvailable("Aave"), "an ended campaign keeps its name");
        vm.expectRevert(abi.encodeWithSelector(CampaignRegistry.NameTaken.selector, "Aave", address(c)));
        _create("Aave");
    }

    // ── isNameAvailable ──────────────────────────────────────────

    function test_IsNameAvailable_agreesWithCreate() public {
        assertTrue(registry.isNameAvailable("Aave"));
        _create("Aave");
        assertFalse(registry.isNameAvailable("Aave"));
        assertFalse(registry.isNameAvailable("aave"), "normalized, like the index it reads");
        assertTrue(registry.isNameAvailable("Aave v3"));
    }

    /// The form asks "may I use this?" — for a malformed name the answer is no, not a revert. The
    /// specific reason comes from the length and charset checks the client runs locally.
    function test_IsNameAvailable_returnsFalseForMalformedNames() public view {
        assertFalse(registry.isNameAvailable(""));
        assertFalse(registry.isNameAvailable("   "));
        assertFalse(registry.isNameAvailable("123456789012345678901234567890123")); // 33
        assertFalse(registry.isNameAvailable(string(abi.encodePacked("Aa", hex"09", "ve"))));
        assertFalse(registry.isNameAvailable(string(abi.encodePacked(hex"d090", "ave"))));
    }

    function test_IsNameAvailable_acceptsExactlyMaxLength() public view {
        assertTrue(registry.isNameAvailable("12345678901234567890123456789012"));
    }

    // ── direct construction ──────────────────────────────────────

    /// A campaign built without the registry still validates its own name's shape — that is the guard
    /// protecting every UI that lists campaigns — but cannot check uniqueness, because the index it
    /// would need lives in the registry. Such a campaign is outside the marketplace anyway: it is
    /// absent from `campaignCount`, `browse`, and the vault's registrations.
    function test_DirectConstruction_validatesShapeButNotUniqueness() public {
        _create("Aave");

        Types.CampaignConfig memory cfg = _config("Aave");
        Campaign twin = new Campaign(
            cfg, _kpis(), _tiers(), address(vault), address(attribution), address(reputation), oracle
        );
        assertEq(twin.name(), "Aave", "duplicate names are reachable off-registry");
        assertFalse(registry.isCampaign(address(twin)), "but such a campaign is not in the registry");

        cfg.name = "";
        vm.expectRevert(Names.EmptyName.selector);
        new Campaign(
            cfg, _kpis(), _tiers(), address(vault), address(attribution), address(reputation), oracle
        );
    }

    // ── fixtures ─────────────────────────────────────────────────

    function _config(string memory name_) internal view returns (Types.CampaignConfig memory) {
        return Types.CampaignConfig({
            project: project,
            name: name_,
            token: address(token),
            rewardPool: POOL,
            startTime: uint64(block.timestamp),
            endTime: uint64(block.timestamp + 30 days),
            attributionWindow: 7 days,
            minReputation: 0
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
        tiers[0] = new Types.RewardTier[](1);
        tiers[0][0] = Types.RewardTier({threshold: 10, reward: 1_000 ether});
    }

    function _create(string memory name_) internal returns (Campaign) {
        vm.prank(project);
        (, address addr) = registry.createCampaign(_config(name_), _kpis(), _tiers());
        return Campaign(addr);
    }

    function _fundAndActivate(Campaign c) internal {
        deal(address(token), project, POOL);
        vm.startPrank(project);
        token.approve(address(vault), POOL);
        vault.deposit(address(c), POOL);
        c.activate();
        vm.stopPrank();
    }
}
