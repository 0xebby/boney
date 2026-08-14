// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title Types
/// @notice Shared enums and structs for the Boney protocol.
/// @dev Supersedes the hardcoded `BoneyCore.DelivarableTypes` struct: KPIs are described by
///      `KpiSpec`, which pairs a protocol-recognized `kind` with an optional external verifier
///      adapter so new metrics can be added without changing core contracts.
library Types {
    /// @notice Protocol-recognized KPI categories.
    /// @dev `Custom` defers entirely to a `verifier` adapter. Every other value is a hint for
    ///      indexers and UIs; settlement logic never branches on `kind`.
    enum KpiKind {
        Custom,
        Mint,
        Swap,
        TokenPurchase,
        Deposit,
        Stake,
        Bridge,
        Tvl,
        Volume,
        ActiveUser,
        signUps,
        downloads
    }

    /// @notice Campaign lifecycle.
    /// @dev `Pending` accepts escrow deposits. `Active` accepts KPI reports. `Paused` is a
    ///      reversible halt. `Ended` and `Cancelled` are terminal; both allow escrow reclaim
    ///      after the claim grace window.
    enum CampaignStatus {
        Pending,
        Active,
        Paused,
        Ended,
        Cancelled
    }

    /// @notice A single measurable objective within a campaign.
    /// @param kind Category hint; `Custom` requires a verifier.
    /// @param verifier Optional `IKpiVerifier` adapter. `address(0)` means the raw reported
    ///        amount is credited as-is (trusting the reporter/oracle).
    /// @param target Campaign-wide goal for this KPI. Informational; tiers drive payouts.
    /// @param aggregate If true this KPI is campaign-level and oracle-reported only; it never
    ///        credits an individual promoter. See decision D7 in todo.md.
    /// @param params Opaque configuration forwarded to the verifier (e.g. the contract address
    ///        and event signature being tracked).
    struct KpiSpec {
        KpiKind kind;
        address verifier;
        uint256 target;
        bool aggregate;
        bytes params;
    }

    /// @notice A payout threshold for a single KPI.
    /// @param threshold Attributed progress a promoter must reach to unlock `reward`.
    /// @param reward Amount released from the shared pool when the threshold is crossed.
    struct RewardTier {
        uint256 threshold;
        uint256 reward;
    }

    /// @notice Immutable campaign parameters, fixed at deployment.
    /// @param project Owner of the campaign; receives unspent escrow on end/cancel.
    /// @param name Human-readable campaign name, shown wherever the campaign is listed. 
    ///        the normalized form exists only as the registry's lookup key.
    /// @param token ERC20 used for escrow and payouts.
    /// @param rewardPool Total escrow required before the campaign can be activated.
    /// @param startTime Earliest timestamp at which the campaign may be activated.
    /// @param endTime Timestamp after which KPI reports are rejected.
    /// @param attributionWindow Seconds an attribution touch stays valid for a user.
    /// @param minReputation Minimum reputation score required for a promoter to join.
    struct CampaignConfig {
        address project;
        string name;
        address token;
        uint256 rewardPool;
        uint64 startTime;
        uint64 endTime;
        uint64 attributionWindow;
        uint256 minReputation;
    }
}
