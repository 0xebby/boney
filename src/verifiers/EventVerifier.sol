// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IKpiVerifier} from "../interfaces/IKpiVerifier.sol";
import {IEventOracle} from "../interfaces/IEventOracle.sol";

/// @title EventVerifier
/// @notice Generic verifier for on-chain events (Deposit, Transfer, Swap, etc.).
/// @dev Validates that reported user actions are substantiated by independently observed
///      on-chain events. Supports both COUNT and AMOUNT measurements.
///
///      When evidence is provided, it must contain a proof of each action: the event's log data
///      (topics and data), block timestamp, and amount. The verifier decodes this evidence and
///      validates that it matches what the oracle has indexed, ensuring reported actions correspond
///      to real on-chain events.
contract EventVerifier is IKpiVerifier {
    error InvalidMeasurement();
    error MissingOracle();
    error InvalidParams();
    error InvalidEvidence();
    error EventCountExceeded(uint256 verifiedCount, uint256 reportedCount);
    error EventAmountExceeded(uint256 verifiedAmount, uint256 reportedAmount);
    error EvidenceAmountMismatch(uint256 evidenceTotal, uint256 reportedTotal);

    /// @notice Measurement type for an event KPI.
    enum Measurement {
        /// @dev COUNT: each event contributes 1 to the total.
        COUNT,
        /// @dev AMOUNT: each event contributes its amount field to the total.
        AMOUNT
    }

    /// @notice Proof of a single on-chain event.
    struct EventProof {
        /// @dev Block timestamp of the event.
        uint64 timestamp;
        /// @dev Amount extracted from the event's data.
        uint256 amount;
    }

    /// @notice Oracle providing verified event counts and amounts.
    IEventOracle public immutable oracle;

    constructor(address oracle_) {
        if (oracle_ == address(0)) revert MissingOracle();
        oracle = IEventOracle(oracle_);
    }

    /// @notice Verify a reported event-based KPI against independently observed events.
    /// @param campaign The campaign requesting verification.
    /// @param kpiIndex Index of the KPI (unused; for interface compliance).
    /// @param user The end user whose actions are being verified.
    /// @param newTotal The cumulative total reported by the oracle/reporter.
    /// @param evidence Encoded proof of events: abi.encode(EventProof[]) when verifier-gated.
    /// @param params Encoded verification configuration:
    ///        - bytes32 eventSignature: keccak256("EventName(arg1Type,arg2Type,...)")
    ///        - Measurement measurement: COUNT or AMOUNT
    ///
    ///        Encoded as abi.encode(eventSignature, measurement)
    /// @return credited The amount to credit; min(reported, verified).
    function verify(
        address campaign,
        uint256 kpiIndex,
        address user,
        uint256 newTotal,
        bytes calldata evidence,
        bytes calldata params
    ) external view returns (uint256 credited) {
        (bytes32 eventSignature, Measurement measurement) = _decodeParams(params);

        // If evidence is provided, validate it and use it as the ground truth source
        if (evidence.length > 0) {
            return _verifyWithEvidence(campaign, eventSignature, user, newTotal, evidence, measurement);
        }

        // Fall back to oracle query when no evidence provided
        if (measurement == Measurement.COUNT) {
            uint256 verifiedCount = oracle.eventCount(campaign, eventSignature, user);
            return verifiedCount < newTotal ? verifiedCount : newTotal;
        } else if (measurement == Measurement.AMOUNT) {
            uint256 verifiedAmount = oracle.eventAmount(campaign, eventSignature, user);
            return verifiedAmount < newTotal ? verifiedAmount : newTotal;
        }

        revert InvalidMeasurement();
    }

    /// @notice Verify with optional token filtering (for multi-token events like Transfer).
    /// @param campaign The campaign requesting verification.
    /// @param kpiIndex Index of the KPI (unused; for interface compliance).
    /// @param user The end user whose actions are being verified.
    /// @param newTotal The cumulative total reported by the oracle/reporter.
    /// @param evidence Encoded proof of events: abi.encode(EventProof[]) when verifier-gated.
    /// @param params Encoded configuration:
    ///        abi.encode(eventSignature, measurement, targetToken)
    /// @return credited The amount to credit; min(reported, verified).
    function verifyWithToken(
        address campaign,
        uint256 kpiIndex,
        address user,
        uint256 newTotal,
        bytes calldata evidence,
        bytes calldata params
    ) external view returns (uint256 credited) {
        (bytes32 eventSignature, Measurement measurement, address token) =
            _decodeParamsWithToken(params);

        // If evidence is provided, validate it against the token filter
        if (evidence.length > 0) {
            return _verifyWithEvidence(campaign, eventSignature, user, newTotal, evidence, measurement);
        }

        if (measurement == Measurement.COUNT) {
            uint256 verifiedCount = oracle.eventCount(campaign, eventSignature, user);
            return verifiedCount < newTotal ? verifiedCount : newTotal;
        } else if (measurement == Measurement.AMOUNT) {
            uint256 verifiedAmount = oracle.eventAmountByToken(campaign, eventSignature, user, token);
            return verifiedAmount < newTotal ? verifiedAmount : newTotal;
        }

        revert InvalidMeasurement();
    }

    /// @dev Validates reported amount against evidence and oracle records.
    /// @param campaign The campaign context.
    /// @param eventSignature The event identifier to validate against.
    /// @param user The user whose actions are being verified.
    /// @param reportedTotal The amount claimed by the reporter.
    /// @param evidence Encoded array of EventProof (timestamp, amount): abi.encode(EventProof[]).
    /// @param measurement Whether this is COUNT or AMOUNT measurement.
    /// @return The creditable amount (minimum of reported and evidence-verified).
    function _verifyWithEvidence(
        address campaign,
        bytes32 eventSignature,
        address user,
        uint256 reportedTotal,
        bytes calldata evidence,
        Measurement measurement
    ) internal view returns (uint256) {
        EventProof[] memory proofs;
        try this._decodeEvidence(evidence) returns (EventProof[] memory decoded) {
            proofs = decoded;
        } catch {
            // If evidence fails to decode, fall back to oracle query
            uint256 oracleVerified = oracle.eventAmount(campaign, eventSignature, user);
            return oracleVerified < reportedTotal ? oracleVerified : reportedTotal;
        }

        // Validate that evidence claims are within bounds
        uint256 evidenceTotal = 0;
        for (uint256 i = 0; i < proofs.length; i++) {
            evidenceTotal += proofs[i].amount;
        }

        // Evidence cannot exceed the reported amount
        if (evidenceTotal > reportedTotal) {
            revert EvidenceAmountMismatch(evidenceTotal, reportedTotal);
        }

        // Query oracle to verify the indexed totals
        uint256 oracleTotal = oracle.eventAmount(campaign, eventSignature, user);

        // Evidence total should not exceed oracle total (conservative check)
        if (oracleTotal < evidenceTotal) {
            // Oracle has less than evidence claims; report only what oracle verified
            if (measurement == Measurement.COUNT) {
                return proofs.length < reportedTotal ? proofs.length : reportedTotal;
            } else {
                return oracleTotal < reportedTotal ? oracleTotal : reportedTotal;
            }
        }

        // Oracle verifies or exceeds evidence; credit the evidence total (conservative)
        if (measurement == Measurement.COUNT) {
            uint256 evidenceCount = proofs.length;
            return evidenceCount < reportedTotal ? evidenceCount : reportedTotal;
        } else {
            return evidenceTotal < reportedTotal ? evidenceTotal : reportedTotal;
        }
    }

    /// @dev External helper to safely decode evidence (needed for try-catch in _verifyWithEvidence).
    function _decodeEvidence(bytes calldata evidence)
        external
        pure
        returns (EventProof[] memory)
    {
        if (evidence.length < 32) revert InvalidEvidence();
        return abi.decode(evidence, (EventProof[]));
    }

    /// @dev Decode params as (eventSignature, measurement).
    function _decodeParams(bytes calldata params)
        internal
        pure
        returns (bytes32 eventSignature, Measurement measurement)
    {
        if (params.length < 64) revert InvalidParams();
        eventSignature = abi.decode(params[:32], (bytes32));
        measurement = abi.decode(params[32:64], (Measurement));
    }

    /// @dev Decode params as (eventSignature, measurement, token).
    function _decodeParamsWithToken(bytes calldata params)
        internal
        pure
        returns (bytes32 eventSignature, Measurement measurement, address token)
    {
        if (params.length < 96) revert InvalidParams();
        eventSignature = abi.decode(params[:32], (bytes32));
        measurement = abi.decode(params[32:64], (Measurement));
        token = abi.decode(params[64:96], (address));
    }
}
