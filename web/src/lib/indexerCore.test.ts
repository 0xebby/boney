import {describe, it, expect} from "vitest";
import {decodeAbiParameters, pad, toHex} from "viem";
import {
  actorFromTopic,
  aggregateByActor,
  blockChunks,
  decideReport,
  encodeActions,
  rawAmount,
  type IndexedLog,
} from "./indexerCore";
import {AMOUNT_MODE, type EventSource} from "./kpiSource";

const WETH_DEPOSIT_TOPIC =
  "0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c";

// Real Base Sepolia WETH depositors, checksummed with `cast to-check-sum-address` rather than by
// hand — a mistyped checksum makes viem throw somewhere far from the typo.
const ALICE = "0xDfAb13959371EFF8fdd71aecD1403FD78b743eE0" as const;
const BOB = "0x80d727579841B02eFb0364DD4C52fa3795593577" as const;

function source(overrides: Partial<EventSource> = {}): EventSource {
  return {
    source: "0x4200000000000000000000000000000000000006",
    topic0: WETH_DEPOSIT_TOPIC,
    actorTopic: 1,
    amountMode: AMOUNT_MODE.dataWord0,
    scale: BigInt(1e15),
    ...overrides,
  };
}

/** A WETH Deposit log, shaped exactly like the ones read off Base Sepolia. */
function depositLog(
  user: `0x${string}`,
  wad: bigint,
  blockNumber: bigint,
  timestamp = BigInt(1_700_000_000),
): IndexedLog {
  return {
    topics: [WETH_DEPOSIT_TOPIC, pad(user.toLowerCase() as `0x${string}`, {size: 32})],
    data: pad(toHex(wad), {size: 32}),
    blockNumber,
    timestamp,
  };
}

describe("actorFromTopic", () => {
  it("reads a checksummed address out of the low 20 bytes", () => {
    expect(actorFromTopic(depositLog(ALICE, BigInt(1e18), BigInt(1)), 1)).toBe(ALICE);
  });

  it("returns null when the topic is absent", () => {
    // A log from a different event with fewer topics — skipped, not fatal.
    expect(actorFromTopic(depositLog(ALICE, BigInt(1e18), BigInt(1)), 2)).toBeNull();
  });

  it("returns null for a malformed topic", () => {
    const log = {...depositLog(ALICE, BigInt(1e18), BigInt(1)), topics: [WETH_DEPOSIT_TOPIC, "0x00"]} as IndexedLog;
    expect(actorFromTopic(log, 1)).toBeNull();
  });
});

describe("rawAmount", () => {
  it("reads the first data word in dataWord0 mode", () => {
    expect(rawAmount(depositLog(ALICE, BigInt(3e15), BigInt(1)), AMOUNT_MODE.dataWord0)).toBe(
      BigInt(3e15),
    );
  });

  it("ignores the payload entirely in count mode", () => {
    // An ERC-721 Transfer's data word is a token id; summing ids would be nonsense.
    expect(rawAmount(depositLog(ALICE, BigInt(9_999), BigInt(1)), AMOUNT_MODE.count)).toBe(BigInt(1));
  });

  it("returns null when there is no data word to read", () => {
    const log = {...depositLog(ALICE, BigInt(1), BigInt(1)), data: "0x"} as IndexedLog;
    expect(rawAmount(log, AMOUNT_MODE.dataWord0)).toBeNull();
  });
});

describe("aggregateByActor", () => {
  it("sums one user's deposits and scales the total", () => {
    // 3 x 0.001 WETH at a 0.001 scale = 3 units of progress.
    const logs = [
      depositLog(ALICE, BigInt(1e15), BigInt(10)),
      depositLog(ALICE, BigInt(1e15), BigInt(11)),
      depositLog(ALICE, BigInt(1e15), BigInt(12)),
    ];

    const totals = aggregateByActor(logs, source());
    expect(totals.get(ALICE.toLowerCase())?.amount).toBe(BigInt(3));
  });

  it("keeps users separate", () => {
    const totals = aggregateByActor(
      [depositLog(ALICE, BigInt(5e15), BigInt(10)), depositLog(BOB, BigInt(2e15), BigInt(11))],
      source(),
    );

    expect(totals.get(ALICE.toLowerCase())?.amount).toBe(BigInt(5));
    expect(totals.get(BOB.toLowerCase())?.amount).toBe(BigInt(2));
  });

  /**
   * The bug this pins: scaling each log before summing floors every sub-scale deposit to zero, so
   * a user making many small deposits accrues nothing. Scaling the running total instead means
   * they add up.
   */
  it("scales the running total, not each log", () => {
    // Ten deposits of 0.0002 WETH = 0.002 WETH = 2 units. Each alone floors to 0.
    const logs = Array.from({length: 10}, (_, i) =>
      depositLog(ALICE, BigInt(2e14), BigInt(10 + i)),
    );

    expect(aggregateByActor(logs, source()).get(ALICE.toLowerCase())?.amount).toBe(BigInt(2));
  });

  it("drops a user whose total still rounds to nothing", () => {
    // Below scale with nothing to add to — reporting 0 is a no-op the campaign ignores anyway.
    const totals = aggregateByActor([depositLog(ALICE, BigInt(1e14), BigInt(10))], source());
    expect(totals.has(ALICE.toLowerCase())).toBe(false);
  });

  it("orders actions chronologically regardless of page order", () => {
    const totals = aggregateByActor(
      [
        depositLog(ALICE, BigInt(1e15), BigInt(30), BigInt(3_000)),
        depositLog(ALICE, BigInt(1e15), BigInt(10), BigInt(1_000)),
        depositLog(ALICE, BigInt(1e15), BigInt(20), BigInt(2_000)),
      ],
      source(),
    );

    const actions = totals.get(ALICE.toLowerCase())!.actions;
    expect(actions.map((a) => a.timestamp)).toEqual([BigInt(1_000), BigInt(2_000), BigInt(3_000)]);
  });

  /**
   * TouchWindowVerifier reverts EvidenceExceedsClaim when the evidence sums to more than the
   * reported amount, and silently under-credits when it sums to less. Apportioning has to be exact.
   */
  it("apportions actions to sum exactly to the reported total", () => {
    const logs = [
      depositLog(ALICE, BigInt(1_500_000_000_000_000), BigInt(10)),
      depositLog(ALICE, BigInt(1_500_000_000_000_000), BigInt(11)),
    ];

    const total = aggregateByActor(logs, source())!.get(ALICE.toLowerCase())!;
    const sum = total.actions.reduce((a, b) => a + b.amount, BigInt(0));

    expect(total.amount).toBe(BigInt(3));
    expect(sum).toBe(total.amount);
  });

  it("tracks the highest contributing block", () => {
    const totals = aggregateByActor(
      [depositLog(ALICE, BigInt(1e15), BigInt(10)), depositLog(ALICE, BigInt(1e15), BigInt(42))],
      source(),
    );
    expect(totals.get(ALICE.toLowerCase())?.lastBlock).toBe(BigInt(42));
  });

  it("counts events rather than amounts in count mode", () => {
    const totals = aggregateByActor(
      [
        depositLog(ALICE, BigInt(999), BigInt(10)),
        depositLog(ALICE, BigInt(888), BigInt(11)),
      ],
      source({amountMode: AMOUNT_MODE.count, scale: BigInt(1)}),
    );
    expect(totals.get(ALICE.toLowerCase())?.amount).toBe(BigInt(2));
  });

  it("skips logs whose actor topic is missing", () => {
    const orphan: IndexedLog = {
      topics: [WETH_DEPOSIT_TOPIC],
      data: pad(toHex(BigInt(5e15)), {size: 32}),
      blockNumber: BigInt(10),
      timestamp: BigInt(1_000),
    };
    expect(aggregateByActor([orphan], source()).size).toBe(0);
  });
});

