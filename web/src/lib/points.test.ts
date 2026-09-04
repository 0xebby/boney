import {describe, expect, it} from "vitest";
import {
  actionsOf,
  findPointsRow,
  foldPoints,
  isMagnitudeKpi,
  pointsShare,
  totalOf,
  POINTS_JOIN,
  POINTS_PROMOTER_ACTION,
  POINTS_PROMOTER_REPORT,
  POINTS_REFERRAL_ACTION,
  POINTS_REFERRAL_REPORT,
  POINTS_TOUCH,
  type PointsInput,
} from "./points";

/**
 * Points fold tests.
 *
 * Four rules carry the board and are asserted directly:
 *
 *  1. **A re-signature cannot score twice.** The subgraph keeps one `Touch` per `(campaign, user)`, so
 *     the fold must award per row and never per signature.
 *  2. **A credited action pays both sides, the promoter higher.**
 *  3. **A magnitude KPI is flat.** Multiplying a token amount into points would let one large deposit
 *     outrank a wallet that performed fifty actions.
 *  4. **A wallet reaches the fold in any case.** Addresses arrive checksummed from wagmi and lowercased
 *     from the subgraph; two cases of one wallet must not become two rows.
 */

const WALLET_A = `0x${"aa".repeat(20)}`;
const WALLET_B = `0x${"bb".repeat(20)}`;
const REFERRAL = `0x${"cc".repeat(20)}`;
const CAMPAIGN = `0x${"11".repeat(20)}`;
const PROMOTER_ID = `0x${"77".repeat(32)}`;

const SWAP_KIND = 2;
const VOLUME_KIND = 8;

const empty: PointsInput = {joins: [], touches: [], credits: [], kpis: []};

const countKpi = (index: number) => ({
  id: `${CAMPAIGN}-${index}`,
  kind: SWAP_KIND,
  amountMode: 0,
});

const credit = (over: Partial<PointsInput["credits"][number]> = {}) => ({
  campaign: CAMPAIGN,
  kpiIndex: 0,
  promoterId: PROMOTER_ID,
  user: REFERRAL,
  amount: BigInt(3),
  ...over,
});

describe("isMagnitudeKpi", () => {
  it("treats a dataWord0 KPI as a magnitude", () => {
    expect(isMagnitudeKpi({id: "k", kind: SWAP_KIND, amountMode: 1})).toBe(true);
  });

  it("treats a count-mode KPI as countable", () => {
    expect(isMagnitudeKpi({id: "k", kind: SWAP_KIND, amountMode: 0})).toBe(false);
  });

  /** Gyndore's KPIs carry no event-source blob, and their credited amounts are action counts. */
  it("treats a KPI with no amount mode as countable when its kind counts actions", () => {
    expect(isMagnitudeKpi({id: "k", kind: SWAP_KIND, amountMode: undefined})).toBe(false);
  });

  it("treats a value-denominated kind as a magnitude whatever its amount mode", () => {
    expect(isMagnitudeKpi({id: "k", kind: VOLUME_KIND, amountMode: 0})).toBe(true);
  });

  /** An unindexed KPI has an unknown unit, so the conservative arm wins. */
  it("treats an unknown KPI as a magnitude", () => {
    expect(isMagnitudeKpi(undefined)).toBe(true);
  });
});

