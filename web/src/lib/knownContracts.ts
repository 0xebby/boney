import {baseSepolia, sepolia} from "viem/chains";

/**
 * Contracts we can name without asking the chain.
 *
 * A KPI's event source is an address, and an address names nothing to a reader. Most of the time the
 * contract can name itself — an ERC-20 answers `name()`/`symbol()`, and `useTrackedEvent` asks it —
 * but the interesting sources are exactly the ones that cannot: Aave's Pool proxy implements neither,
 * and Sygma's bridge implements neither. Those are the two real-protocol campaigns on Base Sepolia,
 * so without this map the frontend's best offer for both is a shortened hex string.
 *
 * Kept separate from `kpiSource.ts` and `eventNames.ts` so both may import it without a cycle: the
 * probe (a form-time chain read) and the resolver (a render-time pure function) both need to name an
 * address, and neither should have to import the other to do it. Chain ids come straight from
 * `viem/chains` rather than from `lib/chains`, which would drag deployment addresses and `NEXT_PUBLIC_*`
 * env reads into a module that is only a lookup table.
 *
 * Addresses only — no ABIs, no assumptions about what a contract does. Every entry is copied from a
 * constant this repo already verified against a live chain, cited on the line.
 */

/** Lowercased so a checksummed address from any source keys the same entry. */
type ContractLabels = Readonly<Record<string, string>>;

/**
 * Base's canonical WETH predeploy, identical across every Base network.
 *
 * Same address `kpiSource.WETH_BASE` exports for the deposit preset; duplicated as a lowercase key
 * rather than imported to keep this module free of the cycle described above.
 */
const WETH_BASE_KEY = "0x4200000000000000000000000000000000000006";

/**
 * Base Sepolia. Both protocol entries come from `script/SeedRealKpi.s.sol`, whose header records
 * that each was matched against real logs (Aave) or a constant in the deployed bytecode (Sygma)
 * rather than assumed.
 */
const BASE_SEPOLIA: ContractLabels = {
  // `SeedRealKpi.AAVE_POOL` — the V3 Pool proxy, which is what emits `Supply`.
  "0x8bab6d1b75f19e9ed9fce8b9bd338844ff79ae27": "Aave V3 Pool",
  // `SeedRealKpi.SYGMA_BRIDGE`.
  "0x9d5c332ebe0dae36e07a4ed552ad4d8c5067a61f": "Sygma Bridge",
  // `SeedSwapKpi.POOL` — the 0.3% WETH/USDC pool from `UniswapV3Factory.getPool`, whose `Swap` logs
  // were sampled live. The fee tier is part of the name because all four tiers exist on this chain and
  // they are different pools with different liquidity.
  "0x46880b404cd35c165eddeff7421019f8dd25f4ad": "Uniswap V3 WETH/USDC 0.3%",
  // SwapRouter02, which appears as `sender` on every routed swap — worth naming so a KPI mistakenly
  // pointed at `topics[1]` shows whose address it is really crediting.
  "0x94cc0aac535ccdb3c01d6787d6413c739ae12bc4": "Uniswap SwapRouter02",
  // Circle's test USDC. It answers `symbol()`, so this entry only saves a round trip.
  "0x036cbd53842c5426634e7929541ec2318f3dcf7e": "USDC",
  // The five below come from `script/SeedGyndore.s.sol`. Gyndore is a Uniswap V3 fork, so its pool
  // and position manager have the same reason to be named here as Uniswap's own: neither answers
  // `name()`, and the fork's addresses are nobody's canonical ones.
  // `SeedGyndore.POOL_GYND_CBBTC` — the pool carrying the `Swap` logs. The fee tier is part of the
  // name because it identifies the pool: a pair and a tier together are what the factory keys on.
  "0x7b47dac59075af44046795ba347ec872d5409263": "Gyndore GYND/cbBTC 1%",
  // `SeedGyndore.SWAP_ROUTER`, which appears as `sender` on every routed swap — worth naming so a KPI
  // mistakenly pointed at `topics[1]` shows whose address it is really crediting.
  "0xc7dbf300b6aea3cfe1730f1c692c606b17b514a6": "Gyndore SwapRouter",
  // `SeedGyndore.STAKING` — `GyndStaking`, which answers none of the three.
  "0x5c0e023ce4a353e5cd9a43e28d2879cb9e876865": "Gyndore Staking",
  // `SeedGyndore.POSITION_MANAGER`. It calls itself `UNI-V3-POS`, which names the fork it came from
  // and not this deployment, so the entry is what distinguishes it from Uniswap's own manager.
  "0x76998e42b789d81004f006402b6c62a8bdcafd5b": "Gyndore Positions",
  // `SeedGyndore.GYND` — the escrow token, and the token KPI 1 pins. It answers `symbol()`; named
  // here so the KPI's topic filter reads as a token rather than a padded word.
  "0x0d442ec7bddb06b531dca3dd39abaff554170776": "GYND",
  [WETH_BASE_KEY]: "WETH",
};

/** Ethereum Sepolia. Nothing protocol-specific is seeded there; WETH is not this predeploy. */
const SEPOLIA: ContractLabels = {};

const BY_CHAIN: Readonly<Record<number, ContractLabels>> = {
  [baseSepolia.id]: BASE_SEPOLIA,
  [sepolia.id]: SEPOLIA,
};

/**
 * The label for a known contract, or `undefined` when we have nothing better than the address.
 *
 * Chain-scoped on purpose: an address is only meaningful together with the chain it was deployed on,
 * and a fork or a local anvil replaying these addresses would hold different code. Callers treat
 * `undefined` as "ask the contract" rather than as an error — see `eventNames.resolveTrackedEvent`
 * for the full precedence.
 */
export function knownContractName(
  chainId: number | undefined,
  address: string | undefined,
): string | undefined {
  if (chainId === undefined || !address) return undefined;
  return BY_CHAIN[chainId]?.[address.toLowerCase()];
}

/**
 * A contract's `name()` and `symbol()` folded into one label: `Boney USD (bUSD)`.
 *
 * A token answers both and they differ, so both are worth showing — the symbol is what every other
 * amount on the page is denominated in, and the name is what makes the symbol recognisable. Either
 * one alone stands on its own. An empty or whitespace string counts as absent: a contract whose
 * `name()` returns `""` has told us nothing, and `" ()"` is worse than the address it replaced.
 *
 * Shared by the render-time resolver (`eventNames.resolveTrackedEvent`) and the create form's probe,
 * so a contract is described the same way whether it is being chosen or being displayed.
 */
export function contractLabel(
  scanned: {name?: string; symbol?: string} | undefined,
): string | undefined {
  const name = scanned?.name?.trim();
  const symbol = scanned?.symbol?.trim();

  if (name && symbol && name !== symbol) return `${name} (${symbol})`;
  return name || symbol || undefined;
}
