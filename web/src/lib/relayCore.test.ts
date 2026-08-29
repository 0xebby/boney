import {describe, it, expect} from "vitest";
import {encodeAbiParameters, pad, toEventSelector, parseAbiItem, type AbiEvent, type Hex} from "viem";
import {
  AGGREGATION,
  actorTopicToParamIndex,
  aggregateDeltas,
  decodeUserEvents,
  describeConfigDrift,
  nextTotals,
  parseEventSignature,
  planReportBatches,
  resolveScanRange,
  uniqueBlocks,
  validateParamIndexes,
  type KpiConfig,
  type RelayLog,
} from "./relayCore";
import {attributionLookup, buildAttributionWindows, type TouchLog} from "./attributionWindows";
import {AMOUNT_MODE} from "./kpiSource";

// Checksummed with `cast to-check-sum-address` rather than by hand — a mistyped checksum makes viem
// throw somewhere far from the typo.
const ALICE = "0xDfAb13959371EFF8fdd71aecD1403FD78b743eE0" as const;
const BOB = "0x80d727579841B02eFb0364DD4C52fa3795593577" as const;
const TOKEN = "0x4200000000000000000000000000000000000006" as const;

const DEPOSIT_SIG = "Deposit(address indexed user, uint256 amount)";
const TRANSFER_SIG = "Transfer(address indexed from, address indexed to, uint256 value)";

function config(overrides: Partial<KpiConfig> = {}): KpiConfig {
  return {
    targetContract: TOKEN,
    eventSignature: DEPOSIT_SIG,
    userParamIndex: 0,
    valueParamIndex: 1,
    aggregation: AGGREGATION.sum,
    scale: BigInt(1),
    windowStartBlock: BigInt(100),
    windowEndBlock: BigInt(1000),
    configured: true,
    ...overrides,
  };
}

/** A `Deposit(address indexed user, uint256 amount)` log. */
function depositLog(user: `0x${string}`, amount: bigint, blockNumber: bigint): RelayLog {
  return {
    topics: [toEventSelector(parseAbiItem(`event ${DEPOSIT_SIG}`) as AbiEvent), pad(user)],
    data: encodeAbiParameters([{type: "uint256"}], [amount]),
    blockNumber,
  };
}

describe("parseEventSignature", () => {
  it("derives the same topic0 the chain would", () => {
    // Canonical ERC-20 Transfer topic, independently known.
    const {topic0} = parseEventSignature(TRANSFER_SIG);
    expect(topic0).toBe("0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef");
  });

  it("handles a signature written without indexed keywords or names", () => {
    const {topic0} = parseEventSignature("Transfer(address,address,uint256)");
    expect(topic0).toBe("0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef");
  });

  it("exposes params in declaration order regardless of which are indexed", () => {
    const {event} = parseEventSignature(TRANSFER_SIG);
    expect(event.inputs.map((i) => i.name)).toEqual(["from", "to", "value"]);
  });

  it("throws on a signature that cannot parse, rather than scanning with a wrong topic", () => {
    expect(() => parseEventSignature("not a signature")).toThrow(/Could not parse/);
  });
});

describe("validateParamIndexes", () => {
  it("accepts a well-formed config", () => {
    const {event} = parseEventSignature(DEPOSIT_SIG);
    expect(() => validateParamIndexes(event, config())).not.toThrow();
  });

  it("rejects a user index past the end of the event", () => {
    const {event} = parseEventSignature(DEPOSIT_SIG);
    expect(() => validateParamIndexes(event, config({userParamIndex: 5}))).toThrow(/out of range/);
  });

  /**
   * The quiet failure this exists for: a non-address user param decodes into garbage that matches no
   * attributed wallet, so the run reports nothing and merely looks like a quiet period.
   */
  it("rejects a user index pointing at a non-address param", () => {
    const {event} = parseEventSignature(DEPOSIT_SIG);
    expect(() => validateParamIndexes(event, config({userParamIndex: 1}))).toThrow(
      /expected "address"/,
    );
  });

  it("rejects an unsummable value param under SUM", () => {
    const {event} = parseEventSignature(DEPOSIT_SIG);
    expect(() => validateParamIndexes(event, config({valueParamIndex: 0}))).toThrow(
      /cannot be summed/,
    );
  });

  it("ignores the value param under COUNT, which never reads it", () => {
    const {event} = parseEventSignature(DEPOSIT_SIG);
    const cfg = config({aggregation: AGGREGATION.count, valueParamIndex: 99});
    expect(() => validateParamIndexes(event, cfg)).not.toThrow();
  });
});

