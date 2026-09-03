import {
  decodeAbiParameters,
  encodeAbiParameters,
  getAddress,
  isHex,
  keccak256,
  pad,
  toHex,
  type Hex,
  type PublicClient,
} from "viem";
import {isAddress as isViemAddress} from "viem/utils";
import {IERC20MetadataAbi} from "./abis";
import {formatTokenAmount} from "./format";
import {contractLabel, knownContractName} from "./knownContracts";

/**
 * Event-sourced KPI configuration — the encoding of `Types.KpiSpec.params`.
 *
 * `Types.sol:50` describes `params` as "opaque configuration forwarded to the verifier (e.g. the
 * contract address and event signature being tracked)", and `BoneyDocs.md:118` says `kind` is "a
 * hint for indexers and UIs". This module is that convention made concrete: it is what lets a
 * campaign declare *which contract and which event* it measures, rather than leaving the answer in
 * an off-chain config file that nothing on chain can be checked against.
 *
 * Pure and React-free (decision F6), like `promoter.ts` and `filters.ts`, so the encoding is unit-tested
 * without a chain or a wallet. Getting this wrong is a silent-corruption risk in the same class as
 * `campaignArgs.ts`: a campaign encodes successfully, deploys, and then credits progress from the
 * wrong contract's events.
 *
 * The chain does not read this blob as a consensus rule — `Campaign` forwards `params` to the
 * verifier and otherwise ignores it. It is a commitment published on chain so the off-chain halves
 * agree on what a campaign measures.
 *
 * It is no longer the *only* such commitment, though. `EventMetricKpiVerifier` keeps its own copy of
 * the watched contract, event and scale in its own storage (`setKpiConfig`), because a verifier
 * reading its config from this same field could not coexist with `TouchWindowVerifier`, which reads
 * `params` as a bare `uint64` lookback. That means two descriptions of the same event now exist, and
 * they can drift — so the relayer refuses to run when they disagree
 * (`relayCore.describeConfigDrift`). Change one side and you must change the other.
 */

/** How the credited amount is taken from a matched log. */
export const AMOUNT_MODE = {
  /** Each matching log counts as 1, whatever its data says. For "how many mints" KPIs. */
  count: 0,
  /** Decode the first 32-byte word of `log.data` as a `uint256`. For "how much was deposited". */
  dataWord0: 1,
} as const;

export type AmountMode = (typeof AMOUNT_MODE)[keyof typeof AMOUNT_MODE];

export type EventSource = {
  /** Contract whose logs are watched. */
  source: `0x${string}`;
  /** `keccak256` of the event signature — `log.topics[0]`. */
  topic0: `0x${string}`;
  /**
   * Which indexed topic carries the referral's address.
   *
   * 1-based over `topics`, because `topics[0]` is always the signature: an actor at `topics[0]`
   * is not a thing that can exist. An event whose actor is not indexed cannot be sourced this
   * way at all — the address would be in `data`, at an offset only the full ABI reveals.
   */
  actorTopic: 1 | 2 | 3;
  amountMode: AmountMode;
  /**
   * Divisor applied to the raw amount before crediting.
   *
   * Token amounts are in base units, so an unscaled WETH deposit credits ~1e15 progress against a
   * ladder whose rungs are single digits — every tier crosses on the first event. Scaling is what
   * keeps `RewardTier.threshold` a human number. Integer division, so the remainder is dropped;
   * pick a scale fine enough that the dust does not matter.
   *
   * 0 is accepted and means 1. It is what an unset field decodes to, and a "no scaling" reading
   * beats a division-by-zero at report time.
   */
  scale: bigint;
  /**
   * Which indexed topic must equal `filterValue` for a log to count.
   *
   * 1-based over `topics` like `actorTopic`, and never equal to it. Absent means the KPI counts
   * every log of this event on this contract.
   */
  filterTopic?: 1 | 2 | 3;
  /**
   * The raw 32-byte topic word `filterTopic` must equal.
   *
   * A raw word rather than an address, so the same field constrains an indexed `uint`, `bytes32` or
   * enum. Set whenever `filterTopic` is.
   */
  filterValue?: `0x${string}`;
};

/**
 * ABI layout of the params blob.
 *
 * Five separate words rather than a packed struct: `abi.encode` pads everything to 32 bytes
 * regardless, so packing would buy nothing and cost the ability to read a field with
 * `decodeAbiParameters` alone.
 */
const PARAMS_ABI = [
  {type: "address", name: "source"},
  {type: "bytes32", name: "topic0"},
  {type: "uint8", name: "actorTopic"},
  {type: "uint8", name: "amountMode"},
  {type: "uint256", name: "scale"},
] as const;

/**
 * ABI layout of the blob when the KPI narrows on a topic.
 *
 * A strict extension of `PARAMS_ABI`: the two fields are appended, so the first five words decode
 * identically either way. The short form is still what `encodeEventSource` emits when there is no
 * filter, which keeps every campaign created before this field byte-identical.
 */
const FILTERED_PARAMS_ABI = [
  {type: "address", name: "source"},
  {type: "bytes32", name: "topic0"},
  {type: "uint8", name: "actorTopic"},
  {type: "uint8", name: "amountMode"},
  {type: "uint256", name: "scale"},
  {type: "uint8", name: "filterTopic"},
  {type: "bytes32", name: "filterValue"},
] as const;

