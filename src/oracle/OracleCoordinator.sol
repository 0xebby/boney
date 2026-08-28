// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IOracleCoordinator} from "../interfaces/IOracleCoordinator.sol";
import {ICampaign} from "../interfaces/ICampaign.sol";
import {ICampaignRegistry} from "../interfaces/ICampaignRegistry.sol";

/// @title OracleCoordinator
/// @notice Staked reporting of campaign-level KPI aggregates with an optimistic dispute window.
/// @dev Reporters post collateral and submit a report, which lands only after `disputeWindow` elapses
///      without a challenge. A successful dispute slashes the reporter and voids the report.
///      Dispute authority is the governor's. Report ids hash the reporter and a per-reporter
///      sequence, so two reporters can make the same claim without collision.
contract OracleCoordinator is IOracleCoordinator, Ownable, ReentrancyGuard {
    /// @notice Lifecycle state of a submitted report.
    /// @param reporter Account that submitted the report.
    /// @param campaign Campaign the report targets.
    /// @param kpiIndex KPI index within that campaign.
    /// @param amount New total being reported — campaign-level for an aggregate report,
    ///        `(user, kpi)`-level for a per-user one.
    /// @param deadline Timestamp after which the report may be applied.
    /// @param disputed Whether governance voided the report.
    /// @param applied Whether the report has already been pushed to the campaign.
    /// @param user End user credited by a per-user report, or `address(0)` for an aggregate. The
    ///        discriminator between the two kinds.
    /// @param evidence Verifier evidence forwarded to `reportUserAction`; empty for aggregates.
    struct ReportState {
        address reporter;
        address campaign;
        uint256 kpiIndex;
        uint256 amount;
        uint64 deadline;
        bool disputed;
        bool applied;
        address user;
        bytes evidence;
    }

    /// @notice Registry used to confirm a target address is a real campaign.
    /// @dev Not immutable: the coordinator is deployed before the registry, then wired exactly once
    ///      via `setCampaignRegistry`.
    ICampaignRegistry public campaignRegistry;

    /// @notice Minimum collateral required to submit reports.
    uint256 public immutable minStake;

    /// @inheritdoc IOracleCoordinator
    uint256 public immutable disputeWindow;

    /// @notice Cooldown after a reporter's last report before their stake can be withdrawn, so
    ///         collateral is still slashable while reports are in flight.
    uint256 public immutable unstakeDelay;

    /// @dev reporter => collateral currently posted.
    mapping(address => uint256) private _stake;
    /// @dev reporter => next report sequence number, folded into the report id.
    mapping(address => uint256) private _sequence;
    /// @dev reporter => timestamp before which stake is locked.
    mapping(address => uint256) public stakeLockedUntil;
    /// @dev reportId => report state.
    mapping(bytes32 => ReportState) private _reports;
    /// @notice Total slashed collateral held by the protocol.
    uint256 public slashPool;

    /// @notice Deploys the coordinator with staking and dispute parameters.
    /// @param governor Owner able to dispute reports and withdraw the slash pool.
    /// @param minStake_ Minimum collateral required to submit reports.
    /// @param disputeWindow_ Seconds a report stays challengeable before it can be applied.
    /// @param unstakeDelay_ Extra cooldown past the dispute window before stake unlocks.
    constructor(address governor, uint256 minStake_, uint256 disputeWindow_, uint256 unstakeDelay_)
        Ownable(governor)
    {
        if (governor == address(0)) revert ZeroAddress();
        minStake = minStake_;
        disputeWindow = disputeWindow_;
        unstakeDelay = unstakeDelay_;
    }

    /// @notice Wire the campaign registry. Callable exactly once, by the governor.
    /// @param registry Address of the campaign registry.
    function setCampaignRegistry(address registry) external onlyOwner {
        if (registry == address(0)) revert ZeroAddress();
        if (address(campaignRegistry) != address(0)) revert RegistryAlreadySet();
        campaignRegistry = ICampaignRegistry(registry);
        emit RegistrySet(registry);
    }

    // ── staking ──────────────────────────────────────────────────

    /// @inheritdoc IOracleCoordinator
    /// @dev Accepts partial deposits; eligibility is enforced at submission, not here.
    function stake() external payable {
        if (msg.value == 0) revert NothingStaked();
        _stake[msg.sender] += msg.value;
        emit ReporterStaked(msg.sender, msg.value);
    }

    /// @inheritdoc IOracleCoordinator
    /// @dev Blocked until every report the reporter filed has passed its dispute window.
    function unstake() external nonReentrant {
        uint256 amount = _stake[msg.sender];
        if (amount == 0) revert NothingStaked();

        uint256 lockedUntil = stakeLockedUntil[msg.sender];
        if (block.timestamp < lockedUntil) revert StakeLocked(lockedUntil);

        _stake[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    // ── reporting ────────────────────────────────────────────────

    /// @inheritdoc IOracleCoordinator
    function submitReport(Report calldata report) external returns (bytes32 reportId) {
        return _record(report.campaign, report.kpiIndex, report.amount, address(0), "");
    }

    /// @inheritdoc IOracleCoordinator
    /// @dev Rejects a zero user; `address(0)` marks a stored report as an aggregate.
    function submitUserReport(UserReport calldata report) external returns (bytes32 reportId) {
        if (report.user == address(0)) revert ZeroAddress();
        return _record(report.campaign, report.kpiIndex, report.newTotal, report.user, report.evidence);
    }

    /// @dev Shared submission path for both report kinds: stake gate, campaign check, id derivation,
    ///      and the collateral lock. `user` is folded into the id, so the two kinds have disjoint ids.
    /// @param campaign Campaign the report targets.
    /// @param kpiIndex KPI index within that campaign.
    /// @param amount New total being reported.
    /// @param user End user for a per-user report, or `address(0)` for an aggregate.
    /// @param evidence Verifier evidence forwarded on apply; empty for aggregates.
    /// @return reportId Id of the stored report.
    function _record(address campaign, uint256 kpiIndex, uint256 amount, address user, bytes memory evidence)
        private
        returns (bytes32 reportId)
    {
        if (_stake[msg.sender] < minStake) revert NotAReporter(msg.sender);
        if (address(campaignRegistry) == address(0)) revert RegistryNotSet();
        if (!campaignRegistry.isCampaign(campaign)) revert UnknownCampaign(campaign);

        uint256 seq = _sequence[msg.sender]++;
        reportId = keccak256(abi.encode(msg.sender, campaign, kpiIndex, amount, user, seq));
        if (_reports[reportId].reporter != address(0)) revert ReportAlreadyExists(reportId);

        uint64 deadline = uint64(block.timestamp + disputeWindow);
        _reports[reportId] = ReportState({
            reporter: msg.sender,
            campaign: campaign,
            kpiIndex: kpiIndex,
            amount: amount,
            deadline: deadline,
            disputed: false,
            applied: false,
            user: user,
            evidence: evidence
        });

        // Keep collateral locked past this report's dispute window.
        uint256 lockUntil = block.timestamp + disputeWindow + unstakeDelay;
        if (lockUntil > stakeLockedUntil[msg.sender]) stakeLockedUntil[msg.sender] = lockUntil;

        emit ReportSubmitted(reportId, campaign, msg.sender, deadline);
    }

    /// @inheritdoc IOracleCoordinator
    /// @dev Permissionless once the dispute window closes.
    function applyReport(bytes32 reportId) external nonReentrant {
        ReportState storage r = _reports[reportId];
        if (r.user != address(0)) revert NotAggregateReport(reportId);
        _clearForApply(r, reportId);

        ICampaign(r.campaign).applyAggregateUpdate(r.kpiIndex, r.amount);
        emit ReportApplied(reportId, r.campaign);
    }

    /// @inheritdoc IOracleCoordinator
    /// @dev The campaign resolves attribution, credits the promoter, and settles crossed tiers inline.
    function applyUserReport(bytes32 reportId) external nonReentrant {
        ReportState storage r = _reports[reportId];
        if (r.user == address(0)) revert NotUserReport(reportId);
        _clearForApply(r, reportId);

        ICampaign(r.campaign).reportUserAction(r.kpiIndex, r.user, r.amount, r.evidence);
        emit ReportApplied(reportId, r.campaign);
    }

    /// @dev Shared checks for both apply paths. Marks the report applied before the external campaign
    ///      call.
    /// @param r The stored report.
    /// @param reportId Id of that report, for error reporting.
    function _clearForApply(ReportState storage r, bytes32 reportId) private {
        if (r.reporter == address(0)) revert UnknownReport(reportId);
        if (r.disputed) revert ReportIsDisputed(reportId);
        if (r.applied) revert ReportAlreadyApplied(reportId);
        if (block.timestamp < r.deadline) revert DisputeWindowOpen(r.deadline);

        r.applied = true;
    }

    /// @inheritdoc IOracleCoordinator
    function disputeReport(bytes32 reportId) external onlyOwner {
        ReportState storage r = _reports[reportId];
        if (r.reporter == address(0)) revert UnknownReport(reportId);
        if (r.applied) revert ReportAlreadyApplied(reportId);
        if (block.timestamp >= r.deadline) revert DisputeWindowClosed(r.deadline);

        r.disputed = true;

        uint256 slashed = _stake[r.reporter];
        if (slashed != 0) {
            _stake[r.reporter] = 0;
            slashPool += slashed;
            emit ReporterSlashed(r.reporter, slashed);
        }

        emit ReportDisputed(reportId, r.campaign, msg.sender);
    }

    /// @notice Withdraw slashed collateral to the protocol treasury.
    /// @param to Recipient of the slashed funds.
    function withdrawSlashPool(address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = slashPool;
        if (amount == 0) revert NothingStaked();

        slashPool = 0;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    // ── views ────────────────────────────────────────────────────

    /// @inheritdoc IOracleCoordinator
    function reportDeadline(bytes32 reportId) external view returns (uint256) {
        return _reports[reportId].deadline;
    }

    /// @inheritdoc IOracleCoordinator
    function reportDisputed(bytes32 reportId) external view returns (bool) {
        return _reports[reportId].disputed;
    }

    /// @inheritdoc IOracleCoordinator
    function reportApplied(bytes32 reportId) external view returns (bool) {
        return _reports[reportId].applied;
    }

    /// @inheritdoc IOracleCoordinator
    function stakeOf(address reporter) external view returns (uint256) {
        return _stake[reporter];
    }

    /// @inheritdoc IOracleCoordinator
    function campaignContract() external view returns (address) {
        return address(campaignRegistry);
    }

    /// @notice Full state of a report.
    /// @param reportId Id returned by `submitReport`.
    /// @return The stored report state.
    function reportState(bytes32 reportId) external view returns (ReportState memory) {
        return _reports[reportId];
    }

    /// @notice Whether `who` currently meets the stake requirement.
    /// @param who Address to check.
    /// @return True if their stake is at or above `minStake`.
    function isReporter(address who) external view returns (bool) {
        return _stake[who] >= minStake;
    }
}
