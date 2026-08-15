# KPI Verifier Integration — Web Frontend Guide

## Overview

The Boney web frontend now supports **event-based KPI verifiers** that validate reported user actions against independently observed on-chain events.

This document covers:
1. **Available verifiers** and how to configure them
2. **Helper utilities** for creating KPI specs
3. **Integration patterns** for campaign creation
4. **Example usage** on Base Sepolia

## Architecture

```
┌─────────────────────────────┐
│   Web Frontend              │
│  Campaign Creation Form     │
└──────────────┬──────────────┘
               │
               ├─ createDepositKpi()
               ├─ createTransferKpi()
               └─ createEventKpi()
               │
               ▼
┌─────────────────────────────┐
│   KpiSpec                   │
│  - kind: "Custom"           │
│  - verifier: address        │
│  - target: bigint           │
│  - params: encoded          │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│   Campaign Contract         │
│   reportUserAction()        │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│   Verifier (EventVerifier   │
│   DepositVerifier, etc.)    │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│   Oracle / Indexer          │
│   Verified events & amounts │
└─────────────────────────────┘
```

## Available Verifiers

### 1. EventVerifier (Generic)

**Contract:** `EventVerifier.sol`

**Purpose:** Validates any on-chain event against an oracle's verified event counts or cumulative amounts.

**Supports:**
- COUNT measurement: each event contributes 1
- AMOUNT measurement: each event contributes its amount field
- Multi-token filtering via `eventAmountByToken()`

**Example event signatures:**
- Deposit: `0x6fc1c4e87bc337ca3df86b8a8711bd307435f7d5cf51147ceaefd309a07e6799`
- Transfer: `0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef`
- Swap: `0xc42079f94a6350d7e6235f29174924f7e02632f38b15ea856481f98a62eca1d4`

### 2. DepositVerifier (WETH-Specific)

**Contract:** `DepositVerifier.sol`

**Purpose:** Specialized verifier for `Deposit(address indexed dst, uint256 wad)` events.

**Use case:** WETH deposits on Base Sepolia (`0x4200000000000000000000000000000000000006`)

**Key property:** Supports AMOUNT measurement only (measures cumulative WETH deposited).

### 3. TransferVerifier (ERC20 Transfers)

**Contract:** `TransferVerifier.sol`

**Purpose:** Verifies `Transfer(address indexed from, address indexed to, uint256 value)` events with directional filtering.

**Directions:**
- `FROM` (0): User is the sender
- `TO` (1): User is the recipient
- `EITHER` (2): User is sender or recipient

## Helper Utilities

Located in [`src/lib/kpiVerifiers.ts`](src/lib/kpiVerifiers.ts):

### Creating KPI Specs

#### `createDepositKpi(verifierAddress, target, measurement?)`

Creates a KPI spec for Deposit events:

```typescript
import { createDepositKpi, VerifierMeasurement } from '@/lib/kpiVerifiers';

const kpi = createDepositKpi(
  '0x1234...', // DepositVerifier address
  parseUnits('5', 18), // Target: 5 WETH
  VerifierMeasurement.AMOUNT // Measure cumulative amounts
);
```

#### `createTransferKpi(verifierAddress, target, direction?)`

Creates a KPI spec for Transfer events:

```typescript
import { createTransferKpi, TransferDirection } from '@/lib/kpiVerifiers';

const kpi = createTransferKpi(
  '0x5678...', // TransferVerifier address
  parseUnits('1000', 6), // Target: 1000 USDC
  TransferDirection.FROM // Measure outgoing transfers
);
```

#### `createEventKpi(verifierAddress, eventSignature, target, measurement?)`

Creates a KPI spec for any custom event:

```typescript
import { createEventKpi, EVENT_SIGNATURES, VerifierMeasurement } from '@/lib/kpiVerifiers';

const kpi = createEventKpi(
  '0x9abc...', // EventVerifier address
  EVENT_SIGNATURES.SWAP, // Uniswap V3 Swap events
  parseUnits('100000', 18), // Target: 100k token swapped
  VerifierMeasurement.AMOUNT
);
```

### Constants

#### `EVENT_SIGNATURES`

Precomputed keccak256 hashes for common event types:

```typescript
import { EVENT_SIGNATURES } from '@/lib/kpiVerifiers';

EVENT_SIGNATURES.DEPOSIT     // Deposit(address,uint256)
EVENT_SIGNATURES.WITHDRAWAL  // Withdrawal(address,uint256)
EVENT_SIGNATURES.TRANSFER    // Transfer(address,address,uint256)
EVENT_SIGNATURES.APPROVAL    // Approve(address,address,uint256)
EVENT_SIGNATURES.SWAP        // Swap(address,int256,int256,...)
EVENT_SIGNATURES.MINT        // Mint(address,uint256)
EVENT_SIGNATURES.BURN        // Burn(address,uint256)
```