describe("resolveScanRange", () => {
  const base = {
    checkpoint: BigInt(0),
    windowStartBlock: BigInt(100),
    windowEndBlock: BigInt(1000),
    head: BigInt(500),
    confirmations: BigInt(5),
  };

  it("starts at the window on a first run and stays behind the head", () => {
    expect(resolveScanRange(base)).toEqual({
      scan: true,
      fromBlock: BigInt(100),
      toBlock: BigInt(495),
    });
  });

  it("resumes one past the checkpoint rather than rescanning it", () => {
    const r = resolveScanRange({...base, checkpoint: BigInt(300)});
    expect(r).toMatchObject({scan: true, fromBlock: BigInt(301)});
  });

  /**
   * The regression this guards. Totals are additive (`nextTotals` = stored + delta), so a range that
   * has already been folded in must not be walked again — rescanning from the window start counted a
   * single deposit once per relay cycle and drove the observed ceiling to 13 against a real count of 1.
   */
  it("never re-walks a range already folded into the stored totals", () => {
    const r = resolveScanRange({...base, checkpoint: BigInt(300)});
    if (!r.scan) throw new Error("expected a scan");
    expect(r.fromBlock > BigInt(300)).toBe(true);
  });

  /** Activity before tracking began is out of scope, and scanning it is pure RPC spend. */
  it("never starts before the window, even from a lower checkpoint", () => {
    const r = resolveScanRange({...base, checkpoint: BigInt(20)});
    expect(r).toMatchObject({scan: true, fromBlock: BigInt(100)});
  });

  /** Overshooting would do all the work and then revert `PastReportWindow` on chain. */
  it("clamps to the window end when the head has run past it", () => {
    const r = resolveScanRange({...base, head: BigInt(5000)});
    expect(r).toEqual({scan: true, fromBlock: BigInt(100), toBlock: BigInt(1000)});
  });

  it("stops entirely once the checkpoint reaches the window end", () => {
    const r = resolveScanRange({...base, checkpoint: BigInt(1000)});
    expect(r).toMatchObject({scan: false});
    if (!r.scan) expect(r.reason).toMatch(/fully scanned/);
  });

  it("reports nothing to do when no new confirmed blocks exist", () => {
    const r = resolveScanRange({...base, checkpoint: BigInt(495)});
    expect(r).toMatchObject({scan: false});
    if (!r.scan) expect(r.reason).toMatch(/nothing new/);
  });

  /** `head - confirmations` must clamp at 0 rather than going negative and scanning backwards. */
  it("does not underflow on a chain shorter than the confirmation depth", () => {
    const r = resolveScanRange({...base, head: BigInt(2), windowStartBlock: BigInt(1)});
    expect(r).toEqual({scan: false, reason: "nothing new to scan yet (next block would be 1)"});
  });
});

describe("decodeUserEvents", () => {
  it("decodes user and value by declaration position", () => {
    const {event} = parseEventSignature(DEPOSIT_SIG);
    const {decoded, undecodable} = decodeUserEvents(
      [depositLog(ALICE, BigInt(500), BigInt(10)), depositLog(BOB, BigInt(700), BigInt(11))],
      event,
      config(),
    );

    expect(undecodable).toBe(0);
    expect(decoded).toEqual([
      {user: ALICE.toLowerCase(), value: BigInt(500), blockNumber: BigInt(10)},
      {user: BOB.toLowerCase(), value: BigInt(700), blockNumber: BigInt(11)},
    ]);
  });

  /** COUNT ignores the payload, so an event whose data is a token id is still countable. */
  it("contributes 1 per log under COUNT, whatever the data says", () => {
    const {event} = parseEventSignature(DEPOSIT_SIG);
    const {decoded} = decodeUserEvents(
      [depositLog(ALICE, BigInt(99999), BigInt(10))],
      event,
      config({aggregation: AGGREGATION.count}),
    );

    expect(decoded[0]!.value).toBe(BigInt(1));
  });

  /**
   * The case a fixed word offset gets wrong. `to` is the *second* indexed param and `value` is the
   * only non-indexed one, so positions 1 and 2 have to resolve across two different log sections.
   */
  it("decodes a user in the second topic and a value in data", () => {
    const {event, topic0} = parseEventSignature(TRANSFER_SIG);
    const log: RelayLog = {
      topics: [topic0, pad(BOB), pad(ALICE)],
      data: encodeAbiParameters([{type: "uint256"}], [BigInt(4242)]),
      blockNumber: BigInt(7),
    };

    const {decoded} = decodeUserEvents(
      [log],
      event,
      config({eventSignature: TRANSFER_SIG, userParamIndex: 1, valueParamIndex: 2}),
    );

    expect(decoded).toEqual([{user: ALICE.toLowerCase(), value: BigInt(4242), blockNumber: BigInt(7)}]);
  });

  it("skips and counts a log that will not decode instead of abandoning the run", () => {
    const {event} = parseEventSignature(DEPOSIT_SIG);
    const broken: RelayLog = {topics: ["0xdeadbeef" as Hex], data: "0x", blockNumber: BigInt(1)};

    const {decoded, undecodable} = decodeUserEvents(
      [broken, depositLog(ALICE, BigInt(1), BigInt(2))],
      event,
      config(),
    );

    expect(undecodable).toBe(1);
    expect(decoded).toHaveLength(1);
  });
});

