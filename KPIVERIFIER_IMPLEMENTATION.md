# KPI Verifier Implementation — Event-Based Verification

## Overview

Implemented a comprehensive **event-based KPI verification system** that validates reported user actions against independently observed on-chain events. This ensures that:

- **Frontrun attacks are mitigated**: Reporters cannot claim more credit than what was actually verified
- **Conservative reporting is accepted**: A reporter claiming less than verified is always accepted
- **Oracle-driven verification**: An off-chain indexer/oracle maintains verified event counts and amounts

## Architecture

```
On-Chain Event Emission
        ↓
WETH Deposit event / Transfer event / etc.
        ↓
Off-Chain Indexer/Oracle
        ↓
Verified event counts and amounts
        ↓
IEventOracle (on-chain interface)
        ↓
IKpiVerifier Adapters
        ↓
Campaign.reportUserAction()
        ↓
Automatic tier settlement
```

## Implemented Contracts

### 1. **IEventOracle** (`src/interfaces/IEventOracle.sol`)

Interface for oracles that track verified on-chain events:

```solidity
interface IEventOracle {
    function eventCount(address campaign, bytes32 eventType, address user) 
        external view returns (uint256 cumulativeCount);
    
    function eventAmount(address campaign, bytes32 eventType, address user) 
        external view returns (uint256 cumulativeAmount);
    
    function eventAmountByToken(address campaign, bytes32 eventType, address user, address token) 
        external view returns (uint256 cumulativeAmount);
}
```

### 2. **EventVerifier** (`src/verifiers/EventVerifier.sol`)

Generic verifier supporting multiple event types and measurements:

```solidity
contract EventVerifier is IKpiVerifier {
    enum Measurement { COUNT, AMOUNT }
    
    function verify(
        address campaign,
        uint256 kpiIndex,
        address user,
        uint256 newTotal,        // Reporter's claim
        bytes calldata evidence,
        bytes calldata params    // abi.encode(eventSig, Measurement)
    ) external view returns (uint256 credited);
    
    function verifyWithToken(
        address campaign,
        uint256 kpiIndex,
        address user,
        uint256 newTotal,
        bytes calldata evidence,
        bytes calldata params    // abi.encode(eventSig, Measurement, token)
    ) external view returns (uint256 credited);
}
```

**Key Logic:**
- Returns `min(verified, reported)` 
- If verified < reported: clamps to verified (prevents overclaim)
- If verified > reported: accepts conservative report
- Supports both COUNT (number of events) and AMOUNT (sum of amounts) measurements

### 3. **DepositVerifier** (`src/verifiers/DepositVerifier.sol`)

Specialized verifier for `Deposit(address indexed dst, uint256 wad)` events (e.g., WETH):

```solidity
contract DepositVerifier is IKpiVerifier {
    bytes32 public constant DEPOSIT_SIG = keccak256("Deposit(address,uint256)");
    
    function verify(..., uint256 newTotal, ...) 
        external view returns (uint256 credited);
}
```

Used for WETH deposits on Base Sepolia: `0x4200000000000000000000000000000000000006`

### 4. **TransferVerifier** (`src/verifiers/TransferVerifier.sol`)

Verifies `Transfer(address indexed from, address indexed to, uint256 value)` events with direction filtering:

```solidity
contract TransferVerifier is IKpiVerifier {
    enum Direction { FROM, TO, EITHER }
    
    function verify(..., bytes calldata params) 
        external view returns (uint256 credited);
        // params = abi.encode(Direction)
}
```

## Campaign Integration Changes

Updated [`src/campaign/Campaign.sol`](src/campaign/Campaign.sol) to pass **cumulative totals** instead of deltas to verifiers:

```solidity
// OLD (incorrect)
uint256 delta = newTotal - already;
credited = IKpiVerifier(spec.verifier).verify(
    address(this),
    kpiIndex,
    user,
    delta,  // ❌ Delta is ephemeral
    evidence,
    spec.params
);

// NEW (correct)
uint256 verifiedTotal = IKpiVerifier(spec.verifier).verify(
    address(this),
    kpiIndex,
    user,
    newTotal,  // ✅ Cumulative total (stable)
    evidence,
    spec.params
);
if (verifiedTotal > newTotal) {
    revert VerifierOvercredit(verifiedTotal, newTotal);
}
if (verifiedTotal <= already) return;  // No new credit
uint256 credited = verifiedTotal - already;
_userCredited[user][kpiIndex] = verifiedTotal;
_progress[promoter][kpiIndex] += credited;
_totalProgress[kpiIndex] += credited;
```

