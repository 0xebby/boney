import {type Hex} from "viem";
import {KPI_KIND_LABEL, type KpiKind} from "./types";
import {eventTopic, effectiveScale, type AmountMode, type EventSource} from "./kpiSource";
import {parseEventSignature} from "./relayCore";
import {knownContractName, contractLabel} from "./knownContracts";
import {shortAddress} from "./format";

/**
 * Naming what a KPI actually watches, in words rather than hashes.
 *
 * A KPI's on-chain commitment (`Types.KpiSpec.params`, encoded by `kpiSource.ts`) carries `topics[0]`
 * — a keccak hash. A hash is a perfectly good matching key and a useless label: the campaign
 * measuring Aave supplies rendered as `0x2b627736… on 0x8bAB…AE27`, which tells a reader nothing
 * about either the event or the protocol. This module turns the same commitment into
 * `Supply(address,address,address,uint256,uint16) on Aave V3 Pool`.
 *
 * Three sources of a name, in descending order of authority:
 *
 *  1. **The verifier's own config.** `EventMetricKpiVerifier.KpiConfig.eventSignature` stores the
 *     *full* human-readable declaration on chain, `indexed` keywords included — it has to, because
 *     the relayer builds a real ABI decoder from it (`relayCore.parseEventSignature`). That makes it
 *     the one authoritative name, published by whoever configured the KPI.
 *  2. **The catalog below**, for KPIs whose verifier holds no config — every campaign that reports by
 *     hand, and every KPI carrying a `TouchWindowVerifier` lookback instead.
 *  3. **The KPI's `kind`**, which is a category hint rather than an event, so it is used only as a
 *     last resort and the caller is told (`eventFrom: "kind"`) so it can show the topic beside it.
 *
 * Pure and React-free (decision F6), like `kpiSource.ts` and `relayCore.ts` — the precedence rules
 * are the part that can be wrong, and they are unit-tested without a chain.
 */

// ── signatures ───────────────────────────────────────────────────

/**
 * The compact form of a full event declaration, plus the topic it hashes to.
 *
 * `"Supply(address indexed reserve, address user, ...)"` becomes
 * `"Supply(address,address,address,uint256,uint16)"` — the canonical form, which is both what the
 * hash is taken over and what fits in a table cell.
 *
 * Returns `null` rather than throwing. `parseEventSignature` throws by design: it runs at the
 * relayer's startup, where a signature that will not parse must stop the process before it reports
 * a confidently wrong number. Here the same string arrives from a contract's storage while a page is
 * rendering, and "we could not read this name" has to degrade to the next source rather than blank
 * the panel.
 */
export function describeSignature(full: string): {compact: string; topic0: Hex} | null {
  const trimmed = full.trim();
  if (!trimmed) return null;

  try {
    const {event, topic0} = parseEventSignature(trimmed);
    const types = event.inputs.map((input) => input.type).join(",");
    return {compact: `${event.name}(${types})`, topic0};
  } catch {
    return null;
  }
}

/**
 * Events we can name from a topic hash alone.
 *
 * Deliberately short. A topic is a one-way hash, so an entry here is a *claim* that a given hash
 * means a given signature, and a wrong claim mislabels every campaign watching that event. So the
 * bar for adding one is the bar `script/SeedRealKpi.s.sol` sets for itself: either the signature is
 * fixed by an ERC, or this repo has matched the hash against a real log. Cite which, on the entry.
 *
 * Topics are computed by `eventTopic` rather than pasted, so a typo in a signature cannot silently
 * key an entry to a hash nothing emits — the entry simply never matches, and the tests pin the two
 * hashes that were verified on chain.
 */
