import {describe, it, expect} from "vitest";
import {decodeAbiParameters, pad, toHex, type Hex} from "viem";
import {
  actorFromTopic,
  aggregateActions,
  aggregateByActor,
  blockChunks,
  decideReport,
  logRequest,
  logScanKey,
  encodeActions,
  foldToLimit,
  rawAmount,
  tallyByPromoter,
  type IndexedLog,
} from "./indexerCore";
import {attributionLookup, buildAttributionWindows, type TouchLog} from "./attributionWindows";
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

const ID_A = pad("0x0a", {size: 32});
const ID_B = pad("0x0b", {size: 32});

/**
 * A `TouchStored` log, as `buildAttributionWindows` consumes them.
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
 * @param startTime Campaign start, below which nothing is creditable.
 * @returns The lookup `aggregateByActor` and `aggregateActions` take.
 */
function lookup(touches: readonly TouchLog[], startTime = BigInt(0)) {
  return attributionLookup(buildAttributionWindows(touches), startTime);
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

describe("aggregateByActor — attribution windows", () => {
  const T = BigInt(1_700_000_000);
  const LATER = T + BigInt(86_400);

  it("drops an action sharing the touch's own block, keeps the one after it", () => {
    // `AttributionRegistry.promoterAt` requires `storedAtBlock < atBlock`, so a touch never captures
    // the block it landed in.
    const totals = aggregateByActor(
      [
        depositLog(ALICE, BigInt(1e15), BigInt(10), T),
        depositLog(ALICE, BigInt(1e15), BigInt(11), T),
      ],
      source(),
      lookup([touchLog(ALICE, BigInt(10), LATER)]),
    );
    expect(totals.get(ALICE.toLowerCase())?.amount).toBe(BigInt(1));
  });

  it("drops activity from before the first touch", () => {
    const totals = aggregateByActor(
      [
        depositLog(ALICE, BigInt(1e15), BigInt(5), T),
        depositLog(ALICE, BigInt(1e15), BigInt(11), T),
        depositLog(ALICE, BigInt(1e15), BigInt(12), T),
      ],
      source(),
      lookup([touchLog(ALICE, BigInt(10), LATER)]),
    );
    // 2 of the 3, not 3 — the pre-attribution one credits a promoter who did not cause it.
    expect(totals.get(ALICE.toLowerCase())?.amount).toBe(BigInt(2));
  });

  it("keeps work done under a superseded touch", () => {
    const totals = aggregateByActor(
      [
        depositLog(ALICE, BigInt(1e15), BigInt(11), T),
        depositLog(ALICE, BigInt(1e15), BigInt(21), T + BigInt(60)),
      ],
      source(),
      lookup([
        touchLog(ALICE, BigInt(10), LATER, ID_A),
        touchLog(ALICE, BigInt(20), LATER, ID_B),
      ]),
    );
    // Both eras count toward the cumulative total; `Campaign` splits them between A and B.
    expect(totals.get(ALICE.toLowerCase())?.amount).toBe(BigInt(2));
  });

  it("drops an action at the second the touch expires", () => {
    const expiry = T + BigInt(60);
    const totals = aggregateByActor(
      [depositLog(ALICE, BigInt(5e15), BigInt(11), expiry)],
      source(),
      lookup([touchLog(ALICE, BigInt(10), expiry)]),
    );
    expect(totals.has(ALICE.toLowerCase())).toBe(false);
  });

  it("drops an action in a gap, rather than falling back to an older live touch", () => {
    const expiry = T + BigInt(60);
    const totals = aggregateByActor(
      [depositLog(ALICE, BigInt(5e15), BigInt(20), T + BigInt(120))],
      source(),
      lookup([
        touchLog(ALICE, BigInt(10), expiry, ID_A),
        touchLog(ALICE, BigInt(30), LATER, ID_B),
      ]),
    );
    // `Campaign` skips it too, so counting it would leave a total that can never settle.
    expect(totals.has(ALICE.toLowerCase())).toBe(false);
  });

  it("drops an actor with no window at all — never attributed", () => {
    const totals = aggregateByActor(
      [depositLog(BOB, BigInt(5e15), BigInt(11), T)],
      source(),
      lookup([touchLog(ALICE, BigInt(10), LATER)]),
    );
    expect(totals.has(BOB.toLowerCase())).toBe(false);
  });

  it("drops an action from before the campaign started", () => {
    const totals = aggregateByActor(
      [depositLog(ALICE, BigInt(5e15), BigInt(11), T)],
      source(),
      lookup([touchLog(ALICE, BigInt(10), LATER)], T + BigInt(1)),
    );
    expect(totals.has(ALICE.toLowerCase())).toBe(false);
  });

  /** Matches the relayer: unresolved is excluded rather than assumed to fall inside a window. */
  it("drops a log whose timestamp could not be resolved", () => {
    const totals = aggregateByActor(
      [depositLog(ALICE, BigInt(5e15), BigInt(11), BigInt(0))],
      source(),
      lookup([touchLog(ALICE, BigInt(10), LATER)]),
    );
    expect(totals.has(ALICE.toLowerCase())).toBe(false);
  });

  it("null opts out entirely, for diagnostics", () => {
    const totals = aggregateByActor(
      [depositLog(ALICE, BigInt(5e15), BigInt(10), BigInt(0))],
      source(),
      null,
    );
    expect(totals.get(ALICE.toLowerCase())?.amount).toBe(BigInt(5));
  });

  it("applies the same windows on the indexed path, so the two cannot disagree", () => {
    const src = source();
    const attribution = lookup([touchLog(ALICE, BigInt(10), LATER)]);

    const fromLogs = aggregateByActor(
      [
        depositLog(ALICE, BigInt(1e15), BigInt(10), T),
        depositLog(ALICE, BigInt(1e15), BigInt(11), T),
      ],
      src,
      attribution,
    );
    const fromIndexer = aggregateActions(
      [
        {user: ALICE, value: BigInt(1e15), blockNumber: BigInt(10), timestamp: T},
        {user: ALICE, value: BigInt(1e15), blockNumber: BigInt(11), timestamp: T},
      ],
      src,
      attribution,
    );

    expect(fromIndexer.get(ALICE.toLowerCase())?.amount).toBe(BigInt(1));
    expect(fromIndexer.get(ALICE.toLowerCase())?.amount).toBe(
      fromLogs.get(ALICE.toLowerCase())?.amount,
    );
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

    const totals = aggregateByActor(logs, source(), null);
    expect(totals.get(ALICE.toLowerCase())?.amount).toBe(BigInt(3));
  });

  it("keeps users separate", () => {
    const totals = aggregateByActor(
      [depositLog(ALICE, BigInt(5e15), BigInt(10)), depositLog(BOB, BigInt(2e15), BigInt(11))],
      source(),
      null,
    );

    expect(totals.get(ALICE.toLowerCase())?.amount).toBe(BigInt(5));
    expect(totals.get(BOB.toLowerCase())?.amount).toBe(BigInt(2));
  });

  /**
   * The bug this pins: scaling each log before summing floors every sub-scale deposit to zero, so
   * a referral making many small deposits accrues nothing. Scaling the running total instead means
   * they add up.
   */
  it("scales the running total, not each log", () => {
    // Ten deposits of 0.0002 WETH = 0.002 WETH = 2 units. Each alone floors to 0.
    const logs = Array.from({length: 10}, (_, i) =>
      depositLog(ALICE, BigInt(2e14), BigInt(10 + i)),
    );

    expect(aggregateByActor(logs, source(), null).get(ALICE.toLowerCase())?.amount).toBe(BigInt(2));
  });

  it("drops a referral whose total still rounds to nothing", () => {
    // Below scale with nothing to add to — reporting 0 is a no-op the campaign ignores anyway.
    const totals = aggregateByActor([depositLog(ALICE, BigInt(1e14), BigInt(10))], source(), null);
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
      null,
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

    const total = aggregateByActor(logs, source(), null)!.get(ALICE.toLowerCase())!;
    const sum = total.actions.reduce((a, b) => a + b.amount, BigInt(0));

    expect(total.amount).toBe(BigInt(3));
    expect(sum).toBe(total.amount);
  });

  it("tracks the highest contributing block", () => {
    const totals = aggregateByActor(
      [depositLog(ALICE, BigInt(1e15), BigInt(10)), depositLog(ALICE, BigInt(1e15), BigInt(42))],
      source(),
      null,
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
      null,
    );
    expect(totals.get(ALICE.toLowerCase())?.amount).toBe(BigInt(2));
  });

  /**
   * The bug this pins: `apportion` used to re-read each log's data word regardless of amount mode, so
   * a count-mode KPI split a total of *n events* across shares derived from token amounts. These two
   * logs produced `[999, -997]` — the sum was right, which is why the assertion above never caught it,
   * but a negative `uint256` cannot be encoded and the evidence was unusable on chain.
   */
  it("apportions count-mode evidence as whole events, never negatively", () => {
    const total = aggregateByActor(
      [depositLog(ALICE, BigInt(999), BigInt(10)), depositLog(ALICE, BigInt(888), BigInt(11))],
      source({amountMode: AMOUNT_MODE.count, scale: BigInt(1)}),
      null,
    ).get(ALICE.toLowerCase())!;

    expect(total.actions.map((a) => a.amount)).toEqual([BigInt(1), BigInt(1)]);
    for (const action of total.actions) expect(action.amount >= BigInt(0)).toBe(true);
    // Still exactly the claim, or `TouchWindowVerifier` reverts `EvidenceExceedsClaim`.
    expect(total.actions.reduce((a, b) => a + b.amount, BigInt(0))).toBe(total.amount);
  });

  /** Count-mode evidence has to survive the encoder a real report would put it through. */
  it("produces count-mode evidence that actually encodes", () => {
    const total = aggregateByActor(
      [depositLog(ALICE, BigInt(999), BigInt(10)), depositLog(ALICE, BigInt(888), BigInt(11))],
      source({amountMode: AMOUNT_MODE.count, scale: BigInt(1)}),
      null,
    ).get(ALICE.toLowerCase())!;

    expect(() => encodeActions(total.actions)).not.toThrow();
  });
});

/**
 * The indexed path must agree with the log-scanning path.
 *
 * Not a nice-to-have: the report panel and `pnpm index` can each take either route, and a referral
 * credited one figure by one and a different figure by the other is the silent-corruption failure this
 * module exists to prevent. Both funnel into the same fold, and these tests are what hold that.
 */
describe("aggregateActions", () => {
  const decoded = (value: bigint, blockNumber: bigint, timestamp: bigint) => ({
    user: ALICE,
    value,
    blockNumber,
    timestamp,
  });

  it("matches aggregateByActor on the same activity", () => {
    const src = source();
    const wads = [BigInt(1_500_000_000_000_000), BigInt(1_500_000_000_000_000)];

    const fromLogs = aggregateByActor(
      [depositLog(ALICE, wads[0]!, BigInt(10)), depositLog(ALICE, wads[1]!, BigInt(11))],
      src,
      null,
    ).get(ALICE.toLowerCase())!;

    const fromIndexer = aggregateActions(
      [
        decoded(wads[0]!, BigInt(10), BigInt(1_700_000_000)),
        decoded(wads[1]!, BigInt(11), BigInt(1_700_000_000)),
      ],
      src,
      null,
    ).get(ALICE.toLowerCase())!;

    expect(fromIndexer.amount).toBe(fromLogs.amount);
    expect(fromIndexer.actions).toEqual(fromLogs.actions);
    expect(fromIndexer.lastBlock).toBe(fromLogs.lastBlock);
  });

  it("applies count mode to the KPI, not to the stored value", () => {
    const totals = aggregateActions(
      [decoded(BigInt(999), BigInt(10), BigInt(1)), decoded(BigInt(888), BigInt(11), BigInt(2))],
      source({amountMode: AMOUNT_MODE.count, scale: BigInt(1)}),
      null,
    );

    expect(totals.get(ALICE.toLowerCase())?.amount).toBe(BigInt(2));
  });

  /** Same reason the log path sorts: out-of-order evidence verifies but reads as corrupt. */
  it("orders actions chronologically regardless of the order returned", () => {
    const totals = aggregateActions(
      [
        decoded(BigInt(1e15), BigInt(30), BigInt(3_000)),
        decoded(BigInt(1e15), BigInt(10), BigInt(1_000)),
        decoded(BigInt(1e15), BigInt(20), BigInt(2_000)),
      ],
      source({scale: BigInt(1e15)}),
      null,
    );

    expect(totals.get(ALICE.toLowerCase())!.actions.map((a) => a.timestamp)).toEqual([
      BigInt(1_000),
      BigInt(2_000),
      BigInt(3_000),
    ]);
  });

  /** Sub-scale activity accumulates rather than flooring away — the fixture's original bug. */
  it("accumulates sub-scale activity instead of dropping it", () => {
    const totals = aggregateActions(
      [
        decoded(BigInt(6e14), BigInt(10), BigInt(1)),
        decoded(BigInt(6e14), BigInt(11), BigInt(2)),
      ],
      source({scale: BigInt(1e15)}),
      null,
    );

    expect(totals.get(ALICE.toLowerCase())?.amount).toBe(BigInt(1));
  });
});

describe("aggregateByActor — log-shape edge cases", () => {
  /** WETH9 `Withdrawal(address indexed src, uint256 wad)` — the same shape as `Deposit`. */
  const WETH_WITHDRAWAL_TOPIC =
    "0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65" as const;

  it("skips a log of another event from the same contract", () => {
    // WETH's `Withdrawal` carries a wallet at topics[1] and a wad in data, exactly where `Deposit`
    // does, so a fold that trusted the request would credit withdrawals as deposits.
    const withdrawal: IndexedLog = {
      ...depositLog(ALICE, BigInt(5e15), BigInt(10)),
      topics: [WETH_WITHDRAWAL_TOPIC, pad(ALICE.toLowerCase() as `0x${string}`, {size: 32})],
    };

    expect(aggregateByActor([withdrawal], source(), null).size).toBe(0);
    expect(
      aggregateByActor(
        [withdrawal, depositLog(ALICE, BigInt(5e15), BigInt(11))],
        source(),
        null,
      ).get(ALICE.toLowerCase())?.amount,
    ).toBe(BigInt(5));
  });

  it("skips a log carrying no topics at all", () => {
    const bare: IndexedLog = {
      ...depositLog(ALICE, BigInt(5e15), BigInt(10)),
      topics: [],
    };
    expect(aggregateByActor([bare], source(), null).size).toBe(0);
  });

  it("matches the event signature case-insensitively", () => {
    const shouted: IndexedLog = {
      ...depositLog(ALICE, BigInt(5e15), BigInt(10)),
      topics: [
        WETH_DEPOSIT_TOPIC.toUpperCase().replace("0X", "0x") as `0x${string}`,
        pad(ALICE.toLowerCase() as `0x${string}`, {size: 32}),
      ],
    };
    expect(aggregateByActor([shouted], source(), null).get(ALICE.toLowerCase())?.amount).toBe(
      BigInt(5),
    );
  });

  it("skips logs whose actor topic is missing", () => {
    const orphan: IndexedLog = {
      topics: [WETH_DEPOSIT_TOPIC],
      data: pad(toHex(BigInt(5e15)), {size: 32}),
      blockNumber: BigInt(10),
      timestamp: BigInt(1_000),
    };
    expect(aggregateByActor([orphan], source(), null).size).toBe(0);
  });
});

describe("decideReport", () => {
  const total = {
    referral: ALICE,
    amount: BigInt(5),
    actions: [{blockNumber: BigInt(10), timestamp: BigInt(1_000), amount: BigInt(5)}],
    lastBlock: BigInt(10),
  };

  it("sends when the total has grown", () => {
    const decision = decideReport(total, BigInt(2));
    expect(decision.send).toBe(true);
    // Cumulative, not a delta — Campaign computes the delta itself.
    expect(decision.send === true && decision.newTotal).toBe(BigInt(5));
  });

  /**
   * The live touch is deliberately not a condition: `Campaign` credits each evidence action to
   * whoever held the referral at that action's block, so a report can pay a promoter whose touch has
   * since been superseded.
   */
  it("sends for a referral whose attribution has moved on", () => {
    expect(decideReport(total, BigInt(0)).send).toBe(true);
  });

  it("is a no-op when re-indexing the same range", () => {
    expect(decideReport(total, BigInt(5)).send).toBe(false);
  });

  it("never reports a total below what the chain already credited", () => {
    // Would revert NonMonotonic. Can happen if a reorg drops logs the last run saw.
    expect(decideReport(total, BigInt(9)).send).toBe(false);
  });
});

describe("encodeActions", () => {
  it("round trips through the Types.Action[] layout", () => {
    const actions = [
      {blockNumber: BigInt(100), timestamp: BigInt(1_700_000_000), amount: BigInt(2)},
      {blockNumber: BigInt(120), timestamp: BigInt(1_700_000_500), amount: BigInt(3)},
    ];

    const [decoded] = decodeAbiParameters(
      [
        {
          type: "tuple[]",
          components: [
            {type: "uint64", name: "blockNumber"},
            {type: "uint64", name: "timestamp"},
            {type: "uint256", name: "amount"},
          ],
        },
      ],
      encodeActions(actions),
    );

    expect(decoded).toHaveLength(2);
    // The block number is what `Campaign` asks `promotersAt` about, so it has to survive the encode.
    expect(decoded).toEqual(actions);
  });
});

/**
 * Evidence longer than `Campaign.MAX_EVIDENCE_ACTIONS` reverts `TooManyActions`, so a busy referral's
 * actions have to be folded rather than truncated — truncating would drop amount from a total the
 * report still claims.
 */
describe("foldToLimit", () => {
  const action = (blockNumber: bigint, amount: bigint, timestamp = blockNumber * BigInt(2)) => ({
    blockNumber,
    timestamp,
    amount,
  });

  it("leaves a list that already fits untouched", () => {
    const actions = [action(BigInt(1), BigInt(1)), action(BigInt(2), BigInt(2))];
    expect(foldToLimit(actions, 4)).toEqual(actions);
  });

  it("collapses same-block actions first, which loses nothing", () => {
    const folded = foldToLimit(
      [
        action(BigInt(10), BigInt(1), BigInt(100)),
        action(BigInt(10), BigInt(2), BigInt(100)),
        action(BigInt(11), BigInt(3), BigInt(110)),
      ],
      2,
    );

    // The chain's walk cannot tell two actions in one block apart, so the merge is exact.
    expect(folded).toEqual([
      {blockNumber: BigInt(10), timestamp: BigInt(100), amount: BigInt(3)},
      {blockNumber: BigInt(11), timestamp: BigInt(110), amount: BigInt(3)},
    ]);
  });

  it("folds a run onto its newest member", () => {
    const folded = foldToLimit(
      [
        action(BigInt(1), BigInt(1)),
        action(BigInt(2), BigInt(1)),
        action(BigInt(3), BigInt(1)),
        action(BigInt(4), BigInt(1)),
      ],
      2,
    );

    // Newest, so the entry resolves to the promoter holding attribution at that point.
    expect(folded).toEqual([
      {blockNumber: BigInt(2), timestamp: BigInt(4), amount: BigInt(2)},
      {blockNumber: BigInt(4), timestamp: BigInt(8), amount: BigInt(2)},
    ]);
  });

  it("preserves the sum and the ordering at any limit", () => {
    const actions = Array.from({length: 300}, (_, i) =>
      action(BigInt(i + 1), BigInt(i + 1)),
    );
    const expected = actions.reduce((a, b) => a + b.amount, BigInt(0));

    for (const limit of [1, 2, 7, 256, 299]) {
      const folded = foldToLimit(actions, limit);
      expect(folded.length).toBeLessThanOrEqual(limit);
      expect(folded.reduce((a, b) => a + b.amount, BigInt(0))).toBe(expected);
      for (let i = 1; i < folded.length; i++) {
        // `Campaign` reverts UnorderedEvidence on a block number that goes backwards.
        expect(folded[i]!.blockNumber > folded[i - 1]!.blockNumber).toBe(true);
      }
    }
  });

  it("keeps the newest action's block, so the last entry still resolves", () => {
    const actions = Array.from({length: 10}, (_, i) => action(BigInt(i + 1), BigInt(1)));
    const folded = foldToLimit(actions, 3);
    expect(folded[folded.length - 1]!.blockNumber).toBe(BigInt(10));
  });

  it("rejects a non-positive limit rather than returning nothing", () => {
    expect(() => foldToLimit([action(BigInt(1), BigInt(1))], 0)).toThrow(/positive/);
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

// ── the fixed-topic filter ───────────────────────────────────────

const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as const;

/** The LiFi router on Base Sepolia, and a second address to point a filter at instead. */
const ROUTER = "0x816Fc6EeE47e3157A666827a0C06205294C81770" as const;
const OTHER_ROUTER = "0x4200000000000000000000000000000000000006" as const;

const asTopic = (address: `0x${string}`) =>
  pad(address.toLowerCase() as `0x${string}`, {size: 32});

/** An ERC-20 `Transfer`, with the sender at topic 1 and the recipient at topic 2. */
function transferLog(
  from: `0x${string}`,
  to: `0x${string}`,
  value: bigint,
  blockNumber: bigint,
): IndexedLog {
  return {
    topics: [TRANSFER_TOPIC, asTopic(from), asTopic(to)],
    data: pad(toHex(value), {size: 32}),
    blockNumber,
    timestamp: BigInt(1_700_000_000),
  };
}

function transferSource(overrides: Partial<EventSource> = {}): EventSource {
  return source({
    topic0: TRANSFER_TOPIC,
    actorTopic: 2,
    amountMode: AMOUNT_MODE.dataWord0,
    ...overrides,
  });
}

describe("aggregateByActor — the fixed-topic filter", () => {
  const ZERO = "0x0000000000000000000000000000000000000000" as const;

  it("keeps only the logs whose filtered topic matches", () => {
    const logs = [
      transferLog(ROUTER, ALICE, BigInt(4e15), BigInt(100)),
      transferLog(OTHER_ROUTER, ALICE, BigInt(9e15), BigInt(101)),
      transferLog(ROUTER, ALICE, BigInt(2e15), BigInt(102)),
    ];

    const filtered = aggregateByActor(
      logs,
      transferSource({filterTopic: 1, filterValue: asTopic(ROUTER)}),
      null,
    );
    expect(filtered.get(ALICE.toLowerCase())?.amount).toBe(BigInt(6));
    expect(filtered.get(ALICE.toLowerCase())?.actions).toHaveLength(2);
  });

  it("counts every log when no filter is set", () => {
    const logs = [
      transferLog(ROUTER, ALICE, BigInt(4e15), BigInt(100)),
      transferLog(OTHER_ROUTER, ALICE, BigInt(9e15), BigInt(101)),
      transferLog(ROUTER, ALICE, BigInt(2e15), BigInt(102)),
    ];

    expect(aggregateByActor(logs, transferSource(), null).get(ALICE.toLowerCase())?.amount).toBe(
      BigInt(15),
    );
  });

  it("credits nothing when the filter names a router nobody used", () => {
    const logs = [transferLog(ROUTER, ALICE, BigInt(9e15), BigInt(100))];

    const totals = aggregateByActor(
      logs,
      transferSource({filterTopic: 1, filterValue: asTopic(OTHER_ROUTER)}),
      null,
    );
    expect(totals.size).toBe(0);
  });

  it("reads a zero filter value as mints only", () => {
    // The `erc721-mint-only` preset: `from == address(0)` is a mint, anything else is a resale.
    const logs = [
      transferLog(ZERO, ALICE, BigInt(1), BigInt(100)),
      transferLog(BOB, ALICE, BigInt(2), BigInt(101)),
      transferLog(ZERO, ALICE, BigInt(3), BigInt(102)),
      transferLog(ZERO, BOB, BigInt(4), BigInt(103)),
    ];

    const totals = aggregateByActor(
      logs,
      transferSource({
        amountMode: AMOUNT_MODE.count,
        scale: BigInt(1),
        filterTopic: 1,
        filterValue: asTopic(ZERO),
      }),
      null,
    );
    expect(totals.get(ALICE.toLowerCase())?.amount).toBe(BigInt(2));
    expect(totals.get(BOB.toLowerCase())?.amount).toBe(BigInt(1));
  });

  it("drops a log that does not carry the filtered topic at all", () => {
    // An ERC-721 `Transfer` indexes the token id, so a filter on topic 3 finds a word; a
    // three-topic ERC-20 log has nothing there and must not slip through.
    const logs = [transferLog(ROUTER, ALICE, BigInt(9e15), BigInt(100))];

    const totals = aggregateByActor(
      logs,
      transferSource({filterTopic: 3, filterValue: asTopic(ROUTER)}),
      null,
    );
    expect(totals.size).toBe(0);
  });
});

describe("the LiFi swap this filter was built for", () => {
  // Base Sepolia tx 0x48a3b136…a957: a swap through the LiFi router emits
  // `LiFiGenericSwapCompleted`, which indexes only `transactionId`, plus a WETH `Transfer` from the
  // router to the receiver carrying `toAmount` to the wei. The Transfer is the reachable proxy.
  const ACTOR = "0xba954E89cE301415964E9405f09F4Cc7c668976A" as const;
  const TO_AMOUNT = BigInt("0x237035aba27000");
  const WETH = "0x4200000000000000000000000000000000000006" as const;

  const swapSource = (filterValue: `0x${string}`): EventSource => ({
    source: WETH,
    topic0: TRANSFER_TOPIC,
    actorTopic: 2,
    amountMode: AMOUNT_MODE.dataWord0,
    scale: BigInt(1e15),
    filterTopic: 1,
    filterValue,
  });

  const logs = [
    transferLog(ROUTER, ACTOR, TO_AMOUNT, BigInt(46111150)),
    // Unrelated WETH arriving at the same wallet: a plain send, not a swap.
    transferLog(BOB, ACTOR, BigInt(50e15), BigInt(46111160)),
  ];

  it("credits the swap's toAmount and nothing else", () => {
    const totals = aggregateByActor(logs, swapSource(asTopic(ROUTER)), null);
    expect(totals.get(ACTOR.toLowerCase())?.amount).toBe(BigInt(9));
    expect(totals.get(ACTOR.toLowerCase())?.actions).toHaveLength(1);
  });

  it("credits nothing when the filter points at a different router", () => {
    expect(aggregateByActor(logs, swapSource(asTopic(OTHER_ROUTER)), null).size).toBe(0);
  });

  it("would credit the unrelated transfer too without the filter", () => {
    const {source, topic0, actorTopic, amountMode, scale} = swapSource(asTopic(ROUTER));
    const unfiltered: EventSource = {source, topic0, actorTopic, amountMode, scale};
    expect(aggregateByActor(logs, unfiltered, null).get(ACTOR.toLowerCase())?.amount).toBe(
      BigInt(59),
    );
  });
});

/**
 * The split `Campaign._tally` makes, mirrored in the browser.
 *
 * A referral's observed total is one number, but the credit is not: the chain walks the evidence and
 * adds each action to whoever held the referral at that action's block. A panel that selects by
 * promoter has to show that promoter's share, and the only way it cannot disagree with the chain is
 * to tally the same apportioned actions `encodeActions` sends.
 */
describe("tallyByPromoter", () => {
  const T = BigInt(1_700_000_000);
  const EXPIRES = T + BigInt(86_400);

  it("credits each action to whoever held the referral at its block", () => {
    const attribution = lookup([
      touchLog(ALICE, BigInt(10), EXPIRES, ID_A),
      touchLog(ALICE, BigInt(30), EXPIRES, ID_B),
    ]);
    const actions = [
      {blockNumber: BigInt(20), timestamp: T, amount: BigInt(4)},
      {blockNumber: BigInt(40), timestamp: T, amount: BigInt(6)},
    ];

    const tally = tallyByPromoter(ALICE, actions, attribution);
    expect(tally.get(ID_A.toLowerCase())).toBe(BigInt(4));
    expect(tally.get(ID_B.toLowerCase())).toBe(BigInt(6));
  });

  it("sums repeat spells under the same promoter", () => {
    const attribution = lookup([touchLog(ALICE, BigInt(10), EXPIRES, ID_A)]);
    const actions = [
      {blockNumber: BigInt(20), timestamp: T, amount: BigInt(4)},
      {blockNumber: BigInt(21), timestamp: T, amount: BigInt(6)},
    ];

    const tally = tallyByPromoter(ALICE, actions, attribution);
    expect(tally.size).toBe(1);
    expect(tally.get(ID_A.toLowerCase())).toBe(BigInt(10));
  });

  it("drops an action nobody held", () => {
    // Before the first touch, so no window covers it — the same action `aggregateByActor` would have
    // refused to count in the first place.
    const attribution = lookup([touchLog(ALICE, BigInt(30), EXPIRES, ID_A)]);
    const tally = tallyByPromoter(
      ALICE,
      [{blockNumber: BigInt(20), timestamp: T, amount: BigInt(4)}],
      attribution,
    );
    expect(tally.size).toBe(0);
  });

  /**
   * The property that makes the panel's figure trustworthy: tallying the apportioned actions cannot
   * lose or invent units against the total the same scan produced.
   */
  it("sums to the referral's observed total over the evidence the chain receives", () => {
    const attribution = lookup([
      touchLog(ALICE, BigInt(10), EXPIRES, ID_A),
      touchLog(ALICE, BigInt(30), EXPIRES, ID_B),
    ]);
    const logs = [
      depositLog(ALICE, BigInt(4.5e15), BigInt(20), T),
      depositLog(ALICE, BigInt(6.5e15), BigInt(40), T),
    ];

    const total = aggregateByActor(logs, source(), attribution).get(ALICE.toLowerCase());
    if (!total) throw new Error("expected a total");

    const tally = tallyByPromoter(ALICE, total.actions, attribution);
    const summed = [...tally.values()].reduce((sum, v) => sum + v, BigInt(0));
    expect(summed).toBe(total.amount);
  });
});

describe("logRequest", () => {
  const FROM = BigInt(46_130_021);
  const TO = BigInt(46_277_856);

  it("names the event and the range in the shapes eth_getLogs takes", () => {
    const src = source();
    expect(logRequest(src.source, src.topic0, src, FROM, TO)).toEqual({
      address: src.source,
      fromBlock: toHex(FROM),
      toBlock: toHex(TO),
      topics: [WETH_DEPOSIT_TOPIC],
    });
  });

  it("puts a fixed-topic filter in its own slot, padding the ones below it", () => {
    const src = source({filterTopic: 2, filterValue: pad(ALICE.toLowerCase() as Hex, {size: 32})});
    expect(logRequest(src.source, src.topic0, src, FROM, TO).topics).toEqual([
      WETH_DEPOSIT_TOPIC,
      null,
      pad(ALICE.toLowerCase() as Hex, {size: 32}),
    ]);
  });

  it("constrains the signature alone when there is no source to read a filter from", () => {
    expect(logRequest(source().source, WETH_DEPOSIT_TOPIC, null, FROM, TO).topics).toEqual([
      WETH_DEPOSIT_TOPIC,
    ]);
  });

  it("lower-cases the signature, so a node cannot miss a shouted topic", () => {
    const shouted = WETH_DEPOSIT_TOPIC.toUpperCase().replace("0X", "0x") as Hex;
    expect(logRequest(source().source, shouted, null, FROM, TO).topics).toEqual([
      WETH_DEPOSIT_TOPIC,
    ]);
  });
});

describe("logScanKey", () => {
  const FROM = BigInt(46_130_021);
  const TO = BigInt(46_277_856);

  it("matches for the same source over the same range", () => {
    expect(logScanKey(source(), FROM, TO)).toBe(logScanKey(source(), FROM, TO));
  });

  it("ignores the fields that only change how the logs are read", () => {
    const other = source({actorTopic: 2, amountMode: AMOUNT_MODE.count, scale: BigInt(1)});
    expect(logScanKey(other, FROM, TO)).toBe(logScanKey(source(), FROM, TO));
  });

  it("separates a different contract", () => {
    const other = source({source: "0x7B47daC59075aF44046795BA347EC872D5409263"});
    expect(logScanKey(other, FROM, TO)).not.toBe(logScanKey(source(), FROM, TO));
  });

  it("separates a different event signature", () => {
    const other = source({topic0: pad("0x01", {size: 32})});
    expect(logScanKey(other, FROM, TO)).not.toBe(logScanKey(source(), FROM, TO));
  });

  it("separates a different block range", () => {
    expect(logScanKey(source(), FROM, TO)).not.toBe(logScanKey(source(), FROM, TO + BigInt(1)));
    expect(logScanKey(source(), FROM, TO)).not.toBe(logScanKey(source(), FROM - BigInt(1), TO));
  });

  it("separates a fixed-topic filter from an unfiltered scan, and one value from another", () => {
    const filtered = source({filterTopic: 2, filterValue: pad(ALICE, {size: 32})});
    const otherValue = source({filterTopic: 2, filterValue: pad(BOB, {size: 32})});

    expect(logScanKey(filtered, FROM, TO)).not.toBe(logScanKey(source(), FROM, TO));
    expect(logScanKey(filtered, FROM, TO)).not.toBe(logScanKey(otherValue, FROM, TO));
  });

  it("reads a checksummed address and an upper-case topic as the same request", () => {
    const shouted = source({
      source: "0x4200000000000000000000000000000000000006",
      topic0: WETH_DEPOSIT_TOPIC.toUpperCase().replace("0X", "0x") as Hex,
    });
    expect(logScanKey(shouted, FROM, TO)).toBe(logScanKey(source(), FROM, TO));
  });
});
