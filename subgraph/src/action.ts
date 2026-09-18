import {Address, BigInt, Bytes, ethereum} from "@graphprotocol/graph-ts";
import {KpiAction} from "../generated/schema";

/** Raw and normalized material for one supported event log. */
export function writeAction(
  event: ethereum.Event,
  topic0: string,
  topics: Array<Bytes>,
  data: Bytes,
  eventShape: string,
  user: Address,
  value: BigInt,
): void {
  const action = new KpiAction(eventId(event));
  action.source = event.address;
  action.topic0 = Bytes.fromHexString(topic0);
  if (topics.length > 0) action.topic1 = topics[0];
  if (topics.length > 1) action.topic2 = topics[1];
  if (topics.length > 2) action.topic3 = topics[2];
  action.data = data;
  action.eventShape = eventShape;
  action.user = user;
  action.value = value;
  action.blockNumber = event.block.number;
  action.timestamp = event.block.timestamp;
  action.txHash = event.transaction.hash;
  action.logIndex = event.logIndex;
  action.save();
}

/** ABI word containing an address. */
export function addressTopic(address: Address): Bytes {
  const encoded = ethereum.encode(ethereum.Value.fromAddress(address));
  if (encoded === null) return Bytes.empty();
  return encoded as Bytes;
}

/** ABI word containing an unsigned integer. */
export function uintTopic(value: BigInt): Bytes {
  const encoded = ethereum.encode(ethereum.Value.fromUnsignedBigInt(value));
  if (encoded === null) return Bytes.empty();
  return encoded as Bytes;
}

/** ABI-encoded event data tuple. */
export function eventData(values: Array<ethereum.Value>): Bytes {
  const encoded = ethereum.encode(ethereum.Value.fromTuple(changetype<ethereum.Tuple>(values)));
  if (encoded === null) return Bytes.empty();
  return encoded as Bytes;
}

/** Chronological identity for one Ethereum log. */
function eventId(event: ethereum.Event): string {
  return pad(event.block.number, 32) + "-" + pad(event.logIndex, 16) + "-" + event.transaction.hash.toHexString();
}

function pad(value: BigInt, width: i32): string {
  let result = value.toString();
  while (result.length < width) result = "0" + result;
  return result;
}
