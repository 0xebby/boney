import {describe, it, expect} from "vitest";
import {pad, type Hex} from "viem";
import {
  attributionLookup,
  buildAttributionWindows,
  earliestAttributedBlock,
  mergeAttributionWindows,
  type TouchLog,
} from "./attributionWindows";

// Checksummed with `cast to-check-sum-address` rather than by hand — a mistyped checksum makes viem
// throw somewhere far from the typo.
const ALICE = "0xDfAb13959371EFF8fdd71aecD1403FD78b743eE0" as const;
const BOB = "0x80d727579841B02eFb0364DD4C52fa3795593577" as const;

const ID_A = pad("0x0a", {size: 32});
const ID_B = pad("0x0b", {size: 32});

const T = BigInt(1_700_000_000);
const FOREVER = T + BigInt(86_400);

/**
 * A `TouchStored` log.
 *
 * @param user Wallet the touch attributes.
 * @param blockNumber Block the touch landed in.
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

describe("buildAttributionWindows", () => {
  it("keeps every touch, including superseded ones", () => {
    const windows = buildAttributionWindows([
      touchLog(ALICE, BigInt(10), FOREVER, ID_A),
      touchLog(ALICE, BigInt(20), FOREVER, ID_B),
    ]);

    // `AttributionRegistry` overwrites its live slot but appends to history; this mirrors the history.
    expect(windows.get(ALICE.toLowerCase())).toHaveLength(2);
  });

  it("orders a referral's windows oldest first regardless of page order", () => {
    const windows = buildAttributionWindows([
      touchLog(ALICE, BigInt(30), FOREVER),
      touchLog(ALICE, BigInt(10), FOREVER),
      touchLog(ALICE, BigInt(20), FOREVER),
    ]);

    expect(windows.get(ALICE.toLowerCase())!.map((w) => w.fromBlock)).toEqual([
      BigInt(10),
      BigInt(20),
      BigInt(30),
    ]);
  });

  it("keys by lowercased address, whatever case the log carried", () => {
    const windows = buildAttributionWindows([touchLog(ALICE, BigInt(10), FOREVER)]);
    expect(windows.has(ALICE.toLowerCase())).toBe(true);
    expect(windows.has(ALICE)).toBe(false);
  });

  it("keeps referrals separate", () => {
    const windows = buildAttributionWindows([
      touchLog(ALICE, BigInt(10), FOREVER),
      touchLog(BOB, BigInt(11), FOREVER),
    ]);
    expect(windows.size).toBe(2);
  });
});

/**
 * The subgraph holds only a referral's live touch, so it is merged under whatever superseded history
 * the log scan reached. Losing a spell here credits the wrong promoter for work already done.
 */
describe("mergeAttributionWindows", () => {
  it("adds a referral the base map never saw", () => {
    const merged = mergeAttributionWindows(
      buildAttributionWindows([touchLog(ALICE, BigInt(10), FOREVER)]),
      buildAttributionWindows([touchLog(BOB, BigInt(20), FOREVER)]),
    );

    expect(merged.size).toBe(2);
    expect(merged.get(BOB.toLowerCase())!.map((w) => w.fromBlock)).toEqual([BigInt(20)]);
  });

  it("does not repeat a spell both sources carry", () => {
    const both = [touchLog(ALICE, BigInt(10), FOREVER, ID_A)];
    const merged = mergeAttributionWindows(
      buildAttributionWindows(both),
      buildAttributionWindows(both),
    );

    expect(merged.get(ALICE.toLowerCase())).toHaveLength(1);
  });

  it("keeps a second promoter holding the referral in the same block", () => {
    const merged = mergeAttributionWindows(
      buildAttributionWindows([touchLog(ALICE, BigInt(10), FOREVER, ID_A)]),
      buildAttributionWindows([touchLog(ALICE, BigInt(10), FOREVER, ID_B)]),
    );

    expect(merged.get(ALICE.toLowerCase())).toHaveLength(2);
  });

  it("orders the union oldest first", () => {
    const merged = mergeAttributionWindows(
      buildAttributionWindows([touchLog(ALICE, BigInt(30), FOREVER, ID_A)]),
      buildAttributionWindows([
        touchLog(ALICE, BigInt(10), FOREVER, ID_B),
        touchLog(ALICE, BigInt(20), FOREVER, ID_B),
      ]),
    );

    expect(merged.get(ALICE.toLowerCase())!.map((w) => w.fromBlock)).toEqual([
      BigInt(10),
      BigInt(20),
      BigInt(30),
    ]);
  });

  it("leaves the inputs untouched", () => {
    const base = buildAttributionWindows([touchLog(ALICE, BigInt(10), FOREVER, ID_A)]);
    const extra = buildAttributionWindows([touchLog(ALICE, BigInt(20), FOREVER, ID_B)]);
    mergeAttributionWindows(base, extra);

    expect(base.get(ALICE.toLowerCase())).toHaveLength(1);
    expect(extra.get(ALICE.toLowerCase())).toHaveLength(1);
  });

  it("resolves a live touch the log scan aged out of", () => {
    // The reported bug: the touch is below the log floor, so the log scan returns nothing and the
    // referral resolves to no promoter at all.
    const logs = buildAttributionWindows([]);
    const graph = buildAttributionWindows([touchLog(ALICE, BigInt(10), FOREVER, ID_A)]);

    expect(attributionLookup(logs, BigInt(0)).at(ALICE, BigInt(11), T)).toBeNull();
    expect(
      attributionLookup(mergeAttributionWindows(logs, graph), BigInt(0)).at(ALICE, BigInt(11), T),
    ).toBe(ID_A);
  });
});

