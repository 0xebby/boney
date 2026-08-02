// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title IEscrowVault
/// @notice Custody for campaign funds. Holds no business logic: it tracks a per-campaign balance
///         and only the campaign itself may move its own funds.
interface IEscrowVault {
    event CampaignRegistered(address indexed campaign, address indexed token);
    event RegistrarSet(address indexed registrar);
    event Deposited(address indexed campaign, address indexed from, uint256 amount);
    event Released(address indexed campaign, address indexed to, uint256 amount);
    event Reclaimed(address indexed campaign, address indexed to, uint256 amount);

    /// @notice Bind a campaign to the token it escrows. Callable only by the registrar.
    function registerCampaign(address campaign, address token) external;

    /// @notice Bind the campaign registry. Callable exactly once, by the admin.
    function setRegistrar(address registrar) external;

    /// @notice Pull `amount` of the campaign's token from the caller into escrow.
    /// @dev Pulls from `msg.sender` only. An arbitrary `from` parameter would let anyone move
    ///      tokens out of any address that had approved this vault and into a campaign of their
    ///      choosing — where they would control the reclaim.
    function deposit(address campaign, uint256 amount) external;

    /// @notice Pay out from the caller's own campaign balance. Caller must be the campaign.
    function release(address to, uint256 amount) external;

    /// @notice Return unspent funds from the caller's own campaign balance to `to`.
    function reclaim(address to, uint256 amount) external;

    function balanceOf(address campaign) external view returns (uint256);

    function tokenOf(address campaign) external view returns (address);

    function registrar() external view returns (address);
}