describe("foldPoints — joins and attributions", () => {
  it("awards a join per campaign joined", () => {
    const rows = foldPoints({
      ...empty,
      joins: [
        {promoterId: PROMOTER_ID, wallet: WALLET_A},
        {promoterId: `0x${"88".repeat(32)}`, wallet: WALLET_A},
      ],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.counts.joins).toBe(2);
    expect(rows[0]!.total).toBe(2 * POINTS_JOIN);
  });

  /**
   * The whole re-signature rule. `AttributionRegistry` overwrites a touch in place and the subgraph
   * mirrors that, so a wallet that signs the same campaign five times still has one row — and a fold
   * over rows is what makes re-signing worth nothing.
   */
  it("awards an attribution per row, so one campaign scores once however often it was signed", () => {
    const rows = foldPoints({...empty, touches: [{user: WALLET_A}]});
    expect(rows[0]!.total).toBe(POINTS_TOUCH);
    expect(rows[0]!.counts.touches).toBe(1);
  });

  it("scores two campaigns signed by the same wallet twice", () => {
    const rows = foldPoints({...empty, touches: [{user: WALLET_A}, {user: WALLET_A}]});
    expect(rows[0]!.total).toBe(2 * POINTS_TOUCH);
  });
});

describe("foldPoints — credited actions", () => {
  it("pays the referral and the promoter for the same action, the promoter higher", () => {
    const rows = foldPoints({
      joins: [{promoterId: PROMOTER_ID, wallet: WALLET_A}],
      touches: [],
      credits: [credit({amount: BigInt(4)})],
      kpis: [countKpi(0)],
    });

    const promoter = findPointsRow(rows, WALLET_A)!;
    const referral = findPointsRow(rows, REFERRAL)!;

    expect(referral.counts.referralActions).toBe(4);
    expect(referral.earned.referralActions).toBe(4 * POINTS_REFERRAL_ACTION);
    expect(promoter.counts.promoterActions).toBe(4);
    expect(promoter.earned.promoterActions).toBe(4 * POINTS_PROMOTER_ACTION);
    expect(POINTS_PROMOTER_ACTION).toBeGreaterThan(POINTS_REFERRAL_ACTION);
  });

  it("awards a magnitude KPI flat, so a large amount cannot buy a rank", () => {
    const whale = foldPoints({
      ...empty,
      credits: [credit({amount: BigInt("5000000000000000000")})],
      kpis: [{id: `${CAMPAIGN}-0`, kind: SWAP_KIND, amountMode: 1}],
    });

    expect(findPointsRow(whale, REFERRAL)!.total).toBe(POINTS_REFERRAL_REPORT);
    expect(findPointsRow(whale, REFERRAL)!.counts.referralActions).toBe(1);
  });

  it("scores fifty counted actions above one magnitude report", () => {
    const swapper = foldPoints({
      ...empty,
      credits: [credit({amount: BigInt(50)})],
      kpis: [countKpi(0)],
    });
    const whale = foldPoints({
      ...empty,
      credits: [credit({amount: BigInt("5000000000000000000")})],
      kpis: [{id: `${CAMPAIGN}-0`, kind: SWAP_KIND, amountMode: 1}],
    });

    expect(findPointsRow(swapper, REFERRAL)!.total).toBeGreaterThan(
      findPointsRow(whale, REFERRAL)!.total,
    );
  });

  /** A count-mode amount too large to be an action count is not one, so it falls back to flat. */
  it("refuses to multiply an implausible count into points", () => {
    const rows = foldPoints({
      ...empty,
      credits: [credit({amount: BigInt("1000000000000000000")})],
      kpis: [countKpi(0)],
    });

    expect(findPointsRow(rows, REFERRAL)!.total).toBe(POINTS_REFERRAL_REPORT);
  });

  it("ignores a zero credit entirely", () => {
    expect(foldPoints({...empty, credits: [credit({amount: BigInt(0)})], kpis: [countKpi(0)]})).toEqual(
      [],
    );
  });

  /** `Credit` carries only the promoter's id, so a wallet-less promoter can still pay its referral. */
  it("still pays the referral when the promoter has no wallet row", () => {
    const rows = foldPoints({...empty, credits: [credit()], kpis: [countKpi(0)]});

    expect(rows).toHaveLength(1);
    expect(rows[0]!.wallet).toBe(REFERRAL.toLowerCase());
    expect(rows[0]!.counts.promoterActions).toBe(0);
  });

  it("keys the KPI lookup on campaign and index together", () => {
    const rows = foldPoints({
      ...empty,
      credits: [credit({kpiIndex: 1, amount: BigInt(2)})],
      kpis: [countKpi(0), {id: `${CAMPAIGN}-1`, kind: SWAP_KIND, amountMode: 1}],
    });

    expect(findPointsRow(rows, REFERRAL)!.total).toBe(POINTS_REFERRAL_REPORT);
  });

  it("credits the promoter of a magnitude report at the higher flat rate", () => {
    const rows = foldPoints({
      joins: [{promoterId: PROMOTER_ID, wallet: WALLET_A}],
      touches: [],
      credits: [credit({amount: BigInt(9)})],
      kpis: [{id: `${CAMPAIGN}-0`, kind: VOLUME_KIND, amountMode: undefined}],
    });

    expect(findPointsRow(rows, WALLET_A)!.earned.promoterActions).toBe(POINTS_PROMOTER_REPORT);
  });
});

describe("foldPoints — ranking", () => {
  it("orders by total descending and ranks from one", () => {
    const rows = foldPoints({
      ...empty,
      joins: [
        {promoterId: PROMOTER_ID, wallet: WALLET_A},
        {promoterId: `0x${"88".repeat(32)}`, wallet: WALLET_A},
      ],
      touches: [{user: WALLET_B}],
    });

    expect(rows.map((row) => [row.wallet, row.rank])).toEqual([
      [WALLET_A.toLowerCase(), 1],
      [WALLET_B.toLowerCase(), 2],
    ]);
  });

  /** Competition ranking: equal totals share a rank and the next one skips. */
  it("gives tied wallets the same rank and skips the one after", () => {
    const rows = foldPoints({
      ...empty,
      touches: [{user: WALLET_A}, {user: WALLET_B}, {user: REFERRAL}, {user: REFERRAL}],
    });

    expect(rows.map((row) => row.rank)).toEqual([1, 2, 2]);
  });

  it("merges a checksummed wallet with its lowercased self", () => {
    const rows = foldPoints({
      ...empty,
      joins: [{promoterId: PROMOTER_ID, wallet: WALLET_A.toUpperCase().replace("0X", "0x")}],
      touches: [{user: WALLET_A}],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.total).toBe(POINTS_JOIN + POINTS_TOUCH);
  });

  it("returns nothing for a protocol with no activity", () => {
    expect(foldPoints(empty)).toEqual([]);
  });
});

describe("totalOf, pointsShare and findPointsRow", () => {
  it("sums a breakdown", () => {
    expect(totalOf({joins: 250, touches: 100, referralActions: 30, promoterActions: 75})).toBe(455);
  });

  it("scales a total against the leader", () => {
    expect(pointsShare(500, 1000)).toBe(0.5);
    expect(pointsShare(2000, 1000)).toBe(1);
    expect(pointsShare(-5, 1000)).toBe(0);
    expect(pointsShare(500, 0)).toBe(0);
  });

  it("finds a row whatever case the wallet arrives in, and nothing for no wallet", () => {
    const rows = foldPoints({...empty, touches: [{user: WALLET_A}]});

    expect(findPointsRow(rows, WALLET_A.toUpperCase().replace("0X", "0x"))?.rank).toBe(1);
    expect(findPointsRow(rows, undefined)).toBeUndefined();
    expect(findPointsRow(rows, WALLET_B)).toBeUndefined();
  });
});

describe("actionsOf", () => {
  it("counts both sides of a wallet's credited history", () => {
    const rows = foldPoints({
      joins: [{promoterId: PROMOTER_ID, wallet: WALLET_A}],
      touches: [],
      credits: [
        credit({amount: BigInt(4)}),
        credit({promoterId: `0x${"99".repeat(32)}`, user: WALLET_A, amount: BigInt(2)}),
      ],
      kpis: [countKpi(0)],
    });

    // Four driven as promoter, two performed as a referral.
    expect(actionsOf(findPointsRow(rows, WALLET_A)!)).toBe(6);
  });
});
