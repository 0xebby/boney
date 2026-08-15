// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IKpiVerifier} from "../interfaces/IKpiVerifier.sol";
import {IEventOracle} from "../interfaces/IEventOracle.sol";

/// @title EventVerifier
/// @notice Generic verifier for on-chain events (Deposit, Transfer, Swap, etc.).
/// @dev Validates that reported user actions are substantiated by independently observed
///      on-chain events. Supports both COUNT and AMOUNT measurements.
contract EventVerifier is IKpiVerifier {
    error InvalidMeasurement();
    error MissingOracle();
    error InvalidParams();
    error EventCountExceeded(uint256 verifiedCount, uint256 reportedCount);
    error EventAmountExceeded(uint256 verifiedAmount, uint256 reportedAmount);

    /// @notice Measurement type for an event KPI.
    enum Measurement {
        /// @dev COUNT: each event contributes 1 to the total.
        COUNT,
        /// @dev AMOUNT: each event contributes its amount field to the total.
        AMOUNT
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
    /// @param evidence Optional additional proof (reserved for future use; e.g., event receipts).
    /// @param params Encoded verification configuration:
    ///        - bytes32 eventSignature: keccak256("EventName(arg1Type,arg2Type,...)")
    ///        - Measurement measurement: COUNT or AMOUNT
    ///        - address eventContract: (optional, for multi-source filtering)
    ///
    ///        Encoded as abi.encode(eventSignature, measurement):
    ///        abi.encode(keccak256("Deposit(address,uint256)"), Measurement.AMOUNT)
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

        if (measurement == Measurement.COUNT) {
            // For COUNT, query the event count and return the minimum of reported vs verified.
            // If verified > reported (conservative report): return reported
            // If verified < reported (overclaim): return verified
            uint256 verifiedCount = oracle.eventCount(campaign, eventSignature, user);
            return verifiedCount < newTotal ? verifiedCount : newTotal;
        } else if (measurement == Measurement.AMOUNT) {
            // For AMOUNT, query the cumulative amount and return the minimum of reported vs verified.
            // If verified > reported (conservative report): return reported
            // If verified < reported (overclaim): return verified
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
    /// @param evidence Optional proof (reserved for future use).
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

        if (measurement == Measurement.COUNT) {
            uint256 verifiedCount = oracle.eventCount(campaign, eventSignature, user);
            return verifiedCount < newTotal ? verifiedCount : newTotal;
        } else if (measurement == Measurement.AMOUNT) {
            uint256 verifiedAmount = oracle.eventAmountByToken(campaign, eventSignature, user, token);
            return verifiedAmount < newTotal ? verifiedAmount : newTotal;
        }

        revert InvalidMeasurement();
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
