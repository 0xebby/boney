// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IKpiVerifier} from "../interfaces/IKpiVerifier.sol";
import {IEventMetricKpiVerifier} from "../interfaces/IEventMetricKpiVerifier.sol";

/// @title EventMetricKpiVerifier
/// @notice Caps a campaign's claimed KPI total against an independently observed on-chain metric,
///         computed off-chain by a trusted relayer that scans event logs via `eth_getLogs`.
/// @dev The relayer pushes observed totals ahead of time, so `verify` is a stored-value lookup and
///      comparison. The `reporter` key is trusted.
contract EventMetricKpiVerifier is IEventMetricKpiVerifier, Ownable {
    /// @notice What a KPI watches, and how the relayer should fold it.
    /// @param targetContract Contract emitting the event.
    /// @param eventSignature Full human-readable event ABI, `indexed` keywords included exactly as
    ///        declared in the source, e.g. "Deposit(address indexed user, uint256 amount)".
    /// @param userParamIndex 0-based position of the user-address param in declaration order,
    ///        whether or not it is indexed.
    /// @param valueParamIndex 0-based position of the numeric param to sum. Ignored for `COUNT`,
    ///        but still stored so the struct shape does not change between modes.
    /// @param aggregation `COUNT` or `SUM`.
    /// @param scale Divisor applied to a user's observed total inside `verify`, so the compared figure
    ///        is denominated the way the project denominates it. 0 is read as 1. Mirrors the indexer's
    ///        `scale` in `web/src/lib/kpiSource.ts`. `verifiedTotals` holds the raw, unscaled metric.
    /// @param windowStartBlock Earliest block worth scanning — typically where attribution begins.
    /// @param windowEndBlock Latest block the relayer may report up to. See `setKpiConfig`.
    /// @param configured Set once `setKpiConfig` has run; nothing may be reported or verified first.
    /// @param epoch Generation of this config, bumped when `setKpiConfig` changes what is watched. Part
    ///        of every total's storage key, so a bump abandons every total observed under the previous
    ///        config.
    struct KpiConfig {
        address targetContract;
        string eventSignature;
        uint8 userParamIndex;
        uint8 valueParamIndex;
        Aggregation aggregation;
        uint256 scale;
        uint256 windowStartBlock;
        uint256 windowEndBlock;
        bool configured;
        uint256 epoch;
    }

    /// @notice Account allowed to push observed metrics. Trusted.
    address public reporter;

    /// @notice `_kpiKey(campaign, kpiIndex)` => what that KPI watches.
    mapping(bytes32 => KpiConfig) public kpiConfigs;

    /// @notice `_userKey(campaign, kpiIndex, epoch, user)` => independently observed cumulative
    ///         metric, in the event's own units. Divide by `KpiConfig.scale` for the comparable
    ///         figure; `verify` does that, and `observedProgressOf` exposes it.
    mapping(bytes32 => uint256) public verifiedTotals;

    /// @notice `_userKey(...)` => `block.timestamp` of the most recent report for that user.
    mapping(bytes32 => uint256) public lastReportedAt;

    /// @notice `_kpiKey(...)` => last block fully scanned and folded into `verifiedTotals`.
    /// @dev Read by the relayer to resume scanning.
    mapping(bytes32 => uint256) public lastScannedBlock;

    /// @dev Restricts a call to the reporter key.
    modifier onlyReporter() {
        if (msg.sender != reporter) revert NotReporter(msg.sender);
        _;
    }

    /// @param owner_ Account allowed to configure KPIs and rotate the reporter.
    /// @param reporter_ Account allowed to push observed metrics.
    constructor(address owner_, address reporter_) Ownable(owner_) {
        if (reporter_ == address(0)) revert ZeroAddress();
        reporter = reporter_;
        emit ReporterUpdated(address(0), reporter_);
    }

    /// @notice Rotate the reporter key.
    /// @param newReporter Account that may push observed metrics from now on.
    function setReporter(address newReporter) external onlyOwner {
        if (newReporter == address(0)) revert ZeroAddress();
        emit ReporterUpdated(reporter, newReporter);
        reporter = newReporter;
    }

    /// @notice Define what a KPI watches. Must run before anything can be reported or verified.
    /// @dev Re-running with only a later `windowEndBlock` leaves the checkpoint and stored totals alone.
    ///      Changing anything else bumps `epoch`, abandoning every total, and resets the checkpoint.
    /// @param campaign Campaign the KPI belongs to.
    /// @param kpiIndex Index of the KPI within that campaign.
    /// @param targetContract Contract emitting the watched event.
    /// @param eventSignature Full human-readable event ABI, `indexed` keywords included.
    /// @param userParamIndex 0-based declaration-order position of the user-address param.
    /// @param aggregation `COUNT` or `SUM`.
    /// @param valueParamIndex 0-based declaration-order position of the summed param; ignored for
    ///        `COUNT`.
    /// @param scale Divisor the relayer applies to cumulative totals so the observed metric is
    ///        denominated the same way the project's claim is. 0 is read as 1. See `KpiConfig`.
    /// @param windowStartBlock Earliest block in scope; events before it are not creditable.
    /// @param windowEndBlock Latest block the relayer may report up to — the campaign's reporting
    ///        close. Enforced here, not left to relayer good behavior.
    function setKpiConfig(
        address campaign,
        uint256 kpiIndex,
        address targetContract,
        string calldata eventSignature,
        uint8 userParamIndex,
        Aggregation aggregation,
        uint8 valueParamIndex,
        uint256 scale,
        uint256 windowStartBlock,
        uint256 windowEndBlock
    ) external onlyOwner {
        if (campaign == address(0) || targetContract == address(0)) revert ZeroAddress();
        if (bytes(eventSignature).length == 0) revert EmptyEventSignature();
        if (windowStartBlock > windowEndBlock) revert BadWindow(windowStartBlock, windowEndBlock);

        bytes32 kKey = _kpiKey(campaign, kpiIndex);
        KpiConfig storage existing = kpiConfigs[kKey];

        // A first configuration opens at epoch 0.
        uint256 epoch = existing.epoch;
        bool invalidates = existing.configured
            && _watchesDifferentEvent(
                existing,
                targetContract,
                eventSignature,
                userParamIndex,
                aggregation,
                valueParamIndex,
                scale,
                windowStartBlock
            );
        if (invalidates) epoch += 1;

        kpiConfigs[kKey] = KpiConfig({
            targetContract: targetContract,
            eventSignature: eventSignature,
            userParamIndex: userParamIndex,
            valueParamIndex: valueParamIndex,
            aggregation: aggregation,
            scale: scale,
            windowStartBlock: windowStartBlock,
            windowEndBlock: windowEndBlock,
            configured: true,
            epoch: epoch
        });

        if (invalidates) {
            lastScannedBlock[kKey] = 0;
            emit KpiTotalsInvalidated(campaign, kpiIndex, epoch);
        }

        emit KpiConfigured(
            campaign,
            kpiIndex,
            targetContract,
            eventSignature,
            userParamIndex,
            aggregation,
            valueParamIndex,
            scale,
            windowStartBlock,
            windowEndBlock
        );
    }

    /// @notice Push one user's observed cumulative metric, without touching the checkpoint.
    /// @dev For manual correction. Incremental relayer runs should use `reportBatch`.
    /// @param campaign Campaign the KPI belongs to.
    /// @param kpiIndex Index of the KPI within that campaign.
    /// @param user End user the metric describes.
    /// @param verifiedTotal Cumulative metric observed for that user.
    function reportVerifiedTotal(address campaign, uint256 kpiIndex, address user, uint256 verifiedTotal)
        external
        onlyReporter
    {
        KpiConfig storage cfg = kpiConfigs[_kpiKey(campaign, kpiIndex)];
        if (!cfg.configured) revert KpiNotConfigured(campaign, kpiIndex);

        bytes32 uKey = _userKey(campaign, kpiIndex, cfg.epoch, user);
        verifiedTotals[uKey] = verifiedTotal;
        lastReportedAt[uKey] = block.timestamp;

        emit VerifiedTotalReported(campaign, kpiIndex, user, verifiedTotal);
    }

    /// @notice Push many users' observed totals and advance the scan checkpoint in one transaction.
    /// @dev Totals and checkpoint move together. Only users whose total changed need including; for a
    ///      run split across transactions, only the last should carry the new checkpoint.
    /// @param campaign Campaign the KPI belongs to.
    /// @param kpiIndex Index of the KPI within that campaign.
    /// @param users Users whose totals changed.
    /// @param totals New cumulative totals, positionally matching `users`.
    /// @param scannedUpToBlock Block the relayer confirms it has fully incorporated. Must not
    ///        regress, and must not exceed the configured `windowEndBlock`.
    function reportBatch(
        address campaign,
        uint256 kpiIndex,
        address[] calldata users,
        uint256[] calldata totals,
        uint256 scannedUpToBlock
    ) external onlyReporter {
        if (users.length != totals.length) revert LengthMismatch(users.length, totals.length);

        bytes32 kKey = _kpiKey(campaign, kpiIndex);
        _requireAdvanceable(campaign, kpiIndex, kKey, scannedUpToBlock);
        uint256 epoch = kpiConfigs[kKey].epoch;

        for (uint256 i = 0; i < users.length; i++) {
            bytes32 uKey = _userKey(campaign, kpiIndex, epoch, users[i]);
            verifiedTotals[uKey] = totals[i];
            lastReportedAt[uKey] = block.timestamp;
            emit VerifiedTotalReported(campaign, kpiIndex, users[i], totals[i]);
        }

        lastScannedBlock[kKey] = scannedUpToBlock;
        emit CheckpointAdvanced(campaign, kpiIndex, scannedUpToBlock);
    }

    /// @notice Advance the checkpoint with no total updates.
    /// @dev For a scanned range that held no matching logs.
    /// @param campaign Campaign the KPI belongs to.
    /// @param kpiIndex Index of the KPI within that campaign.
    /// @param scannedUpToBlock Block the relayer confirms it has fully scanned.
    function advanceCheckpoint(address campaign, uint256 kpiIndex, uint256 scannedUpToBlock)
        external
        onlyReporter
    {
        bytes32 kKey = _kpiKey(campaign, kpiIndex);
        _requireAdvanceable(campaign, kpiIndex, kKey, scannedUpToBlock);

        lastScannedBlock[kKey] = scannedUpToBlock;
        emit CheckpointAdvanced(campaign, kpiIndex, scannedUpToBlock);
    }

    /// @inheritdoc IKpiVerifier
    /// @dev `evidence` and `params` are accepted for interface compatibility and ignored. Reverts on an
    ///      unconfigured KPI.
    function verify(
        address campaign,
        uint256 kpiIndex,
        address user,
        uint256 amount,
        bytes calldata,
        bytes calldata
    ) external view returns (uint256 credited) {
        KpiConfig storage cfg = kpiConfigs[_kpiKey(campaign, kpiIndex)];
        if (!cfg.configured) revert KpiNotConfigured(campaign, kpiIndex);

        uint256 observed =
            verifiedTotals[_userKey(campaign, kpiIndex, cfg.epoch, user)] / _effectiveScale(cfg.scale);
        return amount < observed ? amount : observed;
    }

    // ── views ────────────────────────────────────────────────────

    /// @notice A KPI's watch config, addressed directly rather than by hashed key.
    /// @param campaign Campaign the KPI belongs to.
    /// @param kpiIndex Index of the KPI within that campaign.
    /// @return The stored config; `configured` is false if it was never set.
    function configOf(address campaign, uint256 kpiIndex) external view returns (KpiConfig memory) {
        return kpiConfigs[_kpiKey(campaign, kpiIndex)];
    }

    /// @notice A user's independently observed cumulative metric, in the event's own raw units.
    /// @dev The value the relayer accumulates against. For the capped figure, use `observedProgressOf`.
    /// @param campaign Campaign the KPI belongs to.
    /// @param kpiIndex Index of the KPI within that campaign.
    /// @param user End user to read.
    /// @return The observed cumulative metric, 0 if never reported under the current config.
    function verifiedTotalOf(address campaign, uint256 kpiIndex, address user)
        external
        view
        returns (uint256)
    {
        KpiConfig storage cfg = kpiConfigs[_kpiKey(campaign, kpiIndex)];
        return verifiedTotals[_userKey(campaign, kpiIndex, cfg.epoch, user)];
    }

    /// @notice The scaled ceiling a claim for this user would be capped at — what `verify` compares
    ///         against.
    /// @param campaign Campaign the KPI belongs to.
    /// @param kpiIndex Index of the KPI within that campaign.
    /// @param user End user to read.
    /// @return The observed metric divided by the configured scale.
    function observedProgressOf(address campaign, uint256 kpiIndex, address user)
        external
        view
        returns (uint256)
    {
        KpiConfig storage cfg = kpiConfigs[_kpiKey(campaign, kpiIndex)];
        return verifiedTotals[_userKey(campaign, kpiIndex, cfg.epoch, user)] / _effectiveScale(cfg.scale);
    }

    /// @notice Where the relayer left off for a KPI.
    /// @param campaign Campaign the KPI belongs to.
    /// @param kpiIndex Index of the KPI within that campaign.
    /// @return Last block fully incorporated, 0 if the relayer has never run.
    function checkpointOf(address campaign, uint256 kpiIndex) external view returns (uint256) {
        return lastScannedBlock[_kpiKey(campaign, kpiIndex)];
    }

    // ── internals ────────────────────────────────────────────────

    /// @dev Whether a replacement config describes a different measurement. Every field except
    ///      `windowEndBlock` is compared.
    /// @param existing The stored config.
    /// @param targetContract Replacement contract emitting the watched event.
    /// @param eventSignature Replacement event ABI.
    /// @param userParamIndex Replacement position of the user-address param.
    /// @param aggregation Replacement aggregation mode.
    /// @param valueParamIndex Replacement position of the summed param.
    /// @param scale Replacement divisor.
    /// @param windowStartBlock Replacement earliest block in scope.
    /// @return True when the replacement watches something else, so totals must be abandoned.
    function _watchesDifferentEvent(
        KpiConfig storage existing,
        address targetContract,
        string calldata eventSignature,
        uint8 userParamIndex,
        Aggregation aggregation,
        uint8 valueParamIndex,
        uint256 scale,
        uint256 windowStartBlock
    ) private view returns (bool) {
        return existing.targetContract != targetContract
            || keccak256(bytes(existing.eventSignature)) != keccak256(bytes(eventSignature))
            || existing.userParamIndex != userParamIndex || existing.aggregation != aggregation
            || existing.valueParamIndex != valueParamIndex || existing.scale != scale
            || existing.windowStartBlock != windowStartBlock;
    }

    /// @dev A configured 0 means no scaling. Matches `effectiveScale` in `web/src/lib/kpiSource.ts`.
    /// @param scale The configured divisor.
    /// @return The divisor to actually apply.
    function _effectiveScale(uint256 scale) private pure returns (uint256) {
        return scale == 0 ? 1 : scale;
    }

    /// @dev Shared guard for both checkpoint-advancing paths: KPI configured, no checkpoint regression,
    ///      and within `windowEndBlock`.
    /// @param campaign Campaign the KPI belongs to.
    /// @param kpiIndex Index of the KPI within that campaign.
    /// @param kKey Precomputed `_kpiKey(campaign, kpiIndex)`.
    /// @param scannedUpToBlock Proposed new checkpoint.
    function _requireAdvanceable(address campaign, uint256 kpiIndex, bytes32 kKey, uint256 scannedUpToBlock)
        private
        view
    {
        KpiConfig storage cfg = kpiConfigs[kKey];
        if (!cfg.configured) revert KpiNotConfigured(campaign, kpiIndex);

        uint256 current = lastScannedBlock[kKey];
        if (scannedUpToBlock < current) revert CheckpointRegression(current, scannedUpToBlock);
        if (scannedUpToBlock > cfg.windowEndBlock) {
            revert PastReportWindow(cfg.windowEndBlock, scannedUpToBlock);
        }
    }

    /// @dev Per-KPI storage key.
    /// @param campaign Campaign the KPI belongs to.
    /// @param kpiIndex Index of the KPI within that campaign.
    /// @return The hashed key.
    function _kpiKey(address campaign, uint256 kpiIndex) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(campaign, kpiIndex));
    }

    /// @dev Per-user-per-KPI storage key, scoped to a config generation. `epoch` is in the preimage, so
    ///      a config change moves every total to fresh slots.
    /// @param campaign Campaign the KPI belongs to.
    /// @param kpiIndex Index of the KPI within that campaign.
    /// @param epoch Generation of the KPI's config, from `KpiConfig.epoch`.
    /// @param user End user the metric describes.
    /// @return The hashed key.
    function _userKey(address campaign, uint256 kpiIndex, uint256 epoch, address user)
        private
        pure
        returns (bytes32)
    {
        return keccak256(abi.encodePacked(campaign, kpiIndex, epoch, user));
    }
}