describe("decideReport", () => {
  const total = {
    user: ALICE,
    amount: BigInt(5),
    actions: [{timestamp: BigInt(1_000), amount: BigInt(5)}],
    lastBlock: BigInt(10),
  };

  /**
   * The constraint that makes "index every mint and credit them all" impossible: storeTouch needs
   * the user's own signature, so a stranger's activity can never be credited.
   */
  it("refuses an unattributed user — Campaign would revert NoAttribution", () => {
    const decision = decideReport(total, false, BigInt(0));
    expect(decision.send).toBe(false);
    expect(decision.send === false && decision.reason).toMatch(/NoAttribution/);
  });

  it("sends when attributed and the total has grown", () => {
    const decision = decideReport(total, true, BigInt(2));
    expect(decision.send).toBe(true);
    // Cumulative, not a delta — Campaign computes the delta itself.
    expect(decision.send === true && decision.newTotal).toBe(BigInt(5));
  });

  it("is a no-op when re-indexing the same range", () => {
    expect(decideReport(total, true, BigInt(5)).send).toBe(false);
  });

  it("never reports a total below what the chain already credited", () => {
    // Would revert NonMonotonic. Can happen if a reorg drops logs the last run saw.
    expect(decideReport(total, true, BigInt(9)).send).toBe(false);
  });
});

describe("encodeActions", () => {
  it("round trips through the TouchWindowVerifier.Action[] layout", () => {
    const actions = [
      {timestamp: BigInt(1_700_000_000), amount: BigInt(2)},
      {timestamp: BigInt(1_700_000_500), amount: BigInt(3)},
    ];

    const [decoded] = decodeAbiParameters(
      [
        {
          type: "tuple[]",
          components: [
            {type: "uint64", name: "timestamp"},
            {type: "uint256", name: "amount"},
          ],
        },
      ],
      encodeActions(actions),
    );

    expect(decoded).toHaveLength(2);
    expect((decoded as readonly {timestamp: bigint; amount: bigint}[])[0]!.amount).toBe(BigInt(2));
  });
});

describe("blockChunks", () => {
  /** Base's public RPC rejects ranges over 2000 blocks: "query exceeds max block range 2000". */
  it("never emits a chunk wider than the limit", () => {
    const chunks = blockChunks(BigInt(0), BigInt(10_000), BigInt(2_000));
    for (const c of chunks) {
      expect(c.to - c.from + BigInt(1)).toBeLessThanOrEqual(BigInt(2_000));
    }
  });

  it("covers the range exactly, with no gaps or overlap", () => {
    const chunks = blockChunks(BigInt(100), BigInt(5_100), BigInt(2_000));
    expect(chunks[0]!.from).toBe(BigInt(100));
    expect(chunks[chunks.length - 1]!.to).toBe(BigInt(5_100));

    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.from).toBe(chunks[i - 1]!.to + BigInt(1));
    }
  });

  it("handles a single-block range", () => {
    expect(blockChunks(BigInt(7), BigInt(7), BigInt(2_000))).toEqual([
      {from: BigInt(7), to: BigInt(7)},
    ]);
  });

  it("returns nothing when the range is empty", () => {
    expect(blockChunks(BigInt(10), BigInt(9), BigInt(2_000))).toEqual([]);
  });

  it("rejects a non-positive chunk size rather than looping forever", () => {
    expect(() => blockChunks(BigInt(0), BigInt(10), BigInt(0))).toThrow(/positive/);
  });
});
