// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Types} from "../libraries/Types.sol";

/**
 * @title Errors library
 * @author Boney
 * @notice Defines the error messages emitted by the different contracts of the boney protocol
 */


 library Errors {
    string public constant ZERO_ADDRESS = '1'; // 'Address is the zero address'
    string public constant ZERO_TOUCH_DURATION = '2'; // 

    error ZeroWindow();
    error InvalidPromoterId();
    error TouchExpired(uint64 expiresAt, uint64 timestamp);
    error TouchTooLong(uint64 expiresAt, uint64 maxExpiresAt);
    error TouchNotYetValid(uint64 signedAt, uint64 timestamp);
    error TouchNotNewer(uint64 signedAt, uint64 storedSignedAt);
    error TouchAlreadyActive(bytes32 promoterId, uint64 expiresAt);
    error InvalidSignature();
    error PromoterNotRegistered(address campaign, bytes32 promoterId);
    error TouchDurationTooLong(uint64 maximum, uint64 provided);
    error CampaignOver(uint256 endTime, uint64 timestamp);
    error CampaignTerminal(uint256 status);
    error LengthMismatch(uint256 blocks, uint256 timestamps);
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
    error AmbiguousAttribution(address user, uint256 kpiIndex);
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
    error TooManyActions(uint256 provided, uint256 max);
    error EmptyReportBatch();
    error TooManyReports(uint256 provided, uint256 max);
    error UnorderedEvidence(uint256 index);
    error ExtensionTooLarge(uint64 maximum, uint64 provided);
    error ExtensionNotForward(uint64 current, uint64 provided);
    error TopUpTooEarly(uint256 paidOut, uint256 required);
    error TopUpTooSmall(uint256 provided, uint256 required);
    error ShortfallUnfunded(uint256 provided, uint256 required);
    error NoShortFallOwed(address promoter);
    error OutstandingShortfall(uint256 amount);
    error InvalidReporter();


 }