describe("uniqueBlocks", () => {
  it("dedupes so one RPC read covers shared blocks", () => {
    const decoded = [
      {user: ALICE.toLowerCase(), value: BigInt(1), blockNumber: BigInt(5)},
      {user: ALICE.toLowerCase(), value: BigInt(2), blockNumber: BigInt(5)},
      {user: BOB.toLowerCase(), value: BigInt(3), blockNumber: BigInt(6)},
    ];

    expect(uniqueBlocks(decoded)).toEqual([BigInt(5), BigInt(6)]);
  });
});

describe("aggregateDeltas", () => {
  const alice = ALICE.toLowerCase();
  const bob = BOB.toLowerCase();
  const ID_A = pad("0x0a", {size: 32});
  const ID_B = pad("0x0b", {size: 32});
  const FOREVER = BigInt(9_000);

  /**
   * A `TouchStored` log.
   *
   * @param user Wallet the touch attributes.
   * @param blockNumber Block the touch landed in — the window's exclusive lower bound.
   * @param expiresAt Second the attribution lapses, exclusive.
   * @param promoterId Promoter the window credits.
   * @returns The touch log.
   */
  function touchLog(
    user: `0x${string}`,
    blockNumber: bigint,
    expiresAt: bigint,
    promoterId: Hex = ID_A,
  ): TouchLog {
    return {user, promoterId, signedAt: expiresAt - BigInt(1), expiresAt, blockNumber};
  }

  /**
   * The attribution lookup those touches produce.
   *
   * @param touches Touch logs, in any order.
   * @param startTime Campaign start, below which nothing counts.
   * @returns The lookup `aggregateDeltas` takes.
   */
  function lookup(touches: readonly TouchLog[], startTime = BigInt(0)) {
    return attributionLookup(buildAttributionWindows(touches), startTime);
  }

  it("sums the logs falling inside a user's attribution window", () => {
    const result = aggregateDeltas({
      decoded: [
        {user: alice, value: BigInt(10), blockNumber: BigInt(2)},
        {user: alice, value: BigInt(5), blockNumber: BigInt(3)},
      ],
      attribution: lookup([touchLog(ALICE, BigInt(1), FOREVER)]),
      blockTimestamps: new Map([
        [BigInt(2), BigInt(1000)],
        [BigInt(3), BigInt(2000)],
      ]),
    });

    expect(result.deltas.get(alice)).toBe(BigInt(15));
    expect(result.excludedPreAttribution).toBe(0);
  });

  /**
   * A promoter did not cause activity that predates their touch, and `AttributionRegistry.promoterAt`
   * requires `storedAtBlock < atBlock` — so the touch's own block is excluded too.
   */
  it("excludes activity from the touch's block and earlier", () => {
    const result = aggregateDeltas({
      decoded: [
        {user: alice, value: BigInt(60), blockNumber: BigInt(1)},
        {user: alice, value: BigInt(40), blockNumber: BigInt(2)},
      ],
      attribution: lookup([touchLog(ALICE, BigInt(1), FOREVER)]),
      blockTimestamps: new Map([
        [BigInt(1), BigInt(1000)],
        [BigInt(2), BigInt(2000)],
      ]),
    });

    expect(result.deltas.get(alice)).toBe(BigInt(40));
    expect(result.excludedPreAttribution).toBe(1);
  });

  /**
   * The ceiling has to cover work done under a superseded touch, or it starves the retroactive credit
   * `Campaign` now pays: it splits the report per action, and `min(claim, observed)` is what caps it.
   */
  it("counts work done under a superseded touch", () => {
    const result = aggregateDeltas({
      decoded: [
        {user: alice, value: BigInt(10), blockNumber: BigInt(2)},
        {user: alice, value: BigInt(7), blockNumber: BigInt(11)},
      ],
      attribution: lookup([
        touchLog(ALICE, BigInt(1), FOREVER, ID_A),
        touchLog(ALICE, BigInt(10), FOREVER, ID_B),
      ]),
      blockTimestamps: new Map([
        [BigInt(2), BigInt(1000)],
        [BigInt(11), BigInt(2000)],
      ]),
    });

    expect(result.deltas.get(alice)).toBe(BigInt(17));
  });

  it("excludes activity from after the attribution lapsed", () => {
    const result = aggregateDeltas({
      decoded: [{user: alice, value: BigInt(10), blockNumber: BigInt(2)}],
      attribution: lookup([touchLog(ALICE, BigInt(1), BigInt(1500))]),
      blockTimestamps: new Map([[BigInt(2), BigInt(2000)]]),
    });

    expect(result.deltas.size).toBe(0);
    expect(result.excludedPreAttribution).toBe(1);
  });

  /**
   * `Campaign` credits nobody for these users, so reporting them would raise a cap nothing could ever
   * draw against.
   */
  it("skips users with no touch at all", () => {
    const result = aggregateDeltas({
      decoded: [
        {user: alice, value: BigInt(10), blockNumber: BigInt(2)},
        {user: bob, value: BigInt(99), blockNumber: BigInt(2)},
      ],
      attribution: lookup([touchLog(ALICE, BigInt(1), FOREVER)]),
      blockTimestamps: new Map([[BigInt(2), BigInt(1000)]]),
    });

    expect(result.deltas.has(bob)).toBe(false);
    expect(result.unattributed).toEqual([bob]);
  });

  /** Excluding beats assuming an unresolved block fell inside a window. */
  it("excludes a log whose block timestamp is unknown", () => {
    const result = aggregateDeltas({
      decoded: [{user: alice, value: BigInt(10), blockNumber: BigInt(9)}],
      attribution: lookup([touchLog(ALICE, BigInt(1), FOREVER)]),
      blockTimestamps: new Map(),
    });

    expect(result.deltas.size).toBe(0);
    expect(result.excludedPreAttribution).toBe(1);
  });

  it("excludes activity from before the campaign started", () => {
    const result = aggregateDeltas({
      decoded: [{user: alice, value: BigInt(10), blockNumber: BigInt(2)}],
      attribution: lookup([touchLog(ALICE, BigInt(1), FOREVER)], BigInt(1500)),
      blockTimestamps: new Map([[BigInt(2), BigInt(1000)]]),
    });

    expect(result.deltas.size).toBe(0);
    expect(result.excludedPreAttribution).toBe(1);
  });
});

