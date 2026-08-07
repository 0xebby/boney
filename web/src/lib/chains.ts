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

export const DEFAULT_CHAIN = anvil;

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
