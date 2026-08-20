import {Bytes} from "@graphprotocol/graph-ts";
import {Deposit} from "../generated/templates/WethDeposit/WETH";
import {Withdrawal} from "../generated/templates/WethWithdrawal/WETH";
import {KpiAction} from "../generated/schema";
import {DEPOSIT_TOPIC0, WITHDRAWAL_TOPIC0} from "./kpiSource";

/**
 * The WETH-shaped presets: one indexed address, one `uint256` in data.
 *
 * `Deposit(address indexed dst, uint256 wad)` backs the `weth-deposit` preset in
 * `web/src/lib/kpiSource.ts`, whose shape was confirmed against a real Base Sepolia log. `Withdrawal`
 * is its counterpart, and is here because the current fixture actually uses it — it is not in
 * `EVENT_PRESETS` yet, which is a gap on the TypeScript side rather than here.
 *
 * Separate templates rather than one with two handlers, even though both events live on the same
 * contract and share an ABI. Two data sources on one address is fine — each declares only its own
 * event, so neither sees the other's logs — and it keeps one KPI's spawn from silently indexing a
 * second event the KPI never asked for.
 *
 * Same two omissions as the `Transfer` presets: no scaling, no attribution check. See `transfer.ts`.
 */

export function handleWethDeposit(event: Deposit): void {
  const action = new KpiAction(
    event.transaction.hash.toHexString() + "-" + event.logIndex.toString(),
  );
  action.source = event.address;
  action.topic0 = Bytes.fromHexString(DEPOSIT_TOPIC0);
  action.user = event.params.dst;
  action.value = event.params.wad;
  action.blockNumber = event.block.number;
  action.timestamp = event.block.timestamp;
  action.save();
}

export function handleWethWithdrawal(event: Withdrawal): void {
  const action = new KpiAction(
    event.transaction.hash.toHexString() + "-" + event.logIndex.toString(),
  );
  action.source = event.address;
  action.topic0 = Bytes.fromHexString(WITHDRAWAL_TOPIC0);
  action.user = event.params.src;
  action.value = event.params.wad;
  action.blockNumber = event.block.number;
  action.timestamp = event.block.timestamp;
  action.save();
}