/**
 * Every case here mirrors `AttributionRegistry._promoterAt`. The relayer's ceiling and the indexer's
 * claim both resolve attribution through this, so a disagreement with the chain's walk shows up as a
 * report that credits less than it claims — or one that claims progress no promoter can ever be paid.
 */
describe("attributionLookup", () => {
  it("credits the promoter holding the referral at that block", () => {
    const at = attributionLookup(
      buildAttributionWindows([touchLog(ALICE, BigInt(10), FOREVER, ID_A)]),
      BigInt(0),
    ).at;

    expect(at(ALICE, BigInt(11), T)).toBe(ID_A);
  });

  it("does not credit the touch's own block", () => {
    // `storedAtBlock < atBlock` — a touch landing in an action's block does not capture the action.
    const lookup = attributionLookup(
      buildAttributionWindows([touchLog(ALICE, BigInt(10), FOREVER)]),
      BigInt(0),
    );

    expect(lookup.at(ALICE, BigInt(10), T)).toBeNull();
    expect(lookup.at(ALICE, BigInt(11), T)).toBe(ID_A);
  });

  it("returns nothing before the first touch", () => {
    const lookup = attributionLookup(
      buildAttributionWindows([touchLog(ALICE, BigInt(10), FOREVER)]),
      BigInt(0),
    );
    expect(lookup.at(ALICE, BigInt(9), T)).toBeNull();
  });

  it("hands a block after a switch to the newer promoter, and one before it to the older", () => {
    const lookup = attributionLookup(
      buildAttributionWindows([
        touchLog(ALICE, BigInt(10), FOREVER, ID_A),
        touchLog(ALICE, BigInt(20), FOREVER, ID_B),
      ]),
      BigInt(0),
    );

    expect(lookup.at(ALICE, BigInt(15), T)).toBe(ID_A);
    expect(lookup.at(ALICE, BigInt(21), T)).toBe(ID_B);
  });

  it("treats expiry as exclusive", () => {
    const expiry = T + BigInt(60);
    const lookup = attributionLookup(
      buildAttributionWindows([touchLog(ALICE, BigInt(10), expiry)]),
      BigInt(0),
    );

    expect(lookup.at(ALICE, BigInt(11), expiry - BigInt(1))).toBe(ID_A);
    expect(lookup.at(ALICE, BigInt(11), expiry)).toBeNull();
  });

  /**
   * The rule that makes gaps credit nobody. Falling back would pay a promoter whose touch the referral
   * had already replaced, and the chain would skip the action regardless.
   */
  it("never falls back past a lapsed window to an older live one", () => {
    const lookup = attributionLookup(
      buildAttributionWindows([
        touchLog(ALICE, BigInt(10), FOREVER, ID_A),
        touchLog(ALICE, BigInt(20), T + BigInt(60), ID_B),
      ]),
      BigInt(0),
    );

    // B's window has lapsed by then; A's has not, and is still not consulted.
    expect(lookup.at(ALICE, BigInt(21), T + BigInt(120))).toBeNull();
  });

  it("returns nothing for a referral with no touch at all", () => {
    const lookup = attributionLookup(
      buildAttributionWindows([touchLog(ALICE, BigInt(10), FOREVER)]),
      BigInt(0),
    );

    expect(lookup.at(BOB, BigInt(11), T)).toBeNull();
    expect(lookup.known(BOB)).toBe(false);
    expect(lookup.known(ALICE)).toBe(true);
  });

  it("treats an unresolved timestamp as outside every window", () => {
    const lookup = attributionLookup(
      buildAttributionWindows([touchLog(ALICE, BigInt(10), FOREVER)]),
      BigInt(0),
    );
    expect(lookup.at(ALICE, BigInt(11), BigInt(0))).toBeNull();
  });

  it("credits nothing from before the campaign started", () => {
    const lookup = attributionLookup(
      buildAttributionWindows([touchLog(ALICE, BigInt(10), FOREVER)]),
      T,
    );

    expect(lookup.at(ALICE, BigInt(11), T - BigInt(1))).toBeNull();
    expect(lookup.at(ALICE, BigInt(11), T)).toBe(ID_A);
  });
});

describe("earliestAttributedBlock", () => {
  it("starts the scan one block after the campaign's first touch", () => {
    const windows = buildAttributionWindows([
      touchLog(BOB, BigInt(40), FOREVER),
      touchLog(ALICE, BigInt(10), FOREVER),
      touchLog(ALICE, BigInt(20), FOREVER, ID_B),
    ]);

    expect(earliestAttributedBlock(windows)).toBe(BigInt(11));
  });

  it("is null when no touch was ever stored", () => {
    expect(earliestAttributedBlock(buildAttributionWindows([]))).toBeNull();
  });

  it("excludes exactly the blocks the lookup credits to nobody", () => {
    const touches = [touchLog(ALICE, BigInt(10), FOREVER)];
    const windows = buildAttributionWindows(touches);
    const floor = earliestAttributedBlock(windows)!;
    const lookup = attributionLookup(windows, BigInt(0));

    expect(lookup.at(ALICE, floor - BigInt(1), T)).toBeNull();
    expect(lookup.at(ALICE, floor, T)).toBe(ID_A);
  });
});
