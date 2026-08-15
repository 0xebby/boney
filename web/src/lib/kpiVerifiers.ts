/**
 * KPI Verifier configuration and utilities.
 *
 * Helpers for creating KPI specifications with event-based verifiers.
 * Each verifier validates reported user actions against independently observed on-chain events.
 */

import type {KpiSpec} from "./types";

/** Presets for common KPI verifiers deployed on various chains. */
export const VERIFIER_PRESETS: Record<
  string,
  Record<string, {address: `0x${string}`; name: string; description: string}>
> = {
  // Base Sepolia deployed verifiers (example)
  84532: {
    depositWeth: {
      address: "0x0000000000000000000000000000000000000000", // Replace with actual deployed address
      name: "WETH Deposits",
      description: "Verifies Deposit(address indexed dst, uint256 wad) events from WETH contract",
    },
    transfer: {
      address: "0x0000000000000000000000000000000000000000", // Replace with actual deployed address
      name: "Token Transfers",
      description: "Verifies Transfer(address indexed from, address indexed to, uint256 value) events",
    },
  },
  // Local Anvil deployment
  31337: {
    depositWeth: {
      address: "0x0000000000000000000000000000000000000000", // Replace with actual deployed address
      name: "WETH Deposits",
      description: "Verifies Deposit(address indexed dst, uint256 wad) events from WETH contract",
    },
    transfer: {
      address: "0x0000000000000000000000000000000000000000", // Replace with actual deployed address
      name: "Token Transfers",
      description: "Verifies Transfer(address indexed from, address indexed to, uint256 value) events",
    },
  },
};

/** Event signature constants for common events. */
export const EVENT_SIGNATURES = {
  // WETH
  DEPOSIT: "0x6fc1c4e87bc337ca3df86b8a8711bd307435f7d5cf51147ceaefd309a07e6799", // keccak256("Deposit(address,uint256)")
  WITHDRAWAL: "0x7fcf532c15f0a6db0bd6d0e038bfa482c3bfa8f3456341aafb9d97a5282541e0", // keccak256("Withdrawal(address,uint256)")
  
  // ERC20
  TRANSFER: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", // keccak256("Transfer(address,address,uint256)")
  APPROVAL: "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925", // keccak256("Approve(address,address,uint256)")

  // Uniswap V3
  SWAP: "0xc42079f94a6350d7e6235f29174924f7e02632f38b15ea856481f98a62eca1d4", // keccak256("Swap(address,int256,int256,uint160,uint128,int24)")

  // Generic
  MINT: "0x0f6798a560793a54c3bcfe86a93cde1e73087d944c0ea20544137d4121396885", // keccak256("Mint(address,uint256)")
  BURN: "0xcc16f5dbb4873280815c1ee09dbd06736cffcc184412cf7a19a60a82b4331384", // keccak256("Burn(address,uint256)")
} as const;

/** Measurement types for event verifiers. */
export enum VerifierMeasurement {
  COUNT = 0,    // Each event contributes 1
  AMOUNT = 1,   // Each event contributes its amount field
}

/** Direction types for Transfer verifiers. */
export enum TransferDirection {
  FROM = 0,     // User is the sender
  TO = 1,       // User is the recipient
  EITHER = 2,   // User is sender or recipient
}

/**
 * Create a KPI spec for a Deposit event (e.g., WETH).
 *
 * @param verifierAddress The address of a DepositVerifier contract
 * @param target The target amount or count
 * @param measurement COUNT or AMOUNT
 * @returns A KpiSpec ready to be used in campaign configuration
 */
export function createDepositKpi(
  verifierAddress: `0x${string}`,
  target: bigint,
  measurement: VerifierMeasurement = VerifierMeasurement.AMOUNT,
): KpiSpec {
  const params = encodeEventVerifierParams(EVENT_SIGNATURES.DEPOSIT, measurement);
  return {
    kind: "Custom",
    verifier: verifierAddress,
    target,
    aggregate: false,
    params,
  };
}

/**
 * Create a KPI spec for a Transfer event (e.g., ERC20 token transfers).
 *
 * @param verifierAddress The address of a TransferVerifier contract
 * @param target The target amount or count
 * @param direction FROM, TO, or EITHER
 * @returns A KpiSpec ready to be used in campaign configuration
 */
export function createTransferKpi(
  verifierAddress: `0x${string}`,
  target: bigint,
  direction: TransferDirection = TransferDirection.FROM,
): KpiSpec {
  const params = encodeTransferVerifierParams(direction);
  return {
    kind: "Custom",
    verifier: verifierAddress,
    target,
    aggregate: false,
    params,
  };
}

/**
 * Create a KPI spec for a custom event type.
 *
 * @param verifierAddress The address of an EventVerifier contract
 * @param eventSignature keccak256 hash of the event signature
 * @param target The target amount or count
 * @param measurement COUNT or AMOUNT
 * @returns A KpiSpec ready to be used in campaign configuration
 */
export function createEventKpi(
  verifierAddress: `0x${string}`,
  eventSignature: `0x${string}`,
  target: bigint,
  measurement: VerifierMeasurement = VerifierMeasurement.AMOUNT,
): KpiSpec {
  const params = encodeEventVerifierParams(eventSignature, measurement);
  return {
    kind: "Custom",
    verifier: verifierAddress,
    target,
    aggregate: false,
    params,
  };
}

/**
 * Encode parameters for EventVerifier.verify().
 * Used internally by createDepositKpi and createEventKpi.
 *
 * Encodes as: abi.encode(eventSignature, measurement)
 */
export function encodeEventVerifierParams(
  eventSignature: string,
  measurement: VerifierMeasurement,
): `0x${string}` {
  // Pad eventSignature to 32 bytes (it's already keccak256, so 32 bytes)
  const sig = eventSignature.startsWith("0x") ? eventSignature : `0x${eventSignature}`;

  // measurement is a uint256 (0 or 1)
  const measurementHex = measurement.toString(16).padStart(64, "0");

  // ABI encode: skip function selector, just the parameters
  // abi.encode(bytes32, uint256) = bytes32 || uint256
  const encoded = sig.slice(2) + measurementHex;
  return `0x${encoded}`;
}

/**
 * Encode parameters for TransferVerifier.verify().
 * Used internally by createTransferKpi.
 *
 * Encodes as: abi.encode(Direction)
 */
export function encodeTransferVerifierParams(direction: TransferDirection): `0x${string}` {
  // direction is a uint256 (0, 1, or 2)
  const directionHex = direction.toString(16).padStart(64, "0");
  return `0x${directionHex}`;
}

/**
 * Human-readable description of a verifier configuration.
 *
 * @param kpi The KPI spec to describe
 * @returns A string describing what this KPI measures
 */
export function describeKpi(kpi: KpiSpec): string {
  if (kpi.kind === "Custom") {
    // Try to decode the params to provide more detail
    try {
      if (kpi.params.length >= 66) {
        // Has at least one 32-byte value
        const measurement = kpi.params.slice(-2);
        if (measurement === "00") {
          return `Custom event verification (COUNT mode) — target: ${kpi.target}`;
        } else if (measurement === "01") {
          return `Custom event verification (AMOUNT mode) — target: ${kpi.target}`;
        }
      }
    } catch {
      // Fallback
    }
  }

  return `${kpi.kind} — target: ${kpi.target}`;
}