/** Byte length of a well-formed unfiltered blob: five 32-byte words, hex-encoded, plus `0x`. */
const ENCODED_HEX_LENGTH = 2 + 5 * 64;

/** Byte length of a well-formed filtered blob: the same five words plus the two filter fields. */
const FILTERED_HEX_LENGTH = 2 + 7 * 64;

/** A 32-byte word of zeroes — an indexed `address(0)`, which is what a mint's `from` carries. */
export const ZERO_TOPIC = `0x${"0".repeat(64)}` as const;

/**
 * Length at which `TouchWindowVerifier` reads `params` as a bare `uint64` lookback.
 *
 * `TouchWindowVerifier._lookback` returns 0 unless `params.length == 32`
 * (`TouchWindowVerifier.sol:113`). An event blob is 160 bytes, so a KPI carrying both configs gets
 * `lookback = 0` — strict, which is the *safe* direction (it credits less, never more), but it is
 * silently not what whoever set the lookback asked for. `eventSourceConflictsWithVerifier` exists
 * so the create form can say so out loud instead of letting it pass.
 */
const TOUCH_WINDOW_PARAMS_LENGTH = 32;

export function encodeEventSource(src: EventSource): Hex {
  if (src.actorTopic < 1 || src.actorTopic > 3) {
    throw new Error(`actorTopic must be 1..3, got ${src.actorTopic}`);
  }
  if (src.scale < BigInt(0)) {
    throw new Error(`scale must not be negative, got ${src.scale}`);
  }

  // Lowercased for the same reason `derivePromoterId` does it: viem rejects a mixed-case address
  // whose EIP-55 checksum does not validate, so a hand-typed one would throw here rather than
  // encode to the same 20 bytes it obviously means.
  const head = [
    src.source.toLowerCase() as `0x${string}`,
    src.topic0.toLowerCase() as `0x${string}`,
    src.actorTopic,
    src.amountMode,
    src.scale,
  ] as const;

  if (!src.filterTopic) return encodeAbiParameters(PARAMS_ABI, [...head]);

  if (src.filterTopic < 1 || src.filterTopic > 3) {
    throw new Error(`filterTopic must be 1..3, got ${src.filterTopic}`);
  }
  if (src.filterTopic === src.actorTopic) {
    throw new Error(`filterTopic must differ from actorTopic, got ${src.filterTopic}`);
  }

  const filterValue = normalizeTopicValue(src.filterValue);
  if (!filterValue) {
    throw new Error(`filterValue must be an address or a 32-byte word, got ${src.filterValue}`);
  }

  return encodeAbiParameters(FILTERED_PARAMS_ABI, [...head, src.filterTopic, filterValue]);
}

/**
 * A topic filter value as the raw 32-byte word the log carries.
 *
 * @param raw A 32-byte word, or a 20-byte address to left-pad as an indexed address does.
 * @returns The lowercased word, or `null` when the input is neither shape.
 */
export function normalizeTopicValue(
  raw: string | undefined | null,
): `0x${string}` | null {
  const trimmed = raw?.trim().toLowerCase();
  if (!trimmed || !isHex(trimmed)) return null;
  if (trimmed.length === 66) return trimmed as `0x${string}`;
  if (trimmed.length === 42) return pad(trimmed as Hex, {size: 32}).toLowerCase() as `0x${string}`;
  return null;
}

/**
 * Decodes a params blob, or `null` when it is not an event source.
 *
 * Never throws. The campaign detail page renders this for every KPI on every campaign — including
 * the five already live on Base Sepolia, whose `params` is `"0x"` — so a throw here would blank a
 * page over a field the campaign was never required to set. "Not event-sourced" is the normal
 * case, not an error.
 */
export function decodeEventSource(params: Hex | undefined | null): EventSource | null {
  if (!params || params === "0x") return null;

  try {
    if (params.length === ENCODED_HEX_LENGTH) {
      const [source, topic0, actorTopic, amountMode, scale] = decodeAbiParameters(
        PARAMS_ABI,
        params,
      );
      return buildEventSource(source, topic0, actorTopic, amountMode, scale, 0, ZERO_TOPIC);
    }

    if (params.length === FILTERED_HEX_LENGTH) {
      const [source, topic0, actorTopic, amountMode, scale, filterTopic, filterValue] =
        decodeAbiParameters(FILTERED_PARAMS_ABI, params);
      return buildEventSource(
        source,
        topic0,
        actorTopic,
        amountMode,
        scale,
        filterTopic,
        filterValue,
      );
    }

    return null;
  } catch {
    // A blob of the right length that is not this struct — a different adapter's config, say.
    return null;
  }
}

/**
 * Validates decoded fields and normalizes them into an `EventSource`.
 *
 * @param source Watched contract.
 * @param topic0 Event signature hash.
 * @param actorTopic Topic index carrying the credited wallet.
 * @param amountMode How the amount is read.
 * @param scale Divisor applied to the amount.
 * @param filterTopic Constrained topic index, 0 for none.
 * @param filterValue Word the constrained topic must equal.
 * @returns The source, or `null` when a field is out of range.
 */