#### `VERIFIER_PRESETS`

Deployed verifier addresses by chain:

```typescript
import { VERIFIER_PRESETS } from '@/lib/kpiVerifiers';

const baseSepoliaVerifiers = VERIFIER_PRESETS[84532];
baseSepoliaVerifiers.depositWeth.address  // WETH DepositVerifier
baseSepoliaVerifiers.transfer.address     // TransferVerifier
```

### Encoding Functions

#### `encodeEventVerifierParams(eventSignature, measurement)`

Manually encode parameters for EventVerifier:

```typescript
const params = encodeEventVerifierParams(
  EVENT_SIGNATURES.TRANSFER,
  VerifierMeasurement.AMOUNT
);
// Returns: 0x<32-byte event sig><64-bit measurement>
```

#### `encodeTransferVerifierParams(direction)`

Manually encode parameters for TransferVerifier:

```typescript
const params = encodeTransferVerifierParams(TransferDirection.FROM);
// Returns: 0x<64-bit direction index>
```

## Integration Patterns

### Pattern 1: Campaign Creation with Deposit KPI

```typescript
import { createDepositKpi } from '@/lib/kpiVerifiers';
import { parseUnits } from 'viem';

// In your campaign creation form handler:
async function createCampaignWithDepositKpi(
  projectAddress: `0x${string}`,
  campaignName: string,
  rewardToken: `0x${string}`,
  rewardPool: bigint,
  depositVerifierAddress: `0x${string}`,
  startTime: bigint,
  endTime: bigint
) {
  // Create a KPI: users must deposit 10 WETH
  const depositKpi = createDepositKpi(
    depositVerifierAddress,
    parseUnits('10', 18)
  );

  // Create reward tiers
  const tiers = [
    { threshold: parseUnits('2', 18), reward: parseUnits('1000', 6) },  // 1000 USDC at 2 WETH
    { threshold: parseUnits('5', 18), reward: parseUnits('2500', 6) },  // 2500 USDC at 5 WETH
    { threshold: parseUnits('10', 18), reward: parseUnits('5000', 6) }, // 5000 USDC at 10 WETH
  ];

  // Call the contract to create campaign
  const tx = await client.writeContract({
    address: boneyAddress,
    abi: BoneyAbi,
    functionName: 'createCampaign',
    args: [
      {
        project: projectAddress,
        name: campaignName,
        token: rewardToken,
        rewardPool,
        startTime,
        endTime,
        attributionWindow: BigInt(7 * 24 * 60 * 60), // 7 days
        minReputation: BigInt(0),
      },
      [depositKpi], // KPIs
      [tiers],      // Tiers per KPI
    ],
  });

  return tx.hash;
}
```

### Pattern 2: Campaign Creation with Multiple KPIs

```typescript
import { createDepositKpi, createTransferKpi } from '@/lib/kpiVerifiers';
import { parseUnits } from 'viem';

async function createMultiKpiCampaign(/* ... */) {
  const kpis = [
    // KPI 0: Users must deposit 5 WETH
    createDepositKpi(
      depositVerifierAddress,
      parseUnits('5', 18)
    ),
    
    // KPI 1: Users must transfer 1000 USDC
    createTransferKpi(
      transferVerifierAddress,
      parseUnits('1000', 6),
      TransferDirection.FROM
    ),
  ];

  const tiers = [
    // Tiers for KPI 0 (Deposits)
    [
      { threshold: parseUnits('2', 18), reward: parseUnits('1000', 6) },
      { threshold: parseUnits('5', 18), reward: parseUnits('2000', 6) },
    ],
    
    // Tiers for KPI 1 (Transfers)
    [
      { threshold: parseUnits('500', 6), reward: parseUnits('500', 6) },
      { threshold: parseUnits('1000', 6), reward: parseUnits('1500', 6) },
    ],
  ];

  // ... write contract call
}
```

### Pattern 3: Displaying Verifier Information

```typescript
import { describeKpi } from '@/lib/kpiVerifiers';
import type { KpiSpec } from '@/lib/types';

function KpiDisplay({ kpi }: { kpi: KpiSpec }) {
  return (
    <div>
      <h3>{describeKpi(kpi)}</h3>
      <p>Verifier: {kpi.verifier}</p>
      <p>Target: {kpi.target.toString()}</p>
      <p>Measurement: {kpi.aggregate ? 'Aggregate' : 'Per-User'}</p>
    </div>
  );
}
```

## Base Sepolia Example

### Step 1: Deploy Verifiers

```bash
# In the protocol root
PRIVATE_KEY=0x... \
  forge script script/DeployBoney.s.sol:DeployBoney \
  --rpc-url https://sepolia.base.org \
  --broadcast
```

