// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "forge-std/Test.sol";
import {EventVerifier} from "../src/verifiers/EventVerifier.sol";
import {DepositVerifier} from "../src/verifiers/DepositVerifier.sol";
import {TransferVerifier} from "../src/verifiers/TransferVerifier.sol";
import {IEventOracle} from "../src/interfaces/IEventOracle.sol";

/// @title MockEventOracle
/// @notice Mock oracle providing verified event counts and amounts for testing.
contract MockEventOracle is IEventOracle {
    // campaign => (eventSig => (user => count))
    mapping(address campaign => mapping(bytes32 eventSig => mapping(address user => uint256)))
        public verifiedEventCounts;

    // campaign => (eventSig => (user => amount))
    mapping(address campaign => mapping(bytes32 eventSig => mapping(address user => uint256)))
        public verifiedEventAmounts;

    // campaign => (eventSig => (user => (token => amount)))
    mapping(address campaign => mapping(bytes32 eventSig => mapping(address user => mapping(address token => uint256))))
        public verifiedEventAmountsByToken;

    /// @notice Set the verified event count for a user.
    function setEventCount(address campaign, bytes32 eventSig, address user, uint256 count)
        external
    {
        verifiedEventCounts[campaign][eventSig][user] = count;
    }

    /// @notice Set the verified event amount for a user.
    function setEventAmount(address campaign, bytes32 eventSig, address user, uint256 amount)
        external
    {
        verifiedEventAmounts[campaign][eventSig][user] = amount;
    }

    /// @notice Set the verified event amount for a user with a specific token.
    function setEventAmountByToken(
        address campaign,
        bytes32 eventSig,
        address user,
        address token,
        uint256 amount
    ) external {
        verifiedEventAmountsByToken[campaign][eventSig][user][token] = amount;
    }

    /// @notice Query verified event count.
    function eventCount(address campaign, bytes32 eventSig, address user)
        external
        view
        returns (uint256)
    {
        return verifiedEventCounts[campaign][eventSig][user];
    }

    /// @notice Query verified event amount.
    function eventAmount(address campaign, bytes32 eventSig, address user)
        external
        view
        returns (uint256)
    {
        return verifiedEventAmounts[campaign][eventSig][user];
    }

    /// @notice Query verified event amount by token.
    function eventAmountByToken(
        address campaign,
        bytes32 eventSig,
        address user,
        address token
    ) external view returns (uint256) {
        return verifiedEventAmountsByToken[campaign][eventSig][user][token];
    }
}