function buildEventSource(
  source: `0x${string}`,
  topic0: `0x${string}`,
  actorTopic: number,
  amountMode: number,
  scale: bigint,
  filterTopic: number,
  filterValue: `0x${string}`,
): EventSource | null {
  if (actorTopic < 1 || actorTopic > 3) return null;
  if (amountMode !== AMOUNT_MODE.count && amountMode !== AMOUNT_MODE.dataWord0) return null;
  if (filterTopic < 0 || filterTopic > 3) return null;
  if (filterTopic !== 0 && filterTopic === actorTopic) return null;

  const decoded: EventSource = {
    source: getAddress(source),
    topic0: topic0.toLowerCase() as `0x${string}`,
    actorTopic: actorTopic as 1 | 2 | 3,
    amountMode: amountMode as AmountMode,
    scale,
  };

  // The unfiltered form is the canonical shape for "no filter", so a long blob carrying a zero
  // filter topic decodes to exactly what the short one does.
  if (filterTopic === 0) return decoded;

  return {
    ...decoded,
    filterTopic: filterTopic as 1 | 2 | 3,
    filterValue: filterValue.toLowerCase() as `0x${string}`,
  };
}

/** Whether a KPI's params would be misread by `TouchWindowVerifier`. See the constant above. */
export function eventSourceConflictsWithVerifier(
  params: Hex | undefined | null,
  verifier: `0x${string}` | undefined,
): boolean {
  if (!verifier || verifier === "0x0000000000000000000000000000000000000000") return false;
  if (!params || params === "0x") return false;
  return (params.length - 2) / 2 !== TOUCH_WINDOW_PARAMS_LENGTH;
}

/** The effective divisor — see the note on `EventSource.scale` for why 0 means 1. */
export function effectiveScale(src: EventSource): bigint {
  return src.scale === BigInt(0) ? BigInt(1) : src.scale;
}

/**
 * Whether a log satisfies the source's topic filter.
 *
 * A log that does not carry the filtered topic at all fails: a filter on a topic this event never
 * indexes must drop the log rather than pass it.
 *
 * @param log Log whose topics are tested.
 * @param src Decoded event source.
 * @returns True when the source carries no filter, or the filtered topic equals `filterValue`.
 */
export function matchesTopicFilter(
  log: {topics: readonly (string | undefined)[]},
  src: EventSource,
): boolean {
  if (!src.filterTopic || !src.filterValue) return true;

  const topic = log.topics[src.filterTopic];
  if (!topic) return false;

  return topic.toLowerCase() === src.filterValue.toLowerCase();
}

/**
 * The `eth_getLogs` topic slots above `topics[0]`, so every caller narrows node-side identically.
 *
 * Built by index rather than by appending, because the actor slot and the filter slot may fall in
 * either order.
 *
 * @param src Decoded event source.
 * @param actorFilter Left-padded referral addresses to match at `actorTopic`, when narrowing on them.
 * @returns One entry per constrained index, `null` where nothing is constrained; empty when neither
 *          a filter nor an actor list applies.
 */
export function topicFilterArray(
  src: EventSource,
  actorFilter?: readonly Hex[],
): (Hex | Hex[] | null)[] {
  const filter =
    src.filterTopic && src.filterValue
      ? {index: src.filterTopic, value: src.filterValue.toLowerCase() as Hex}
      : null;
  const highest = Math.max(filter?.index ?? 0, actorFilter ? src.actorTopic : 0);

  const slots: (Hex | Hex[] | null)[] = [];
  for (let i = 1; i <= highest; i++) {
    if (actorFilter && i === src.actorTopic) slots.push([...actorFilter]);
    else if (filter && i === filter.index) slots.push(filter.value);
    else slots.push(null);
  }

  return slots;
}

// ── well-known events ────────────────────────────────────────────

/** `topic0` for a human-readable event signature, e.g. `"Deposit(address,uint256)"`. */
export function eventTopic(signature: string): `0x${string}` {
  return keccak256(toHex(signature));
}

/**
 * Presets for events we have actually verified against a live chain, so the create form can offer
 * one click instead of asking a project to hand-assemble a topic hash.
 *
 * WETH's `Deposit` is the canonical Base predeploy at `0x4200…0006`. Its shape was confirmed
 * against a real Base Sepolia log: `topics[1]` carries `dst`, and `data` is the single `uint256`
 * `wad` — which is exactly `actorTopic: 1` with `amountMode: dataWord0`.
 *
 * These are *offers*, not a naming table. Recovering a signature from a topic hash for display is
 * `eventNames.catalogSignature`, which knows a wider set — a topic only these two presets could name
 * left both live real-protocol campaigns rendering as hex.
 */
export const WETH_BASE = "0x4200000000000000000000000000000000000006" as const;

/** `keccak256("Transfer(address,address,uint256)")`, which the mints-only reading is specific to. */
const TRANSFER_TOPIC0 = eventTopic("Transfer(address,address,uint256)").toLowerCase();

