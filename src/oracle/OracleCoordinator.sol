// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IOracleCoordinator} from "../interfaces/IOracleCoordinator.sol";
import {ICampaign} from "../interfaces/ICampaign.sol";
import {ICampaignRegistry} from "../interfaces/ICampaignRegistry.sol";

/// @title OracleCoordinator
/// @notice Staked reporting of campaign-level KPI aggregates with an optimistic dispute window.
/// @dev Roadmap phase 3 in miniature: reporters post collateral, submit a report, and the report
///      only lands after `disputeWindow` elapses without a challenge. A successful dispute slashes
///      the reporter and permanently voids the report.
///
///      MVP scope (tracked in todo.md): dispute authority is the governor's. Permissionless
///      disputes with challenger bonds are the next step and do not change this contract's shape —
///      only who may call `disputeReport`.
///
///      Reports are keyed by content hash including the reporter and a per-reporter sequence, so
///      two reporters can make the same claim independently and neither can overwrite the other.
contract OracleCoordinator is IOracleCoordinator, Ownable, ReentrancyGuard {
    error ZeroAddress();
    error NotAReporter(address who);
    error NothingStaked();
    error StakeLocked(uint256 until);
    error UnknownReport(bytes32 reportId);
    error ReportAlreadyExists(bytes32 reportId);
    error DisputeWindowOpen(uint256 until);
    error DisputeWindowClosed(uint256 until);
    error ReportIsDisputed(bytes32 reportId);
    error ReportAlreadyApplied(bytes32 reportId);
    error UnknownCampaign(address campaign);
    error TransferFailed();
    error RegistryAlreadySet();
    error RegistryNotSet();

    /// @notice Emitted once the campaign registry is wired.
    /// @notice Emitted once when the campaign registry is wired, enabling report submission.
    /// @param registry The campaign registry used to validate report targets.
    event RegistrySet(address indexed registry);

    /// @notice Lifecycle state of a submitted report.
    /// @param reporter Account that submitted the report.
    /// @param campaign Campaign the report targets.
    /// @param kpiIndex KPI index within that campaign.
    /// @param amount New campaign-level total being reported.
    /// @param deadline Timestamp after which the report may be applied.
    /// @param disputed Whether governance voided the report.
    /// @param applied Whether the report has already been pushed to the campaign.
    struct ReportState {
        address reporter;
        address campaign;
        uint256 kpiIndex;
        uint256 amount;
        uint64 deadline;
        bool disputed;
        bool applied;
    }

    /// @notice Registry used to confirm a target address is a real campaign.
    /// @dev Not immutable because the registry must know this coordinator's address at its own
    ///      construction, and this coordinator must know the registry's — a cycle. The coordinator
    ///      is deployed first with no registry, then wired exactly once via `setCampaignRegistry`.
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
    /// @dev reporter => next report sequence number. Folded into the report id so a reporter can
    ///      file the same claim twice without the second submission colliding with the first.
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
    /// @dev Accepts partial deposits so collateral can be accumulated over several transactions.
    ///      Eligibility is enforced at `submitReport` (via `_stake >= minStake`), not here, so a
    ///      reporter is not forced to reach the minimum in a single call.
    function stake() external payable {
        if (msg.value == 0) revert NothingStaked();
        _stake[msg.sender] += msg.value;
        emit ReporterStaked(msg.sender, msg.value);
    }

    /// @inheritdoc IOracleCoordinator
    /// @dev Blocked until every report the reporter filed has passed its dispute window;
    ///      otherwise a reporter could submit a false report and exit before being slashed.
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
        if (_stake[msg.sender] < minStake) revert NotAReporter(msg.sender);
        if (address(campaignRegistry) == address(0)) revert RegistryNotSet();
        if (!campaignRegistry.isCampaign(report.campaign)) revert UnknownCampaign(report.campaign);

        uint256 seq = _sequence[msg.sender]++;
        reportId = keccak256(abi.encode(msg.sender, report.campaign, report.kpiIndex, report.amount, seq));
        if (_reports[reportId].reporter != address(0)) revert ReportAlreadyExists(reportId);

        uint64 deadline = uint64(block.timestamp + disputeWindow);
        _reports[reportId] = ReportState({
            reporter: msg.sender,
            campaign: report.campaign,
            kpiIndex: report.kpiIndex,
            amount: report.amount,
            deadline: deadline,
            disputed: false,
            applied: false
        });

        // Keep collateral locked past this report's dispute window.
        uint256 lockUntil = block.timestamp + disputeWindow + unstakeDelay;
        if (lockUntil > stakeLockedUntil[msg.sender]) stakeLockedUntil[msg.sender] = lockUntil;

        emit ReportSubmitted(reportId, report.campaign, msg.sender, deadline);
    }

    /// @inheritdoc IOracleCoordinator
    /// @dev Permissionless once the window closes: anyone can push a good report through.
    function applyReport(bytes32 reportId) external nonReentrant {
        ReportState storage r = _reports[reportId];
        if (r.reporter == address(0)) revert UnknownReport(reportId);
        if (r.disputed) revert ReportIsDisputed(reportId);
        if (r.applied) revert ReportAlreadyApplied(reportId);
        if (block.timestamp < r.deadline) revert DisputeWindowOpen(r.deadline);

        r.applied = true;
        ICampaign(r.campaign).applyAggregateUpdate(r.kpiIndex, r.amount);
        emit ReportApplied(reportId, r.campaign);
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
