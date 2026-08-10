// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ICampaign} from "../interfaces/ICampaign.sol";
import {IEscrowVault} from "../interfaces/IEscrowVault.sol";
import {IReputationRegistry} from "../interfaces/IReputationRegistry.sol";
import {IAttributionRegistry} from "../interfaces/IAttributionRegistry.sol";
import {IKpiVerifier} from "../interfaces/IKpiVerifier.sol";
import {Types} from "../libraries/Types.sol";

/// @title Campaign
/// @notice One performance campaign: escrowed rewards released automatically as attributed KPI
///         progress crosses per-promoter thresholds.
/// @dev Immutable once deployed (decision D8): parameters, KPIs and tiers cannot change, so a
///      project cannot move the goalposts after promoters have done the work.
///
///      Reported amounts are **cumulative per user**, not increments. The contract credits only
///      `newTotal - alreadyCredited`, so a replayed report is a no-op rather than an inflation
///      vector — the central anti-fake-conversion property of the reporting path.
///
///      Rewards draw from one shared pool, first-come (D3). When the pool cannot cover a crossed
///      tier the contract pays what remains and emits `PoolExhausted`; it never reverts, because
///      reverting would let one exhausted tier block all further reporting for everyone.
contract Campaign is ICampaign, ReentrancyGuard {
    error NotProject();
    error NotReporter();
    error NotOracle();
    error WrongStatus(Types.CampaignStatus actual);
    error AlreadyJoined();
    error NotJoined();
    error InsufficientReputation(uint256 score, uint256 required);
    error UnreachableReputation(uint256 required, uint256 maxScore);
    error UnknownKpi(uint256 kpiIndex);
    error AggregateKpi(uint256 kpiIndex);
    error NotAggregateKpi(uint256 kpiIndex);
    error NoAttribution(address user);
    error NonMonotonic(uint256 current, uint256 provided);
    error VerifierOvercredit(uint256 credited, uint256 max);
    error OutsideWindow(uint64 startTime, uint64 endTime);
    error NotFunded(uint256 balance, uint256 required);
    error ClaimWindowOpen(uint64 until);
    error NothingToReclaim();
    error ZeroAddress();
    error InvalidWindow();
    error ZeroRewardPool();
    error NoKpis();
    error TierLengthMismatch();
    error EmptyTiers(uint256 kpiIndex);
    error TiersNotAscending(uint256 kpiIndex, uint256 tierIndex);
    error ZeroTierReward(uint256 kpiIndex, uint256 tierIndex);
    error CustomKpiNeedsVerifier(uint256 kpiIndex);
    error TooManyKpis(uint256 provided, uint256 max);
    error TooManyTiers(uint256 kpiIndex, uint256 provided, uint256 max);

    /// @notice Window after a campaign ends during which promoters may still settle earned tiers,
    ///         before the project can reclaim what is left.
    uint64 public constant CLAIM_GRACE = 7 days;

    /// @notice Caps on campaign shape.
    /// @dev `_settle` walks the tier ladder and `reportUserAction` indexes KPIs, both on
    ///      user-facing paths. Without a bound, a campaign could be created with a ladder large
    ///      enough that settlement exceeds the block gas limit — bricking payouts for promoters
    ///      who already did the work. Validated once at construction.
    uint256 public constant MAX_KPIS = 32;
    /// @notice Cap on tiers per KPI, bounding the per-report settlement loop.
    uint256 public constant MAX_TIERS_PER_KPI = 32;

    // ── dependencies ─────────────────────────────────────────────

    /// @notice Vault holding this campaign's escrowed rewards.
    IEscrowVault public immutable escrowVault;
    /// @notice Registry resolving which promoter owns a given end user.
    IAttributionRegistry public immutable attributionRegistry;
    /// @notice Registry consulted for the `minReputation` gate at join time.
    IReputationRegistry public immutable reputationRegistry;
    /// @notice Coordinator allowed to push aggregate updates and user reports.
    address public immutable oracleCoordinator;

    // ── frozen parameters (D8) ───────────────────────────────────
    // Stored as individual immutables because Solidity does not allow immutable structs;
    // `config()` reassembles them for the ICampaign surface.

    /// @notice Owner of the campaign; funds it, controls its lifecycle, receives unspent escrow.
    address public immutable project;
    /// @notice ERC20 used for escrow and payouts.
    address public immutable token;
    /// @notice Total escrow required before the campaign can be activated, and the ceiling on
    ///         everything this campaign can ever pay out.
    uint256 public immutable rewardPool;
    /// @notice Start of the window in which reports are accepted.
    uint64 public immutable startTime;
    /// @notice End of that window. Past it, anyone may `end()` the campaign.
    uint64 public immutable endTime;
    /// @notice Recommended touch TTL for frontends when asking a user to sign an attribution.
    /// @dev Advisory. The hard cap on touch lifetime lives in AttributionRegistry.
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
    /// @dev kpiIndex => campaign-level total.
    mapping(uint256 => uint256) private _totalProgress;

    /// @dev Restricts a call to the campaign's project.
    modifier onlyProject() {
        if (msg.sender != project) revert NotProject();
        _;
    }

    /// @dev Restricts a call to the Active status.
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

        // Reject a gate no wallet could ever clear. `minReputation` is immutable and `join()` is
        // the only thing that reads it, so an unreachable value produces a campaign that deploys
        // cleanly, accepts escrow, reports Active, and silently admits nobody for its whole life —
        // with no way to correct it short of redeploying and re-funding.
        //
        // Read from the registry rather than hard-coded: the ceiling is a product of the
        // registered schemas and their weights, both of which governance can move, so a constant
        // here would be wrong the first time anything is re-weighted.
        //
        // `try` because `maxScore` postdates the first deployments. A registry that predates it
        // reverts on the call, and treating that as "no constraint" keeps campaign creation
        // working against an older registry instead of bricking it protocol-wide. The comparison
        // is deliberately outside the `try` block so a genuine `UnreachableReputation` revert
        // cannot be swallowed by the `catch`.
        uint256 cap = type(uint256).max;
        try IReputationRegistry(reputationRegistry_).maxScore() returns (uint256 reported) {
            cap = reported;
        } catch {}
        if (cfg.minReputation > cap) revert UnreachableReputation(cfg.minReputation, cap);

        if (kpis_.length == 0) revert NoKpis();
        if (kpis_.length > MAX_KPIS) revert TooManyKpis(kpis_.length, MAX_KPIS);
        if (kpis_.length != tiers_.length) revert TierLengthMismatch();

        for (uint256 i; i < kpis_.length; ++i) {
            // A Custom KPI has no protocol-defined meaning, so it is only trustworthy with an
            // adapter that can substantiate reports.
            if (kpis_[i].kind == Types.KpiKind.Custom && kpis_[i].verifier == address(0)) {
                revert CustomKpiNeedsVerifier(i);
            }

            Types.RewardTier[] memory t = tiers_[i];
            // Aggregate KPIs are analytics-only (D7) and may legitimately carry no tiers.
            if (t.length == 0 && !kpis_[i].aggregate) revert EmptyTiers(i);
            if (t.length > MAX_TIERS_PER_KPI) {
                revert TooManyTiers(i, t.length, MAX_TIERS_PER_KPI);
            }

            uint256 previous;
            for (uint256 j; j < t.length; ++j) {
                if (t[j].reward == 0) revert ZeroTierReward(i, j);
                // Strictly ascending thresholds let settlement walk tiers in one pass.
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
        token = cfg.token;
        rewardPool = cfg.rewardPool;
        startTime = cfg.startTime;
        endTime = cfg.endTime;
        attributionWindow = cfg.attributionWindow;
        minReputation = cfg.minReputation;

        escrowVault = IEscrowVault(escrowVault_);
        attributionRegistry = IAttributionRegistry(attributionRegistry_);
        reputationRegistry = IReputationRegistry(reputationRegistry_);
        oracleCoordinator = oracleCoordinator_;

        status = Types.CampaignStatus.Pending;
    }

    // ── lifecycle ────────────────────────────────────────────────

    /// @inheritdoc ICampaign
    /// @dev Requires the full reward pool to be escrowed first: promoters should never start
    ///      working against a partially funded campaign.
    function activate() external onlyProject {
        if (status != Types.CampaignStatus.Pending) revert WrongStatus(status);
        uint256 balance = escrowVault.balanceOf(address(this));
        if (balance < rewardPool) revert NotFunded(balance, rewardPool);
        if (block.timestamp >= endTime) revert OutsideWindow(startTime, endTime);

        _setStatus(Types.CampaignStatus.Active);
        emit Activated(startTime, endTime);
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
    /// @dev The project may end early; anyone may end it once `endTime` has passed, so a project
    ///      cannot leave a finished campaign in limbo to stall the claim grace window.
    function end() external {
        if (status != Types.CampaignStatus.Active && status != Types.CampaignStatus.Paused) {
            revert WrongStatus(status);
        }
        if (msg.sender != project && block.timestamp < endTime) revert OutsideWindow(startTime, endTime);

        endedAt = uint64(block.timestamp);
        _setStatus(Types.CampaignStatus.Ended);
    }

    /// @inheritdoc ICampaign
    /// @dev Only from `Pending`. Once active, promoters may have earned rewards, so cancellation would be a rug.
    function cancel() external onlyProject {
        if (status != Types.CampaignStatus.Pending) revert WrongStatus(status);

        endedAt = uint64(block.timestamp);
        _setStatus(Types.CampaignStatus.Cancelled);
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
    /// @dev Joining is allowed while `Pending` too, so KOLs can prepare links before launch.
    ///
    ///      **Sybil resistance**: `AlreadyJoined` stops one wallet from rejoining, but a KOL
    ///      controlling multiple wallets can join from each. Under LAST_TOUCH the user can re-point
    ///      attribution across those wallets with newer Touches. Each wallet walks the tier ladder
    ///      from rung zero (`_settledTiers` and `_progress` are keyed by promoter address), so the
    ///      bottom rungs can be farmed. Five wallets each taking the user +10 units extract 5,000
    ///      from the same 50 units of activity, against 3,000 for one honest promoter at 50 (tested
    ///      in `test/RejoinAttack.t.sol::test_SybilFarmingBottomRung`). `minReputation` is the
    ///      existing lever — it raises the cost per sybil. A structural fix would require either
    ///      making lower rungs non-repeatable for the same user across promoters, or keying the
    ///      ladder to something sybil-resistant.
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

        // Bind the id in the attribution registry so user-signed touches naming it are accepted.
        attributionRegistry.registerPromoter(promoterId);

        emit PromoterJoined(msg.sender, promoterId, score);
    }

    // ── reporting ────────────────────────────────────────────────

    /// @inheritdoc ICampaign
    /// @param newTotal Cumulative amount for this `(user, kpiIndex)` pair, not a delta.
    /// @dev Accepted while Active and inside the campaign window, **and** for `CLAIM_GRACE` after
    ///      `end()`. The post-end half is load-bearing: `end()` is callable by the project at any
    ///      time, so a reporting cutoff pinned to Active alone let a project end early and strand
    ///      progress its promoters had already earned — the referrals were attributed, the actions
    ///      happened, and no transaction could ever record them. Reporting now closes on exactly
    ///      the second `reclaimUnspent` opens, so escrow is never reclaimable while credit is
    ///      still owed.
    function reportUserAction(uint256 kpiIndex, address user, uint256 newTotal, bytes calldata evidence)
        external
        nonReentrant
    {
        _requireReportableStatus();
        if (msg.sender != project && msg.sender != oracleCoordinator) revert NotReporter();
        if (kpiIndex >= _kpis.length) revert UnknownKpi(kpiIndex);
        if (user == address(0)) revert ZeroAddress();
        _requireReportWindow();

        Types.KpiSpec storage spec = _kpis[kpiIndex];
        if (spec.aggregate) revert AggregateKpi(kpiIndex);

        uint256 already = _userCredited[user][kpiIndex];
        if (newTotal < already) revert NonMonotonic(already, newTotal);
        uint256 delta = newTotal - already;
        if (delta == 0) return; // idempotent replay

        // Resolve attribution before crediting: unattributed actions have no payee.
        bytes32 promoterId = _resolvePromoterId(user);
        if (promoterId == bytes32(0)) revert NoAttribution(user);
        address promoter = _promoterOf[promoterId];
        if (promoter == address(0)) revert NoAttribution(user);

        uint256 credited = delta;
        if (spec.verifier != address(0)) {
            credited = IKpiVerifier(spec.verifier).verify(
                address(this), kpiIndex, user, delta, evidence, spec.params
            );
            // A verifier may discount a claim but must never inflate it.
            if (credited > delta) revert VerifierOvercredit(credited, delta);
            if (credited == 0) return;
        }

        // Credit only the verified portion, so a discounted report can be retried later with
        // better evidence rather than being permanently burned.
        _userCredited[user][kpiIndex] = already + credited;
        _progress[promoter][kpiIndex] += credited;
        _totalProgress[kpiIndex] += credited;

        emit ProgressCredited(kpiIndex, promoterId, user, credited);

        _settle(promoter, promoterId, kpiIndex);
    }

    /// @inheritdoc ICampaign
    /// @dev Aggregate KPIs (TVL, volume) are campaign-level and never credit an individual
    ///      promoter — see D7. They advance totals for display only.
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
    /// @dev Permissionless: anyone may push a promoter's earned rewards through, including during
    ///      the post-end claim grace window.
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

    /// @dev Walks the tier ladder for one `(promoter, kpi)` pair and pays every newly crossed
    ///      tier. State is written before each external transfer (checks-effects-interactions);
    ///      callers are `nonReentrant`.
    ///      The ladder is per-promoter by design (each KOL earns their own tiers), which also means
    ///      it is re-walkable by a KOL joining from a second wallet — see the sybil note on
    ///      `join()`. `_settledTiers` is never cleared, so a given promoter address cannot re-earn
    ///      a tier; the repetition is across addresses, not within one.
    /// @param promoter Wallet receiving the payouts.
    /// @param promoterId The promoter's campaign-bound id, used for event indexing.
    /// @param kpiIndex Index of the KPI whose ladder is walked.
    function _settle(address promoter, bytes32 promoterId, uint256 kpiIndex) private {
        Types.RewardTier[] storage ladder = _tiers[kpiIndex];
        uint256 progress = _progress[promoter][kpiIndex];
        uint256 next = _settledTiers[promoter][kpiIndex];

        while (next < ladder.length && progress >= ladder[next].threshold) {
            uint256 reward = ladder[next].reward;
            uint256 remaining = rewardPool - paidOut;
            uint256 tierPay = reward > remaining ? remaining : reward;

            // Mark the tier settled even when the pool cannot cover it: the ladder must keep
            // advancing, and the shortfall is surfaced via `PoolExhausted`.
            _settledTiers[promoter][kpiIndex] = next + 1;

            if (tierPay != 0) {
                paidOut += tierPay;
                escrowVault.release(promoter, tierPay);
            }
            emit TierSettled(promoterId, promoter, kpiIndex, next, tierPay);
            if (tierPay < reward) emit PoolExhausted(reward - tierPay);

            unchecked {
                ++next;
            }
        }
    }

    // ── escrow return ────────────────────────────────────────────

    /// @inheritdoc ICampaign
    /// @dev Cancelled campaigns return funds immediately (nobody earned anything). Ended
    ///      campaigns wait out `CLAIM_GRACE` so promoters can settle first.
    function reclaimUnspent() external nonReentrant onlyProject {
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
        if (block.timestamp < startTime || block.timestamp > endTime) {
            revert OutsideWindow(startTime, endTime);
        }
    }

    /// @dev Who gets paid for `user`'s actions.
    ///
    ///      While the campaign is live this is strictly `activePromoter` — an expired touch credits
    ///      nobody, which is the consent model `AttributionRegistry` is built on: attribution lapses,
    ///      and a promoter who goes quiet loses it. `test_Report_recoverableAfterAttributionExpires`
    ///      pins the consequence that a lapse hands everything to whoever the user signs for next.
    ///
    ///      After `end()` that rule would defeat the reporting grace window it sits next to. Touch
    ///      TTLs are days and campaigns run for weeks, so by the time a withheld report can finally
    ///      be filed most touches have lapsed and every one of those reports would revert
    ///      `NoAttribution` — handing the project back exactly the escrow the grace window exists to
    ///      protect. So once the campaign is Ended, and only then, the stored touch is honoured even
    ///      if expired.
    ///
    ///      That relaxation cannot be used to steal credit. `storeTouch` overwrites only with a
    ///      strictly newer `signedAt`, so the stored touch is always the user's latest signed
    ///      intent; it rejects an already-expired `expiresAt`, so no one can backfill a stale touch
    ///      after the fact; and it is bounded to `CLAIM_GRACE`, after which reporting closes
    ///      entirely. No new activity can occur post-end, so the only question left is who earned
    ///      what already happened.
    function _resolvePromoterId(address user) private view returns (bytes32) {
        bytes32 live = attributionRegistry.activePromoter(address(this), user);
        if (live != bytes32(0)) return live;
        if (status != Types.CampaignStatus.Ended) return bytes32(0);
        return attributionRegistry.touchOf(address(this), user).promoterId;
    }

    /// @dev Statuses that may still receive reports: Active, or Ended inside `CLAIM_GRACE`. Mirrors
    ///      `settle`'s guard so crediting and paying open and close together, and is the exact
    ///      complement of `reclaimUnspent` — that requires `block.timestamp > endedAt + CLAIM_GRACE`,
    ///      so the two windows can never overlap.
    ///
    ///      Paused is intentionally excluded: pausing halts reporting, and it cannot be used to
    ///      strand anyone because `end()` is permissionless once `endTime` passes, which converts a
    ///      parked campaign into an Ended one and starts the grace clock.
    function _requireReportableStatus() private view {
        if (status == Types.CampaignStatus.Ended) {
            if (block.timestamp > endedAt + CLAIM_GRACE) revert WrongStatus(status);
        } else if (status != Types.CampaignStatus.Active) {
            revert WrongStatus(status);
        }
    }

    /// @dev While Active the campaign window bounds reports. Once Ended, the grace window already
    ///      bounded them in `_requireReportableStatus`, and `endedAt` is necessarily past
    ///      `startTime`, so re-checking `endTime` here would reject every post-end report.
    function _requireReportWindow() private view {
        if (status == Types.CampaignStatus.Ended) return;
        _requireWindow();
    }

    // ── views ────────────────────────────────────────────────────

    /// @inheritdoc ICampaign
    function config() external view returns (Types.CampaignConfig memory) {
        return Types.CampaignConfig({
            project: project,
            token: token,
            rewardPool: rewardPool,
            startTime: startTime,
            endTime: endTime,
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

    /// @notice Cumulative amount already credited for a `(user, kpi)` pair.
    /// @param user The end user.
    /// @param kpiIndex Index of the KPI.
    /// @return Amount credited so far; the replay guard for reports.
    function userCreditedOf(address user, uint256 kpiIndex) external view returns (uint256) {
        return _userCredited[user][kpiIndex];
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
        return rewardPool - paidOut;
    }
}
