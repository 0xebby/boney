// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IKpiVerifier} from "../interfaces/IKpiVerifier.sol";
import {IAttributionRegistry} from "../interfaces/IAttributionRegistry.sol";

/// @dev Campaigns expose their registry as a public immutable of interface type; declared locally
///      so the verifier reads whichever registry the calling campaign actually uses rather than
///      one wired in at deploy time.
interface ICampaignAttribution {
    function attributionRegistry() external view returns (IAttributionRegistry);
}

/// @title TouchWindowVerifier
/// @notice Credits only the actions a user performed while the currently attributed promoter held
///         the attribution.
/// @dev Closes the reporting-interval gap in `Campaign.reportUserAction`. That function resolves
///      attribution when a report *lands*, and the chain only ever sees a cumulative `newTotal` —
///      it has no idea when the underlying actions happened. So without an adapter the effective
///      granularity of attribution is the project's reporting cadence: everything accrued since
///      the last report follows whoever holds the touch at report time, including activity that
///      predates that touch entirely. A promoter who knows the cadence can farm it by getting the
///      user to sign just before a batch.
///
///      This adapter supplies the missing timestamps. `evidence` carries the individual actions
///      making up the reported delta, and only those at or after the live touch's `signedAt`
///      (less `lookback`) are credited.
///
///      What it can and cannot do: a verifier may only reduce `credited`, never redirect the
///      payee. So it denies the late-arriving promoter the delta they did not earn — it cannot
///      award that delta to the promoter who did. Uncredited progress stays uncredited, and
///      `Campaign` leaves `_userCredited` unadvanced for it, so a corrected report can still land
///      later once the right promoter is attributed again.
///
///      **Lookback.** A user typically clicks a link, acts, and only then is asked to sign — so
///      the action legitimately predates the touch. `lookback` (from the KPI's `params`) is how
///      far before `signedAt` an action still counts. It is a direct trade: the window is also
///      exactly how much history a newly-signed touch can capture, so keep it near the real
///      click-to-sign latency and far below the reporting interval. Zero means strict.
///
///      Stateless and view-only; one deployment serves every campaign.
contract TouchWindowVerifier is IKpiVerifier {
    error EvidenceExceedsClaim(uint256 total, uint256 amount);
    error FutureAction(uint64 timestamp, uint64 blockTimestamp);

    /// @param timestamp When the user performed the action.
    /// @param amount How much it contributes to the KPI.
    struct Action {
        uint64 timestamp;
        uint256 amount;
    }

    /// @inheritdoc IKpiVerifier
    /// @dev Fails closed: no evidence or no live touch credits nothing, which `Campaign` treats as
    ///      a no-op report rather than a revert.
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
            // A future-dated action would clear any floor, so it is rejected rather than skipped.
            if (a.timestamp > nowTs) revert FutureAction(a.timestamp, nowTs);

            total += a.amount;
            if (a.timestamp >= floor) credited += a.amount;
        }

        // Evidence may describe less than the reporter claimed — the remainder is simply not
        // credited. Claiming *more* than the report means the two disagree about what happened.
        if (total > amount) revert EvidenceExceedsClaim(total, amount);
    }

    /// @notice The earliest action timestamp this touch can credit.
    function windowFloor(address campaign, address user, bytes calldata params)
        external
        view
        returns (uint64)
    {
        IAttributionRegistry.Touch memory touch =
            ICampaignAttribution(campaign).attributionRegistry().touchOf(campaign, user);
        return _floor(touch.signedAt, _lookback(params));
    }

    /// @dev A KPI configured without params is strict — the safe reading of "unset".
    function _lookback(bytes calldata params) private pure returns (uint64) {
        if (params.length != 32) return 0;
        return abi.decode(params, (uint64));
    }

    function _floor(uint64 signedAt, uint64 lookback) private pure returns (uint64) {
        return signedAt > lookback ? signedAt - lookback : 0;
    }
}