export const KNOWN_EVENTS = [
  /** ERC-20 §Transfer, and ERC-721's identically-shaped one. The most-watched event there is. */
  "Transfer(address,address,uint256)",
  /** ERC-20 §Approval. */
  "Approval(address,address,uint256)",
  /**
   * ERC-1155 §TransferSingle — how a 1155 collection reports a mint.
   *
   * Not hypothetical: this is the topic the live `Cpeg` campaign's "NFT mints" KPI watches, and
   * before this entry it was the one KPI on the fixture still rendering as a hash.
   */
  "TransferSingle(address,address,address,uint256,uint256)",
  /**
   * ERC-1155 §TransferBatch.
   *
   * Named for completeness, with a caveat worth knowing before configuring one: its amounts are
   * `uint256[]`, so the first word of `data` is an ABI offset rather than a quantity and
   * `AMOUNT_MODE.dataWord0` would credit nonsense. `count` mode is the only sound reading.
   */
  "TransferBatch(address,address,address,uint256[],uint256[])",
  /** WETH9 `Deposit(address indexed dst, uint256 wad)` — verified against a live Base Sepolia log. */
  "Deposit(address,uint256)",
  /** WETH9 `Withdrawal(address indexed src, uint256 wad)`, the counterpart of the above. */
  "Withdrawal(address,uint256)",
  /** Aave V3 Pool. `SeedRealKpi.AAVE_SUPPLY_TOPIC`, matched against live Base Sepolia logs. */
  "Supply(address,address,address,uint256,uint16)",
  /**
   * Uniswap V3 pool swaps. `SeedSwapKpi.SWAP_TOPIC`, matched against live pool logs on Base Sepolia.
   *
   * `topics[2]` is `recipient` — the end user on a routed swap, where `sender` is the router. Note the
   * amounts are `int256` and the input token's is the *second* data word, so this event can back a
   * count KPI but not a volume one; see `SeedSwapKpi` for what volume reads instead.
   */
  "Swap(address,address,int256,int256,uint160,uint128,int24)",
  /** Sygma bridge. `SeedRealKpi.SYGMA_DEPOSIT_TOPIC`, matched against the deployed bytecode. */
  "Deposit(uint8,bytes32,uint64,address,bytes,bytes)",
  /**
   * Gyndore's `GyndStaking`. `SeedGyndore.STAKED_TOPIC`, matched against live Base Sepolia logs.
   *
   * `topics[1]` is the staker and `topics[2]` the staked token, which is what lets one KPI pin the
   * token while crediting the user. The amount is the single `data` word.
   */
  "Staked(address,address,uint256)",
] as const;

/**
 * `topic0` → signature, built once at module scope.
 *
 * A `Map` rather than a linear scan over `KNOWN_EVENTS`: the browse page resolves one of these per
 * KPI per row, and hashing six strings once beats hashing them per render.
 */
const BY_TOPIC = new Map<string, string>(
  KNOWN_EVENTS.map((signature) => [eventTopic(signature).toLowerCase(), signature]),
);

/** The catalog's name for a topic, or `undefined` when we have never seen it. */
export function catalogSignature(topic0: Hex): string | undefined {
  return BY_TOPIC.get(topic0.toLowerCase());
}

// ── resolution ───────────────────────────────────────────────────

/** Where a resolved name came from, so a caller can render an inference differently from a fact. */
export type EventNameSource = "config" | "catalog" | "kind";
export type ProtocolNameSource = "catalog" | "chain" | "campaign" | "address";

export type TrackedEventInput = {
  /** The KPI's on-chain commitment, already decoded by `kpiSource.decodeEventSource`. */
  source: EventSource;
  /** Category hint from the spec, the last-resort label. */
  kind: KpiKind;
  /** Which chain the source address lives on; without it no catalog entry can apply. */
  chainId?: number;
  /** `EventMetricKpiVerifier.KpiConfig.eventSignature`, when the KPI has a config. */
  configSignature?: string;
  /**
   * What the source contract calls itself, when it answers `name()`/`symbol()`/`decimals()` at all.
   *
   * `decimals` is what lets a `dataWord0` scale be stated as a real token amount ("0.001 WETH")
   * rather than as a divisor. Absent for the contracts that answer none of the three — Aave's Pool
   * proxy and Sygma's bridge — where `lib/kpiUnits` falls back to base units rather than assuming 18.
   */
  scanned?: {name?: string; symbol?: string; decimals?: number};
  /** The campaign's own name — a project's label for the thing, not the contract's. */
  campaignName?: string;
};

export type TrackedEvent = {
  /** Best available name for the event: a signature, or the `kind` label if nothing else. */
  event: string;
  eventFrom: EventNameSource;
  /** Always the topic the *indexer* matches on, whatever the name resolved from. */
  topic0: Hex;
  /** The watched contract, carried through so a caller can link it without re-decoding params. */
  contract: `0x${string}`;
  /** Best available name for the watched contract. Never empty — falls back to a short address. */
  protocol: string;
  protocolFrom: ProtocolNameSource;
  /** Divisor applied before crediting; 1 when unscaled. */
  scale: bigint;
  /**
   * How the credited amount is taken from a matched log.
   *
   * Carried alongside `scale` because neither means anything without the other: the same divisor is a
   * unit conversion under `dataWord0` and a plain difficulty multiplier under `count`. `lib/kpiUnits`
   * is what turns the pair into a sentence.
   */
  amountMode: AmountMode;
  /**
   * The watched contract's own units, when it published them.
   *
   * Carried through from `scanned` rather than left for the caller to thread separately: a scale is
   * only expressible as a token amount together with the decimals it is denominated in, and every
   * consumer of one wants the other. Absent for a contract that answers neither.
   */
  token?: {symbol?: string; decimals?: number};
  /**
   * Set when the verifier's configured signature hashes to a different topic than the params blob.
   *
   * The two are separate copies of the same fact (see the note at the top of `kpiSource.ts`) and can
   * drift. When they disagree the config's name is *dropped*, not shown: the params topic is what
   * `indexerCore` matches logs against, so naming the KPI after the other one would put a confident
   * label on the wrong event. The relayer refuses to run in this state
   * (`relayCore.describeConfigDrift`); the UI cannot refuse to render, so it says so instead.
   */
  drift?: string;
};