describe("nextTotals", () => {
  const alice = ALICE.toLowerCase();

  it("adds this run's delta to the total already on chain", () => {
    const {users, totals} = nextTotals(
      new Map([[alice, BigInt(40)]]),
      new Map([[alice, BigInt(60)]]),
    );

    expect(users).toEqual([ALICE]);
    expect(totals).toEqual([BigInt(100)]);
  });

  it("treats an unreported user as starting from zero", () => {
    const {totals} = nextTotals(new Map([[alice, BigInt(7)]]), new Map());
    expect(totals).toEqual([BigInt(7)]);
  });

  it("returns checksummed addresses, since the contract call needs them", () => {
    const {users} = nextTotals(new Map([[alice, BigInt(1)]]), new Map());
    expect(users[0]).toBe(ALICE);
  });
});

describe("planReportBatches", () => {
  const users = [ALICE, BOB, ALICE, BOB, ALICE] as const;
  const totals = [BigInt(1), BigInt(2), BigInt(3), BigInt(4), BigInt(5)];

  it("sends everything in one transaction, carrying the new checkpoint", () => {
    const batches = planReportBatches({users, totals, size: 10, newCheckpoint: BigInt(200)});

    expect(batches).toHaveLength(1);
    expect(batches[0]!.checkpoint).toBe(BigInt(200));
    expect(batches[0]!.totals).toEqual(totals);
  });

  /**
   * Splitting by user is refused rather than performed. Totals are additive, so re-reporting a batch
   * is not the no-op re-pushing an absolute total was: holding the old checkpoint on the non-final
   * batches would double-add batch 1 on any retry, and advancing it on every batch would strand the
   * users a failed batch never reported. Both are silent; the throw is recoverable.
   */
  it("refuses to split by user rather than pick an unsafe checkpoint", () => {
    expect(() => planReportBatches({users, totals, size: 2, newCheckpoint: BigInt(200)})).toThrow(
      /exceeds the 2-per-transaction limit/,
    );
  });

  it("still advances the checkpoint when a range held no creditable activity", () => {
    const batches = planReportBatches({
      users: [],
      totals: [],
      size: 2,
      newCheckpoint: BigInt(200),
    });

    expect(batches).toEqual([{users: [], totals: [], checkpoint: BigInt(200)}]);
  });

  it("rejects mismatched inputs rather than reporting a misaligned total", () => {
    expect(() =>
      planReportBatches({users, totals: [BigInt(1)], size: 2, newCheckpoint: BigInt(1)}),
    ).toThrow(/length mismatch/);
  });
});

