import {BigInt, Bytes, ethereum} from "@graphprotocol/graph-ts";
import {Supply} from "../generated/templates/AaveSupply/AavePool";
import {Deposit} from "../generated/templates/SygmaDeposit/SygmaBridge";
import {addressTopic, eventData, uintTopic, writeAction} from "./action";
import {
  AAVE_SUPPLY_TOPIC0,
  EVENT_SHAPE_AAVE_SUPPLY,
  EVENT_SHAPE_SYGMA_DEPOSIT,
  SYGMA_DEPOSIT_TOPIC0,
} from "./kpiSource";

/** Stores one Aave V3 supply credited to `onBehalfOf`. */
export function handleAaveSupply(event: Supply): void {
  const topics = new Array<Bytes>(3);
  topics[0] = addressTopic(event.params.reserve);
  topics[1] = addressTopic(event.params.onBehalfOf);
  topics[2] = uintTopic(BigInt.fromI32(event.params.referralCode));
  const values = new Array<ethereum.Value>(2);
  values[0] = ethereum.Value.fromAddress(event.params.user);
  values[1] = ethereum.Value.fromUnsignedBigInt(event.params.amount);

  writeAction(
    event,
    AAVE_SUPPLY_TOPIC0,
    topics,
    eventData(values),
    EVENT_SHAPE_AAVE_SUPPLY,
    event.params.onBehalfOf,
    BigInt.fromI32(1),
  );
}

/** Stores one Sygma bridge deposit credited to its indexed user. */
export function handleSygmaDeposit(event: Deposit): void {
  const topics = new Array<Bytes>(1);
  topics[0] = addressTopic(event.params.user);
  const values = new Array<ethereum.Value>(5);
  values[0] = ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(event.params.destinationDomainID));
  values[1] = ethereum.Value.fromFixedBytes(event.params.resourceID);
  values[2] = ethereum.Value.fromUnsignedBigInt(event.params.depositNonce);
  values[3] = ethereum.Value.fromBytes(event.params.data);
  values[4] = ethereum.Value.fromBytes(event.params.handlerResponse);

  writeAction(
    event,
    SYGMA_DEPOSIT_TOPIC0,
    topics,
    eventData(values),
    EVENT_SHAPE_SYGMA_DEPOSIT,
    event.params.user,
    BigInt.fromI32(1),
  );
}
