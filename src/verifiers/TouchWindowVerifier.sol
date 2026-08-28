// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IKpiVerifier} from "../interfaces/IKpiVerifier.sol";
import {ITouchWindowVerifier} from "../interfaces/ITouchWindowVerifier.sol";
import {IAttributionRegistry} from "../interfaces/IAttributionRegistry.sol";

/// @dev Declared locally so the verifier reads whichever registry the calling campaign uses, rather
///      than one wired in at deploy time.
interface ICampaignAttribution {
    /// @notice The attribution registry the calling campaign resolves touches against.
    /// @return The registry this verifier should read.
    function attributionRegistry() external view returns (IAttributionRegistry);
}

/// @title TouchWindowVerifier
/// @notice Credits only the actions a user performed while the currently attributed promoter held
///         the attribution.
/// @dev `Campaign.reportUserAction` resolves attribution when a report lands and sees only a
///      cumulative total, so without this adapter the granularity of attribution is the project's
///      reporting cadence. `evidence` supplies the missing per-action timestamps, and only actions at
///      or after the live touch's `signedAt` (less `lookback`) are credited.
///
///      A verifier may only reduce `credited`, never redirect the payee, so uncredited progress stays
///      uncredited and a corrected report can land later.
///
///      `lookback` comes from the KPI's `params` and is how far before `signedAt` an action still
///      counts; it is also how much history a newly-signed touch can capture. Zero means strict.
///
///      Stateless and view-only; one deployment serves every campaign.
contract TouchWindowVerifier is ITouchWindowVerifier {
    /// @param timestamp When the user performed the action.
    /// @param amount How much it contributes to the KPI.
    struct Action {
        uint64 timestamp;
        uint256 amount;
    }

    /// @inheritdoc IKpiVerifier
    /// @dev No evidence or no stored touch credits nothing, which `Campaign` treats as a no-op report.
    function verify(
        address campaign,
        uint256,
        address user,
        uint256 amount,
        bytes calldata evidence,
        bytes calldata params
    ) external view returns (uint256 credited) {
        if (evidence.length == 0) return 0;

        IAttributionRegistry.Touch memory touch =
            ICampaignAttribution(campaign).attributionRegistry().touchOf(campaign, user);
        if (touch.promoterId == bytes32(0)) return 0;

        uint64 floor = _floor(touch.signedAt, _lookback(params));
        uint64 nowTs = uint64(block.timestamp);

        Action[] memory actions = abi.decode(evidence, (Action[]));
        uint256 total;

        for (uint256 i = 0; i < actions.length; i++) {
            Action memory a = actions[i];
            // Future-dated actions are rejected rather than skipped.
            if (a.timestamp > nowTs) revert FutureAction(a.timestamp, nowTs);

            total += a.amount;
            if (a.timestamp >= floor) credited += a.amount;
        }

        // Evidence may describe less than was claimed; claiming more is a disagreement.
        if (total > amount) revert EvidenceExceedsClaim(total, amount);
    }

    /// @notice The earliest action timestamp this touch can credit.
    /// @param campaign The campaign to read attribution from.
    /// @param user The end user whose touch sets the floor.
    /// @param params The KPI's configured `params` blob, carrying the lookback.
    /// @return The cutoff timestamp; actions at or after it are credited. 0 when the user has no
    ///         stored touch, since an unset `signedAt` credits nothing anyway.
    function windowFloor(address campaign, address user, bytes calldata params)
        external
        view
        returns (uint64)
    {
        IAttributionRegistry.Touch memory touch =
            ICampaignAttribution(campaign).attributionRegistry().touchOf(campaign, user);
        return _floor(touch.signedAt, _lookback(params));
    }

    /// @dev A KPI configured without params is strict.
    /// @param params The KPI's `params` blob; a single abi-encoded `uint64`.
    /// @return Seconds before `signedAt` that an action still counts, or 0 if params are unset or
    ///         not the expected width.
    function _lookback(bytes calldata params) private pure returns (uint64) {
        if (params.length != 32) return 0;
        return abi.decode(params, (uint64));
    }

    /// @dev Clamps at 0 rather than underflowing for a touch signed within `lookback` of the epoch.
    /// @param signedAt When the user signed the live touch.
    /// @param lookback Grace period before `signedAt`.
    /// @return The earliest creditable action timestamp.
    function _floor(uint64 signedAt, uint64 lookback) private pure returns (uint64) {
        return signedAt > lookback ? signedAt - lookback : 0;
    }
}