describe("actorTopicToParamIndex", () => {
  const transfer = parseEventSignature(TRANSFER_SIG).event;
  const supply = parseEventSignature(
    "Supply(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint16 indexed referralCode)",
  ).event;

  it("maps topics onto declaration order when every leading param is indexed", () => {
    expect(actorTopicToParamIndex(transfer, 1)).toBe(0); // from
    expect(actorTopicToParamIndex(transfer, 2)).toBe(1); // to
  });

  /** The case that makes this a mapping rather than an equality check. */
  it("skips non-indexed params when counting topics", () => {
    expect(actorTopicToParamIndex(supply, 1)).toBe(0); // reserve
    expect(actorTopicToParamIndex(supply, 2)).toBe(2); // onBehalfOf — 2nd indexed, 3rd declared
    expect(actorTopicToParamIndex(supply, 3)).toBe(4); // referralCode — 3rd indexed, 5th declared
  });

  it("returns null for a topic the event does not have", () => {
    expect(actorTopicToParamIndex(transfer, 3)).toBeNull();
    expect(actorTopicToParamIndex(supply, 4)).toBeNull();
  });

  /** `topics[0]` is the signature, so there is no actor topic 0. */
  it("rejects zero and negative topics", () => {
    expect(actorTopicToParamIndex(transfer, 0)).toBeNull();
    expect(actorTopicToParamIndex(transfer, -1)).toBeNull();
  });
});