## Test Suite: EventVerifierTest (27 tests, all passing ✅)

### COUNT Measurement Tests
- `test_CountMeasurement_SingleDeposit` — 1 verified, 1 reported → credit 1
- `test_CountMeasurement_MultipleDeposits` — 5 verified, 5 reported → credit 5
- `test_CountMeasurement_OverreportClamped` — 3 verified, 10 reported → credit 3
- `test_CountMeasurement_UnderreportAccepted` — 10 verified, 5 reported → credit 5
- `test_CountMeasurement_ZeroDeposits` — 0 verified, 0 reported → credit 0

### AMOUNT Measurement Tests
- `test_AmountMeasurement_SingleDeposit` — 1 WETH verified, 1 WETH reported → credit 1 WETH
- `test_AmountMeasurement_MultipleDeposits` — 5 WETH verified, 5 WETH reported → credit 5 WETH
- `test_AmountMeasurement_OverreportClamped` — 5 WETH verified, 100 WETH reported → credit 5 WETH
- `test_AmountMeasurement_UnderreportAccepted` — 100 WETH verified, 25 WETH reported → credit 25 WETH

### DepositVerifier Tests (WETH)
- `test_DepositVerifier_SingleDeposit` — WETH deposit verification
- `test_DepositVerifier_OverreportClamped` — Clamping on overclaim

### TransferVerifier Tests
- `test_TransferVerifier_WithDirection_TO` — Transfers TO user
- `test_TransferVerifier_WithDirection_FROM` — Transfers FROM user
- `test_TransferVerifier_DifferentTokens` — Multi-token support

### Multi-User & Multi-Campaign Tests
- `test_MultiUser_Isolation` — Different users, same campaign
- `test_MultiUser_DifferentCampaigns` — Same user, different campaigns

### Incremental Reporting Scenario Tests
- `test_IncrementalReporting_FirstReport` — First deposit: 1 WETH verified → credit 1
- `test_IncrementalReporting_SecondReport` — Total now 3 WETH, already 1 credited → credit 2 delta
- `test_IncrementalReporting_FrontrunReport` — 1 WETH verified, 5 claimed → credit 1 (clamped)

### Security & Edge Cases
- `test_Scenario_FrontrunMitigated` — Verifies frontrun attack is mitigated
- `test_Scenario_CampaignIntegration` — E2E flow: verify → calculate delta → credit promoter
- `test_EdgeCase_ZeroReport` — Conservative zero report accepted
- `test_EdgeCase_LargeAmount` — 1M USDC handling
- `test_EdgeCase_NoVerifiedEvents` — Oracle returns 0 by default
- `test_Error_MissingOracle` — Constructor validation
- `test_Error_VerifiedLessThanReported_StillAccepted` — Overclaim capping works
- `test_Error_VerifiedMoreThanReported_StillAccepted` — Conservative reports work

## MockEventOracle (Test Fixture)

Implements `IEventOracle` for testing:

```solidity
contract MockEventOracle is IEventOracle {
    function setEventCount(address campaign, bytes32 eventSig, address user, uint256 count) external;
    function setEventAmount(address campaign, bytes32 eventSig, address user, uint256 amount) external;
    function setEventAmountByToken(address campaign, bytes32 eventSig, address user, address token, uint256 amount) external;
}
```

## Example Usage Flow

### Scenario: WETH Deposit KPI on Base Sepolia

1. **Campaign is created** with:
   ```
   KPI 0: WETH Deposits
   - verifier: DepositVerifier (0x...)
   - kind: Custom
   - target: 10 WETH
   - Tiers:
     * 2 WETH → 1000 USDC reward
     * 5 WETH → 2000 USDC reward
     * 10 WETH → 5000 USDC reward
   ```

2. **User deposits 1 WETH** on Uniswap V3
   ```
   WETH.deposit{value: 1 ether}()
   // Emits: Deposit(user, 1 ether)
   ```