export const EVENT_PRESETS = [
  {
    id: "weth-deposit",
    label: "WETH deposits (Base)",
    signature: "Deposit(address,uint256)",
    filterValueIsPlaceholder: false,
    /** 0.001 WETH per unit of progress, so tier thresholds stay small integers. */
    source: {
      source: WETH_BASE,
      topic0: eventTopic("Deposit(address,uint256)"),
      actorTopic: 1,
      amountMode: AMOUNT_MODE.dataWord0,
      scale: BigInt(1e15),
    } satisfies EventSource,
  },
  {
    id: "erc721-mint",
    label: "ERC-721 transfers",
    signature: "Transfer(address,address,uint256)",
    filterValueIsPlaceholder: false,
    /**
     * `topics[2]` is `to` — the recipient is the actor for a mint, not `from`. Counting mode,
     * since the third topic is a token id and summing ids would be meaningless.
     */
    source: {
      source: "0x0000000000000000000000000000000000000000",
      topic0: eventTopic("Transfer(address,address,uint256)"),
      actorTopic: 2,
      amountMode: AMOUNT_MODE.count,
      scale: BigInt(1),
    } satisfies EventSource,
  },
  {
    id: "erc721-mint-only",
    label: "ERC-721 mints only",
    signature: "Transfer(address,address,uint256)",
    /** The zero word is the filter itself here, not a gap the project fills. */
    filterValueIsPlaceholder: false,
    /** `topics[1]` is `from`, and a mint's `from` is `address(0)` — which is what the filter pins. */
    source: {
      source: "0x0000000000000000000000000000000000000000",
      topic0: eventTopic("Transfer(address,address,uint256)"),
      actorTopic: 2,
      amountMode: AMOUNT_MODE.count,
      scale: BigInt(1),
      filterTopic: 1,
      filterValue: ZERO_TOPIC,
    } satisfies EventSource,
  },
  {
    id: "router-transfer",
    label: "Token received from one sender (router / bridge)",
    signature: "Transfer(address,address,uint256)",
    /** Which router is always project-specific, so the form leaves the value for them to paste. */
    filterValueIsPlaceholder: true,
    /**
     * The reachable shape for a router whose own event leaves the user in `data`: credit the
     * `Transfer` the router makes to them, constrained to that router as the sender. Both the token
     * and the sender are the campaign's to set.
     */
    source: {
      source: WETH_BASE,
      topic0: eventTopic("Transfer(address,address,uint256)"),
      actorTopic: 2,
      amountMode: AMOUNT_MODE.dataWord0,
      scale: BigInt(1e15),
      filterTopic: 1,
      filterValue: ZERO_TOPIC,
    } satisfies EventSource,
  },
] as const;

/** One-line description for the UI, e.g. `Deposit(address,uint256) on 0x4200…0006`. */
export function eventSourceSummary(src: EventSource, signature?: string): string {
  const event = signature ?? shortHex(src.topic0);
  return `${event} on ${shortHex(src.source)}`;
}

