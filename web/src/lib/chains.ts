import {anvil, sepolia, baseSepolia, mainnet} from "viem/chains";
import {GENERATED_DEPLOYMENTS} from "./deployments";

/**
 * Chain and deployment configuration.
 *
 * `GENERATED_DEPLOYMENTS` holds addresses read from Foundry's broadcast receipt (see
 * `scripts/generate-deployments.ts`), so the addresses the app talks to are exactly the ones
 * that landed on chain. Testnet/mainnet addresses can be added via `NEXT_PUBLIC_*` env vars.
 */

export const SUPPORTED_CHAINS = {
  anvil: anvil.id,
  sepolia: sepolia.id,
  baseSepolia: baseSepolia.id,
  mainnet: mainnet.id,
} as const;

export type SupportedChainId = (typeof SUPPORTED_CHAINS)[keyof typeof SUPPORTED_CHAINS];

/** Addresses of the deployed protocol modules on one chain. */
export type Deployment = {
  boney: `0x${string}`;
  campaignRegistry: `0x${string}`;
  escrowVault: `0x${string}`;
  attributionRegistry: `0x${string}`;
  reputationRegistry: `0x${string}`;
  attestationVerifier: `0x${string}`;
  oracleCoordinator: `0x${string}`;
  /**
   * Boney's canonical KPI verifier — the one the relayer reports observed metrics to.
   *
   * Optional because the KPI verification layer postdates the live deployments: a broadcast
   * receipt from before it lands without these three, and requiring them would break
   * `pnpm deployments` until a full redeploy. Filled in automatically by the next deploy.
   */
  eventMetricKpiVerifier?: `0x${string}`;
  /** The wrapper a campaign's `KpiSpec.verifier` points at. Optional; see above. */
  guardedKpiVerifier?: `0x${string}`;
  /** Attribution-timing lens, composable as the guard's second verifier. Optional; see above. */
  touchWindowVerifier?: `0x${string}`;
  /**
   * Block the protocol was deployed in — the floor for any log scan.
   *
   * Nothing on chain enumerates a campaign's promoters, so listing them means `getLogs` over
   * `PromoterJoined`, and public RPCs cap one query at ~2000 blocks. Scanning from genesis on an
   * L2 is thousands of round trips; from here it is a handful. Zero means "scan from genesis",
   * which is correct on a local chain and the honest default when the block is unknown.
   */
  startBlock: bigint;
};

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

function env(key: string): `0x${string}` {
  const value = process.env[key];
  if (!value) return ZERO_ADDRESS;
  return value as `0x${string}`;
}

/**
 * Like `env`, but absent means `undefined` rather than the zero address.
 *
 * Only for the optional KPI-verifier keys. Collapsing "not deployed" into `0x0` would let the
 * relayer happily point at the zero address and fail with a decode error instead of saying the
 * verifier is missing.
 */
function optionalEnv(key: string): `0x${string}` | undefined {
  const value = process.env[key];
  return value ? (value as `0x${string}`) : undefined;
}

/**
 * Deployment addresses by chain id. The anvil entry is generated from the broadcast receipt;
 * the others come from env vars and are zero until set.
 */
