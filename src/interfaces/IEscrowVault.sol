// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title IEscrowVault
/// @notice Custody for campaign funds. Holds no business logic: it tracks a per-campaign balance
///         and only the campaign itself may move its own funds.
interface IEscrowVault {
    // ── errors ───────────────────────────────────────────────────

    error NotRegistrar();
    error NotAdmin();
    error ZeroAddress();
    error AlreadyRegistered();
    error CampaignNotRegistered();
    error ZeroAmount();
    error InsufficientBalance(uint256 available, uint256 requested);
    error RegistrarAlreadySet();
    error RegistrarNotSet();

    // ── events ───────────────────────────────────────────────────

    /// @notice Emitted when a campaign is bound to its escrow token. Must precede any deposit.
    /// @param campaign The campaign being bound.
    /// @param token ERC20 it escrows and pays out in.
    event CampaignRegistered(address indexed campaign, address indexed token);

    /// @notice Emitted once when the campaign registry is wired. Fires at most once per vault.
    /// @param registrar The campaign registry.
    event RegistrarSet(address indexed registrar);

    /// @notice Emitted when funds enter a campaign's escrow.
    /// @param campaign The campaign credited.
    /// @param from Who paid.
    /// @param amount Amount actually received and credited, which is less than the amount
    ///        requested for a fee-on-transfer token.
    event Deposited(address indexed campaign, address indexed from, uint256 amount);

    /// @notice Emitted when a campaign pays a promoter.
    /// @param campaign The campaign spending.
    /// @param to The promoter paid.
    /// @param amount Amount released.
    event Released(address indexed campaign, address indexed to, uint256 amount);

    /// @notice Emitted when unspent escrow returns to a project.
    /// @param campaign The campaign returning funds.
    /// @param to Recipient, the project.
    /// @param amount Amount returned.
    event Reclaimed(address indexed campaign, address indexed to, uint256 amount);

    /// @notice Bind a campaign to the token it escrows. Callable only by the registrar.
    /// @param campaign The campaign being bound.
    /// @param token ERC20 the campaign escrows and pays out in.
    function registerCampaign(address campaign, address token) external;

    /// @notice Bind the campaign registry. Callable exactly once, by the admin.
    /// @param registrar Address of the campaign registry contract.
    function setRegistrar(address registrar) external;

    /// @notice Pull `amount` of the campaign's token from the caller into escrow.
    /// @dev Pulls from `msg.sender` only; there is no `from` parameter.
    /// @param campaign The campaign to credit.
    /// @param amount Amount to pull. The balance credited is the amount actually received, which
    ///        may be less for a fee-on-transfer token.
    function deposit(address campaign, uint256 amount) external;

    /// @notice Pay out from the caller's own campaign balance. Caller must be the campaign.
    /// @param to Recipient of the payout.
    /// @param amount Amount to release.
    function release(address to, uint256 amount) external;

    /// @notice Return unspent funds from the caller's own campaign balance to `to`.
    /// @param to Recipient of the returned funds.
    /// @param amount Amount to reclaim.
    function reclaim(address to, uint256 amount) external;

    /// @notice Escrowed balance credited to `campaign`.
    /// @param campaign The campaign to query.
    /// @return Spendable balance, denominated in the campaign's token.
    function balanceOf(address campaign) external view returns (uint256);

    /// @notice Token a campaign escrows and pays out in.
    /// @param campaign The campaign to query.
    /// @return The bound ERC20 address, or `address(0)` if unregistered.
    function tokenOf(address campaign) external view returns (address);

    /// @notice Account allowed to register campaigns — the campaign registry.
    /// @return The registrar address, or `address(0)` before wiring.
    function registrar() external view returns (address);
}
