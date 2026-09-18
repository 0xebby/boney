import {type AbiEvent, type Hex} from "viem";
import {parseEventSignature} from "./relayCore";

/**
 * What Boneyard's KPI primitive can legally read out of one event.
 *
 * `KpiSpec.params` sees an event through seven fields: a source address, `topic0`, an `actorTopic`
 * of 1..3, `count` or `dataWord0`, a `scale` divisor, and an optional equality filter on one other
 * indexed topic. Everything here derives which of those are available for a given event, and names
 * the reason when one is not.
 *
 * Judgements are made on each parameter's **declared type**, never on a sampled log. A small
 * `uint256` has zero high bytes and so passes a runtime address-shape test while being a token id.
 */

// ── shape ────────────────────────────────────────────────────────

/** One event parameter, with the positions both halves of the config address it by. */
export type EventParam = {
  name?: string;
  type: string;
  indexed: boolean;
  /** Position in declaration order — what `EventMetricKpiVerifier` addresses params by. */
  index: number;
  /** Position in `log.topics`, or undefined when the parameter is not indexed. */
  topic?: 1 | 2 | 3;
};

/** An event reduced to the fields a KPI is configured from. */
export type EventShape = {
  name: string;
  /** The full declaration, `indexed` keywords included, as `EventMetricKpiVerifier` stores it. */
  declaration: string;
  /** Types only, as `topic0` is hashed over — `Staked(address,address,uint256)`. */
  compact: string;
  topic0: Hex;
  params: EventParam[];
};

/**
 * Reads a full event declaration into the shape the capability rules run over.
 *
 * @param declaration Full declaration with `indexed` keywords, e.g. `Staked(address indexed user, uint256 amount)`.
 * @returns The shape, or null when the declaration does not parse as an event.
 */
export function readEventShape(declaration: string): EventShape | null {
  const trimmed = declaration.trim();
  if (!trimmed) return null;

  let event: AbiEvent;
  let topic0: Hex;
  try {
    ({event, topic0} = parseEventSignature(trimmed));
  } catch {
    return null;
  }

  let nextTopic = 1;
  const params: EventParam[] = event.inputs.map((input, index) => {
    const indexed = input.indexed === true;
    // A non-anonymous event carries at most three indexed parameters; a fourth has no topic slot.
    const topic = indexed && nextTopic <= 3 ? (nextTopic++ as 1 | 2 | 3) : undefined;
    return {name: input.name, type: input.type, indexed, index, topic};
  });

  return {
    name: event.name,
    declaration: trimmed,
    compact: `${event.name}(${event.inputs.map((i) => i.type).join(",")})`,
    topic0,
    params,
  };
}

// ── blockers ─────────────────────────────────────────────────────

/** Why a reading is unavailable. Stable so tests and UI copy key on the code, not the wording. */
export type BlockerCode =
  | "no-indexed-address"
  | "no-non-indexed-param"
  | "amount-is-signed"
  | "amount-is-dynamic"
  | "amount-is-address"
  | "amount-not-numeric";

export type Blocker = {code: BlockerCode; message: string};

// ── readings ─────────────────────────────────────────────────────

/** An indexed parameter, addressable as a topic. */
export type TopicSlot = {topic: 1 | 2 | 3; param: EventParam};

/** Whether `dataWord0` reads a real amount, and what stops it when it does not. */
export type AmountCapability = {
  sound: boolean;
  /** The first non-indexed parameter — what `log.data`'s first word actually holds. */
  param?: EventParam;
  blocker?: Blocker;
};

/** Everything the planner may choose from for one event. */
export type Capability = {
  shape: EventShape;
  /** Topics holding an address — the only legal `actorTopic` values. */
  actorSlots: TopicSlot[];
  /** Every indexed topic. A filter may use any of these except the chosen actor's. */
  topicSlots: TopicSlot[];
  dataWord0: AmountCapability;
  /** Whether any per-user KPI can be built from this event at all. */
  attributable: boolean;
  blockers: Blocker[];
};

const UNSIGNED_INT = /^uint\d*$/;
const SIGNED_INT = /^int\d*$/;

/**
 * Derives what a KPI may read from one event.
 *
 * @param shape The event, from `readEventShape`.
 * @returns The available actor topics, filter topics and amount reading, with blockers named.
 */
