import {BigInt, Bytes, ethereum} from "@graphprotocol/graph-ts";

/**
 * The AssemblyScript half of `web/src/lib/kpiSource.ts`.
 *
 * Same blob, same field order, same "0 means 1" reading of `scale`. Kept deliberately minimal: this
 * decodes the commitment and names which template covers it, and nothing else. Every rule about what
 * the decoded numbers *mean* for crediting stays on the TypeScript side, so there is one
 * implementation of the crediting rules rather than two that can drift.
 */

/** `AMOUNT_MODE` in `kpiSource.ts`. */
export const AMOUNT_MODE_COUNT: i32 = 0;
export const AMOUNT_MODE_DATA_WORD_0: i32 = 1;

/** `keccak256("Transfer(address,address,uint256)")`. */
export const TRANSFER_TOPIC0: string =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** `keccak256("Deposit(address,uint256)")` — WETH's, and the `weth-deposit` preset's. */
export const DEPOSIT_TOPIC0: string =
  "0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c";

/** `keccak256("Withdrawal(address,uint256)")` — WETH's counterpart to `Deposit`. */
export const WITHDRAWAL_TOPIC0: string =
  "0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65";

/**
 * Aave V3 Pool `Supply(address indexed reserve, address user, address indexed onBehalfOf,
 * uint256 amount, uint16 indexed referralCode)`, confirmed against live Base Sepolia logs.
 *
 * The actor is `onBehalfOf` (`topics[2]`), not `user` (`topics` carries no `user` — it is unindexed).
 * `user` is whoever sent the transaction; `onBehalfOf` is who receives the aTokens, and therefore who
 * actually performed the action being credited.
 */
export const AAVE_SUPPLY_TOPIC0: string =
  "0x2b627736bca15cd5381dcf80b0bf11fd197d01a037c52b927a881a10fb73ba61";

/**
 * Sygma `Deposit(uint8,bytes32,uint64,address indexed user,bytes,bytes)`, confirmed from deployed
 * bytecode.
 *
 * Named `Deposit` like WETH's but a completely different signature, so it hashes to a different
 * topic0 — which is exactly why matching on topic0 rather than on an event *name* is the only safe
 * way to resolve a template.
 */
export const SYGMA_DEPOSIT_TOPIC0: string =
  "0x17bc3181e17a9620a479c24e6c606e474ba84fc036877b768926872e8cd0e11f";

/**
 * Byte length of an unfiltered event-source blob: five 32-byte words.
 *
 * `TouchWindowVerifier` reads `params` as a bare 32-byte `uint64` lookback, so length is what tells
 * the encodings apart — exactly as `ENCODED_HEX_LENGTH` does in `kpiSource.ts`.
 */
const PARAMS_BYTE_LENGTH: i32 = 160;

/** Byte length of the filtered form: the same five words plus `filterTopic` and `filterValue`. */
const FILTERED_PARAMS_BYTE_LENGTH: i32 = 224;

/** `filterValue` of an unfiltered source, and the value a mint's `from` topic carries. */
const ZERO_TOPIC: string = "0x0000000000000000000000000000000000000000000000000000000000000000";

export class EventSource {
  source: Bytes;
  topic0: Bytes;
  actorTopic: i32;
  amountMode: i32;
  scale: BigInt;
  filterTopic: i32;
  filterValue: Bytes;

  constructor(
    source: Bytes,
    topic0: Bytes,
    actorTopic: i32,
    amountMode: i32,
    scale: BigInt,
    filterTopic: i32,
    filterValue: Bytes,
  ) {
    this.source = source;
    this.topic0 = topic0;
    this.actorTopic = actorTopic;
    this.amountMode = amountMode;
    this.scale = scale;
    this.filterTopic = filterTopic;
    this.filterValue = filterValue;
  }
}

/**
 * Decodes a `KpiSpec.params` blob, or null when it is not an event source.
 *
 * Never throws, for the same reason the TypeScript version never does: "not event-sourced" is the
 * normal case for KPIs that carry a verifier lookback or nothing at all, and a throw here would fail
 * the whole handler and stall indexing over a field no campaign is required to set.
 *
 * The fields are static types, so `abi.encode(a,b,…)` and the encoding of the static tuple `(a,b,…)`
 * are byte-identical — which is why one `ethereum.decode` call covers each form. Both lengths are
 * accepted: a source with no fixed-topic filter is encoded short, so every blob written before the
 * filter existed still decodes.
 */
