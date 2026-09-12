// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ICampaign} from "../interfaces/ICampaign.sol";
import {IEscrowVault} from "../interfaces/IEscrowVault.sol";
import {IReputationRegistry} from "../interfaces/IReputationRegistry.sol";
import {IAttributionRegistry} from "../interfaces/IAttributionRegistry.sol";
import {IKpiVerifier} from "../interfaces/IKpiVerifier.sol";
import {Types} from "../libraries/Types.sol";
import {Names} from "../libraries/Names.sol";

/// @title Campaign
/// @notice One performance campaign: escrowed rewards released automatically as attributed KPI
///         progress crosses per-promoter thresholds.
contract Campaign is ICampaign, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Window after a campaign ends during which promoters may still settle earned tiers,
    ///         before the project can reclaim what is left.
    /// @dev [bscoretest] Protocol value is 7 days.
    uint64 public constant CLAIM_GRACE = 20 minutes;

    /// @notice Maximum number of KPIs a campaign may carry.
    /// @dev Validated once at construction.
    uint256 public constant MAX_KPIS = 32;
    /// @notice Maximum number of reward tiers per KPI.
    uint256 public constant MAX_TIERS_PER_KPI = 32;
    /// @notice Maximum extension numerator against the initial campaign duration.
    uint256 public constant MAX_EXTENSION_NUMERATOR = 1;
    /// @notice Maximum extension denominator against the initial campaign duration.
    uint256 public constant MAX_EXTENSION_DENOMINATOR = 2;
    /// @notice Maximum extension duration.
    uint64 public constant MAX_EXTENSION_DURATION = 360 days;

    /// @notice Maximum number of evidence actions a single report may carry.
    /// @dev Bounds the segment walk in `reportUserAction`.
    uint256 public constant MAX_EVIDENCE_ACTIONS = 256;

    // ── dependencies ─────────────────────────────────────────────

    /// @notice Vault holding this campaign's escrowed rewards.
    IEscrowVault public immutable escrowVault;
    /// @notice Registry resolving which promoter owns a given end user.
    IAttributionRegistry public immutable attributionRegistry;
    /// @notice Registry consulted for the `minReputation` gate at join time.
    IReputationRegistry public immutable reputationRegistry;
    /// @notice Coordinator allowed to push aggregate updates and user reports.
    address public immutable oracleCoordinator;

    /// @notice Owner of the campaign; funds it, controls its lifecycle, receives unspent escrow.
    address public immutable project;
    /// @notice Human-readable campaign name, as supplied at creation.
    string public name;
    /// @notice ERC20 used for escrow and payouts.
    address public immutable token;
    /// @notice Current escrow ceiling on all payouts.
    uint256 private _rewardPool;
    /// @notice Initial reward pool used for top-up limits.
    uint256 public immutable initialRewardPool;
    /// @notice Start of the window in which reports are accepted.
    uint64 public immutable startTime;
    /// @notice End of that window. Past it, anyone may `end()` the campaign.
    uint64 private _endTime;
    /// @notice Initial reporting duration used to bound extensions.
    uint64 public immutable initialDuration;
    /// @notice Absolute reporting deadline after the maximum allowed extension.
    uint64 public immutable maximumEndTime;
    /// @dev Advisory. The hard cap on touch lifetime lives in `AttributionRegistry`.
    uint64 public immutable attributionWindow;
    /// @notice Minimum reputation score a promoter needs to join. 0 disables the gate.
    uint256 public immutable minReputation;

    /// @dev KPI specs, indexed by `kpiIndex` throughout the contract.
    Types.KpiSpec[] private _kpis;
    /// @dev Reward ladders, outer index aligned to `_kpis`; each inner array ascends by threshold.
    Types.RewardTier[][] private _tiers;

    // ── mutable state ────────────────────────────────────────────

    /// @inheritdoc ICampaign
    Types.CampaignStatus public status;
    /// @inheritdoc ICampaign
    uint256 public paidOut;
    /// @notice When the campaign became terminal, and the start of `CLAIM_GRACE`.
    /// @dev 0 until `end()` or `cancel()` runs.
    uint64 public endedAt;

    /// @dev promoter id => promoter wallet. Only ids this campaign issued.
    mapping(bytes32 => address) private _promoterOf;
    /// @dev promoter wallet => campaign-bound promoter id.
    mapping(address => bytes32) private _promoterIdOf;
    /// @dev promoter => kpiIndex => cumulative attributed progress.
    mapping(address => mapping(uint256 => uint256)) private _progress;
    /// @dev promoter => kpiIndex => number of tiers already settled.
    mapping(address => mapping(uint256 => uint256)) private _settledTiers;
    /// @dev user => kpiIndex => cumulative amount already credited (replay guard).
    mapping(address => mapping(uint256 => uint256)) private _userCredited;
    /// @dev user => kpiIndex => block of the last report that credited anything for the pair.
    mapping(address => mapping(uint256 => uint64)) private _lastReportBlock;
    /// @dev user => kpiIndex => promoter id => cumulative amount credited to that promoter. Sums to
    ///      `_userCredited` for the same pair.
    mapping(address => mapping(uint256 => mapping(bytes32 => uint256))) private _creditedTo;
    /// @dev kpiIndex => campaign-level total.
    mapping(uint256 => uint256) private _totalProgress;
    /// @dev promoter => kpiIndex => unpaid reward from pool exhaustion.
    mapping(address => mapping(uint256 => uint256)) private _shortfall;
    /// @dev Total unpaid rewards across all promoters and KPIs.
    uint256 private _totalShortfall;
    /// @dev Accounts allowed to report user actions on behalf of the project.
    mapping(address => bool) public override authorizedReporters;

    /// @dev Restricts a call to the campaign's project.
    modifier onlyProject() {
        if (msg.sender != project) revert NotProject();
        _;
    }

    /// @dev Restricts a call to an Active campaign.
    modifier onlyActive() {
        if (status != Types.CampaignStatus.Active) revert WrongStatus(status);
        _;
    }

    /// @notice Deploys a campaign with immutable configuration.
    /// @param cfg Immutable campaign parameters.
    /// @param kpis_ KPI specifications.
    /// @param tiers_ Reward tiers per KPI.
    /// @param escrowVault_ Vault holding escrowed rewards.
    /// @param attributionRegistry_ Registry storing attribution touches.
    /// @param reputationRegistry_ Registry backing reputation lookups.
    /// @param oracleCoordinator_ Coordinator authorized to push oracle updates.
    constructor(
        Types.CampaignConfig memory cfg,
        Types.KpiSpec[] memory kpis_,
        Types.RewardTier[][] memory tiers_,
        address escrowVault_,
        address attributionRegistry_,
        address reputationRegistry_,
        address oracleCoordinator_
    ) {
        if (
            cfg.project == address(0) || cfg.token == address(0) || escrowVault_ == address(0)
                || attributionRegistry_ == address(0) || reputationRegistry_ == address(0)
                || oracleCoordinator_ == address(0)
        ) revert ZeroAddress();
        if (cfg.rewardPool == 0) revert ZeroRewardPool();
        if (cfg.endTime <= cfg.startTime || cfg.endTime <= block.timestamp) revert InvalidWindow();
        if (cfg.attributionWindow == 0) revert InvalidWindow();

        /// @dev Reverts EmptyName / NameTooLong / InvalidNameChar. Uniqueness is CampaignRegistry's.
        Names.validate(cfg.name);

        // Reject a gate no wallet could clear.
        uint256 reputationCap = type(uint256).max;
        try IReputationRegistry(reputationRegistry_).maxScore() returns (uint256 reported) {
            reputationCap = reported;
        } catch {}
        if (cfg.minReputation > reputationCap) revert UnreachableReputation(cfg.minReputation, reputationCap);

        if (kpis_.length == 0) revert NoKpis();
        if (kpis_.length > MAX_KPIS) revert TooManyKpis(kpis_.length, MAX_KPIS);
        if (kpis_.length != tiers_.length) revert TierLengthMismatch();

        for (uint256 i; i < kpis_.length; ++i) {
            // A Custom KPI requires a verifier adapter.
            if (kpis_[i].kind == Types.KpiKind.Custom && kpis_[i].verifier == address(0)) {
                revert CustomKpiNeedsVerifier(i);
            }

            Types.RewardTier[] memory t = tiers_[i];
            // Aggregate KPIs are analytics-only and may carry no tiers.
            if (t.length == 0 && !kpis_[i].aggregate) revert EmptyTiers(i);
            if (t.length > MAX_TIERS_PER_KPI) {
                revert TooManyTiers(i, t.length, MAX_TIERS_PER_KPI);
            }

            uint256 previous;
            for (uint256 j; j < t.length; ++j) {
                if (t[j].reward == 0) revert ZeroTierReward(i, j);
                // @dev Thresholds must ascend strictly.
                if (t[j].threshold <= previous) revert TiersNotAscending(i, j);
                previous = t[j].threshold;
            }

            _kpis.push(kpis_[i]);
            _tiers.push();
            for (uint256 j; j < t.length; ++j) {
                _tiers[i].push(t[j]);
            }
        }

        project = cfg.project;
        name = cfg.name;
        token = cfg.token;
        _rewardPool = cfg.rewardPool;
        initialRewardPool = cfg.rewardPool;
        startTime = cfg.startTime;
        _endTime = cfg.endTime;
        initialDuration = cfg.endTime - cfg.startTime;
        uint256 extension = ((initialDuration * MAX_EXTENSION_NUMERATOR) / MAX_EXTENSION_DENOMINATOR);
        if (extension > MAX_EXTENSION_DURATION) extension = MAX_EXTENSION_DURATION;
        maximumEndTime = cfg.endTime + uint64(extension);
        attributionWindow = cfg.attributionWindow;
        minReputation = cfg.minReputation;

        escrowVault = IEscrowVault(escrowVault_);
        attributionRegistry = IAttributionRegistry(attributionRegistry_);
        reputationRegistry = IReputationRegistry(reputationRegistry_);
        oracleCoordinator = oracleCoordinator_;

        /// @dev all campaigns default to pending until activation via escrow funding.
        status = Types.CampaignStatus.Pending;
    }

    // ── lifecycle ────────────────────────────────────────────────

    /// @inheritdoc ICampaign
    /// @dev Requires the full reward pool to be escrowed first.
    function activate() external onlyProject {
        if (status != Types.CampaignStatus.Pending) revert WrongStatus(status);
        uint256 balance = escrowVault.balanceOf(address(this));
        if (balance < _rewardPool) revert NotFunded(balance, _rewardPool);
        if (block.timestamp >= _endTime) revert OutsideWindow(startTime, _endTime);

        _setStatus(Types.CampaignStatus.Active);
        emit Activated(startTime, _endTime);
    }

    /// @inheritdoc ICampaign
    function pause() external onlyProject onlyActive {
        _setStatus(Types.CampaignStatus.Paused);
    }

    /// @inheritdoc ICampaign
    function unpause() external onlyProject {
        if (status != Types.CampaignStatus.Paused) revert WrongStatus(status);
        _setStatus(Types.CampaignStatus.Active);
    }

    /// @inheritdoc ICampaign
    /// @dev The project may end early; anyone may end it once `endTime` has passed.
    function end() external {
        if (status != Types.CampaignStatus.Active && status != Types.CampaignStatus.Paused) {
            revert WrongStatus(status);
        }
        if (msg.sender != project && block.timestamp < _endTime) {
            revert OutsideWindow(startTime, _endTime);
        }

        if (status == Types.CampaignStatus.Active) {
            if (_totalShortfall != 0) revert OutstandingShortfall(_totalShortfall);
        }

        endedAt = uint64(block.timestamp);
        _setStatus(Types.CampaignStatus.Ended);
    }

    /// @inheritdoc ICampaign
    /// @dev Only from `Pending`.
    function cancel() external onlyProject {
        if (status != Types.CampaignStatus.Pending) revert WrongStatus(status);

        endedAt = uint64(block.timestamp);
        _setStatus(Types.CampaignStatus.Cancelled);
    }

    /// @inheritdoc ICampaign
    /// @dev The maximum deadline is fixed from the initial campaign duration and is not extended by
    ///      subsequent calls.
    function extend(uint64 newEndTime) external onlyProject {
        if (status != Types.CampaignStatus.Active && status != Types.CampaignStatus.Paused) {
            revert WrongStatus(status);
        }
        if (newEndTime <= _endTime) revert ExtensionNotForward(_endTime, newEndTime);

        if (newEndTime > maximumEndTime) revert ExtensionTooLarge(maximumEndTime, newEndTime);

        uint64 oldEndTime = _endTime;
        _endTime = newEndTime;
        emit Extended(oldEndTime, newEndTime);
    }

    /// @inheritdoc ICampaign
    /// @dev Pulls tokens from the project through the campaign's escrow account and raises the pool
    ///      by the amount the vault actually credits. Any recorded shortfall must be fully covered.
    function topUp(uint256 amount) external onlyProject nonReentrant {
        if (status != Types.CampaignStatus.Active && status != Types.CampaignStatus.Paused) {
            revert WrongStatus(status);
        }

        uint256 requiredPaidOut = (_rewardPool * 90) / 100;
        if (paidOut < requiredPaidOut) revert TopUpTooEarly(paidOut, requiredPaidOut);

        uint256 minimum = (initialRewardPool * 20) / 100;
        if (amount < minimum) revert TopUpTooSmall(amount, minimum);

        IERC20 poolToken = IERC20(token);
        uint256 before = poolToken.balanceOf(address(this));
        poolToken.safeTransferFrom(project, address(this), amount);
        uint256 received = poolToken.balanceOf(address(this)) - before;
        if (received < minimum) revert TopUpTooSmall(received, minimum);

        poolToken.forceApprove(address(escrowVault), received);
        uint256 escrowBefore = escrowVault.balanceOf(address(this));
        escrowVault.deposit(address(this), received);
        uint256 deposited = escrowVault.balanceOf(address(this)) - escrowBefore;
        if (deposited < _totalShortfall) revert ShortfallUnfunded(deposited, _totalShortfall);

        uint256 oldRewardPool = _rewardPool;
        _rewardPool += deposited;
        emit PoolIncreased(oldRewardPool, _rewardPool);
    }

    /// @inheritdoc ICampaign
    /// @dev Callable by the owed promoter after a top-up. A partial payment leaves the remainder
    ///      recorded for a later claim.
    function claimShortfall(uint256 kpiIndex) external nonReentrant {
        if (kpiIndex >= _kpis.length) revert UnknownKpi(kpiIndex);
        if (
            status != Types.CampaignStatus.Active && status != Types.CampaignStatus.Paused
                && status != Types.CampaignStatus.Ended
        ) revert WrongStatus(status);

        uint256 amount = _shortfall[msg.sender][kpiIndex];
        if (amount == 0) revert NoShortFallOwed(msg.sender);

        uint256 available = _rewardPool - paidOut;
        uint256 payout = amount > available ? available : amount;
        if (payout == 0) revert ShortfallUnfunded(available, amount);

        bytes32 promoterId = _promoterIdOf[msg.sender];
        _shortfall[msg.sender][kpiIndex] = amount - payout;
        _totalShortfall -= payout;
        paidOut += payout;
        escrowVault.release(msg.sender, payout);
        emit ShortfallPaid(promoterId, msg.sender, kpiIndex, payout);
    }

    /// @dev Transitions the campaign to a new status and emits the state change.
    /// @param next The new status.
    function _setStatus(Types.CampaignStatus next) private {
        Types.CampaignStatus previous = status;
        status = next;
        emit StatusChanged(previous, next);
    }

    // ── promoters ────────────────────────────────────────────────

    /// @inheritdoc ICampaign
    /// @dev Allowed while `Pending` as well as `Active`.
    function join() external returns (bytes32 promoterId) {
        if (status != Types.CampaignStatus.Active && status != Types.CampaignStatus.Pending) {
            revert WrongStatus(status);
        }
        if (_promoterIdOf[msg.sender] != bytes32(0)) revert AlreadyJoined();

        uint256 score = reputationRegistry.scoreOf(msg.sender);
        if (minReputation != 0 && score < minReputation) {
            revert InsufficientReputation(score, minReputation);
        }

        promoterId = keccak256(abi.encode(address(this), msg.sender));
        _promoterIdOf[msg.sender] = promoterId;
        _promoterOf[promoterId] = msg.sender;

        // Bind the id so user-signed touches naming it are accepted.
        attributionRegistry.registerPromoter(promoterId);

        emit PromoterJoined(msg.sender, promoterId, score);
    }

    // ── reporting ────────────────────────────────────────────────

    /// @inheritdoc ICampaign
    function setAuthorizedReporter(address reporter, bool allowed) external onlyProject {
        if (reporter == address(0)) revert InvalidReporter();
        authorizedReporters[reporter] = allowed;
        emit AuthorizedReporterUpdated(reporter, allowed);
    }

    /// @inheritdoc ICampaign
    /// @param newTotal Cumulative amount for this `(user, kpiIndex)` pair, not a delta.
    /// @dev Accepted while Active and inside the campaign window, and for `CLAIM_GRACE` after `end()`.
    ///      Per-action `evidence` splits the credit across the promoters who held the user when each
    ///      action happened; empty `evidence` credits whoever holds attribution now, and is refused
    ///      with `AmbiguousAttribution` when more than one promoter held them since the last report.
    function reportUserAction(uint256 kpiIndex, address user, uint256 newTotal, bytes calldata evidence)
        external
        nonReentrant
    {
        _requireReportableStatus();
        if (msg.sender != project && msg.sender != oracleCoordinator && !authorizedReporters[msg.sender]) {
            revert NotReporter();
        }
        if (kpiIndex >= _kpis.length) revert UnknownKpi(kpiIndex);
        if (user == address(0)) revert ZeroAddress();
        _requireReportWindow();

        Types.KpiSpec storage spec = _kpis[kpiIndex];
        if (spec.aggregate) revert AggregateKpi(kpiIndex);

        uint256 already = _userCredited[user][kpiIndex];
        if (newTotal < already) revert NonMonotonic(already, newTotal);
        if (newTotal == already) return; // idempotent replay

        // With no evidence there is nothing to segment, so attribution is resolved at report time.
        bytes32 currentId;
        address current;
        if (evidence.length == 0) {
            currentId = _resolvePromoterId(user);
            if (currentId == bytes32(0)) revert NoAttribution(user);
            current = _promoterOf[currentId];
            if (current == address(0)) revert NoAttribution(user);

            // A switch inside the unreported span would hand one promoter's work to another, and with
            // no per-action timing there is nothing to place the work by.
            bytes32 sole = attributionRegistry.soleAttributionSince(
                address(this), user, _lastReportBlock[user][kpiIndex]
            );
            if (sole != currentId) revert AmbiguousAttribution(user, kpiIndex);
        }

        uint256 verifiedTotal = newTotal;
        if (spec.verifier != address(0)) {
            // The verifier receives the cumulative total and returns what may be credited.
            verifiedTotal = IKpiVerifier(spec.verifier).verify(
                address(this), kpiIndex, user, newTotal, evidence, spec.params
            );
            // A verifier may discount a claim but never inflate it.
            if (verifiedTotal > newTotal) revert VerifierOvercredit(verifiedTotal, newTotal);
        }

        // Credit only the newly verified portion.
        if (verifiedTotal <= already) return;

        if (evidence.length == 0) {
            uint256 credited = (verifiedTotal - already);
            _userCredited[user][kpiIndex] = verifiedTotal;
            _applyCredit(user, kpiIndex, currentId, current, credited);
            _settle(current, currentId, kpiIndex);
        } else {
            _creditSegments(user, kpiIndex, already, verifiedTotal, evidence);
        }

        // Closes the span a later evidence-free report is checked over.
        _lastReportBlock[user][kpiIndex] = uint64(block.number);
    }

    /// @dev Splits a report across the promoters who held the user when each action happened.
    /// @param user The end user who's actions is being reported.
    /// @param kpiIndex Index of the KPI being credited.
    /// @param already Amount already credited for this pair, across every promoter.
    /// @param verifiedTotal Cumulative ceiling this report may credit up to.
    /// @param evidence Abi-encoded `Types.Action[]`, non-decreasing by `blockNumber`.
    function _creditSegments(
        address user,
        uint256 kpiIndex,
        uint256 already,
        uint256 verifiedTotal,
        bytes calldata evidence
    ) private {
        Types.Action[] memory actions = abi.decode(evidence, (Types.Action[]));
        if (actions.length > MAX_EVIDENCE_ACTIONS) {
            revert TooManyActions(actions.length, MAX_EVIDENCE_ACTIONS);
        }

        (bytes32[] memory ids, uint256[] memory owed, uint256 distinct) = _tally(user, verifiedTotal, actions);

        uint256 credited = _credit(user, kpiIndex, ids, owed, distinct);
        if (credited == 0) return;

        // Advances by what was credited, not to `verifiedTotal`, so skipped actions stay reportable.
        _userCredited[user][kpiIndex] = already + credited;

        for (uint256 i; i < distinct; ++i) {
            if (owed[i] == 0) continue;
            _settle(_promoterOf[ids[i]], ids[i], kpiIndex);
        }
    }

    /// @dev Tallies each action's amount onto the promoter who held the user at that action's block,
    ///      oldest first so the prefix a ceiling covers is the oldest work.
    /// @param user The end user being reported.
    /// @param verifiedTotal Cumulative ceiling the tally may reach.
    /// @param actions Evidence actions, non-decreasing by `blockNumber`.
    /// @return ids Distinct promoter ids the evidence touched, in first-seen order.
    /// @return owed Amount attributed to each id, parallel to `ids`.
    /// @return distinct How many leading entries of `ids` and `owed` are populated.
    function _tally(address user, uint256 verifiedTotal, Types.Action[] memory actions)
        private
        view
        returns (bytes32[] memory ids, uint256[] memory owed, uint256 distinct)
    {
        bytes32[] memory owners = _ownersOf(user, actions);
        ids = new bytes32[](actions.length);
        owed = new uint256[](actions.length);
        uint256 taken;

        for (uint256 i; i < actions.length && taken < verifiedTotal; ++i) {
            // Nobody held attribution then; the amount stays uncredited and reportable later.
            if (owners[i] == bytes32(0)) continue;

            uint256 share = verifiedTotal - taken;
            if (actions[i].amount < share) share = actions[i].amount;
            if (share == 0) continue;
            taken += share;

            uint256 slot = distinct;
            for (uint256 j; j < distinct; ++j) {
                if (ids[j] == owners[i]) {
                    slot = j;
                    break;
                }
            }
            if (slot == distinct) {
                ids[distinct] = owners[i];
                ++distinct;
            }
            owed[slot] += share;
        }
    }

    /// @dev Applies each promoter's tally less what it has already been credited, and zeroes the
    ///      entries that credit nothing so the caller's settle pass can skip them.
    /// @param user The end user being reported.
    /// @param kpiIndex Index of the KPI being credited.
    /// @param ids Distinct promoter ids from the tally.
    /// @param owed Per-id tallies, overwritten with the amount actually credited.
    /// @param distinct How many leading entries of `ids` and `owed` are populated.
    /// @return credited Total progress written across every promoter.
    function _credit(
        address user,
        uint256 kpiIndex,
        bytes32[] memory ids,
        uint256[] memory owed,
        uint256 distinct
    ) private returns (uint256 credited) {
        for (uint256 i; i < distinct; ++i) {
            address promoter = _promoterOf[ids[i]];
            uint256 paid = _creditedTo[user][kpiIndex][ids[i]];
            // A verifier that revised a total downward can leave a promoter ahead of its tally.
            if (promoter == address(0) || owed[i] <= paid) {
                owed[i] = 0;
                continue;
            }

            owed[i] -= paid;
            credited += owed[i];
            _applyCredit(user, kpiIndex, ids[i], promoter, owed[i]);
        }
    }

    /// @dev Records one promoter's share of a report. Settlement is a separate step so every balance
    ///      is final before escrow moves.
    /// @param user The end user whose actions produced the progress.
    /// @param kpiIndex Index of the KPI being credited.
    /// @param promoterId The promoter's campaign-bound id.
    /// @param promoter The promoter's wallet.
    /// @param amount Progress credited, always non-zero.
    function _applyCredit(
        address user,
        uint256 kpiIndex,
        bytes32 promoterId,
        address promoter,
        uint256 amount
    ) private {
        _creditedTo[user][kpiIndex][promoterId] += amount;
        _progress[promoter][kpiIndex] += amount;
        _totalProgress[kpiIndex] += amount;

        emit ProgressCredited(kpiIndex, promoterId, user, amount);
    }

    /// @dev Who held the user at each action's block, in one registry call. Also enforces the
    ///      non-decreasing block order the oldest-first walk relies on.
    /// @param user The end user being reported.
    /// @param actions Evidence actions.
    /// @return promoterIds Attributed promoter per action, `bytes32(0)` where nobody was.
    function _ownersOf(address user, Types.Action[] memory actions)
        private
        view
        returns (bytes32[] memory promoterIds)
    {
        uint64[] memory blocks = new uint64[](actions.length);
        uint64[] memory timestamps = new uint64[](actions.length);

        for (uint256 i; i < actions.length; ++i) {
            if (i != 0 && actions[i].blockNumber < actions[i - 1].blockNumber) {
                revert UnorderedEvidence(i);
            }
            blocks[i] = actions[i].blockNumber;
            timestamps[i] = actions[i].timestamp;
        }

        promoterIds = attributionRegistry.promotersAt(address(this), user, blocks, timestamps);
    }

    /// @inheritdoc ICampaign
    /// @dev Aggregate KPIs (TVL, volume) are campaign-level and never credit an individual promoter.
    function applyAggregateUpdate(uint256 kpiIndex, uint256 newTotal) external onlyActive {
        if (msg.sender != oracleCoordinator) revert NotOracle();
        if (kpiIndex >= _kpis.length) revert UnknownKpi(kpiIndex);
        if (!_kpis[kpiIndex].aggregate) revert NotAggregateKpi(kpiIndex);
        _requireWindow();

        uint256 current = _totalProgress[kpiIndex];
        if (newTotal < current) revert NonMonotonic(current, newTotal);

        _totalProgress[kpiIndex] = newTotal;
        emit AggregateProgress(kpiIndex, newTotal);
    }

    // ── settlement ───────────────────────────────────────────────

    /// @inheritdoc ICampaign
    /// @dev Permissionless, including during the post-end claim grace window.
    function settle(address promoter, uint256 kpiIndex) external nonReentrant {
        if (kpiIndex >= _kpis.length) revert UnknownKpi(kpiIndex);
        bytes32 promoterId = _promoterIdOf[promoter];
        if (promoterId == bytes32(0)) revert NotJoined();

        if (status == Types.CampaignStatus.Ended) {
            if (block.timestamp > endedAt + CLAIM_GRACE) revert WrongStatus(status);
        } else if (status != Types.CampaignStatus.Active) {
            revert WrongStatus(status);
        }

        _settle(promoter, promoterId, kpiIndex);
    }

    /// @dev Walks the tier ladder for one `(promoter, kpi)` pair and pays every newly crossed tier.
    ///      A tier the pool cannot cover pays what remains and emits `PoolExhausted`.
    /// @param promoter Wallet receiving the payouts.
    /// @param promoterId The promoter's campaign-bound id, used for event indexing.
    /// @param kpiIndex Index of the KPI whose ladder is walked.
    function _settle(address promoter, bytes32 promoterId, uint256 kpiIndex) private {
        Types.RewardTier[] storage ladder = _tiers[kpiIndex];
        uint256 progress = _progress[promoter][kpiIndex];
        uint256 next = _settledTiers[promoter][kpiIndex];

        while (next < ladder.length && progress >= ladder[next].threshold) {
            uint256 reward = ladder[next].reward;
            uint256 remaining = _rewardPool - paidOut;
            uint256 tierPay = reward > remaining ? remaining : reward;

            // Marked settled even when the pool cannot cover it.
            _settledTiers[promoter][kpiIndex] = next + 1;

            if (tierPay != 0) {
                paidOut += tierPay;
                escrowVault.release(promoter, tierPay);
            }
            emit TierSettled(promoterId, promoter, kpiIndex, next, tierPay);
            if (tierPay < reward) {
                uint256 shortfall = reward - tierPay;
                _shortfall[promoter][kpiIndex] += shortfall;
                _totalShortfall += shortfall;
                emit PoolExhausted(shortfall);
            }

            unchecked {
                ++next;
            }
        }
    }

    // ── escrow return ────────────────────────────────────────────

    /// @inheritdoc ICampaign
    /// @dev Cancelled campaigns return funds immediately; Ended campaigns wait out `CLAIM_GRACE`.
    function reclaimUnspent() external nonReentrant onlyProject {
        if (_totalShortfall != 0) revert OutstandingShortfall(_totalShortfall);
        if (status == Types.CampaignStatus.Ended) {
            uint64 until = endedAt + CLAIM_GRACE;
            if (block.timestamp <= until) revert ClaimWindowOpen(until);
        } else if (status != Types.CampaignStatus.Cancelled) {
            revert WrongStatus(status);
        }

        uint256 amount = escrowVault.balanceOf(address(this));
        if (amount == 0) revert NothingToReclaim();

        escrowVault.reclaim(project, amount);
        emit Reclaimed(project, amount);
    }

    /// @dev Reverts unless the current block timestamp is inside the campaign window.
    function _requireWindow() private view {
        if (block.timestamp < startTime || block.timestamp > _endTime) {
            revert OutsideWindow(startTime, _endTime);
        }
    }

    /// @dev The fallback for a report carrying no per-action evidence. While live, resolves to the
    ///      active touch only; once Ended, the stored touch is honoured even if expired.
    /// @param user The end user whose action is being reported.
    /// @return The attributed promoter id, or `bytes32(0)` when there is none.
    function _resolvePromoterId(address user) private view returns (bytes32) {
        bytes32 live = attributionRegistry.activePromoter(address(this), user);
        if (live != bytes32(0)) return live;
        if (status != Types.CampaignStatus.Ended) return bytes32(0);
        return attributionRegistry.touchOf(address(this), user).promoterId;
    }

    /// @dev Reverts unless the status may receive reports: Active, or Ended inside `CLAIM_GRACE`.
    function _requireReportableStatus() private view {
        if (status == Types.CampaignStatus.Ended) {
            if (block.timestamp > endedAt + CLAIM_GRACE) revert WrongStatus(status);
        } else if (status != Types.CampaignStatus.Active) {
            revert WrongStatus(status);
        }
    }

    /// @dev Applies the campaign window while Active; skipped once Ended.
    function _requireReportWindow() private view {
        if (status == Types.CampaignStatus.Ended) return;
        _requireWindow();
    }

    // ── views ────────────────────────────────────────────────────

    /// @inheritdoc ICampaign
    function config() external view returns (Types.CampaignConfig memory) {
        return Types.CampaignConfig({
            project: project,
            name: name,
            token: token,
            rewardPool: _rewardPool,
            startTime: startTime,
            endTime: _endTime,
            attributionWindow: attributionWindow,
            minReputation: minReputation
        });
    }

    /// @inheritdoc ICampaign
    function kpiCount() external view returns (uint256) {
        return _kpis.length;
    }

    /// @inheritdoc ICampaign
    function kpi(uint256 index) external view returns (Types.KpiSpec memory) {
        if (index >= _kpis.length) revert UnknownKpi(index);
        return _kpis[index];
    }

    /// @inheritdoc ICampaign
    function tiers(uint256 kpiIndex) external view returns (Types.RewardTier[] memory) {
        if (kpiIndex >= _kpis.length) revert UnknownKpi(kpiIndex);
        return _tiers[kpiIndex];
    }

    /// @inheritdoc ICampaign
    function promoterIdOf(address promoter) external view returns (bytes32) {
        return _promoterIdOf[promoter];
    }

    /// @inheritdoc ICampaign
    function promoterOf(bytes32 promoterId) external view returns (address) {
        return _promoterOf[promoterId];
    }

    /// @inheritdoc ICampaign
    function progressOf(address promoter, uint256 kpiIndex) external view returns (uint256) {
        return _progress[promoter][kpiIndex];
    }

    /// @inheritdoc ICampaign
    function totalProgress(uint256 kpiIndex) external view returns (uint256) {
        return _totalProgress[kpiIndex];
    }

    /// @inheritdoc ICampaign
    function userCreditedOf(address user, uint256 kpiIndex) external view returns (uint256) {
        return _userCredited[user][kpiIndex];
    }

    /// @inheritdoc ICampaign
    function lastReportBlockOf(address user, uint256 kpiIndex) external view returns (uint64) {
        return _lastReportBlock[user][kpiIndex];
    }

    /// @notice Cumulative amount credited to one promoter for a `(user, kpi)` pair.
    /// @param user The end user.
    /// @param kpiIndex Index of the KPI.
    /// @param promoterId The promoter's campaign-bound id.
    /// @return Amount credited to that promoter so far; these sum to `userCreditedOf`.
    function creditedToOf(address user, uint256 kpiIndex, bytes32 promoterId)
        external
        view
        returns (uint256)
    {
        return _creditedTo[user][kpiIndex][promoterId];
    }

    /// @notice Number of tiers already settled for a `(promoter, kpi)` pair.
    /// @param promoter The promoter.
    /// @param kpiIndex Index of the KPI.
    /// @return Count of settled tiers, which is also the next tier index.
    function settledTiersOf(address promoter, uint256 kpiIndex) external view returns (uint256) {
        return _settledTiers[promoter][kpiIndex];
    }

    /// @notice Rewards still available in the shared pool.
    /// @return The unpaid remainder of the reward pool.
    function remainingPool() external view returns (uint256) {
        return _rewardPool - paidOut;
    }

    /// @inheritdoc ICampaign
    /// @return The current reward pool ceiling, including successful top-ups.
    function rewardPool() public view returns (uint256) {
        return _rewardPool;
    }

    /// @inheritdoc ICampaign
    /// @return The current reporting deadline, including successful extensions.
    function endTime() public view returns (uint64) {
        return _endTime;
    }

    /// @notice Unpaid reward caused by a depleted pool.
    /// @param promoter Promoter owed the reward.
    /// @param kpiIndex KPI whose tier was underpaid.
    /// @return Outstanding shortfall.
    function shortfallOf(address promoter, uint256 kpiIndex) external view returns (uint256) {
        return _shortfall[promoter][kpiIndex];
    }

    /// @inheritdoc ICampaign
    function getProject() external view returns (address) {
        return project;
    }

    /// @inheritdoc ICampaign
    function getOracle() external view returns (address) {
        return oracleCoordinator;
    }
}