/// @title EventVerifierTest
/// @notice Comprehensive tests for event-based KPI verifiers.
contract EventVerifierTest is Test {
    // Base Sepolia contract addresses
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    // Event signatures
    bytes32 constant DEPOSIT_SIG = keccak256("Deposit(address,uint256)");
    bytes32 constant WITHDRAWAL_SIG = keccak256("Withdrawal(address,uint256)");
    bytes32 constant TRANSFER_SIG = keccak256("Transfer(address,address,uint256)");
    bytes32 constant SWAP_SIG = keccak256("Swap(address,uint256,uint256,uint256,uint256,address)");

    MockEventOracle oracle;
    EventVerifier eventVerifier;
    DepositVerifier depositVerifier;
    TransferVerifier transferVerifier;

    address campaign = address(0x1234);
    address user = address(0xabcd);
    address notUser = address(0xdead);

    function setUp() public {
        oracle = new MockEventOracle();
        eventVerifier = new EventVerifier(address(oracle));
        depositVerifier = new DepositVerifier(address(oracle));
        transferVerifier = new TransferVerifier(address(oracle));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // EventVerifier::COUNT measurement tests
    // ─────────────────────────────────────────────────────────────────────────

    function test_CountMeasurement_SingleDeposit() public {
        // Scenario: User made 1 deposit, reporter claims 1
        oracle.setEventCount(campaign, DEPOSIT_SIG, user, 1);

        bytes memory params = abi.encode(DEPOSIT_SIG, EventVerifier.Measurement.COUNT);
        uint256 credited =
            eventVerifier.verify(campaign, 0, user, 1, "", params);

        assertEq(credited, 1, "Should credit 1 for 1 verified deposit");
    }

    function test_CountMeasurement_MultipleDeposits() public {
        // Scenario: User made 5 deposits, reporter reports cumulatively as 5
        oracle.setEventCount(campaign, DEPOSIT_SIG, user, 5);

        bytes memory params = abi.encode(DEPOSIT_SIG, EventVerifier.Measurement.COUNT);
        uint256 credited =
            eventVerifier.verify(campaign, 0, user, 5, "", params);

        assertEq(credited, 5, "Should credit 5 for 5 verified deposits");
    }

    function test_CountMeasurement_OverreportClamped() public {
        // Scenario: Oracle verified 3 deposits, but reporter claims 10
        // Result: Verifier returns 3 (min of verified vs reported)
        oracle.setEventCount(campaign, DEPOSIT_SIG, user, 3);

        bytes memory params = abi.encode(DEPOSIT_SIG, EventVerifier.Measurement.COUNT);
        uint256 credited =
            eventVerifier.verify(campaign, 0, user, 10, "", params);

        assertEq(credited, 3, "Should clamp to 3 verified deposits, not 10 reported");
    }

    function test_CountMeasurement_UnderreportAccepted() public {
        // Scenario: Oracle verified 10 deposits, but reporter conservatively claims only 5
        // Result: Verifier returns min(10, 5) = 5 (accepts conservative report)
        oracle.setEventCount(campaign, DEPOSIT_SIG, user, 10);

        bytes memory params = abi.encode(DEPOSIT_SIG, EventVerifier.Measurement.COUNT);
        uint256 credited =
            eventVerifier.verify(campaign, 0, user, 5, "", params);

        assertEq(credited, 5, "Should accept conservative report of 5 when 10 verified");
    }

    function test_CountMeasurement_ZeroDeposits() public {
        // Scenario: No deposits made, reporter claims 0
        oracle.setEventCount(campaign, DEPOSIT_SIG, user, 0);

        bytes memory params = abi.encode(DEPOSIT_SIG, EventVerifier.Measurement.COUNT);
        uint256 credited =
            eventVerifier.verify(campaign, 0, user, 0, "", params);

        assertEq(credited, 0, "Should credit 0 for no deposits");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // EventVerifier::AMOUNT measurement tests
    // ─────────────────────────────────────────────────────────────────────────

    function test_AmountMeasurement_SingleDeposit() public {
        // Scenario: User deposited 1 WETH total, reporter claims 1 WETH
        uint256 wethAmount = 1 ether;
        oracle.setEventAmount(campaign, DEPOSIT_SIG, user, wethAmount);

        bytes memory params = abi.encode(DEPOSIT_SIG, EventVerifier.Measurement.AMOUNT);
        uint256 credited =
            eventVerifier.verify(campaign, 0, user, wethAmount, "", params);

        assertEq(credited, wethAmount, "Should credit 1 WETH");
    }

    function test_AmountMeasurement_MultipleDeposits() public {
        // Scenario: User made multiple deposits totaling 5 WETH, reporter claims 5 WETH
        uint256 totalWeth = 5 ether;
        oracle.setEventAmount(campaign, DEPOSIT_SIG, user, totalWeth);

        bytes memory params = abi.encode(DEPOSIT_SIG, EventVerifier.Measurement.AMOUNT);
        uint256 credited =
            eventVerifier.verify(campaign, 0, user, totalWeth, "", params);

        assertEq(credited, totalWeth, "Should credit 5 WETH");
    }

    function test_AmountMeasurement_OverreportClamped() public {
        // Scenario: Oracle verified 5 WETH, but reporter claims 100 WETH
        // Result: Verifier returns 5 WETH (min of verified vs reported)
        uint256 verifiedWeth = 5 ether;
        uint256 reportedWeth = 100 ether;
        oracle.setEventAmount(campaign, DEPOSIT_SIG, user, verifiedWeth);

        bytes memory params = abi.encode(DEPOSIT_SIG, EventVerifier.Measurement.AMOUNT);
        uint256 credited =
            eventVerifier.verify(campaign, 0, user, reportedWeth, "", params);

        assertEq(
            credited, verifiedWeth, "Should clamp to 5 WETH verified, not 100 WETH reported"
        );
    }

    function test_AmountMeasurement_UnderreportAccepted() public {
        // Scenario: Oracle verified 100 WETH, but reporter conservatively claims 25 WETH
        // Result: Verifier returns min(100, 25) = 25 WETH (accepts conservative report)
        uint256 verifiedWeth = 100 ether;
        uint256 reportedWeth = 25 ether;
        oracle.setEventAmount(campaign, DEPOSIT_SIG, user, verifiedWeth);

        bytes memory params = abi.encode(DEPOSIT_SIG, EventVerifier.Measurement.AMOUNT);
        uint256 credited =
            eventVerifier.verify(campaign, 0, user, reportedWeth, "", params);

        assertEq(credited, reportedWeth, "Should accept conservative report of 25 WETH");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // DepositVerifier (WETH-specific) tests
    // ─────────────────────────────────────────────────────────────────────────

    function test_DepositVerifier_SingleDeposit() public {
        // WETH: Deposit(address dst, uint256 wad)
        uint256 wethAmount = 1 ether;
        oracle.setEventAmount(campaign, DEPOSIT_SIG, user, wethAmount);

        uint256 credited = depositVerifier.verify(campaign, 0, user, wethAmount, "", "");

        assertEq(credited, wethAmount, "DepositVerifier should credit WETH amount");
    }

    function test_DepositVerifier_OverreportClamped() public {
        // User deposited 2 WETH, reporter claims 10 WETH
        uint256 actualWeth = 2 ether;
        uint256 reportedWeth = 10 ether;
        oracle.setEventAmount(campaign, DEPOSIT_SIG, user, actualWeth);

        uint256 credited = depositVerifier.verify(campaign, 0, user, reportedWeth, "", "");

        assertEq(credited, actualWeth, "Should clamp to actual 2 WETH");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // TransferVerifier tests (token transfers)
    // ─────────────────────────────────────────────────────────────────────────

    function test_TransferVerifier_WithDirection_TO() public {
        // Transfer(address from, address to, uint256 value)
        // Verify transfers TO the user
        uint256 usdcAmount = 1000e6; // 1000 USDC
        oracle.setEventAmount(campaign, keccak256("Transfer(address,address,uint256)"), user, usdcAmount);

        // TransferVerifier params: abi.encode(Direction.TO)
        bytes memory params = abi.encode(TransferVerifier.Direction.TO);
        uint256 credited = transferVerifier.verify(campaign, 0, user, usdcAmount, "", params);

        assertEq(credited, usdcAmount, "Should credit USDC transfer to user");
    }

    function test_TransferVerifier_WithDirection_FROM() public {
        // Verify transfers FROM the user
        uint256 usdcAmount = 500e6; // 500 USDC
        oracle.setEventAmount(campaign, keccak256("Transfer(address,address,uint256)"), user, usdcAmount);

        bytes memory params = abi.encode(TransferVerifier.Direction.FROM);
        uint256 credited = transferVerifier.verify(campaign, 0, user, usdcAmount, "", params);

        assertEq(credited, usdcAmount, "Should credit USDC transfer from user");
    }

    function test_TransferVerifier_DifferentTokens() public {
        // Verify transfers with min() logic across different reporting
        bytes32 transferSig = keccak256("Transfer(address,address,uint256)");
        uint256 actualTransferAmount = 1000e6;
        uint256 reportedTransferAmount = 500e6; // Conservative report

        oracle.setEventAmount(campaign, transferSig, user, actualTransferAmount);

        bytes memory params = abi.encode(TransferVerifier.Direction.EITHER);
        uint256 credited = transferVerifier.verify(campaign, 0, user, reportedTransferAmount, "", params);

        assertEq(credited, reportedTransferAmount, "Should accept conservative report");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Multi-user isolation tests
    // ─────────────────────────────────────────────────────────────────────────

    function test_MultiUser_Isolation() public {
        // Set different counts for different users
        oracle.setEventCount(campaign, DEPOSIT_SIG, user, 5);
        oracle.setEventCount(campaign, DEPOSIT_SIG, notUser, 10);

        bytes memory params = abi.encode(DEPOSIT_SIG, EventVerifier.Measurement.COUNT);

        uint256 userCredited = eventVerifier.verify(campaign, 0, user, 5, "", params);
        uint256 notUserCredited =
            eventVerifier.verify(campaign, 0, notUser, 10, "", params);

        assertEq(userCredited, 5, "User should get their own count");
        assertEq(notUserCredited, 10, "NotUser should get their own count");
    }

    function test_MultiUser_DifferentCampaigns() public {
        // Same user, different campaigns
        address campaign2 = address(0x5678);

        oracle.setEventCount(campaign, DEPOSIT_SIG, user, 3);
        oracle.setEventCount(campaign2, DEPOSIT_SIG, user, 7);

        bytes memory params = abi.encode(DEPOSIT_SIG, EventVerifier.Measurement.COUNT);

        uint256 campaign1Credit = eventVerifier.verify(campaign, 0, user, 3, "", params);
        uint256 campaign2Credit = eventVerifier.verify(campaign2, 0, user, 7, "", params);

        assertEq(campaign1Credit, 3, "Campaign1 should get 3");
        assertEq(campaign2Credit, 7, "Campaign2 should get 7");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Incremental reporting scenario (realistic flow)
    // ─────────────────────────────────────────────────────────────────────────

    function test_IncrementalReporting_FirstReport() public {
        // User makes 1 deposit
        oracle.setEventAmount(campaign, DEPOSIT_SIG, user, 1 ether);

        // Reporter reports cumulatively: newTotal = 1 ether
        bytes memory params = abi.encode(DEPOSIT_SIG, EventVerifier.Measurement.AMOUNT);
        uint256 credited = eventVerifier.verify(campaign, 0, user, 1 ether, "", params);

        assertEq(credited, 1 ether, "First report: credit 1 WETH");
    }

    function test_IncrementalReporting_SecondReport() public {
        // User now has made 2 total deposits (1 + 1)
        oracle.setEventAmount(campaign, DEPOSIT_SIG, user, 2 ether);

        // Campaign already credited 1 ether, reporter now claims newTotal = 2 ether
        // Verifier returns 2, campaign calculates delta = 2 - 1 = 1 ether new credit
        bytes memory params = abi.encode(DEPOSIT_SIG, EventVerifier.Measurement.AMOUNT);
        uint256 credited = eventVerifier.verify(campaign, 0, user, 2 ether, "", params);

        assertEq(credited, 2 ether, "Second report: verifier returns full 2 WETH");
        // (Campaign.sol subtracts the already-credited amount to get the delta)
    }

    function test_IncrementalReporting_FrontrunReport() public {
        // User makes only 1 deposit, but reporter lies and claims 5 WETH
        oracle.setEventAmount(campaign, DEPOSIT_SIG, user, 1 ether);

        // Reporter claims newTotal = 5 ether (lying)
        bytes memory params = abi.encode(DEPOSIT_SIG, EventVerifier.Measurement.AMOUNT);
        uint256 credited = eventVerifier.verify(campaign, 0, user, 5 ether, "", params);

        // Verifier clamps to verified 1 ether
        assertEq(credited, 1 ether, "Frontrun report clamped to 1 verified WETH");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Edge cases
    // ─────────────────────────────────────────────────────────────────────────

    function test_EdgeCase_ZeroReport() public {
        // Oracle has 5 events, but reporter claims 0
        // This is not an error; verifier returns min(5, 0) = 0
        // (Reporter is being extremely conservative, crediting nothing)
        oracle.setEventCount(campaign, DEPOSIT_SIG, user, 5);

        bytes memory params = abi.encode(DEPOSIT_SIG, EventVerifier.Measurement.COUNT);
        uint256 credited = eventVerifier.verify(campaign, 0, user, 0, "", params);

        assertEq(credited, 0, "Zero report should credit 0 (conservative)");
    }

    function test_EdgeCase_LargeAmount() public {
        // Test with large numbers (e.g., 1M USDC)
        uint256 largeAmount = 1_000_000e6;
        oracle.setEventAmount(campaign, DEPOSIT_SIG, user, largeAmount);

        bytes memory params = abi.encode(DEPOSIT_SIG, EventVerifier.Measurement.AMOUNT);
        uint256 credited = eventVerifier.verify(campaign, 0, user, largeAmount, "", params);

        assertEq(credited, largeAmount, "Should handle large amounts");
    }

    function test_EdgeCase_NoVerifiedEvents() public {
        // Oracle has no record, reporter claims something
        // Oracle returns 0 by default
        oracle.setEventCount(campaign, DEPOSIT_SIG, user, 0);

        bytes memory params = abi.encode(DEPOSIT_SIG, EventVerifier.Measurement.COUNT);
        uint256 credited = eventVerifier.verify(campaign, 0, user, 999, "", params);

        assertEq(credited, 0, "No verified events should credit 0");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Error cases
    // ─────────────────────────────────────────────────────────────────────────

    function test_Error_MissingOracle() public {
        vm.expectRevert(EventVerifier.MissingOracle.selector);
        new EventVerifier(address(0));
    }

    function test_Error_VerifiedLessThanReported_StillAccepted() public {
        // Oracle verified only 3 events, but reporter claims 5
        // This is NOT an error; verifier returns min(3, 5) = 3 (caps the overclaim)
        oracle.setEventCount(campaign, DEPOSIT_SIG, user, 3);

        bytes memory params = abi.encode(DEPOSIT_SIG, EventVerifier.Measurement.COUNT);
        uint256 credited = eventVerifier.verify(campaign, 0, user, 5, "", params);

        assertEq(credited, 3, "Overclaim capped to verified amount");
    }

    function test_Error_VerifiedMoreThanReported_StillAccepted() public {
        // Oracle verified 10 events, but reporter claims 3
        // This is NOT an error; verifier returns min(10, 3) = 3 (accepts conservative report)
        oracle.setEventAmount(campaign, DEPOSIT_SIG, user, 10 ether);

        bytes memory params = abi.encode(DEPOSIT_SIG, EventVerifier.Measurement.AMOUNT);
        uint256 credited = eventVerifier.verify(campaign, 0, user, 3 ether, "", params);

        assertEq(credited, 3 ether, "Conservative report accepted");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Integration scenario: Campaign + EventVerifier (semantic test)
    // ─────────────────────────────────────────────────────────────────────────

    function test_Scenario_CampaignIntegration() public {
        // This demonstrates how Campaign will use the new verifier semantics:
        //
        // 1. User makes a deposit → oracle observes 1 WETH
        // 2. Reporter submits: reportUserAction(kpiIndex, user, newTotal=1 ether)
        // 3. Campaign calls verifier.verify(..., newTotal=1 ether)
        // 4. Verifier returns 1 ether
        // 5. Campaign calculates delta = 1 - 0 = 1 ether (first time) and credits the promoter
        //
        // 6. User deposits again → oracle now sees 3 WETH total
        // 7. Reporter submits: reportUserAction(kpiIndex, user, newTotal=3 ether)
        // 8. Campaign calls verifier.verify(..., newTotal=3 ether)
        // 9. Verifier returns 3 ether
        // 10. Campaign calculates delta = 3 - 1 = 2 ether and credits the promoter

        uint256 alreadyCredited = 0;

        // First report
        oracle.setEventAmount(campaign, DEPOSIT_SIG, user, 1 ether);
        bytes memory params = abi.encode(DEPOSIT_SIG, EventVerifier.Measurement.AMOUNT);
        uint256 verifiedTotal = eventVerifier.verify(campaign, 0, user, 1 ether, "", params);
        uint256 delta = verifiedTotal - alreadyCredited;
        assertEq(delta, 1 ether, "First deposit: delta = 1 ether");
        alreadyCredited = verifiedTotal;

        // Second report
        oracle.setEventAmount(campaign, DEPOSIT_SIG, user, 3 ether);
        verifiedTotal = eventVerifier.verify(campaign, 0, user, 3 ether, "", params);
        delta = verifiedTotal - alreadyCredited;
        assertEq(delta, 2 ether, "Second deposit: delta = 2 ether");
    }

    function test_Scenario_FrontrunMitigated() public {
        // Demonstrates frontrun mitigation: attacker cannot cause artificial credit inflation
        //
        // Honest scenario:
        //   Actual deposits: 1 WETH
        //   Reporter (honest) submits: newTotal = 1 WETH
        //   Verifier confirms: 1 WETH
        //   Campaign credits: 1 WETH ✓
        //
        // Attack scenario:
        //   Actual deposits: 1 WETH (still)
        //   Reporter (attacker) submits: newTotal = 100 WETH (lying)
        //   Verifier clamps to: 1 WETH (verified)
        //   Campaign credits: 1 WETH (attack fails) ✓

        oracle.setEventAmount(campaign, DEPOSIT_SIG, user, 1 ether);
        bytes memory params = abi.encode(DEPOSIT_SIG, EventVerifier.Measurement.AMOUNT);

        // Honest report
        uint256 honest =
            eventVerifier.verify(campaign, 0, user, 1 ether, "", params);
        assertEq(honest, 1 ether);

        // Attack report
        uint256 attack =
            eventVerifier.verify(campaign, 0, user, 100 ether, "", params);
        assertEq(attack, 1 ether, "Attack report clamped to verified amount");

        // Both result in the same credit, so the attack does not inflate the outcome
    }
}
