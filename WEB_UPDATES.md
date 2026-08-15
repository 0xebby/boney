# Web Frontend Updates — KPI Verifier Integration

**Date:** 2026-08-15  
**Status:** ✅ Complete — 27 tests passing, web build successful

## Summary

Updated the Boney web frontend to support the new **event-based KPI verifier system**. This enables campaigns to validate reported user actions against independently observed on-chain events.

## Files Modified

### 1. **web/scripts/extract-abis.ts**
   - **Change:** Added three new verifier contracts to the ABI extraction list
   - **Contracts added:**
     - `EventVerifier` — Generic event verification
     - `DepositVerifier` — WETH Deposit specialization  
     - `TransferVerifier` — ERC20 Transfer verification
   - **Impact:** ABIs are now auto-generated from compiled contracts

### 2. **web/src/lib/abis/** (Generated)
   - **New files:**
     - `EventVerifier.ts` (9 ABI entries)
     - `DepositVerifier.ts` (6 ABI entries)
     - `TransferVerifier.ts` (7 ABI entries)
   - **Updated:** `index.ts` now exports all three verifier ABIs
   - **Auto-generated:** Run `pnpm abis` to regenerate after contract changes

### 3. **web/src/lib/kpiVerifiers.ts** (New)
   - **Purpose:** Utility module for KPI verifier configuration
   - **Exports:**
     - `VERIFIER_PRESETS` — Deployed verifier addresses by chain
     - `EVENT_SIGNATURES` — Precomputed keccak256 hashes
     - `VerifierMeasurement` — Enum (COUNT=0, AMOUNT=1)
     - `TransferDirection` — Enum (FROM=0, TO=1, EITHER=2)
     - `createDepositKpi()` — Helper for Deposit KPIs
     - `createTransferKpi()` — Helper for Transfer KPIs
     - `createEventKpi()` — Generic event KPI helper
     - `encodeEventVerifierParams()` — Manual parameter encoding
     - `encodeTransferVerifierParams()` — Manual parameter encoding
     - `describeKpi()` — Human-readable KPI descriptions

### 4. **web/KPI_VERIFIERS.md** (New)
   - **Purpose:** Developer guide for KPI verifier integration
   - **Contents:**
     - Architecture overview
     - Available verifiers and their use cases
     - Helper utility reference with examples
     - Integration patterns (single KPI, multi-KPI)
     - Base Sepolia deployment guide
     - Security considerations
     - Testing guidelines
     - Quick reference table

## Generated Files

```
web/src/lib/abis/
├── EventVerifier.ts          (Generated)
├── DepositVerifier.ts        (Generated)
├── TransferVerifier.ts       (Generated)
└── index.ts                  (Updated with exports)

web/src/lib/
├── kpiVerifiers.ts           (New utility module)
└── types.ts                  (Unchanged)

web/
└── KPI_VERIFIERS.md          (New developer guide)
```

## Verification

✅ **ABI Extraction:**
```bash
$ pnpm abis
  EventVerifier              9 entries
  DepositVerifier            6 entries
  TransferVerifier           7 entries
  Wrote 13 ABIs to src/lib/abis/
```

✅ **Build:**
```bash
$ pnpm build
✓ Compiled successfully in 45s
✓ Generated 10 static pages
```

✅ **Exports:**
```typescript
// All new ABIs and utilities are properly exported and typed
import { EventVerifierAbi, DepositVerifierAbi, TransferVerifierAbi } from '@/lib/abis';
import { createDepositKpi, createTransferKpi, EVENT_SIGNATURES } from '@/lib/kpiVerifiers';
```

## Usage Examples

### Creating a Deposit KPI Campaign

```typescript
import { createDepositKpi } from '@/lib/kpiVerifiers';
import { parseUnits } from 'viem';

const kpi = createDepositKpi(
  '0x1234...', // DepositVerifier address
  parseUnits('10', 18) // Target: 10 WETH
);

// Use in campaign creation
const tx = await client.writeContract({
  address: boneyAddress,
  abi: BoneyAbi,
  functionName: 'createCampaign',
  args: [config, [kpi], [tiers]],
});
```

### Creating a Transfer KPI Campaign

```typescript
import { createTransferKpi, TransferDirection } from '@/lib/kpiVerifiers';

const kpi = createTransferKpi(
  '0x5678...', // TransferVerifier address
  parseUnits('1000', 6), // Target: 1000 USDC
  TransferDirection.FROM // Measure outgoing transfers
);
```

### Using Pre-configured Verifier Addresses

```typescript
import { VERIFIER_PRESETS } from '@/lib/kpiVerifiers';
import { useChainId } from 'wagmi';

const chainId = useChainId();
const verifiers = VERIFIER_PRESETS[chainId];

if (verifiers) {
  const depositVerifier = verifiers.depositWeth.address;
  const transferVerifier = verifiers.transfer.address;
}
```

## Configuration

### For Base Sepolia

Update `web/src/lib/kpiVerifiers.ts` with deployed verifier addresses:

```typescript
84532: {
  depositWeth: {
    address: "0x...", // DepositVerifier on Base Sepolia
    name: "WETH Deposits",
    description: "Verifies Deposit events from WETH contract",
  },
  transfer: {
    address: "0x...", // TransferVerifier on Base Sepolia
    name: "Token Transfers",
    description: "Verifies Transfer events",
  },
}
```

### For Local Anvil

```typescript
31337: {
  depositWeth: {
    address: "0x...", // DepositVerifier on local chain
    // ...
  },
  // ...
}
```

## Breaking Changes

✅ **None.** All changes are additive:
- New ABI files don't affect existing contracts
- New utility module is optional
- No changes to existing types or functions
- Backward compatible with existing campaign creation

## Integration Checklist

- [x] Extract verifier contract ABIs
- [x] Create kpiVerifiers utility module
- [x] Add helper functions for KPI creation
- [x] Export verifier ABIs and utilities
- [x] Write developer documentation
- [x] Verify web build succeeds
- [x] Add type definitions
- [ ] Deploy verifiers to Base Sepolia (manual)
- [ ] Update VERIFIER_PRESETS with deployed addresses (manual)
- [ ] Update campaign creation form to use helpers (manual)

## Next Steps

1. **Deploy verifiers:** Run protocol deployment scripts
2. **Update preset addresses:** Add deployed verifier addresses to `VERIFIER_PRESETS`
3. **Update campaign form:** Integrate helper functions into create campaign UI
4. **Test end-to-end:** Verify campaign creation, reporting, and tier settlement

## Documentation

For detailed guidance on using the KPI verifier system, see:
- **[KPI_VERIFIERS.md](web/KPI_VERIFIERS.md)** — Complete developer guide
- **[KPIVERIFIER_IMPLEMENTATION.md](KPIVERIFIER_IMPLEMENTATION.md)** — Protocol implementation details
- **[test/EventVerifier.t.sol](test/EventVerifier.t.sol)** — Comprehensive test suite (27 tests)

## Testing

All protocol tests continue to pass:

```
$ forge test
384 tests passing
  - EventVerifierTest:       27 tests ✅
  - CampaignTest:            61 tests ✅
  - (11 other suites)
```

Web tests and build verification successful.

---

**Status Summary:**
- ✅ Smart contracts: 384/384 tests passing
- ✅ Web build: Successful, no errors
- ✅ ABIs: Generated and exported
- ✅ Utilities: Implemented with examples
- ✅ Documentation: Complete
- 📋 Deployment: Pending (manual step)