function shortHex(value: string): string {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

/**
 * The fixed-topic filter as a clause to append to a KPI description, or null when there is none.
 *
 * @param src Decoded event source.
 * @returns A phrase such as `from 0x816F…1770`, or null.
 */
export function describeTopicFilter(src: EventSource): string | null {
  if (!src.filterTopic || !src.filterValue) return null;

  const value = src.filterValue.toLowerCase();
  const isTransfer = src.topic0.toLowerCase() === TRANSFER_TOPIC0;
  if (value === ZERO_TOPIC) {
    return isTransfer && src.filterTopic === 1 ? "mints only" : `topic ${src.filterTopic} zero`;
  }

  // A left-padded address is by far the common case — a router, a bridge, a pool — and reads as one,
  // checksummed the way every other address in the UI is.
  const isAddress = value.startsWith(`0x${"0".repeat(24)}`);
  const shown = isAddress ? shortHex(getAddress(`0x${value.slice(26)}`)) : shortHex(value);
  return src.filterTopic === 1 && isTransfer ? `from ${shown}` : `topic ${src.filterTopic} ${shown}`;
}

// ── source liveness ──────────────────────────────────────────────

/**
 * What a probe found, ordered worst-first so a UI can render the head of the list.
 *
 * `error` means the KPI cannot ever credit progress as configured — an address holding no code
 * emits nothing, forever. `warn` means the configuration is *plausible but unconfirmed*: the most
 * common cause is a contract that is simply idle, and the second most common is a signature that
 * hashes to a topic the contract never emits. Nothing here can tell those two apart, which is
 * exactly why it is a warning and not a block.
 */
export type ProbeSeverity = "error" | "warn" | "ok";

export type ProbeFinding = {
  severity: ProbeSeverity;
  message: string;
};

/** Everything a probe needs, already trimmed. Mirrors the form draft without importing it. */
export type ProbeInput = {
  source: string;
  signature: string;
  /**
   * How the amount is taken from a matched log, when the form has settled on one.
   *
   * Optional because every caller predates it and because the interesting check below — a scale that
   * cannot do anything in `count` mode — is answerable without a source address, which the rest of
   * this type is about.
   */
  amountMode?: AmountMode;
  /** The raw scale as typed. A string, because a half-typed number is a normal state of a form. */
  scale?: string;
  /**
   * Which topic the form has chosen as the actor.
   *
   * Optional because callers that predate it omit it, but a probe given it can say that the chosen
   * topic is empty or is not an address — the two ways a KPI credits nothing with nothing to show.
   */
  actorTopic?: number;
  /** Which topic the form constrains to a literal, when it constrains one. 0 or absent means none. */
  filterTopic?: number;
  /** The filter value as typed, an address or a 32-byte word. */
  filterValue?: string;
};

/**
 * Blocks scanned when looking for a sample log.
 *
 * One window, not a full history walk. The question is "does this event ever fire here", and a
 * single hit answers it — walking further would burn a rate-limited public endpoint to raise
 * confidence in the *negative*, which stays unprovable however far back it looks. Held under the
 * 2000-block cap public RPCs enforce, matching `promoters.ts:MAX_LOG_RANGE`.
 */
export const PROBE_BLOCK_RANGE = 1900n;

/**
 * Structural checks that need no chain — a superset of what the form already blocks on.
 *
 * Exists so the probe can refuse to spend an RPC round trip on input that cannot possibly resolve,
 * and so the zero-address case gets named. That one matters: `EVENT_PRESETS` ships the ERC-721
 * entry with `source: address(0)` deliberately (the signature and topic layout are the reusable
 * part; the collection never is), so a project that picks the preset and skips the address field
 * has a KPI that encodes cleanly, deploys cleanly, and credits nothing.
 */
export function classifyEventSource(input: ProbeInput): ProbeFinding[] {
  const findings: ProbeFinding[] = [];
  const source = input.source.trim();
  const signature = input.signature.trim();

  /*
    The scale check runs first, and before the `!source` guard, deliberately.

    It needs no address — it is a statement about two other fields — and the form it most needs to
    reach is the half-filled one, where someone has picked a mode and typed a scale but not yet
    pasted a contract. Ordering it after the guards would silently withhold it from exactly that
    reader. `ProbeFinding[]` is documented as worst-first and this is a `warn`, so it is spliced in
    below rather than pushed, letting the `error`s that follow keep the head of the list.
  */
  const scaleFinding = classifyCountScale(input);

  // Independent of the address, so it is collected before the guards that return early on one.
  findings.push(...filterValueFindings(input));

  if (!source) return withScale(findings, scaleFinding);

  if (!isViemAddress(source, {strict: false})) {
    findings.push({severity: "error", message: "Not a valid address."});
    return withScale(findings, scaleFinding);
  }

  if (source.toLowerCase() === ZERO_ADDRESS) {
    findings.push({
      severity: "error",
      message: "This is the zero address — the preset's placeholder. Enter your own contract.",
    });
    return withScale(findings, scaleFinding);
  }

  if (signature && !SIGNATURE_RE.test(signature)) {
    findings.push({
      severity: "error",
      message: "Use types only, no spaces or names: Deposit(address,uint256).",
    });
  }

  return withScale(findings, scaleFinding);
}

/**
 * Flags a filter topic whose value is missing or malformed.
 *
 * A zero value is legal and means `address(0)` — a mint's `from` — so only an unset or unparseable
 * one is reported here.
 *
 * @param input The form's event-source fields.
 * @returns One error, or nothing.
 */
function filterValueFindings(input: ProbeInput): ProbeFinding[] {
  if (!input.filterTopic) return [];

  if (input.filterTopic > 3) {
    return [
      {
        severity: "error",
        message: `A log carries at most 3 indexed arguments, so filter topic ${input.filterTopic} cannot exist.`,
      },
    ];
  }

  if (input.actorTopic !== undefined && input.filterTopic === input.actorTopic) {
    return [
      {
        severity: "error",
        message: `Topic ${input.filterTopic} cannot be both the credited actor and a fixed value.`,
      },
    ];
  }

  if (!input.filterValue?.trim()) {
    return [
      {
        severity: "error",
        message: `Filter topic ${input.filterTopic} has no value to match. Enter the address or word it must equal.`,
      },
    ];
  }

  if (!normalizeTopicValue(input.filterValue)) {
    return [
      {
        severity: "error",
        message: "The filter value must be a 20-byte address or a 32-byte hex word.",
      },
    ];
  }

  return [];
}

/** Appends the advisory scale finding, keeping the list's worst-first order. */
function withScale(findings: ProbeFinding[], scale: ProbeFinding | null): ProbeFinding[] {
  return scale ? [...findings, scale] : findings;
}

/**
 * The one configuration that encodes cleanly, deploys cleanly, credits progress — and still means
 * something the project almost certainly did not intend.
 *
 * In `count` mode `indexerCore.rawAmount` returns exactly 1 per matching log, so there is no magnitude
 * for a scale to normalize; the divisor only makes thresholds harder to reach. It is *legal* and
 * expressible — "ten deposits per unit" is a real thing to want — so this is a `warn` and never a
 * block, per the form's stated posture. But it is how Base Sepolia's lynx campaign came to credit 51
 * WETH deposits as 5 units against a first tier of 50, which is 500 wraps.
 *
 * A scale of 1 (or a blank, or a zero, which `effectiveScale` reads as 1) is the correct setting here
 * and says nothing.
 */
function classifyCountScale(input: ProbeInput): ProbeFinding | null {
  if (input.amountMode !== AMOUNT_MODE.count) return null;

  const raw = input.scale?.trim();
  if (!raw) return null;

  // Anything unparseable is the form's own "Enter a whole number." to report, not this.
  let scale: bigint;
  try {
    scale = BigInt(raw);
  } catch {
    return null;
  }

  if (scale <= BigInt(1)) return null;

  return {
    severity: "warn",
    message:
      `In count mode every matching event is worth 1, so a scale of ${scale.toLocaleString("en-US")} ` +
      `means ${scale.toLocaleString("en-US")} events per unit of progress — it cannot measure size. ` +
      "Set the scale to 1, or switch Amount to Value to credit the event's own number.",
  };
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const SIGNATURE_RE = /^[A-Za-z_]\w*\([^)]*\)$/;

/**
 * The scale field as a bigint, or undefined when it is not one yet.
 *
 * A half-typed number is a normal state of a form, and the form's own "Enter a whole number." already
 * reports the malformed case — so anything unparseable here means "no scale to apply", which
 * `dataWordFindings` reads as 1, matching `effectiveScale`.
 */
function parseScaleField(raw: string | undefined): bigint | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  try {
    return BigInt(trimmed);
  } catch {
    return undefined;
  }
}

