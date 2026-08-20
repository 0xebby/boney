import {BigInt, Bytes} from "@graphprotocol/graph-ts";
import {Transfer} from "../generated/templates/TransferToActor/ERC20";
import {Transfer as TransferCount} from "../generated/templates/TransferToActorCount/ERC20";
import {KpiAction} from "../generated/schema";
import {TRANSFER_TOPIC0} from "./kpiSource";

/**
 * The `Transfer`-shaped presets: ERC-20/721 `Transfer` crediting the recipient.
 *
 * Two handlers because the amount mode is baked into the preset, not read at runtime:
 *
 *  - `TransferToActor` sums `value` — a volume KPI.
 *  - `TransferToActorCount` contributes 1 per log — the `erc721-mint` preset, where the third topic is
 *    a token id and summing ids would be meaningless.
 *
 * Two things both handlers deliberately do not do:
 *
 *  - **No scaling.** `value` is stored raw, in the token's own base units. `Kpi.scale` is carried on
 *    the KPI for the consumer to apply, mirroring `EventMetricKpiVerifier`, which also stores raw
 *    totals and divides only inside `verify`. Scaling per log would floor every sub-scale transfer to
 *    zero — the bug `aggregateByActor` has a comment about, and the one that shipped in the fixture.
 *  - **No attribution check.** Whether an action is creditable depends on the acting wallet's
 *    `Touch.signedAt`, which can move later via a promoter switch. Deciding it now would bake in an
 *    answer a re-signature invalidates. The filter runs at query time, in `relayCore.aggregateDeltas`.
 */

export function handleTransferToActor(event: Transfer): void {
  write(
    event.transaction.hash,
    event.logIndex,
    event.address,
    event.params.to,
    event.params.value,
    event.block.number,
    event.block.timestamp,
  );
}

export function handleTransferToActorCount(event: TransferCount): void {
  write(
    event.transaction.hash,
    event.logIndex,
    event.address,
    event.params.to,
    // Count mode: the payload is ignored entirely, so every matching log contributes exactly 1.
    BigInt.fromI32(1),
    event.block.number,
    event.block.timestamp,
  );
}

function write(
  txHash: Bytes,
  logIndex: BigInt,
  source: Bytes,
  user: Bytes,
  value: BigInt,
  blockNumber: BigInt,
  timestamp: BigInt,
): void {
  const action = new KpiAction(txHash.toHexString() + "-" + logIndex.toString());
  action.source = source;
  action.topic0 = Bytes.fromHexString(TRANSFER_TOPIC0);
  action.user = user;
  action.value = value;
  action.blockNumber = blockNumber;
  // The field the pre-attribution filter compares against `Touch.signedAt`. Free here; one `getBlock`
  // per distinct block in the RPC path this replaces.
  action.timestamp = timestamp;
  action.save();
}
