import {AttributionRegistryAbi, CampaignAbi} from "./abis";

/**
 * Protocol event declarations, in one place.
 *
 * Every event this app reads is derived from the generated ABIs here rather than re-declared at the
 * point of use. Two hooks used to hold their own `parseAbiItem("event TouchStored(...)")` string,
 * each with a comment asking the reader to keep it identical to the Solidity. That is a second
 * source of truth for a signature that only the contracts get to define, and the failure is silent:
 * a renamed param or a dropped `indexed` keyword still parses, still computes a topic0, and the
 * `getLogs` call it feeds simply stops matching. The UI then shows an empty list, which is
 * indistinguishable from a campaign that genuinely has no touches.
 *
 * Deriving from the ABI removes the copy. `event()` throws when a name is absent, so a Solidity
 * rename surfaces as a loud failure on first use instead of an empty result set.
 *
 * Solidity keeps the matching invariant: every protocol error and event is declared in its module's
 * interface (`src/interfaces/*.sol`), which is what `pnpm abis` extracts.
 */

/** The ABI entry for `name`, narrowed to that specific event. */
type EventOf<abi extends readonly unknown[], name extends string> = Extract<
  abi[number],
  {type: "event"; name: name}
>;

/**
 * Pulls one event out of a generated ABI, preserving its exact arg types.
 *
 * The narrowing is what the hand-written signature strings were really buying: `getLogs({event})`
 * types `log.args` off this, so a widened `AbiEvent` would degrade every read to a union over each
 * of the contract's events.
 *
 * Throws rather than returning undefined. A missing event means the ABI and this file disagree
 * about what the contracts declare, and every downstream `getLogs` would quietly match nothing.
 */
function event<const abi extends readonly unknown[], const name extends string>(
  abi: abi,
  name: name,
): EventOf<abi, name> {
  const found = abi.find(
    (entry): entry is EventOf<abi, name> =>
      typeof entry === "object" &&
      entry !== null &&
      (entry as {type?: unknown}).type === "event" &&
      (entry as {name?: unknown}).name === name,
  );
  if (!found) throw new Error(`No event "${name}" in the generated ABI — run \`pnpm abis\`.`);
  return found;
}

/** `ICampaign.PromoterJoined` — a promoter cleared the reputation gate and joined. */
export const PROMOTER_JOINED = event(CampaignAbi, "PromoterJoined");

/** `IAttributionRegistry.TouchStored` — a referral signed attribution to a promoter. */
export const TOUCH_STORED = event(AttributionRegistryAbi, "TouchStored");