/**
 * The reads a probe makes. Narrowed from `PublicClient` so a test can pass a stub.
 *
 * `readContract` is optional because it is only used for the advisory identity line: every existing
 * caller and every stub predates it, and a probe that cannot name a contract is strictly less useful
 * rather than broken.
 */
export type ProbeClient = Pick<PublicClient, "getCode" | "getBlockNumber" | "getLogs"> &
  Partial<Pick<PublicClient, "readContract">>;

/** Context the probe cannot read off the client. */
export type ProbeOptions = {
  /** Which chain the address is on, for `knownContracts`. Without it, only a scan can name it. */
  chainId?: number;
};

/**
 * Asks the chain whether this source could ever credit anything.
 *
 * Three questions, in order, because each is only meaningful if the one before it passes:
 *
 *  1. **Is there code at the address?** `getCode` returning empty means an EOA or an address
 *     nobody has deployed to on *this* chain. This is the failure the form could not previously
 *     catch: a well-formed, correctly-checksummed address that emits nothing. It is reported as an
 *     error because no amount of promoter effort will ever move that KPI.
 *
 *  2. **What is this contract?** A known address, or whatever it calls itself. Pasting a contract
 *     address is the one step of the form with no feedback loop at all — a project cannot tell a
 *     mistyped pool from the right one by looking at the hex, and the campaign is immutable once
 *     deployed. Naming it back closes that loop. Advisory: an unnamed contract is completely normal.
 *
 *  3. **Has the event fired recently?** One `getLogs` over `PROBE_BLOCK_RANGE`. A hit proves the
 *     signature hashes to a topic this contract really emits — the strongest confirmation
 *     available short of running the indexer. A miss proves nothing on its own, so it downgrades
 *     to a warning naming both plausible causes.
 *
 * Never throws. An RPC that is down, rate-limited, or pointed at the wrong chain must not block a
 * campaign from being created — the probe is advisory, and the chain remains the only authority on
 * what actually gets credited.
 */
export async function probeEventSource(
  client: ProbeClient,
  input: ProbeInput,
  options: ProbeOptions = {},
): Promise<ProbeFinding[]> {
  const structural = classifyEventSource(input);
  if (structural.some((f) => f.severity === "error")) return structural;

  /*
    Advisory structural findings survive the chain probe.

    They describe the KPI's *configuration* — a scale that cannot act in the chosen mode — so nothing
    the chain reports about the contract can resolve them. Appended here, once, because every return
    path in `probeChain` builds a fresh list and would otherwise drop them the moment the address
    turned out to be real.
  */
  const advisory = structural.filter((f) => f.severity === "warn");
  const chain = await probeChain(client, input, options);

  return [...chain, ...advisory];
}

async function probeChain(
  client: ProbeClient,
  input: ProbeInput,
  options: ProbeOptions,
): Promise<ProbeFinding[]> {
  const source = input.source.trim() as `0x${string}`;
  const signature = input.signature.trim();

  let code: Hex | undefined;
  try {
    code = await client.getCode({address: source});
  } catch {
    return [{severity: "warn", message: "Could not reach the chain to check this address."}];
  }

  // viem returns undefined on some transports and "0x" on others for an address with no code.
  if (!code || code === "0x") {
    return [
      {
        severity: "error",
        message: "No contract deployed at this address on the connected chain.",
      },
    ];
  }

  // Appended to whatever the event check concludes rather than returned on its own, so the list
  // stays ordered worst-first — the identity line is never the most important thing on it.
  const identity = await identifyContract(client, source, options.chainId);

  if (!signature) return identity;

  const topic0 = eventTopic(signature);

  try {
    const head = await client.getBlockNumber();
    const fromBlock = head > PROBE_BLOCK_RANGE ? head - PROBE_BLOCK_RANGE : BigInt(0);

    const logs = await client.getLogs({
      address: source,
      fromBlock,
      toBlock: head,
      // Cast: viem types `topics` against a parsed ABI event; here the topic is the input.
    } as Parameters<ProbeClient["getLogs"]>[0]);

    const matched = logs.filter((log) => log.topics[0]?.toLowerCase() === topic0.toLowerCase());

    if (matched.length === 0) {
      return [
        {
          severity: "warn",
          message: `Contract found, but no ${signature} in the last ${PROBE_BLOCK_RANGE} blocks — either it is idle, or the signature does not match what it emits.`,
        },
        ...identity,
      ];
    }

    const sample = matched[0];
    const findings: ProbeFinding[] = [
      {severity: "ok", message: `Contract found and emitting ${signature}.`},
    ];

    // An actor topic the event does not carry can never resolve to a referral, so the indexer would
    // skip every log (`indexerCore.ts:actorFromTopic` returns null). Worth naming here because the
    // sample log is the only place the real topic count is visible before launch.
    findings.push(...actorTopicFindings(sample.topics.length, input.actorTopic));

    // And the only place a topic's *contents* are, which is what makes an actor topic resolvable.
    findings.push(...actorShapeFindings(sample.topics, input.actorTopic));

    findings.push(
      ...topicFilterFindings({
        logs: matched,
        topicCount: sample.topics.length,
        filterTopic: input.filterTopic,
        filterValue: input.filterValue,
        signature,
      }),
    );

    // And the only place the real *data* layout is, which is what `Value` mode depends on.
    findings.push(
      ...dataWordFindings({
        data: sample.data,
        amountMode: input.amountMode,
        scale: parseScaleField(input.scale),
      }),
    );

    findings.push(...identity);

    return findings;
  } catch {
    return [
      {
        severity: "warn",
        message: "Contract found, but the event history could not be read.",
      },
      ...identity,
    ];
  }
}

