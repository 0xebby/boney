import {BigInt, Bytes} from "@graphprotocol/graph-ts";
import {Supply} from "../generated/templates/AaveSupply/AavePool";
import {Deposit} from "../generated/templates/SygmaDeposit/SygmaBridge";
import {KpiAction} from "../generated/schema";
import {AAVE_SUPPLY_TOPIC0, SYGMA_DEPOSIT_TOPIC0} from "./kpiSource";

/**
 * Real third-party protocol presets — the ones that make a fixture demonstrate something.
 *
 * Both are COUNT-only, which is a property of the events rather than a preference. `amountMode` can
 * only read the *first* 32-byte data word, and neither event puts a creditable amount there: Aave's
 * first word is `user` and Sygma's amount is encoded inside `data`. A SUM KPI over either would leave
 * the project's claim and Boney's observation denominated in different things, so `templateFor` refuses
 * that combination outright.
 *
 * Every action is stored with `value = 1`. The unit is "one supply" / "one bridge deposit".
 */

/**
 * Aave V3 `Supply`, crediting `onBehalfOf`.
 *
 * **Not `user`.** `user` is whoever sent the transaction; `onBehalfOf` is who receives the aTokens and
 * therefore who performed the action being credited. They differ whenever a contract or a helper
 * supplies for someone else, and crediting the sender would pay the promoter of the wrong wallet — or
 * of no wallet at all, when the sender is a router with no attribution touch.
 */
export function handleAaveSupply(event: Supply): void {
  write(
    event.transaction.hash,
    event.logIndex,
    event.address,
    Bytes.fromHexString(AAVE_SUPPLY_TOPIC0),
    event.params.onBehalfOf,
    event.block.number,
    event.block.timestamp,
  );
}

/** Sygma bridge `Deposit`, crediting its single indexed `user`. */
export function handleSygmaDeposit(event: Deposit): void {
  write(
    event.transaction.hash,
    event.logIndex,
    event.address,
    Bytes.fromHexString(SYGMA_DEPOSIT_TOPIC0),
    event.params.user,
    event.block.number,
    event.block.timestamp,
  );
}

function write(
  txHash: Bytes,
  logIndex: BigInt,
  source: Bytes,
  topic0: Bytes,
  user: Bytes,
  blockNumber: BigInt,
  timestamp: BigInt,
): void {
  const action = new KpiAction(txHash.toHexString() + "-" + logIndex.toString());
  action.source = source;
  action.topic0 = topic0;
  action.user = user;
  action.value = BigInt.fromI32(1);
  action.blockNumber = blockNumber;
  action.timestamp = timestamp;
  action.save();
}
