// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IKpiVerifier} from "../interfaces/IKpiVerifier.sol";
import {IGuardedKpiVerifier} from "../interfaces/IGuardedKpiVerifier.sol";

/// @title GuardedKpiVerifier
/// @notice Composes Boney's canonical `EventMetricKpiVerifier` with a second verifier, so a KPI is
///         gated by two independent readings rather than one.
/// @dev This is the contract a campaign points `KpiSpec.verifier` at. Boney's value is always
///      computed — the second verifier is a check, never an alternate source of truth. Without this
///      wrapper, a project running its own verifier would be silently overridden by Boney's number
///      every time, and nobody would learn that the two ever disagreed.
///
///      **Two composition modes, because the second verifier can mean two different things.**
///
///      `AGREE` is for a project running its own *independent measurement of the same quantity*. The
///      two values should match, so divergence past `toleranceBps` reverts the whole report with
///      `VerifierDisagreement` rather than quietly taking the smaller one. That surfaces a broken
///      indexer or a disputed metric as an actionable error. `toleranceBps = 0` (exact match) is
///      right for `COUNT`; `SUM`/volume KPIs may want a small nonzero tolerance to absorb rounding
///      and timing differences between two independent scans.
///
///      `CAP` is for layering a *stricter lens on a different quantity*, and it credits
///      `min(boney, project)`. `TouchWindowVerifier` is the motivating case: it floors credit at the
///      current attribution touch's `signedAt`, so after a promoter switch it deliberately discards
///      pre-switch activity that Boney's cumulative totals still retain. Those two numbers differ by
///      construction, not by fault — under `AGREE` every legitimate post-switch report would revert.
///      `CAP` reads the smaller number as the stricter bound it is.
///
///      Either way the result can only shrink a claim: `Campaign.reportUserAction` independently
///      rejects any verifier returning more than was claimed.
contract GuardedKpiVerifier is IGuardedKpiVerifier, Ownable {
    /// @notice How one KPI's second opinion is sourced and combined.
    /// @param projectVerifier The second `IKpiVerifier`. `address(0)` skips the second reading
    ///        entirely and trusts Boney alone — equivalent to pointing the campaign straight at
    ///        `EventMetricKpiVerifier`, but kept routable through here so a KPI can gain a second
    ///        verifier later without the campaign's immutable KPI spec changing.
    /// @param toleranceBps Allowed divergence in basis points of the larger value. `AGREE` only.
    /// @param mode `AGREE` or `CAP`.
    /// @param configured Set once `setGuardConfig` has run.
    struct GuardConfig {
        address projectVerifier;
        uint16 toleranceBps;
        Mode mode;
        bool configured;
    }

    /// @notice Boney's canonical verifier. Always consulted; never optional.
    address public immutable boneyVerifier;

    uint16 constant MAX_TOLERANCE = 10_000;

    /// @notice `keccak256(campaign, kpiIndex)` => how that KPI is guarded.
    mapping(bytes32 => GuardConfig) public guardConfigs;

    /// @param owner_ Account allowed to configure guards.
    /// @param boneyVerifier_ Boney's `EventMetricKpiVerifier`.
    constructor(address owner_, address boneyVerifier_) Ownable(owner_) {
        if (boneyVerifier_ == address(0)) revert ZeroAddress();
        boneyVerifier = boneyVerifier_;
    }

    /// @notice Configure how a KPI's second opinion is sourced and combined.
    /// @param campaign Campaign the KPI belongs to.
    /// @param kpiIndex Index of the KPI within that campaign.
    /// @param projectVerifier The second `IKpiVerifier`, or `address(0)` to trust Boney alone.
    /// @param toleranceBps Allowed divergence in basis points of the larger value, capped at 10,000
    ///        (100%). Ignored under `CAP`.
    /// @param mode `AGREE` to reject divergence, `CAP` to take the stricter of the two.
    function setGuardConfig(
        address campaign,
        uint256 kpiIndex,
        address projectVerifier,
        uint16 toleranceBps,
        Mode mode
    ) external onlyOwner {
        if (campaign == address(0)) revert ZeroAddress();
        if (toleranceBps > MAX_TOLERANCE) revert BpsOutOfRange(toleranceBps);

        guardConfigs[_key(campaign, kpiIndex)] = GuardConfig({
            projectVerifier: projectVerifier,
            toleranceBps: toleranceBps,
            mode: mode,
            configured: true
        });

        emit GuardConfigured(campaign, kpiIndex, projectVerifier, toleranceBps, mode);
    }

    /// @inheritdoc IKpiVerifier
    /// @dev Fails closed on an unconfigured KPI: a campaign wired here before `setGuardConfig` runs
    ///      is loudly broken rather than silently ungated.
    function verify(
        address campaign,
        uint256 kpiIndex,
        address user,
        uint256 amount,
        bytes calldata evidence,
        bytes calldata params
    ) external view returns (uint256 credited) {
        GuardConfig memory cfg = guardConfigs[_key(campaign, kpiIndex)];
        if (!cfg.configured) revert NotConfigured(campaign, kpiIndex);

        uint256 boneyValue =
            IKpiVerifier(boneyVerifier).verify(campaign, kpiIndex, user, amount, evidence, params);

        if (cfg.projectVerifier == address(0)) return boneyValue;

        uint256 projectValue =
            IKpiVerifier(cfg.projectVerifier).verify(campaign, kpiIndex, user, amount, evidence, params);

        if (cfg.mode == Mode.CAP) {
            return projectValue < boneyValue ? projectValue : boneyValue;
        }

        uint256 diff = boneyValue > projectValue ? boneyValue - projectValue : projectValue - boneyValue;
        uint256 base = boneyValue > projectValue ? boneyValue : projectValue;
        uint256 allowed = (base * cfg.toleranceBps) / MAX_TOLERANCE;
        if (diff > allowed) revert VerifierDisagreement(projectValue, boneyValue, diff, allowed);

        // Agreement confirmed. Boney's value stays canonical, so the credited number comes from the
        // same source across every KPI whether or not a second verifier happens to be configured.
        return boneyValue;
    }

    /// @notice A KPI's guard config, addressed directly rather than by hashed key.
    /// @param campaign Campaign the KPI belongs to.
    /// @param kpiIndex Index of the KPI within that campaign.
    /// @return The stored config; `configured` is false if it was never set.
    function guardOf(address campaign, uint256 kpiIndex) external view returns (GuardConfig memory) {
        return guardConfigs[_key(campaign, kpiIndex)];
    }

    /// @dev Per-KPI storage key. Matches `EventMetricKpiVerifier`'s derivation so the two contracts
    ///      can be reasoned about against the same key.
    /// @param campaign Campaign the KPI belongs to.
    /// @param kpiIndex Index of the KPI within that campaign.
    /// @return The hashed key.
    function _key(address campaign, uint256 kpiIndex) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(campaign, kpiIndex));
    }
}