export function decodeEventSource(params: Bytes): EventSource | null {
  const filtered = params.length == FILTERED_PARAMS_BYTE_LENGTH;
  if (params.length != PARAMS_BYTE_LENGTH && !filtered) return null;

  const signature = filtered
    ? "(address,bytes32,uint8,uint8,uint256,uint8,bytes32)"
    : "(address,bytes32,uint8,uint8,uint256)";
  const decoded = ethereum.decode(signature, params);
  if (decoded == null) return null;

  const parts = decoded.toTuple();
  if (parts.length != (filtered ? 7 : 5)) return null;

  const actorTopic = parts[2].toI32();
  const amountMode = parts[3].toI32();
  const filterTopic = filtered ? parts[5].toI32() : 0;
  const filterValue = filtered
    ? parts[6].toBytes()
    : Bytes.fromHexString(ZERO_TOPIC);

  // Same validity range the TypeScript decoder enforces: `topics[0]` is the signature, so an actor
  // at position 0 cannot exist, only two amount modes are defined, and a topic cannot be both the
  // credited actor and a literal the log must carry.
  if (actorTopic < 1 || actorTopic > 3) return null;
  if (amountMode != AMOUNT_MODE_COUNT && amountMode != AMOUNT_MODE_DATA_WORD_0) return null;
  if (filterTopic < 0 || filterTopic > 3) return null;
  if (filterTopic == actorTopic) return null;

  return new EventSource(
    changetype<Bytes>(parts[0].toAddress()),
    parts[1].toBytes(),
    actorTopic,
    amountMode,
    parts[4].toBigInt(),
    filterTopic,
    filterValue,
  );
}

/**
 * Which manifest template covers this event shape, or null when none does.
 *
 * A preset is identified by all three of `(topic0, actorTopic, amountMode)`, not by the event alone:
 * `Transfer` with the recipient as actor and `Transfer` with the sender as actor credit different
 * wallets from the same log, so they cannot share a handler. A fixed-topic filter is not part of the
 * identity: it narrows which logs a consumer credits, not which event shape is indexed, and a
 * template is shared across campaigns whose filters differ.
 *
 * Null is a real answer, not a failure. A subgraph can only index signatures its manifest declares,
 * and a project may name any event on chain — see `UnsupportedSource` in the schema for what happens
 * to those.
 */
export function templateFor(src: EventSource): string | null {
  const topic0 = src.topic0.toHexString().toLowerCase();
  const sum = src.amountMode == AMOUNT_MODE_DATA_WORD_0;

  if (topic0 == TRANSFER_TOPIC0 && src.actorTopic == 2) {
    // ERC-20/721 `Transfer` crediting the recipient. Two modes, two templates: summing `value` is a
    // volume KPI, counting logs is the `erc721-mint` preset, where the third topic is a token id and
    // summing ids would be meaningless.
    return sum ? "TransferToActor" : "TransferToActorCount";
  }

  // WETH-shaped `Deposit`/`Withdrawal`: one indexed address, one `uint256` in data. Count mode is not
  // offered — a "how many deposits" KPI is a legitimate thing to want, but no preset declares it, and
  // guessing here would index a shape nothing on the TypeScript side knows how to price.
  if (topic0 == DEPOSIT_TOPIC0 && src.actorTopic == 1 && sum) return "WethDeposit";
  if (topic0 == WITHDRAWAL_TOPIC0 && src.actorTopic == 1 && sum) return "WethWithdrawal";

  // Real third-party protocols. Both are COUNT-only on purpose, and `sum` is rejected rather than
  // quietly indexed: `amountMode` can only read the *first* data word, and neither event puts an
  // amount there — Aave's first word is `user` and Sygma's amount is buried inside `data`. A SUM KPI
  // over either would have the project and Boney denominating in different things.
  if (topic0 == AAVE_SUPPLY_TOPIC0 && src.actorTopic == 2 && !sum) return "AaveSupply";
  if (topic0 == SYGMA_DEPOSIT_TOPIC0 && src.actorTopic == 1 && !sum) return "SygmaDeposit";

  return null;
}
