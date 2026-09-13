import {Address, BigInt, Bytes, crypto, ethereum} from "@graphprotocol/graph-ts";

/**
 * The AssemblyScript half of `web/src/lib/kpiSource.ts`.
 * decodes the commitment and names which template covers it, and nothing else.
 */

/** `AMOUNT_MODE` in `kpiSource.ts`. */
export const AMOUNT_MODE_COUNT: i32 = 0;
export const AMOUNT_MODE_DATA_WORD_0: i32 = 1;

export const EVENT_SHAPE_ERC20_TRANSFER: string = "erc20-transfer";
export const EVENT_SHAPE_ERC721_TRANSFER: string = "erc721-transfer";
export const EVENT_SHAPE_WETH_DEPOSIT: string = "weth-deposit";
export const EVENT_SHAPE_WETH_WITHDRAWAL: string = "weth-withdrawal";
export const EVENT_SHAPE_AAVE_SUPPLY: string = "aave-supply";
export const EVENT_SHAPE_SYGMA_DEPOSIT: string = "sygma-deposit";

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
 * are byte-identical.
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
 * wallets from the same log, so they cannot share a handler. 
 * 
 * A fixed-topic filter is not part of the identity: it narrows which logs a consumer credits, not which event shape is indexed, and a
 * template is shared across campaigns whose filters differ.
 *
 * A subgraph can only index signatures its manifest declares,
 * and a project may name any event on chain — see `UnsupportedSource` in the schema for what happens
 * to those.
 */
export function templateFor(src: EventSource): string | null {
  const topic0 = src.topic0.toHexString().toLowerCase();
  const sum = src.amountMode == AMOUNT_MODE_DATA_WORD_0;

  if (topic0 == TRANSFER_TOPIC0 && src.actorTopic == 2) {
    return sum ? "Erc20Transfer" : "Erc721Transfer";
  }

  if (topic0 == DEPOSIT_TOPIC0 && src.actorTopic == 1) return "WethDeposit";
  if (topic0 == WITHDRAWAL_TOPIC0 && src.actorTopic == 1) return "WethWithdrawal";
  if (topic0 == AAVE_SUPPLY_TOPIC0 && src.actorTopic == 2 && !sum) return "AaveSupply";
  if (topic0 == SYGMA_DEPOSIT_TOPIC0 && src.actorTopic == 1 && !sum) return "SygmaDeposit";

  return null;
}

/** Concrete event layout emitted by a manifest template. */
export function eventShapeForTemplate(template: string): string | null {
  if (template == "Erc20Transfer") return EVENT_SHAPE_ERC20_TRANSFER;
  if (template == "Erc721Transfer") return EVENT_SHAPE_ERC721_TRANSFER;
  if (template == "WethDeposit") return EVENT_SHAPE_WETH_DEPOSIT;
  if (template == "WethWithdrawal") return EVENT_SHAPE_WETH_WITHDRAWAL;
  if (template == "AaveSupply") return EVENT_SHAPE_AAVE_SUPPLY;
  if (template == "SygmaDeposit") return EVENT_SHAPE_SYGMA_DEPOSIT;
  return null;
}

/** Stable identity for the complete decoded KPI source commitment. */
export function sourceCommitmentId(campaign: Bytes, kpiIndex: i32, src: EventSource): string {
  const values = new Array<ethereum.Value>(7);
  values[0] = ethereum.Value.fromAddress(changetype<Address>(src.source));
  values[1] = ethereum.Value.fromFixedBytes(src.topic0);
  values[2] = ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(src.actorTopic));
  values[3] = ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(src.amountMode));
  values[4] = ethereum.Value.fromUnsignedBigInt(src.scale);
  values[5] = ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(src.filterTopic));
  values[6] = ethereum.Value.fromFixedBytes(src.filterValue);
  const encoded = ethereum.encode(ethereum.Value.fromTuple(changetype<ethereum.Tuple>(values)));
  if (encoded == null) return campaign.toHexString() + "-" + kpiIndex.toString();
  return crypto.keccak256(encoded as Bytes).toHexString();
}