/**
 * Names the contract, if anything can.
 *
 * The catalog first, because the contracts worth naming are exactly the ones that will not name
 * themselves — Aave's Pool proxy and Sygma's bridge implement neither `name()` nor `symbol()`, so a
 * scan of either returns nothing at all. Tokens answer, and a token is what most campaigns watch.
 *
 * Returns `[]` rather than a finding when nothing resolves: "this contract does not publish a name"
 * is not a problem with the KPI, and a line saying so would train a reader to ignore the list.
 */
async function identifyContract(
  client: ProbeClient,
  address: `0x${string}`,
  chainId: number | undefined,
): Promise<ProbeFinding[]> {
  const known = knownContractName(chainId, address);
  if (known) {
    return [{severity: "ok", message: `Known contract: ${known}.`}];
  }

  if (!client.readContract) return [];

  const [name, symbol] = await Promise.all([
    readContractString(client, address, "name"),
    readContractString(client, address, "symbol"),
  ]);

  const label = contractLabel({name, symbol});
  if (!label) return [];

  return [{severity: "ok", message: `This contract calls itself ${label}.`}];
}

/**
 * One `name()`/`symbol()` read, or `undefined`.
 *
 * Every failure is expected and none is interesting: a contract without the metadata extension
 * reverts, and a proxy may return data that does not decode as a string. Swallowed individually so
 * one of the pair still names the contract when the other does not.
 */
function readContractString(
  client: ProbeClient,
  address: `0x${string}`,
  functionName: "name" | "symbol",
): Promise<string | undefined> {
  if (!client.readContract) return Promise.resolve(undefined);

  return client
    .readContract({address, abi: IERC20MetadataAbi, functionName})
    .then((value) => (typeof value === "string" ? value : undefined))
    .catch(() => undefined);
}

/**
 * Flags an actor topic the sampled log cannot carry.
 *
 * `topics.length` counts the signature at index 0, so a log with two topics exposes exactly one
 * indexed argument and only `actorTopic: 1` can resolve. Separated from the probe so the arithmetic
 * is testable without a chain.
 */
export function actorTopicFindings(topicCount: number, actorTopic?: number): ProbeFinding[] {
  const indexed = Math.max(0, topicCount - 1);

  if (indexed === 0) {
    return [
      {
        severity: "error",
        message:
          "This event indexes no arguments, so no topic carries the referral's address. It cannot be event-sourced.",
      },
    ];
  }

  if (actorTopic !== undefined && actorTopic > indexed) {
    return [
      {
        severity: "error",
        message: `This event has ${indexed} indexed argument${indexed === 1 ? "" : "s"}, so actor topic ${actorTopic} is empty. Use 1${indexed > 1 ? `–${indexed}` : ""}.`,
      },
    ];
  }

  return [];
}

/**
 * Flags an actor topic that holds something other than an address.
 *
 * `indexerCore.actorFromTopic` takes the low 20 bytes of whatever word it finds, so a `bytes32` or a
 * `uint256` at that index reads as a wallet no referral will ever match.
 *
 * @param topics Topics of a sampled log, signature included.
 * @param actorTopic The chosen actor topic, when the form has one.
 * @returns One error, or nothing.
 */
export function actorShapeFindings(
  topics: readonly (string | undefined)[],
  actorTopic: number | undefined,
): ProbeFinding[] {
  if (actorTopic === undefined) return [];

  const topic = topics[actorTopic];
  if (!topic || topic.length !== 66) return [];

  const high = topic.slice(2, 26);
  if (/^0+$/.test(high)) return [];

  return [
    {
      severity: "error",
      message:
        `Topic ${actorTopic} of that log is ${topic.slice(0, 10)}…${topic.slice(-6)}, which is not an ` +
        `address — it is a wider value, so crediting it would read its last 20 bytes as a wallet. ` +
        `Pick the topic that carries the user.`,
    },
  ];
}

/**
 * Flags a topic filter the sampled logs contradict.
 *
 * A filter no log matches is a `warn`, never an error: a deliberately narrow filter and a wrong one
 * look identical over one window.
 *
 * @param input Sampled logs, the sample's topic count, the filter fields, and the event signature.
 * @returns At most one finding.
 */