export const DEPLOYMENTS: Partial<Record<number, Deployment>> = {
  [sepolia.id]: {
    boney: env("NEXT_PUBLIC_SEPOLIA_BONEY"),
    campaignRegistry: env("NEXT_PUBLIC_SEPOLIA_CAMPAIGN_REGISTRY"),
    escrowVault: env("NEXT_PUBLIC_SEPOLIA_ESCROW_VAULT"),
    attributionRegistry: env("NEXT_PUBLIC_SEPOLIA_ATTRIBUTION_REGISTRY"),
    reputationRegistry: env("NEXT_PUBLIC_SEPOLIA_REPUTATION_REGISTRY"),
    attestationVerifier: env("NEXT_PUBLIC_SEPOLIA_ATTESTATION_VERIFIER"),
    oracleCoordinator: env("NEXT_PUBLIC_SEPOLIA_ORACLE_COORDINATOR"),
    eventMetricKpiVerifier: optionalEnv("NEXT_PUBLIC_SEPOLIA_KPI_VERIFIER"),
    guardedKpiVerifier: optionalEnv("NEXT_PUBLIC_SEPOLIA_GUARDED_VERIFIER"),
    touchWindowVerifier: optionalEnv("NEXT_PUBLIC_SEPOLIA_TOUCH_VERIFIER"),
    startBlock: BigInt(process.env.NEXT_PUBLIC_SEPOLIA_START_BLOCK ?? 0),
  },
  [baseSepolia.id]: {
    boney: env("NEXT_PUBLIC_BASE_SEPOLIA_BONEY"),
    campaignRegistry: env("NEXT_PUBLIC_BASE_SEPOLIA_CAMPAIGN_REGISTRY"),
    escrowVault: env("NEXT_PUBLIC_BASE_SEPOLIA_ESCROW_VAULT"),
    attributionRegistry: env("NEXT_PUBLIC_BASE_SEPOLIA_ATTRIBUTION_REGISTRY"),
    reputationRegistry: env("NEXT_PUBLIC_BASE_SEPOLIA_REPUTATION_REGISTRY"),
    attestationVerifier: env("NEXT_PUBLIC_BASE_SEPOLIA_ATTESTATION_VERIFIER"),
    oracleCoordinator: env("NEXT_PUBLIC_BASE_SEPOLIA_ORACLE_COORDINATOR"),
    eventMetricKpiVerifier: optionalEnv("NEXT_PUBLIC_BASE_SEPOLIA_KPI_VERIFIER"),
    guardedKpiVerifier: optionalEnv("NEXT_PUBLIC_BASE_SEPOLIA_GUARDED_VERIFIER"),
    touchWindowVerifier: optionalEnv("NEXT_PUBLIC_BASE_SEPOLIA_TOUCH_VERIFIER"),
    startBlock: BigInt(process.env.NEXT_PUBLIC_BASE_SEPOLIA_START_BLOCK ?? 0),
  },
  // Generated entries come last so they win: they are read from the broadcast receipt, so they
  // describe what actually landed on chain rather than what an env var claims. Spread first, a
  // generated deployment would be silently clobbered by unset env vars resolving to zero.
  ...GENERATED_DEPLOYMENTS,
};

export function getDeployment(chainId: number | undefined): Deployment | undefined {
  if (chainId === undefined) return undefined;
  return DEPLOYMENTS[chainId];
}

/** Whether the protocol has a usable (non-zero) deployment on this chain. */
export function isDeployed(chainId: number | undefined): boolean {
  const d = getDeployment(chainId);
  return d !== undefined && d.boney !== ZERO_ADDRESS;
}

/**
 * Chain to read from when no wallet is connected.
 *
 * wagmi has no concept of "no chain": `createConfig` seeds its store with `chains[0].id` and
 * `getClient` falls back to it, so a visitor who has never connected still resolves to a chain —
 * here that was `anvil`, which is a developer's local node and not something a public visitor can
 * reach. Because `isDeployed(31337)` is true (anvil has a generated deployment), the "not available
 * on this network" empty states did not fire either; the app simply issued reads against a dead
 * endpoint and rendered an empty marketplace.
 *
 * Base Sepolia is the default because it is the deployment the public actually shares. Override
 * with `NEXT_PUBLIC_DEFAULT_CHAIN_ID` when developing against a local node — note this only affects
 * *disconnected* browsing; a connected wallet's own chain always wins (see `useBoneyChainId`).
 */
export const DEFAULT_CHAIN_ID = Number(
  process.env.NEXT_PUBLIC_DEFAULT_CHAIN_ID ?? baseSepolia.id,
);

/** Block explorer URL for an address, or undefined for local chains. */
export function explorerAddressUrl(chainId: number, address: string): string | undefined {
  const base: Record<number, string> = {
    [mainnet.id]: "https://etherscan.io",
    [sepolia.id]: "https://sepolia.etherscan.io",
    [baseSepolia.id]: "https://sepolia.basescan.org",
  };
  const root = base[chainId];
  return root ? `${root}/address/${address}` : undefined;
}

export {anvil, sepolia, baseSepolia, mainnet};
