// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IEscrowVault} from "../interfaces/IEscrowVault.sol";

/// @title EscrowVault
/// @notice Custody for campaign funds.
/// @dev Deliberately dumb: it knows a campaign's token and balance, and nothing about KPIs,
///      tiers, or reputation. Only a campaign may move its own funds, so a compromised campaign
///      can never drain another campaign's escrow. The registrar (the CampaignRegistry) is the
///      only account that may bind a campaign to a token.
///
///      Accounting uses an internal ledger rather than `token.balanceOf(this)` so that a
///      fee-on-transfer or rebasing token, or an unsolicited direct transfer, cannot shift one
///      campaign's spendable balance. Deposits credit the *actually received* amount.
contract EscrowVault is IEscrowVault, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Account that may wire the registrar, exactly once.
    address public immutable admin;

    /// @notice Account allowed to register campaigns — the CampaignRegistry.
    /// @dev Not a constructor argument: the registry needs this vault's address at its own
    ///      construction, so one of the two must be wired afterwards. Predicting the registry's
    ///      address with `computeCreateAddress` is fragile (it breaks whenever the deployer's
    ///      nonce differs between simulation and broadcast, silently producing a vault whose
    ///      registrar can never register anything). A one-time setter makes the misconfiguration
    ///      impossible instead of merely unlikely.
    address public registrar;

    /// @dev campaign => escrow token.
    mapping(address => address) private _token;
    /// @dev campaign => spendable balance, denominated in that campaign's token.
    mapping(address => uint256) private _balance;

    /// @dev Restricts a call to the registrar, rejecting before the registrar is wired.
    modifier onlyRegistrar() {
        // Reject before wiring: an unset registrar must not match a zero-address caller.
        if (registrar == address(0)) revert RegistrarNotSet();
        if (msg.sender != registrar) revert NotRegistrar();
        _;
    }

    /// @notice Deploys the escrow vault with a designated admin.
    /// @param admin_ The account allowed to set the registrar.
    constructor(address admin_) {
        if (admin_ == address(0)) revert ZeroAddress();
        admin = admin_;
    }

    /// @notice Bind the campaign registry. Callable exactly once, by `admin`.
    /// @param registrar_ Address of the campaign registry contract.
    function setRegistrar(address registrar_) external {
        if (msg.sender != admin) revert NotAdmin();
        if (registrar_ == address(0)) revert ZeroAddress();
        if (registrar != address(0)) revert RegistrarAlreadySet();
        registrar = registrar_;
        emit RegistrarSet(registrar_);
    }

    /// @inheritdoc IEscrowVault
    /// @param campaign The campaign being bound to a token.
    /// @param token_ ERC20 the campaign escrows and pays out in.
    function registerCampaign(address campaign, address token_) external onlyRegistrar {
        if (campaign == address(0) || token_ == address(0)) revert ZeroAddress();
        if (_token[campaign] != address(0)) revert AlreadyRegistered();

        _token[campaign] = token_;
        emit CampaignRegistered(campaign, token_);
    }

    /// @inheritdoc IEscrowVault
    /// @param campaign The campaign to credit.
    /// @param amount Amount to pull from the caller.
    /// @dev Credits the balance actually received, which may be less than `amount` for a
    ///      fee-on-transfer token. The caller must have approved this vault.
    function deposit(address campaign, uint256 amount) external nonReentrant {
        address token_ = _token[campaign];
        if (token_ == address(0)) revert CampaignNotRegistered();
        if (amount == 0) revert ZeroAmount();

        uint256 before = IERC20(token_).balanceOf(address(this));
        IERC20(token_).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token_).balanceOf(address(this)) - before;
        if (received == 0) revert ZeroAmount();

        _balance[campaign] += received;
        emit Deposited(campaign, msg.sender, received);
    }

    /// @inheritdoc IEscrowVault
    /// @param to Recipient of the payout.
    /// @param amount Amount to release from the caller's balance.
    /// @dev The caller *is* the campaign; there is no campaign parameter to spoof.
    function release(address to, uint256 amount) external nonReentrant {
        _spend(msg.sender, to, amount);
        emit Released(msg.sender, to, amount);
    }

    /// @inheritdoc IEscrowVault
    /// @param to Recipient of the returned funds.
    /// @param amount Amount to reclaim from the caller's balance.
    function reclaim(address to, uint256 amount) external nonReentrant {
        _spend(msg.sender, to, amount);
        emit Reclaimed(msg.sender, to, amount);
    }

    /// @dev Debits `campaign`'s ledger entry and transfers out. Reverts if the campaign is
    ///      unregistered or underfunded, so a campaign can only ever spend what it escrowed.
    /// @param campaign The campaign whose ledger entry is debited.
    /// @param to Recipient of the transfer.
    /// @param amount Amount to debit and transfer.
    function _spend(address campaign, address to, uint256 amount) private {
        address token_ = _token[campaign];
        if (token_ == address(0)) revert CampaignNotRegistered();
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        uint256 available = _balance[campaign];
        if (amount > available) revert InsufficientBalance(available, amount);

        // Debit before transferring; combined with nonReentrant this closes the reentrancy path
        // for tokens with transfer hooks.
        _balance[campaign] = available - amount;
        IERC20(token_).safeTransfer(to, amount);
    }

    /// @inheritdoc IEscrowVault
    /// @param campaign Address of the campaign to query.
    /// @return The escrowed balance for the campaign.
    function balanceOf(address campaign) external view returns (uint256) {
        return _balance[campaign];
    }

    /// @inheritdoc IEscrowVault
    /// @param campaign Address of the campaign to query.
    /// @return The token address bound to the campaign.
    function tokenOf(address campaign) external view returns (address) {
        return _token[campaign];
    }
}