### Step 2: Update Web Configuration

```typescript
// web/src/lib/kpiVerifiers.ts
export const VERIFIER_PRESETS: Record<...> = {
  84532: {
    depositWeth: {
      address: "0x<DepositVerifier address from deploy>",
      name: "WETH Deposits",
      description: "...",
    },
    transfer: {
      address: "0x<TransferVerifier address from deploy>",
      name: "Token Transfers",
      description: "...",
    },
  },
  // ...
};
```

### Step 3: Use in Campaign Form

```typescript
import { VERIFIER_PRESETS } from '@/lib/kpiVerifiers';
import { useChainId } from 'wagmi';

function CampaignForm() {
  const chainId = useChainId();
  const verifiers = VERIFIER_PRESETS[chainId];
  
  if (!verifiers) {
    return <p>Verifiers not deployed on this chain</p>;
  }
  
  return (
    <form>
      <select name="verifier">
        <option value={verifiers.depositWeth.address}>
          {verifiers.depositWeth.name}
        </option>
        <option value={verifiers.transfer.address}>
          {verifiers.transfer.name}
        </option>
      </select>
      {/* ... rest of form */}
    </form>
  );
}
```

## Security Considerations

### Verifier Selection

- ✅ Always use a known, audited verifier address
- ❌ Never accept arbitrary verifier addresses from user input
- ✅ Pin verifier addresses in your frontend config

### Event Signature Validation

- ✅ Use the `EVENT_SIGNATURES` constants
- ✅ Verify event signatures against the actual contract ABI
- ❌ Never hard-code event signatures without double-checking

### Oracle Integrity

The verifier system depends on an off-chain oracle/indexer to provide verified event counts. Ensure:

1. **Oracle trustworthiness**: Use a staked, slashable oracle (e.g., OracleCoordinator)
2. **Event indexing**: Verify the indexer correctly processes events
3. **Replay protection**: The campaign enforces monotonic totals (no replaying old reports)

## Testing

### Unit Tests

Event verifiers are tested comprehensively in the protocol:

```bash
cd /home/ebby/boney
forge test --mc EventVerifierTest
```

**27 tests covering:**
- COUNT and AMOUNT measurements
- Overclaim clamping
- Conservative reporting
- Multi-user isolation
- Incremental reporting
- Frontrun attack mitigation

### Integration Tests

To test the full flow (create campaign → fund → report → settle):

1. Deploy verifiers to a test chain
2. Create a campaign with verifier KPI
3. Mock oracle data via `MockEventOracle`
4. Call `reportUserAction()` and verify tier settlement

Example test structure:

```typescript
import { MockEventOracle } from '@/test/mocks';
import { createDepositKpi } from '@/lib/kpiVerifiers';

describe('Campaign with EventVerifier', () => {
  it('should credit promoters based on verified events', async () => {
    // 1. Deploy campaign with EventVerifier KPI
    // 2. Mock oracle to return 5 WETH deposits
    // 3. Report cumulative 5 WETH via campaign
    // 4. Verify promoter credited for tier crossing
  });
});
```

## Generated ABIs

The following ABI files are auto-generated from compiled contracts:

- `src/lib/abis/EventVerifier.ts` (9 entries)
- `src/lib/abis/DepositVerifier.ts` (6 entries)
- `src/lib/abis/TransferVerifier.ts` (7 entries)

To regenerate after contract changes:

```bash
cd web
pnpm abis
```

## Further Reading

- **Protocol architecture:** [README.md](../../README.md)
- **KPI verifier implementation:** [KPIVERIFIER_IMPLEMENTATION.md](../../KPIVERIFIER_IMPLEMENTATION.md)
- **Test suite:** [test/EventVerifier.t.sol](../../test/EventVerifier.t.sol)
- **Verifier contracts:**
  - [src/verifiers/EventVerifier.sol](../../src/verifiers/EventVerifier.sol)
  - [src/verifiers/DepositVerifier.sol](../../src/verifiers/DepositVerifier.sol)
  - [src/verifiers/TransferVerifier.sol](../../src/verifiers/TransferVerifier.sol)

## Quick Reference

| Task | Function |
|---|---|
| Create Deposit KPI | `createDepositKpi(addr, target)` |
| Create Transfer KPI | `createTransferKpi(addr, target, direction)` |
| Create Custom KPI | `createEventKpi(addr, eventSig, target, measurement)` |
| Get event signature | `EVENT_SIGNATURES.<TYPE>` |
| Get deployed verifier | `VERIFIER_PRESETS[chainId].<name>.address` |
| Describe KPI | `describeKpi(kpi)` |
| Encode EventVerifier params | `encodeEventVerifierParams(sig, measurement)` |
| Encode TransferVerifier params | `encodeTransferVerifierParams(direction)` |