export function describeCapability(shape: EventShape): Capability {
  const topicSlots: TopicSlot[] = shape.params
    .filter((param): param is EventParam & {topic: 1 | 2 | 3} => param.topic !== undefined)
    .map((param) => ({topic: param.topic, param}));

  const actorSlots = topicSlots.filter((slot) => slot.param.type === "address");
  const dataWord0 = describeAmount(shape);

  const blockers: Blocker[] = [];
  if (actorSlots.length === 0) {
    blockers.push({
      code: "no-indexed-address",
      message:
        `${shape.name} indexes no address, so no topic carries a wallet to credit. ` +
        `An event whose user sits in the data payload cannot back a KPI.`,
    });
  }

  return {
    shape,
    actorSlots,
    topicSlots,
    dataWord0,
    attributable: actorSlots.length > 0,
    blockers,
  };
}

/**
 * Whether the first word of `log.data` is an amount worth summing.
 *
 * @param shape The event being read.
 * @returns The first non-indexed parameter and whether `dataWord0` reads it soundly.
 */
function describeAmount(shape: EventShape): AmountCapability {
  const param = shape.params.find((p) => !p.indexed);
  if (!param) {
    return {
      sound: false,
      blocker: {
        code: "no-non-indexed-param",
        message: `${shape.name} has no non-indexed parameter, so there is no data word to read.`,
      },
    };
  }

  const label = param.name ? `${param.name} (${param.type})` : param.type;

  if (UNSIGNED_INT.test(param.type)) return {sound: true, param};

  if (SIGNED_INT.test(param.type)) {
    return {
      sound: false,
      param,
      blocker: {
        code: "amount-is-signed",
        message:
          `${shape.name}'s first data word is ${label}, which is signed. A negative value reads ` +
          `as its two's complement — around 1.16e77 units of progress. Count the event instead, ` +
          `or sum a token transfer leg.`,
      },
    };
  }

  if (param.type === "address") {
    return {
      sound: false,
      param,
      blocker: {
        code: "amount-is-address",
        message:
          `${shape.name}'s first data word is ${label}, not an amount. Summing it credits an ` +
          `address read as a number. Count the event instead.`,
      },
    };
  }

  if (isDynamic(param.type)) {
    return {
      sound: false,
      param,
      blocker: {
        code: "amount-is-dynamic",
        message:
          `${shape.name}'s first data word is ${label}, so that word is an ABI offset rather than ` +
          `a value. Count the event instead.`,
      },
    };
  }

  return {
    sound: false,
    param,
    blocker: {
      code: "amount-not-numeric",
      message: `${shape.name}'s first data word is ${label}, which is not a quantity.`,
    },
  };
}

/**
 * Whether a type is ABI-dynamic, so its head word is an offset rather than the value.
 *
 * @param type Solidity type name.
 * @returns True for arrays, `bytes` and `string`.
 */
function isDynamic(type: string): boolean {
  return type.endsWith("]") || type === "bytes" || type === "string";
}

// ── legality of a chosen configuration ───────────────────────────

/** A configuration the planner is considering, before it becomes a draft. */
export type ReadingChoice = {
  actorTopic: 1 | 2 | 3;
  amountMode: "count" | "dataWord0";
  filterTopic?: 1 | 2 | 3;
};

/**
 * Checks one reading against an event's capability.
 *
 * @param capability The event's available readings.
 * @param choice The actor topic, amount mode and optional filter topic being proposed.
 * @returns Blockers, empty when the reading is legal.
 */
export function checkReading(capability: Capability, choice: ReadingChoice): Blocker[] {
  const blockers: Blocker[] = [];
  const {shape} = capability;

  const actor = capability.topicSlots.find((slot) => slot.topic === choice.actorTopic);
  if (!actor) {
    blockers.push({
      code: "no-indexed-address",
      message: `${shape.name} has no topic ${choice.actorTopic} — it indexes ${capability.topicSlots.length} parameter(s).`,
    });
  } else if (actor.param.type !== "address") {
    const label = actor.param.name ? `${actor.param.name} (${actor.param.type})` : actor.param.type;
    blockers.push({
      code: "no-indexed-address",
      message:
        `Topic ${choice.actorTopic} of ${shape.name} is ${label}, not an address. ` +
        `Crediting it would credit a number read as a wallet.`,
    });
  }

  if (choice.amountMode === "dataWord0" && !capability.dataWord0.sound) {
    if (capability.dataWord0.blocker) blockers.push(capability.dataWord0.blocker);
  }

  if (choice.filterTopic !== undefined) {
    const filter = capability.topicSlots.find((slot) => slot.topic === choice.filterTopic);
    if (!filter) {
      blockers.push({
        code: "no-indexed-address",
        message: `${shape.name} has no topic ${choice.filterTopic} to filter on.`,
      });
    }
  }

  return blockers;
}
