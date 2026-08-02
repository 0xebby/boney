// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test, console} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {EscrowVault} from "../src/escrow/EscrowVault.sol";
import {IEscrowVault} from "../src/interfaces/IEscrowVault.sol";

contract MockToken is ERC20 {
    constructor() ERC20("Mock Token", "MOCK") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract EscrowVaultTest is Test {
    address internal constant REGISTRAR = address(0xB0B0);
    address internal constant CAMPAIGN = address(0xC0C0);
    address internal constant OTHER = address(0x0A0A);

    MockToken internal token;
    EscrowVault internal vault;

    function setUp() public {
        token = new MockToken();
        vault = new EscrowVault(address(this));
        vault.setRegistrar(REGISTRAR);
    }

    // ── registrar wiring ──────────────────────────────────────────

    function test_SetRegistrar() public view {
        assertEq(vault.registrar(), REGISTRAR);
        assertEq(vault.admin(), address(this));
    }

    function test_SetRegistrar_onlyOnce() public {
        vm.expectRevert(EscrowVault.RegistrarAlreadySet.selector);
        vault.setRegistrar(address(0x1234));
    }

    function test_SetRegistrar_onlyAdmin() public {
        EscrowVault fresh = new EscrowVault(address(this));
        vm.prank(OTHER);
        vm.expectRevert(EscrowVault.NotAdmin.selector);
        fresh.setRegistrar(REGISTRAR);
    }

    function test_SetRegistrar_revertsZero() public {
        EscrowVault fresh = new EscrowVault(address(this));
        vm.expectRevert(EscrowVault.ZeroAddress.selector);
        fresh.setRegistrar(address(0));
    }

    /// @dev Before wiring, registration must fail closed rather than matching a zero caller.
    function test_RegisterCampaign_revertsBeforeRegistrarSet() public {
        EscrowVault fresh = new EscrowVault(address(this));
        vm.expectRevert(EscrowVault.RegistrarNotSet.selector);
        fresh.registerCampaign(CAMPAIGN, address(token));
    }

    function _registerCampaign(address campaign) internal {
        vm.prank(REGISTRAR);
        vault.registerCampaign(campaign, address(token));
    }

    function _fund(address campaign, address from, uint256 amount) internal {
        token.mint(from, amount);
        vm.prank(from);
        token.approve(address(vault), amount);
        vm.prank(from);
        vault.deposit(campaign, amount);
    }

    // ── registration ─────────────────────────────────────────────

    function test_RegisterCampaign() public {
        _registerCampaign(CAMPAIGN);
        assertEq(vault.tokenOf(CAMPAIGN), address(token));
        assertEq(vault.balanceOf(CAMPAIGN), 0);
    }

    function test_RegisterCampaign_revertsNonRegistrar() public {
        vm.prank(OTHER);
        vm.expectRevert(EscrowVault.NotRegistrar.selector);
        vault.registerCampaign(CAMPAIGN, address(token));
    }

    function test_RegisterCampaign_revertsDoubleRegister() public {
        _registerCampaign(CAMPAIGN);
        vm.prank(REGISTRAR);
        vm.expectRevert(EscrowVault.AlreadyRegistered.selector);
        vault.registerCampaign(CAMPAIGN, address(token));
    }

    function test_RegisterCampaign_revertsZeroAddresses() public {
        vm.prank(REGISTRAR);
        vm.expectRevert(EscrowVault.ZeroAddress.selector);
        vault.registerCampaign(address(0), address(token));

        vm.prank(REGISTRAR);
        vm.expectRevert(EscrowVault.ZeroAddress.selector);
        vault.registerCampaign(CAMPAIGN, address(0));
    }

    // ── deposit ───────────────────────────────────────────────────

    function test_Deposit() public {
        _registerCampaign(CAMPAIGN);
        _fund(CAMPAIGN, OTHER, 1_000 ether);
        assertEq(vault.balanceOf(CAMPAIGN), 1_000 ether);
        assertEq(token.balanceOf(address(vault)), 1_000 ether);
    }

    function test_Deposit_creditsReceivedAmount() public {
        _registerCampaign(CAMPAIGN);
        _fund(CAMPAIGN, OTHER, 2_500);
        assertEq(vault.balanceOf(CAMPAIGN), 2_500);
    }

    function test_Deposit_revertsUnregistered() public {
        vm.prank(OTHER);
        vm.expectRevert(EscrowVault.CampaignNotRegistered.selector);
        vault.deposit(CAMPAIGN, 100);
    }

    function test_Deposit_revertsZeroAmount() public {
        _registerCampaign(CAMPAIGN);
        token.mint(OTHER, 100);
        vm.prank(OTHER);
        token.approve(address(vault), type(uint256).max);
        vm.prank(OTHER);
        vm.expectRevert(EscrowVault.ZeroAmount.selector);
        vault.deposit(CAMPAIGN, 0);
    }

    function test_Deposit_revertsNoAllowance() public {
        _registerCampaign(CAMPAIGN);
        token.mint(OTHER, 100);
        vm.prank(OTHER);
        vm.expectRevert();
        vault.deposit(CAMPAIGN, 100);
    }

    // ── release (campaign-only spend) ─────────────────────────────

    function test_Release() public {
        _registerCampaign(CAMPAIGN);
        _fund(CAMPAIGN, OTHER, 1_000 ether);

        vm.prank(CAMPAIGN);
        vault.release(OTHER, 400 ether);

        assertEq(vault.balanceOf(CAMPAIGN), 600 ether);
        // `_fund` deposits everything it mints, so OTHER starts at zero and receives only the release.
        assertEq(token.balanceOf(OTHER), 400 ether);
    }

    function test_Release_revertsWhenNotCampaign() public {
        _registerCampaign(CAMPAIGN);
        _fund(CAMPAIGN, OTHER, 1_000 ether);

        vm.prank(OTHER);
        vm.expectRevert(EscrowVault.CampaignNotRegistered.selector);
        vault.release(OTHER, 100 ether);
    }

    function test_Release_revertsInsufficient() public {
        _registerCampaign(CAMPAIGN);
        _fund(CAMPAIGN, OTHER, 100);

        vm.prank(CAMPAIGN);
        vm.expectRevert(abi.encodeWithSelector(EscrowVault.InsufficientBalance.selector, 100, 101));
        vault.release(OTHER, 101);
    }

    function test_Release_revertsUnregisteredCampaign() public {
        vm.prank(CAMPAIGN);
        vm.expectRevert(EscrowVault.CampaignNotRegistered.selector);
        vault.release(OTHER, 1);
    }

    function test_Release_revertsZeroAmount() public {
        _registerCampaign(CAMPAIGN);
        vm.prank(CAMPAIGN);
        vm.expectRevert(EscrowVault.ZeroAmount.selector);
        vault.release(OTHER, 0);
    }

    // ── reclaim ───────────────────────────────────────────────────

    function test_Reclaim() public {
        _registerCampaign(CAMPAIGN);
        _fund(CAMPAIGN, OTHER, 500);

        vm.prank(CAMPAIGN);
        vault.reclaim(OTHER, 500);

        assertEq(vault.balanceOf(CAMPAIGN), 0);
        assertEq(token.balanceOf(OTHER), 500);
    }

    function test_Reclaim_revertsWhenNotCampaign() public {
        _registerCampaign(CAMPAIGN);
        _fund(CAMPAIGN, OTHER, 500);

        vm.prank(OTHER);
        vm.expectRevert(EscrowVault.CampaignNotRegistered.selector);
        vault.reclaim(OTHER, 1);
    }

    function test_Reclaim_revertsInsufficient() public {
        _registerCampaign(CAMPAIGN);
        _fund(CAMPAIGN, OTHER, 10);

        vm.prank(CAMPAIGN);
        vm.expectRevert(abi.encodeWithSelector(EscrowVault.InsufficientBalance.selector, 10, 11));
        vault.reclaim(OTHER, 11);
    }

    // ── cross-campaign isolation ──────────────────────────────────

    function test_CampaignsAreIsolated() public {
        address otherCampaign = address(0x0C0C);
        _registerCampaign(CAMPAIGN);
        _registerCampaign(otherCampaign);
        _fund(CAMPAIGN, OTHER, 1_000);

        // otherCampaign is registered but never funded: it sees a zero balance of its own and
        // cannot reach into CAMPAIGN's escrow.
        vm.prank(otherCampaign);
        vm.expectRevert(abi.encodeWithSelector(EscrowVault.InsufficientBalance.selector, 0, 1));
        vault.release(OTHER, 1);

        assertEq(vault.balanceOf(CAMPAIGN), 1_000);
        assertEq(vault.balanceOf(otherCampaign), 0);
    }
}
