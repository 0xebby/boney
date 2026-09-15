import {Bytes, ethereum} from "@graphprotocol/graph-ts";
import {Deposit} from "../generated/templates/WethDeposit/WETH";
import {Withdrawal} from "../generated/templates/WethWithdrawal/WETH";
import {addressTopic, eventData, writeAction} from "./action";
import {
  DEPOSIT_TOPIC0,
  EVENT_SHAPE_WETH_DEPOSIT,
  EVENT_SHAPE_WETH_WITHDRAWAL,
  WITHDRAWAL_TOPIC0,
} from "./kpiSource";

/** Stores one WETH deposit. */
export function handleWethDeposit(event: Deposit): void {
  const topics = new Array<Bytes>(1);
  topics[0] = addressTopic(event.params.dst);
  const values = new Array<ethereum.Value>(1);
  values[0] = ethereum.Value.fromUnsignedBigInt(event.params.wad);

  writeAction(
    event,
    DEPOSIT_TOPIC0,
    topics,
    eventData(values),
    EVENT_SHAPE_WETH_DEPOSIT,
    event.params.dst,
    event.params.wad,
  );
}

/** Stores one WETH withdrawal. */
export function handleWethWithdrawal(event: Withdrawal): void {
  const topics = new Array<Bytes>(1);
  topics[0] = addressTopic(event.params.src);
  const values = new Array<ethereum.Value>(1);
  values[0] = ethereum.Value.fromUnsignedBigInt(event.params.wad);

  writeAction(
    event,
    WITHDRAWAL_TOPIC0,
    topics,
    eventData(values),
    EVENT_SHAPE_WETH_WITHDRAWAL,
    event.params.src,
    event.params.wad,
  );
}