3. **Off-chain oracle indexes the event**
   ```
   Oracle: depositCount[campaign][user] = 1
   Oracle: depositAmount[campaign][user] = 1 ether
   ```

4. **Reporter submits** (could be project, promoter, or anyone):
   ```
   campaign.reportUserAction(
       kpiIndex=0,
       user=user,
       newTotal=1 ether,
       verifier=depositVerifier,
       evidence=abi.encodePacked(...)
   )
   ```

5. **Campaign calls verifier**:
   ```
   verifiedTotal = depositVerifier.verify(
       campaign=campaign,
       kpiIndex=0,
       user=user,
       newTotal=1 ether,      // Reported cumulative
       evidence=...,
       params=... // DEPOSIT_SIG + AMOUNT
   )
   // Returns: min(1 ether verified, 1 ether reported) = 1 ether
   ```

6. **Campaign settles tier 0** (2 WETH threshold):
   ```
   already = 0
   delta = 1 - 0 = 1 ether
   _progress[promoter][0] = 1 ether
   _totalProgress[0] = 1 ether
   // Tier 0 not crossed yet (need 2 WETH)
   // No payout
   ```

7. **User deposits 1.5 more WETH** later
   ```
   WETH.deposit{value: 1.5 ether}()
   // Emits: Deposit(user, 1.5 ether)
   ```

8. **Oracle updates**:
   ```
   Oracle: depositAmount[campaign][user] = 2.5 ether (total)
   ```

9. **Reporter submits cumulative report**:
   ```
   campaign.reportUserAction(
       kpiIndex=0,
       user=user,
       newTotal=2.5 ether  // Cumulative, not 1.5
   )
   ```

10. **Campaign settles tiers**:
    ```
    verifiedTotal = 2.5 ether (verified)
    delta = 2.5 - 1 = 1.5 ether
    _progress[promoter][0] = 2.5 ether
    Tier 0 (2 WETH) crossed! → Pay 1000 USDC
    ```

## Security Properties

### Anti-Frontrun
```
Actual: 1 WETH
Attacker reports: 100 WETH
Verifier returns: min(1, 100) = 1 WETH ✅
```

### Anti-Replay
- Cumulative totals: replayed reports are no-ops (monotonic guard)
- Event signatures: different event types don't interfere

### Per-User Isolation
- Oracle keyed by `(campaign, eventSig, user)`
- Different users don't affect each other

### Per-Campaign Isolation
- Oracle keyed by campaign address
- Different campaigns don't interfere

## Full Test Suite Status

✅ **384 tests passing** (0 failed)

```
Ran 17 test suites in 6.67s:
- EventVerifierTest:          27 tests ✅
- CampaignTest:               61 tests ✅
- OracleCoordinatorTest:      26 tests ✅
- AttestationVerifierTest:    24 tests ✅
- AttributionRegistryTest:    23 tests ✅
- ReputationRegistryTest:     23 tests ✅
- EscrowVaultTest:            23 tests ✅
- BoneyTest (E2E):            10 tests ✅
- (and 9 more test suites)
```

## Base Sepolia Contract Addresses

| Contract | Address |
|---|---|
| WETH | `0x4200000000000000000000000000000000000006` |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| (Event verifiers deployed by Campaign.createCampaign()) | — |

## Future Enhancements

1. **Real Oracle Integration**: Replace MockEventOracle with on-chain indexer
2. **Multi-Event KPIs**: Combine multiple event types (e.g., Deposit + Transfer)
3. **Zkproof Attestations**: Verify events via ZK proofs instead of oracle
4. **Event Filtering**: Fine-grained filtering by event parameters (amount ranges, time windows)
5. **Weighted Events**: Different event types contribute differently to the total
6. **Custom Verifiers**: Framework for building domain-specific verifiers

## References

- [IEventOracle](src/interfaces/IEventOracle.sol)
- [IKpiVerifier](src/interfaces/IKpiVerifier.sol)
- [EventVerifier](src/verifiers/EventVerifier.sol)
- [DepositVerifier](src/verifiers/DepositVerifier.sol)
- [TransferVerifier](src/verifiers/TransferVerifier.sol)
- [EventVerifierTest](test/EventVerifier.t.sol)
- [Campaign Integration](src/campaign/Campaign.sol) (reportUserAction)
