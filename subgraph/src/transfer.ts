import {BigInt, Bytes, ethereum} from "@graphprotocol/graph-ts";
import {Transfer as Erc20Transfer} from "../generated/templates/Erc20Transfer/ERC20";
import {Transfer as Erc721Transfer} from "../generated/templates/Erc721Transfer/ERC721";
import {addressTopic, eventData, uintTopic, writeAction} from "./action";
import {
  EVENT_SHAPE_ERC20_TRANSFER,
  EVENT_SHAPE_ERC721_TRANSFER,
  TRANSFER_TOPIC0,
} from "./kpiSource";

/** Stores one ERC-20 transfer with its raw amount. */
export function handleErc20Transfer(event: Erc20Transfer): void {
  const topics = new Array<Bytes>(2);
  topics[0] = addressTopic(event.params.from);
  topics[1] = addressTopic(event.params.to);
  const values = new Array<ethereum.Value>(1);
  values[0] = ethereum.Value.fromUnsignedBigInt(event.params.value);

  writeAction(
    event,
    TRANSFER_TOPIC0,
    topics,
    eventData(values),
    EVENT_SHAPE_ERC20_TRANSFER,
    event.params.to,
    event.params.value,
  );
}

/** Stores one ERC-721 transfer with its token id as raw evidence. */
export function handleErc721Transfer(event: Erc721Transfer): void {
  const topics = new Array<Bytes>(3);
  topics[0] = addressTopic(event.params.from);
  topics[1] = addressTopic(event.params.to);
  topics[2] = uintTopic(event.params.tokenId);

  writeAction(
    event,
    TRANSFER_TOPIC0,
    topics,
    Bytes.empty(),
    EVENT_SHAPE_ERC721_TRANSFER,
    event.params.to,
    BigInt.fromI32(1),
  );
}