describe("describeConfigDrift", () => {
  const TOPIC_A = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as const;
  const TOPIC_B = "0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c" as const;

  const agreed = {
    event: parseEventSignature(TRANSFER_SIG).event,
    verifierTopic0: TOPIC_A,
    verifierTarget: TOKEN,
    verifierScale: BigInt(1e18),
    verifierAggregation: AGGREGATION.sum,
    // `Transfer(from, to, value)`: param 1 is `to`, which is the second indexed param, so the
    // matching `actorTopic` is 2.
    verifierUserParamIndex: 1,
    indexerTopic0: TOPIC_A,
    indexerSource: TOKEN,
    indexerScale: BigInt(1e18),
    indexerAmountMode: AMOUNT_MODE.dataWord0,
    indexerActorTopic: 2,
  };

  it("passes when both halves describe the same event", () => {
    expect(describeConfigDrift(agreed)).toBeNull();
  });

  /**
   * The `to` vs `from` case, and the worst of the mismatches: both halves keep working and simply
   * credit different wallets, so `min(claim, observed)` is 0 for everyone and nothing is ever
   * credited. No revert, no error — just progress that never moves.
   */
  it("catches an actor mismatch between userParamIndex and actorTopic", () => {
    // actorTopic 1 is `from`; the verifier still credits param 1, `to`.
    const r = describeConfigDrift({...agreed, indexerActorTopic: 1});
    expect(r).toMatch(/actor mismatch/);
    expect(r).toMatch(/"to"/);
    expect(r).toMatch(/"from"/);
  });

  it("catches an actorTopic the event has no indexed param for", () => {
    // `Transfer` indexes two params, so topics[3] is empty and can never resolve a wallet.
    expect(describeConfigDrift({...agreed, indexerActorTopic: 3})).toMatch(
      /only 2 indexed param\(s\)/,
    );
  });

  /**
   * Aave's `Supply` is the case where the two coordinate systems genuinely diverge: `onBehalfOf` is
   * the *second* indexed param but the *third* declared one, and `referralCode` is topic 3 / param 4.
   * A naive `actorTopic === userParamIndex` comparison would reject this correct config.
   */
  it("accepts a correct config whose indexed and declaration positions differ", () => {
    const aave = parseEventSignature(
      "Supply(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint16 indexed referralCode)",
    );
    const r = describeConfigDrift({
      ...agreed,
      event: aave.event,
      verifierTopic0: aave.topic0,
      indexerTopic0: aave.topic0,
      verifierAggregation: AGGREGATION.count,
      indexerAmountMode: AMOUNT_MODE.count,
      verifierScale: BigInt(1),
      indexerScale: BigInt(1),
      verifierUserParamIndex: 2, // onBehalfOf
      indexerActorTopic: 2, // also onBehalfOf — second indexed param
    });
    expect(r).toBeNull();
  });

  it("catches crediting `reserve` when the verifier credits `onBehalfOf`", () => {
    const aave = parseEventSignature(
      "Supply(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint16 indexed referralCode)",
    );
    const r = describeConfigDrift({
      ...agreed,
      event: aave.event,
      verifierTopic0: aave.topic0,
      indexerTopic0: aave.topic0,
      verifierAggregation: AGGREGATION.count,
      indexerAmountMode: AMOUNT_MODE.count,
      verifierScale: BigInt(1),
      indexerScale: BigInt(1),
      verifierUserParamIndex: 2, // onBehalfOf
      indexerActorTopic: 1, // reserve — an address, so it decodes fine and credits the wrong thing
    });
    expect(r).toMatch(/actor mismatch/);
    expect(r).toMatch(/"reserve"/);
  });

  it("skips the actor check when the KPI carries no actorTopic", () => {
    expect(describeConfigDrift({...agreed, indexerActorTopic: undefined})).toBeNull();
  });

  it("is case-insensitive about the topic, as hex comparison should be", () => {
    expect(describeConfigDrift({...agreed, indexerTopic0: TOPIC_A.toUpperCase() as Hex})).toBeNull();
  });

  /** The expensive quiet failure: project claims one event, Boney verifies another, cap sits at 0. */
  it("catches a different event", () => {
    expect(describeConfigDrift({...agreed, indexerTopic0: TOPIC_B})).toMatch(/event mismatch/);
  });

  it("catches a different source contract", () => {
    expect(describeConfigDrift({...agreed, indexerSource: ALICE})).toMatch(/source mismatch/);
  });

  it("catches a scale that would mis-denominate the cap", () => {
    expect(describeConfigDrift({...agreed, indexerScale: BigInt(1e15)})).toMatch(/scale mismatch/);
  });

  it("treats 0 and 1 as the same scale, since both mean no scaling", () => {
    const r = describeConfigDrift({...agreed, verifierScale: BigInt(0), indexerScale: BigInt(1)});
    expect(r).toBeNull();
  });

  /** A KPI with no event-source blob is not indexer-driven, so there is nothing to disagree with. */
  it("stays quiet for a KPI that carries no event source", () => {
    const r = describeConfigDrift({...agreed, indexerTopic0: undefined, indexerSource: undefined});
    expect(r).toBeNull();
  });

  /**
   * The exact drift that shipped in `SeedDemo`: the verifier folded by SUM while the params blob
   * encoded `count`. Event, source and scale all matched, so every other check here passed — and the
   * indexer then divided a per-log count of 1 by the 1e18 token scale and reported nothing at all.
   */
  it("catches a verifier summing volume against params counting events", () => {
    const r = describeConfigDrift({...agreed, indexerAmountMode: AMOUNT_MODE.count});
    expect(r).toMatch(/aggregation mismatch/);
  });

  it("catches the reverse direction too", () => {
    const r = describeConfigDrift({
      ...agreed,
      verifierAggregation: AGGREGATION.count,
      indexerAmountMode: AMOUNT_MODE.dataWord0,
    });
    expect(r).toMatch(/aggregation mismatch/);
  });

  it("passes when both halves count", () => {
    const r = describeConfigDrift({
      ...agreed,
      verifierAggregation: AGGREGATION.count,
      indexerAmountMode: AMOUNT_MODE.count,
    });
    expect(r).toBeNull();
  });

  /** Nothing to compare against, so this must not be read as a COUNT and rejected. */
  it("skips the aggregation check when the blob carries no amount mode", () => {
    const r = describeConfigDrift({...agreed, indexerAmountMode: undefined});
    expect(r).toBeNull();
  });
});