export function topicFilterFindings(input: {
  logs: readonly {topics: readonly (string | undefined)[]}[];
  topicCount: number;
  filterTopic: number | undefined;
  filterValue: string | undefined;
  signature: string;
}): ProbeFinding[] {
  if (!input.filterTopic) return [];

  const indexed = Math.max(0, input.topicCount - 1);
  if (input.filterTopic > indexed) {
    return [
      {
        severity: "error",
        message: `This event has ${indexed} indexed argument${indexed === 1 ? "" : "s"}, so filter topic ${input.filterTopic} is empty and nothing can match it.`,
      },
    ];
  }

  const value = normalizeTopicValue(input.filterValue);
  if (!value) return [];

  const matched = input.logs.filter(
    (log) => log.topics[input.filterTopic as number]?.toLowerCase() === value,
  );
  if (matched.length > 0) {
    return [
      {
        severity: "ok",
        message: `${matched.length} of the last ${input.logs.length} ${input.signature} events match the filter.`,
      },
    ];
  }

  return [
    {
      severity: "warn",
      message:
        `None of the ${input.logs.length} recent ${input.signature} events had topic ${input.filterTopic} ` +
        `equal to ${shortHex(value)} — either that sender is idle, or it is not the one this event carries there.`,
    },
  ];
}

/**
 * What `Value` mode would actually read out of a sampled log.
 *
 * The form's hardest field to reason about, because the label names a *choice* — count the events or
 * take their value — while the implementation takes the first 32-byte word of `log.data`
 * (`indexerCore.rawAmount`). Those coincide only when the event's first unindexed parameter happens to
 * be the number the project meant. `log.data` holds the unindexed parameters in declaration order, so
 * for `Trade(address indexed user, address token, uint256 amount)` word 0 is `token` — an address, read
 * as an integer around 1e48.
 *
 * Nothing else in the form can catch that. The signature field asks for **types only, no names**
 * (`validation.ts`), so no `indexed` keyword is available to work out which parameters reach `data` at
 * all; a sampled log is the only source of truth the create page has. Hence this reads the real word
 * from a real event and states the number, rather than explaining the layout.
 *
 * Worth the three findings because the blast radius is asymmetric. A gated KPI survives a misread word:
 * `min(claim, observed)` clamps it to Boney's own total, and the relayer decodes properly through
 * `valueParamIndex` with `validateParamIndexes` refusing a non-uint. A KPI with `verifier == address(0)`
 * has no such clamp — `Campaign.reportUserAction` credits `newTotal` as given — so one event crosses
 * every tier on the ladder. And `KpiSpec.params` has no setter, so it can only be caught before deploy.
 *
 * Silent in `count` mode and when the mode is unknown: there is no word to read, and every caller that
 * predates the field omits it.
 */
export function dataWordFindings(input: {
  /** `log.data` of a log that matched the configured topic. */
  data: Hex;
  amountMode: AmountMode | undefined;
  /** The configured scale, for the credited figure. Zero and undefined both mean 1. */
  scale?: bigint;
}): ProbeFinding[] {
  if (input.amountMode !== AMOUNT_MODE.dataWord0) return [];

  // "0x" plus one 32-byte word, the same floor `rawAmount` applies before it will read anything.
  if (input.data.length < 66) {
    return [
      {
        severity: "error",
        message:
          "Value mode has nothing to read: that log carries no unindexed data, so every parameter " +
          "is in a topic. Switch Amount to Count.",
      },
    ];
  }

  let word: bigint;
  try {
    word = BigInt(input.data.slice(0, 66));
  } catch {
    return [];
  }

  if (isAddressShaped(word)) {
    return [
      {
        severity: "warn",
        message:
          `Value mode would read 0x${input.data.slice(26, 66)} from that log — an address, not an ` +
          `amount. This event's first unindexed parameter is probably not the number you want; as ` +
          `written each event credits ${word.toLocaleString("en-US")}.`,
      },
    ];
  }

  const scale = !input.scale || input.scale === BigInt(0) ? BigInt(1) : input.scale;
  const credited = word / scale;

  return [
    {
      severity: "ok",
      message:
        `Value mode reads ${word.toLocaleString("en-US")} from that log — ` +
        `${formatTokenAmount(word, 18, {maxFractionDigits: 18})} if it is an 18-decimal token ` +
        `amount, and ${credited.toLocaleString("en-US")} unit${credited === BigInt(1) ? "" : "s"} ` +
        `of progress at this scale.`,
    },
  ];
}

/**
 * Whether a 32-byte word looks like a zero-padded address rather than a number.
 *
 * An address fills the low 20 bytes and nothing above them, so the test is: top 12 bytes clear
 * (`word < 2**160`) and the 20-byte region's own high byte set (`word >= 2**152`). A small amount fails
 * the second half — `1000 wei` leaves 30 bytes clear, not 12 — which is what keeps this off every
 * ordinary deposit.
 *
 * It is a heuristic, and deliberately a `warn`: amounts in `[2**152, 2**160)` are expressible, roughly
 * 5.7e27 tokens upward at 18 decimals. Absurd for a real token, not impossible, so the message states
 * what was read and lets the project decide.
 */
function isAddressShaped(word: bigint): boolean {
  return word >= BigInt(2) ** BigInt(152) && word < BigInt(2) ** BigInt(160);
}