/**
 * Resolves the display name of a tracked event and its contract.
 *
 * Pure: every chain read the answer depends on is passed in, which is what lets the precedence be
 * tested against all eight combinations of "config present / catalog hit / contract named itself"
 * without a node.
 */
export function resolveTrackedEvent(input: TrackedEventInput): TrackedEvent {
  const {event, eventFrom, drift} = resolveEventName(input);
  const token = resolveToken(input.scanned);

  return {
    event,
    eventFrom,
    topic0: input.source.topic0,
    contract: input.source.source,
    scale: effectiveScale(input.source),
    amountMode: input.source.amountMode,
    ...(token ? {token} : {}),
    ...resolveProtocol(input),
    ...(drift ? {drift} : {}),
  };
}

/**
 * The scanned units, or nothing.
 *
 * Omitted entirely rather than returned as a pair of `undefined`s, so a consumer can ask "did the
 * contract say" with a single check. A symbol alone still counts: `kpiUnits` needs the decimals to
 * name an amount, but a caller labelling something else may only want the symbol.
 */
function resolveToken(
  scanned: TrackedEventInput["scanned"],
): {symbol?: string; decimals?: number} | undefined {
  if (!scanned) return undefined;
  if (scanned.symbol === undefined && scanned.decimals === undefined) return undefined;

  return {
    ...(scanned.symbol !== undefined ? {symbol: scanned.symbol} : {}),
    ...(scanned.decimals !== undefined ? {decimals: scanned.decimals} : {}),
  };
}

function resolveEventName(input: TrackedEventInput): {
  event: string;
  eventFrom: EventNameSource;
  drift?: string;
} {
  const described = input.configSignature ? describeSignature(input.configSignature) : null;

  if (described) {
    if (described.topic0.toLowerCase() === input.source.topic0.toLowerCase()) {
      return {event: described.compact, eventFrom: "config"};
    }

    // Both halves claim to describe this KPI and they name different events. Fall through to a
    // source that agrees with the topic actually being matched, and surface the disagreement.
    const fallback = fromCatalogOrKind(input);
    return {
      ...fallback,
      drift:
        `The verifier is configured for ${described.compact}, which is not the event this KPI ` +
        `credits. Progress comes from ${shortTopic(input.source.topic0)}.`,
    };
  }

  return fromCatalogOrKind(input);
}

function fromCatalogOrKind(input: TrackedEventInput): {
  event: string;
  eventFrom: EventNameSource;
} {
  const catalog = catalogSignature(input.source.topic0);
  if (catalog) return {event: catalog, eventFrom: "catalog"};

  // `Custom` is the "no category was given" member of the enum, so its label says nothing about
  // what fires. Anything else at least narrows it to a class of activity.
  return {
    event: input.kind === "Custom" ? "Unnamed event" : KPI_KIND_LABEL[input.kind],
    eventFrom: "kind",
  };
}

/**
 * Names the watched contract, contract identity first.
 *
 * The campaign's own name comes *below* both the catalog and the contract's self-reported name, and
 * that ordering is the point: a campaign called "Aerodrome" that watches the bUSD mock's `Transfer`
 * is watching bUSD, and labelling that line "Aerodrome" would assert a relationship the chain does
 * not record. The campaign name is still better than raw hex when the contract will not name itself,
 * because it is at least what the project said this KPI is about.
 */
function resolveProtocol(input: TrackedEventInput): {
  protocol: string;
  protocolFrom: ProtocolNameSource;
} {
  const known = knownContractName(input.chainId, input.source.source);
  if (known) return {protocol: known, protocolFrom: "catalog"};

  const scanned = contractLabel(input.scanned);
  if (scanned) return {protocol: scanned, protocolFrom: "chain"};

  const campaign = input.campaignName?.trim();
  if (campaign) return {protocol: campaign, protocolFrom: "campaign"};

  return {protocol: shortAddress(input.source.source), protocolFrom: "address"};
}

/** A topic shortened for prose, e.g. `0x2b627736…`. */
export function shortTopic(topic0: Hex): string {
  return `${topic0.slice(0, 10)}…`;
}
