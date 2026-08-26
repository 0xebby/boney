import {describe, it, expect} from "vitest";
import {
  boneLevel,
  cardScoreFrom,
  foldHistory,
  milestoneBlocks,
  milestonesOf,
  nextMilestone,
  orderedMilestones,
  qualify,
  qualificationHeadline,
  scoreScaleFrom,
  withResolvedDates,
  MAX_LEVEL,
  STAGE_ONE_LEVEL,
  type Milestone,
  type ProspectiveScore,
} from "./boneycard";
import {ETHOS_WEIGHT, REACH_WEIGHT, MAX_BONEY_SCORE} from "./boneyscore";
import type {CampaignView} from "./types";
import type {
  HistoryCampaign,
  HistoryCredit,
  HistoryKpi,
  HistoryMembership,
  HistoryPayout,
  PromoterHistory,
} from "./boneyHistory";

/**
 * `maxScore()`'s unbounded sentinel, spelled out rather than imported from `useScoreCeiling`: that
 * module is `"use client"` and pulls wagmi in, which has no business in a node-environment test.
 */
const UNCAPPED_CEILING = BigInt(2) ** BigInt(256) - BigInt(1);

/**
 * BoneyCard tests.
 *
 * The load-bearing cases are the ones where the two scores disagree. A wallet whose prospective
 * score clears a gate its on-chain score does not is the single state this feature exists to
 * present honestly, and getting it wrong renders a Join button that reverts
 * `InsufficientReputation` after the promoter has paid gas.
 *
 * The second theme: no failure path may render as a zero score. `unavailable` and a genuine 0 are
 * different claims about a person.
 */

const WALLET = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;

const scoreBody = (o: Partial<ProspectiveScore> = {}) => ({
  wallet: WALLET,
  ethos: 1500,
  reach: 1000,
  followers: 42_000,
  smartFollowers: 300,
  handle: "someone",
  profileId: 7,
  reachUnconfirmed: false,
  computedAt: 1_787_000_000,
  ...o,
});

let nextCampaign = 0;
const campaign = (o: Partial<CampaignView> = {}): CampaignView => {
  nextCampaign += 1;
  const hex = nextCampaign.toString(16).padStart(2, "0");
  return {
    campaignId: BigInt(nextCampaign),
    campaign: `0x${hex.repeat(20)}` as `0x${string}`,
    project: "0xcccccccccccccccccccccccccccccccccccccccc",
    name: `Campaign ${nextCampaign}`,
    token: "0xdddddddddddddddddddddddddddddddddddddddd",
    rewardPool: BigInt(1000),
    paidOut: BigInt(0),
    startTime: BigInt(0),
    endTime: BigInt(2_000_000_000),
    minReputation: BigInt(0),
    status: "Active",
    kpiCount: BigInt(1),
    ...o,
  };
};

describe("cardScoreFrom", () => {
  it("computes the total with the same weights the registry uses", () => {
    const state = cardScoreFrom(200, scoreBody({ethos: 1500, reach: 1000}));
    if (state.kind !== "scored") throw new Error(`expected scored, got ${state.kind}`);
    expect(state.score.total).toBe(ETHOS_WEIGHT * 1500 + REACH_WEIGHT * 1000);
  });

  it("attaches a rank, so a new wallet has a badge before it has any history", () => {
    const state = cardScoreFrom(200, scoreBody());
    if (state.kind !== "scored") throw new Error("expected scored");
    expect(state.rank.name).toBeTruthy();
  });

  it("maps no_ethos_profile to `unclaimed`, not to a zero score", () => {
    // The expected first-run state for most wallets. `fetchEthosProfile` throws rather than
    // returning 0, and reach is unreachable too because the X handle comes out of that profile.
    const state = cardScoreFrom(400, {
      error: "no_ethos_profile",
      message: "This wallet has no claimed Ethos profile.",
    });
    expect(state.kind).toBe("unclaimed");
  });

  it("maps an upstream outage to `unavailable`, never to `unclaimed`", () => {
    // Telling a promoter with a perfectly good profile to go and claim one is the failure mode
    // that defaulting to `unclaimed` would produce.
    const state = cardScoreFrom(502, {error: "ethos_unavailable", message: "Ethos is down."});
    expect(state.kind).toBe("unavailable");
  });

  it("treats a malformed 200 as unavailable rather than scoring it as zero", () => {
    expect(cardScoreFrom(200, {wallet: WALLET}).kind).toBe("unavailable");
    expect(cardScoreFrom(200, null).kind).toBe("unavailable");
  });

  it("carries reachUnconfirmed through instead of presenting the 0 as fact", () => {
    const state = cardScoreFrom(200, scoreBody({reach: 0, followers: 0, reachUnconfirmed: true}));
    if (state.kind !== "scored") throw new Error("expected scored");
    expect(state.score.reachUnconfirmed).toBe(true);
    expect(state.score.reach).toBe(0);
  });
});

describe("qualify", () => {
  const none = new Set<string>();

  it("puts an ungated campaign in joinableNow even for a wallet with no score at all", () => {
    // minReputation 0 disables the gate in Solidity, so an unattested wallet can join today. This
    // is the case that makes stage 1 worth opening — five of the eight live campaigns are here.
    const q = qualify({
      campaigns: [campaign({minReputation: BigInt(0)})],
      prospective: 0,
      onChain: BigInt(0),
      joined: none,
    });
    expect(q.joinableNow).toHaveLength(1);
    expect(q.verifyToJoin).toHaveLength(0);
  });

  it("separates verifyToJoin from joinableNow when only the prospective score clears the gate", () => {
    // The central case. On-chain is 0 because nothing has been attested; the Ethos-derived score
    // clears 10,000. Rendering this as joinable would revert InsufficientReputation.
    const q = qualify({
      campaigns: [campaign({minReputation: BigInt(10_000)})],
      prospective: 15_000,
      onChain: BigInt(0),
      joined: none,
    });
    expect(q.verifyToJoin).toHaveLength(1);
    expect(q.joinableNow).toHaveLength(0);
  });

  it("moves a campaign to joinableNow once the on-chain score clears it", () => {
    const q = qualify({
      campaigns: [campaign({minReputation: BigInt(10_000)})],
      prospective: 15_000,
      onChain: BigInt(15_000),
      joined: none,
    });
    expect(q.joinableNow).toHaveLength(1);
    expect(q.verifyToJoin).toHaveLength(0);
  });

  it("reports a shortfall when even the prospective score falls short", () => {
    const q = qualify({
      campaigns: [campaign({minReputation: BigInt(20_000)})],
      prospective: 15_000,
      onChain: BigInt(0),
      joined: none,
    });
    expect(q.scoreTooLow).toHaveLength(1);
    expect(q.scoreTooLow[0].shortfall).toBe(BigInt(5_000));
  });

  it("answers membership before either score", () => {
    const view = campaign({minReputation: BigInt(20_000)});
    const q = qualify({
      campaigns: [view],
      prospective: 0,
      onChain: BigInt(0),
      joined: new Set([view.campaign.toLowerCase()]),
    });
    expect(q.joined).toHaveLength(1);
    expect(q.scoreTooLow).toHaveLength(0);
  });

  it("matches a joined campaign regardless of address casing", () => {
    const view = campaign();
    const q = qualify({
      campaigns: [view],
      prospective: 0,
      onChain: BigInt(0),
      joined: new Set([view.campaign.toUpperCase().replace("0X", "0x").toLowerCase()]),
    });
    expect(q.joined).toHaveLength(1);
  });

  it("puts a closed campaign in closed, not in scoreTooLow", () => {
    // No attestation fixes an Ended campaign, so it must not appear as something verification
    // would unlock.
    for (const status of ["Ended", "Cancelled", "Paused"] as const) {
      const q = qualify({
        campaigns: [campaign({status, minReputation: BigInt(20_000)})],
        prospective: 0,
        onChain: BigInt(0),
        joined: none,
      });
      expect(q.closed, status).toHaveLength(1);
      expect(q.scoreTooLow, status).toHaveLength(0);
    }
  });

  it("treats Pending as open, matching Campaign.join", () => {
    const q = qualify({
      campaigns: [campaign({status: "Pending"})],
      prospective: 0,
      onChain: BigInt(0),
      joined: none,
    });
    expect(q.joinableNow).toHaveLength(1);
  });

  it("qualifies without a connected wallet — the shared card has no connection", () => {
    // `canJoin` treats a missing wallet as a blocker, which is right for a button and wrong for
    // "would this wallet be admitted". If that leaked through, /b/<wallet> would bucket everything
    // as closed.
    const q = qualify({
      campaigns: [campaign(), campaign({minReputation: BigInt(10_000)})],
      prospective: 15_000,
      onChain: BigInt(0),
      joined: none,
    });
    expect(q.joinableNow).toHaveLength(1);
    expect(q.verifyToJoin).toHaveLength(1);
    expect(q.closed).toHaveLength(0);
  });

  it("ignores a negative or fractional prospective score rather than producing a negative BigInt", () => {
    const q = qualify({
      campaigns: [campaign({minReputation: BigInt(100)})],
      prospective: -5.7,
      onChain: BigInt(0),
      joined: none,
    });
    expect(q.scoreTooLow[0].shortfall).toBe(BigInt(100));
  });
});

describe("qualificationHeadline", () => {
  const base = {
    joinableNow: [],
    verifyToJoin: [],
    scoreTooLow: [],
    joined: [],
    closed: [],
  };
  const filler = (n: number) => Array.from({length: n}, () => ({view: campaign(), group: "joinableNow" as const}));

  it("leads with what needs no gas", () => {
    const line = qualificationHeadline({
      ...base,
      joinableNow: filler(5),
      verifyToJoin: filler(3),
    });
    expect(line).toBe(
      "You can join 5 campaigns right now — verify your BoneyScore to unlock 3 more.",
    );
  });

  it("singularises", () => {
    expect(qualificationHeadline({...base, joinableNow: filler(1)})).toBe(
      "You can join 1 campaign right now.",
    );
  });

  it("prompts verification only when nothing is joinable without it", () => {
    expect(qualificationHeadline({...base, verifyToJoin: filler(2)})).toBe(
      "Verify your BoneyScore to unlock 2 campaigns.",
    );
  });

  it("says so when the score is the blocker", () => {
    expect(qualificationHeadline({...base, scoreTooLow: filler(3)})).toBe(
      "3 open campaigns need a higher BoneyScore than yours.",
    );
  });

  /**
   * One gated campaign is not an edge case — it is what a network with a single gated campaign shows
   * every visitor, and "1 open campaign need a higher BoneyScore" is the sentence that gets shipped
   * when the verb is left plural.
   */
  it("agrees the verb with the count, not just the noun", () => {
    expect(qualificationHeadline({...base, scoreTooLow: filler(1)})).toBe(
      "1 open campaign needs a higher BoneyScore than yours.",
    );
    expect(
      qualificationHeadline({...base, joinableNow: filler(3), verifyToJoin: filler(1)}, {verifiable: false}),
    ).toBe(
      "You can join 3 campaigns right now. 1 more is score-gated, and this network cannot record a BoneyScore yet.",
    );
    expect(qualificationHeadline({...base, scoreTooLow: filler(1)}, {anonymous: true})).toBe(
      "1 open campaign, and it is score-gated. Connect to see where you stand.",
    );
  });

  it("does not claim nothing is open when the wallet has joined everything", () => {
    expect(qualificationHeadline({...base, joined: filler(2)})).toBe(
      "You have joined every campaign that is currently open.",
    );
  });

  it("falls back to an honest empty state", () => {
    expect(qualificationHeadline(base)).toBe("No campaigns are open to join right now.");
  });

  /**
   * The registry-with-no-schemas case. `verifyToJoin` is populated (the prospective score does clear
   * those gates) but there is nowhere to record a score, so a headline offering to unlock them sells
   * one transaction per schema for no possible effect.
   */
  it("never offers to unlock anything when the network records no scores", () => {
    const line = qualificationHeadline(
      {...base, joinableNow: filler(5), verifyToJoin: filler(3)},
      {verifiable: false},
    );
    expect(line).not.toMatch(/verify/i);
    expect(line).toBe(
      "You can join 5 campaigns right now. 3 more are score-gated, and this network cannot record a BoneyScore yet.",
    );
  });

  it("folds both gated groups together when verification cannot help", () => {
    // The distinction between them is which side of a verification they sit on, and there is none.
    expect(
      qualificationHeadline({...base, verifyToJoin: filler(2), scoreTooLow: filler(1)}, {verifiable: false}),
    ).toBe("3 open campaigns are score-gated, and this network cannot record a BoneyScore yet.");
  });

  it("still reports an empty chain honestly when nothing is open at all", () => {
    expect(qualificationHeadline(base, {verifiable: false})).toBe(
      "No campaigns are open to join right now.",
    );
  });

  /**
   * The shared-card voice. `qualify` never asks whether a wallet is connected, so the grouping is
   * correct for a visitor — but "you can join" is a claim about a reader whose address nobody knows,
   * and "above your score" is a judgement about a stranger.
   */
  describe("anonymous", () => {
    it("drops the second person", () => {
      const line = qualificationHeadline(
        {...base, joinableNow: filler(5), scoreTooLow: filler(3)},
        {anonymous: true},
      );
      expect(line).not.toMatch(/\byou\b/i);
      expect(line).toBe(
        "5 campaigns open to anyone — no BoneyScore needed. 3 more are score-gated.",
      );
    });

    it("calls a gate a gate rather than a shortfall", () => {
      const line = qualificationHeadline({...base, scoreTooLow: filler(4)}, {anonymous: true});
      expect(line).not.toMatch(/than yours/);
      expect(line).toBe(
        "4 open campaigns, all of them score-gated. Connect to see where you stand.",
      );
    });

    it("takes precedence over verifiable, since there is no wallet to verify", () => {
      const line = qualificationHeadline(
        {...base, joinableNow: filler(2), verifyToJoin: filler(1)},
        {anonymous: true, verifiable: false},
      );
      expect(line).toBe("2 campaigns open to anyone — no BoneyScore needed. 1 more is score-gated.");
    });
  });
});

/**
 * `scoreScaleFrom` decides two things, and the second is the one that costs money if wrong: whether
 * offering to verify is a promise this network can keep. `MAX_BONEY_SCORE` is the arithmetic for the
 * *seeded* schema configuration, not a protocol constant.
 */
describe("scoreScaleFrom", () => {
  it("falls back to the local constant while the read is outstanding", () => {
    // "Unreachable registry" and "registry admits no reputation" are opposite claims. Assuming the
    // second would withhold a verification the chain would have accepted.
    expect(scoreScaleFrom(undefined)).toEqual({max: MAX_BONEY_SCORE, verifiable: true});
  });

  it("uses the chain's ceiling when it differs from the seeded arithmetic", () => {
    const scale = scoreScaleFrom(BigInt(14_000));
    expect(scale.max).toBe(14_000);
    expect(scale.verifiable).toBe(true);
  });

  it("refuses to call a score verifiable when the registry has no weighted schemas", () => {
    // A ceiling of 0 is what `DeployBoney` leaves behind without `SeedDevRep`: every wallet scores 0
    // permanently, and no attestation can change it.
    const scale = scoreScaleFrom(BigInt(0));
    expect(scale.verifiable).toBe(false);
    expect(scale.max).toBeUndefined();
    expect(scale.note).toBeTruthy();
  });

  it("draws no meter against an unbounded ceiling", () => {
    // `maxScore()` returns uint256 max when a weighted schema has no value cap. That is "no ceiling",
    // not an enormous one — a bar against 1.15e77 renders every real score as empty.
    const scale = scoreScaleFrom(UNCAPPED_CEILING);
    expect(scale.max).toBeUndefined();
    expect(scale.verifiable).toBe(true);
    expect(scale.note).toBeTruthy();
  });

  it("treats anything past a real score's range as unbounded, not just the exact sentinel", () => {
    // A second uncapped schema saturates to the same meaning at a different value.
    expect(scoreScaleFrom(BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1)).max).toBeUndefined();
  });

  it("keeps a ceiling that is large but still safely a number", () => {
    expect(scoreScaleFrom(BigInt(Number.MAX_SAFE_INTEGER)).max).toBe(Number.MAX_SAFE_INTEGER);
  });
});

// ── stage 2: the history fold ────────────────────────────────────

/**
 * The history half.
 *
 * Two themes carry most of these cases:
 *
 *  1. **The level can never fall.** A level that drops takes away something already earned, usually
 *     over something the promoter did not control — a project ending a campaign, a pool running dry.
 *     Monotonicity is asserted over a grid rather than at a few points.
 *  2. **A campaign nobody could score on is not a miss.** Gyndore is the live case, and the fold has
 *     to distinguish "delivered nothing" from "nothing was ever creditable".
 *
 * Figures are taken from the real 9 campaigns on registry `0x6427217e` where a real payload pins
 * something a hand-written one would agree with too easily.
 */

const PROMOTER = "0x98405c5776a63547e7cb16000ba04ca53d9fb2f8" as const;
const PROJECT_A = "0xba954e89ce301415964e9405f09f4cc7c668976a" as const;
const PROJECT_B = "0xaaaa00000000000000000000000000000000aaaa" as const;
/** The token the live fixture prices everything in. */
const BUSD_ONE = "0x2755562471b5f6239722ab164d126260f4d8dcc2" as const;
/** Base Sepolia's *other* mock bUSD. Adding the two asserts a rate nobody set. */
const BUSD_TWO = "0xe10ef18b70c536fc0bcadade70c6f7bfe6b262d0" as const;

let nextHistoryCampaign = 0;
function historyCampaign(o: Partial<HistoryCampaign> = {}): HistoryCampaign {
  nextHistoryCampaign += 1;
  const hex = (0x40 + nextHistoryCampaign).toString(16).padStart(2, "0");
  return {
    address: `0x${hex.repeat(20)}` as `0x${string}`,
    campaignId: BigInt(nextHistoryCampaign),
    project: PROJECT_A,
    token: BUSD_ONE,
    name: `Campaign ${nextHistoryCampaign}`,
    status: "Active",
    createdAt: BigInt(1_787_000_000),
    ...o,
  };
}

let nextPromoterId = 0;
function membership(o: Partial<HistoryMembership> & {campaign?: HistoryCampaign} = {}) {
  nextPromoterId += 1;
  return {
    campaign: o.campaign ?? historyCampaign(),
    // Per campaign, and unrelated to any other campaign's id — which is the hop the fold has to make.
    promoterId: `0x${(0x90 + nextPromoterId).toString(16).padStart(2, "0").repeat(32)}` as `0x${string}`,
    reputationAtJoin: BigInt(24_620),
    joinedAtBlock: BigInt(45_857_000 + nextPromoterId),
    ...o,
  } satisfies HistoryMembership;
}

let nextLog = 0;
function credit(o: Partial<HistoryCredit> & {promoterId: `0x${string}`}): HistoryCredit {
  nextLog += 1;
  return {
    // Deliberately counts *down* as `nextLog` rises, so `id` order is the reverse of time order.
    // Anything that dated a milestone by id instead of `timestamp` fails here.
    id: `0x${(0xff - nextLog).toString(16).padStart(2, "0").repeat(32)}-${nextLog}`,
    campaign: "0x" as `0x${string}`,
    kpiIndex: 0,
    user: `0x${(0x10 + nextLog).toString(16).padStart(2, "0").repeat(20)}` as `0x${string}`,
    amount: BigInt(1),
    timestamp: BigInt(1_787_100_000 + nextLog * 1000),
    blockNumber: BigInt(45_860_000 + nextLog),
    ...o,
  };
}

function payout(o: Partial<HistoryPayout> & {campaign: `0x${string}`}): HistoryPayout {
  nextLog += 1;
  return {
    id: `0x${(0xff - nextLog).toString(16).padStart(2, "0").repeat(32)}-${nextLog}`,
    kpiIndex: 0,
    tier: 0,
    paid: BigInt(200) * BigInt(10) ** BigInt(18),
    timestamp: BigInt(1_787_200_000 + nextLog * 1000),
    blockNumber: BigInt(45_870_000 + nextLog),
    ...o,
  };
}

function kpi(o: Partial<HistoryKpi> & {campaign: `0x${string}`}): HistoryKpi {
  return {
    index: 0,
    kind: 2, // Swap
    aggregate: false,
    target: BigInt(1000),
    verifier: "0xa0eee1757a1a01d987b0c638c6703e0ba83baa69",
    source: null,
    topic0: null,
    ...o,
  };
}

function history(o: Partial<PromoterHistory> = {}): PromoterHistory {
  return {
    wallet: PROMOTER,
    memberships: [],
    credits: [],
    payouts: [],
    kpis: [],
    truncated: false,
    indexedBlock: BigInt(45_979_767),
    hasIndexingErrors: false,
    ...o,
  };
}

describe("boneLevel", () => {
  it("puts a wallet with no delivery at the stage-1 level", () => {
    expect(boneLevel({campaignsDelivered: 0, tiers: 0})).toBe(STAGE_ONE_LEVEL);
  });

  it("reaches 5 for the live dev wallet's real counts", () => {
    // 8 delivered campaigns and 31 tier payouts across the 9 campaigns on registry 0x6427217e.
    // The ladder is calibrated to this: a top level nobody can reach is a locked door, not a level.
    expect(boneLevel({campaignsDelivered: 8, tiers: 31})).toBe(5);
  });

  it("never decreases as either count rises", () => {
    // The one hard rule. Asserted over a grid because the rungs are `OR`s of two inputs, and a
    // predicate that was monotone in each input separately could still dip across the pair.
    for (let delivered = 0; delivered <= 12; delivered += 1) {
      for (let tiers = 0; tiers <= 40; tiers += 1) {
        const here = boneLevel({campaignsDelivered: delivered, tiers});
        expect(boneLevel({campaignsDelivered: delivered + 1, tiers})).toBeGreaterThanOrEqual(here);
        expect(boneLevel({campaignsDelivered: delivered, tiers: tiers + 1})).toBeGreaterThanOrEqual(here);
      }
    }
  });

  it("credits tiers when the credit rows did not survive", () => {
    // A truncated `credits` page with an intact `tierPayouts` page. Taking the highest satisfied rung
    // rather than scanning to the first failure is what keeps this from collapsing to level 1: 30
    // tiers clears rung 5 while 0 delivered campaigns fails rung 2.
    expect(boneLevel({campaignsDelivered: 0, tiers: 30})).toBe(5);
  });

  it("never exceeds MAX_LEVEL", () => {
    expect(boneLevel({campaignsDelivered: 5000, tiers: 5000})).toBe(MAX_LEVEL);
  });
});

describe("foldHistory", () => {
  it("returns an empty card for a wallet that has joined nothing", () => {
    // The most important state: what every new promoter sees. Zeros are correct *here* because the
    // read succeeded — the failure case never reaches this function, it stays a GraphResult.
    const card = foldHistory(history());
    expect(card.campaignsJoined).toBe(0);
    expect(card.level).toBe(STAGE_ONE_LEVEL);
    expect(card.earned).toEqual([]);
    expect(card.promotingSinceBlock).toBeUndefined();
    // All seven milestones present and unearned, so the card can show what is next rather than a void.
    expect(card.milestones).toHaveLength(7);
    expect(card.milestones.every((m) => !m.earned)).toBe(true);
  });

  it("attributes credits through the per-campaign promoterId", () => {
    // The hop the whole read path exists for: `Credit` carries only `promoterId`, which is unrelated
    // between campaigns, so a fold that keyed on the wallet would put every credit in one bucket.
    const one = membership();
    const two = membership();
    const card = foldHistory(
      history({
        memberships: [one, two],
        credits: [
          credit({promoterId: one.promoterId}),
          credit({promoterId: one.promoterId}),
          credit({promoterId: two.promoterId}),
        ],
      }),
    );

    const rowOne = card.rows.find((r) => r.campaign.address === one.campaign.address);
    const rowTwo = card.rows.find((r) => r.campaign.address === two.campaign.address);
    expect(rowOne?.actions).toBe(2);
    expect(rowTwo?.actions).toBe(1);
    expect(card.actions).toBe(3);
    expect(card.campaignsDelivered).toBe(2);
  });

  it("counts a user referred in two campaigns once", () => {
    const one = membership();
    const two = membership();
    const user = "0xd572ab30163c4e7ae7c186ec016e3bd0686e4958" as const;
    const card = foldHistory(
      history({
        memberships: [one, two],
        credits: [credit({promoterId: one.promoterId, user}), credit({promoterId: two.promoterId, user})],
      }),
    );
    expect(card.referrals).toBe(1);
    // But each campaign's own row still says one, because within a row it is one user.
    expect(card.rows.every((r) => r.referrals === 1)).toBe(true);
  });

  it("marks an aggregate-only campaign not creditable rather than a miss", () => {
    // Campaign 8 "Gyndore": one aggregate Swap KPI behind a ladder that could never pay anybody.
    // `reportUserAction` reverts `AggregateKpi` before attribution, so `delivered: false` here is a
    // project-side error, not a promoter's failure, and the card has to be able to tell them apart.
    const gyndore = membership({campaign: historyCampaign({name: "Gyndore", status: "Ended"})});
    const card = foldHistory(
      history({
        memberships: [gyndore],
        kpis: [kpi({campaign: gyndore.campaign.address, aggregate: true})],
      }),
    );
    const row = card.rows[0];
    expect(row.aggregateOnly).toBe(true);
    expect(row.delivered).toBe(false);
    expect(card.campaignsDelivered).toBe(0);
  });

  it("does not claim a campaign was uncreditable when no KPIs came back", () => {
    // Absent data cannot support the claim. A truncated KPI page must not turn into an accusation
    // about someone else's campaign.
    const one = membership();
    const card = foldHistory(history({memberships: [one], kpis: []}));
    expect(card.rows[0].aggregateOnly).toBe(false);
  });

  it("still counts a campaign creditable when only one of its KPIs is aggregate", () => {
    const one = membership();
    const card = foldHistory(
      history({
        memberships: [one],
        kpis: [
          kpi({campaign: one.campaign.address, index: 0, aggregate: true}),
          kpi({campaign: one.campaign.address, index: 1, aggregate: false}),
        ],
        credits: [credit({promoterId: one.promoterId, kpiIndex: 1})],
      }),
    );
    expect(card.rows[0].aggregateOnly).toBe(false);
    expect(card.rows[0].delivered).toBe(true);
  });

  it("flags a campaign the project ended before its own window closed", () => {
    const early = membership({campaign: historyCampaign({status: "Ended"})});
    const ran = membership({campaign: historyCampaign({status: "Ended"})});
    const now = 1_787_500_000;
    const card = foldHistory(history({memberships: [early, ran]}), {
      now,
      views: new Map([
        // `end()` is project-callable at any time, so an Ended campaign whose endTime is still in the
        // future was killed early — it offered no chance to deliver.
        [early.campaign.address.toLowerCase(), {endTime: BigInt(now + 86_400)}],
        [ran.campaign.address.toLowerCase(), {endTime: BigInt(now - 86_400)}],
      ]),
    });
    expect(card.rows.find((r) => r.campaign.address === early.campaign.address)?.endedEarly).toBe(true);
    expect(card.rows.find((r) => r.campaign.address === ran.campaign.address)?.endedEarly).toBe(false);
  });

  it("claims nothing about ending early when no window is available", () => {
    // The subgraph's `Campaign` carries no end time, so without the chain read "Ended" is all that is
    // known — and the row has to say only that rather than guess.
    const ended = membership({campaign: historyCampaign({status: "Ended"})});
    const card = foldHistory(history({memberships: [ended]}));
    expect(card.rows[0].endedEarly).toBeUndefined();
  });

  it("groups earnings by token and never adds two of them", () => {
    // Base Sepolia has two mock bUSD deployments at different addresses. A card that summed them
    // would assert a 1:1 rate nobody set.
    const a = membership({campaign: historyCampaign({token: BUSD_ONE})});
    const b = membership({campaign: historyCampaign({token: BUSD_ONE})});
    const c = membership({campaign: historyCampaign({token: BUSD_TWO})});
    const unit = BigInt(10) ** BigInt(18);
    const card = foldHistory(
      history({
        memberships: [a, b, c],
        payouts: [
          payout({campaign: a.campaign.address, paid: BigInt(200) * unit}),
          payout({campaign: b.campaign.address, paid: BigInt(400) * unit}),
          payout({campaign: c.campaign.address, paid: BigInt(9000) * unit}),
        ],
      }),
    );

    expect(card.earned).toHaveLength(2);
    // Largest first, so `[0]` is the dominant token the card renders.
    expect(card.earned[0]).toEqual({token: BUSD_TWO, paid: BigInt(9000) * unit, campaigns: 1});
    expect(card.earned[1]).toEqual({token: BUSD_ONE, paid: BigInt(600) * unit, campaigns: 2});
  });

  it("counts a tier that paid nothing as crossed", () => {
    // `TierSettled` fires with whatever the pool could release, so `paid` can be 0 when it ran short.
    // The tier was earned; only the money is missing.
    const one = membership();
    const card = foldHistory(
      history({
        memberships: [one],
        payouts: [payout({campaign: one.campaign.address, paid: BigInt(0)})],
      }),
    );
    expect(card.tiers).toBe(1);
    expect(card.rows[0].tiers).toBe(1);
    // Nothing arrived, so there is no token row to render.
    expect(card.earned).toEqual([]);
  });

  it("surfaces a payout with no membership row instead of dropping it", () => {
    // Should be impossible — settlement pays a promoter who joined, and `join()` records the wallet in
    // the same transaction. A non-zero count means the index is inconsistent, and silently dropping it
    // would understate what someone earned.
    const one = membership();
    const card = foldHistory(
      history({
        memberships: [one],
        payouts: [payout({campaign: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"})],
      }),
    );
    expect(card.orphanPayouts).toBe(1);
    expect(card.tiers).toBe(1);
    expect(card.rows[0].tiers).toBe(0);
    // No membership means no token to attribute it to.
    expect(card.earned).toEqual([]);
  });

  it("keeps a membership with no join block out of 'promoting since'", () => {
    // `Promoter.wallet` is set by `PromoterJoined`, but `registerPromoter` is permissionless and can
    // create a row with no join. Such a row can hold no credits, so it must not date the history.
    const joined = membership({joinedAtBlock: BigInt(45_900_000)});
    const registeredOnly = membership({joinedAtBlock: undefined});
    const card = foldHistory(history({memberships: [joined, registeredOnly]}));
    expect(card.promotingSinceBlock).toBe(BigInt(45_900_000));
    // Still counted as a membership — it is a real row for this wallet — and sorted last.
    expect(card.campaignsJoined).toBe(2);
    expect(card.rows[card.rows.length - 1].campaign.address).toBe(registeredOnly.campaign.address);
  });

  it("counts distinct projects, and does not let one project cap the level", () => {
    // Every live campaign sits behind one project address, so `projects` reads 1 for everybody. That
    // is why the ladder takes no project requirement — a rung nobody can clear is not a progression.
    const a = membership({campaign: historyCampaign({project: PROJECT_A})});
    const b = membership({campaign: historyCampaign({project: PROJECT_A})});
    const card = foldHistory(
      history({
        memberships: [a, b],
        credits: [credit({promoterId: a.promoterId}), credit({promoterId: b.promoterId})],
        payouts: [
          payout({campaign: a.campaign.address}),
          payout({campaign: b.campaign.address}),
          payout({campaign: b.campaign.address}),
          payout({campaign: b.campaign.address}),
          payout({campaign: b.campaign.address}),
        ],
      }),
    );
    expect(card.projects).toBe(1);
    expect(card.level).toBe(3);
  });

  it("collects specialization badges from KPIs that actually have credit", () => {
    // Kinds with credit, not kinds present. A KPI nobody scored on says nothing about a specialization.
    const a = membership();
    const b = membership();
    const card = foldHistory(
      history({
        memberships: [a, b],
        kpis: [
          kpi({campaign: a.campaign.address, index: 0, kind: 1}), // Mint
          kpi({campaign: a.campaign.address, index: 1, kind: 4}), // Deposit — no credit
          kpi({campaign: b.campaign.address, index: 0, kind: 6}), // Bridge
        ],
        credits: [
          credit({promoterId: a.promoterId, kpiIndex: 0}),
          credit({promoterId: b.promoterId, kpiIndex: 0}),
        ],
      }),
    );
    expect(card.specializations.sort()).toEqual(["Bridge", "Mint"]);
  });

  it("carries truncation through as a floor on every count", () => {
    const card = foldHistory(history({truncated: true}));
    expect(card.partial).toBe(true);
    expect(foldHistory(history({hasIndexingErrors: true})).partial).toBe(true);
  });
});

describe("milestonesOf", () => {
  const noKinds = () => [];

  it("dates the firsts by timestamp, not by id order", () => {
    // `Credit.id` is `<txHash>-<logIndex>` — lexicographic, and unrelated to when anything happened.
    // The fixture builds ids that descend as time ascends, so an id-ordered implementation fails here.
    const one = membership();
    const credits = [
      credit({promoterId: one.promoterId, timestamp: BigInt(1_787_300_000)}),
      credit({promoterId: one.promoterId, timestamp: BigInt(1_787_100_000)}),
      credit({promoterId: one.promoterId, timestamp: BigInt(1_787_200_000)}),
    ];
    const milestones = milestonesOf({
      memberships: [one],
      credits,
      payouts: [],
      kindsOfCredit: noKinds,
    });
    const firstCredit = milestones.find((m) => m.key === "firstCredit");
    expect(firstCredit?.earned).toBe(true);
    expect(firstCredit?.at).toBe(1_787_100_000);
  });

  it("separates crossing a tier from being paid for it", () => {
    // A pool that ran short settles the tier and releases nothing. Folding the two together would
    // either claim a payment that never came or hide a tier genuinely earned.
    const one = membership();
    const milestones = milestonesOf({
      memberships: [one],
      credits: [],
      payouts: [
        payout({campaign: one.campaign.address, paid: BigInt(0), timestamp: BigInt(1_787_400_000)}),
        payout({campaign: one.campaign.address, paid: BigInt(5), timestamp: BigInt(1_787_500_000)}),
      ],
      kindsOfCredit: noKinds,
    });
    expect(milestones.find((m) => m.key === "firstTier")?.at).toBe(1_787_400_000);
    expect(milestones.find((m) => m.key === "firstPaid")?.at).toBe(1_787_500_000);
  });

  it("leaves 'first paid' unearned when every tier paid zero", () => {
    const one = membership();
    const milestones = milestonesOf({
      memberships: [one],
      credits: [],
      payouts: [payout({campaign: one.campaign.address, paid: BigInt(0)})],
      kindsOfCredit: noKinds,
    });
    expect(milestones.find((m) => m.key === "firstTier")?.earned).toBe(true);
    expect(milestones.find((m) => m.key === "firstPaid")?.earned).toBe(false);
  });

  it("dates the 5th campaign to the 5th join, in block order", () => {
    const blocks = [45_900_500, 45_857_100, 45_939_200, 45_880_000, 45_860_000, 45_870_000];
    const memberships = blocks.map((b) => membership({joinedAtBlock: BigInt(b)}));
    const milestones = milestonesOf({memberships, credits: [], payouts: [], kindsOfCredit: noKinds});
    expect(milestones.find((m) => m.key === "firstJoin")?.atBlock).toBe(BigInt(45_857_100));
    // 5th smallest, not 5th in array order.
    expect(milestones.find((m) => m.key === "fifthCampaign")?.atBlock).toBe(BigInt(45_900_500));
  });

  it("dates a repeat project to the repeat, not to the project's first campaign", () => {
    const first = membership({
      campaign: historyCampaign({project: PROJECT_A}),
      joinedAtBlock: BigInt(45_857_000),
    });
    const other = membership({
      campaign: historyCampaign({project: PROJECT_B}),
      joinedAtBlock: BigInt(45_858_000),
    });
    const repeat = membership({
      campaign: historyCampaign({project: PROJECT_A}),
      joinedAtBlock: BigInt(45_859_000),
    });
    const milestones = milestonesOf({
      memberships: [repeat, first, other],
      credits: [],
      payouts: [],
      kindsOfCredit: noKinds,
    });
    expect(milestones.find((m) => m.key === "firstRepeatProject")?.atBlock).toBe(BigInt(45_859_000));
  });

  it("leaves a repeat project unearned for a wallet with one campaign per project", () => {
    const milestones = milestonesOf({
      memberships: [
        membership({campaign: historyCampaign({project: PROJECT_A})}),
        membership({campaign: historyCampaign({project: PROJECT_B})}),
      ],
      credits: [],
      payouts: [],
      kindsOfCredit: noKinds,
    });
    expect(milestones.find((m) => m.key === "firstRepeatProject")?.earned).toBe(false);
  });

  it("dates the second protocol type to the credit that introduced it", () => {
    const one = membership();
    const a = credit({promoterId: one.promoterId, timestamp: BigInt(1_787_100_000)});
    const b = credit({promoterId: one.promoterId, timestamp: BigInt(1_787_200_000)});
    const c = credit({promoterId: one.promoterId, timestamp: BigInt(1_787_300_000)});
    const milestones = milestonesOf({
      memberships: [one],
      credits: [c, a, b],
      // a and b are both Swaps; c is the first Bridge.
      kindsOfCredit: (credit) => (credit.id === c.id ? ["Bridge"] : ["Swap"]),
      payouts: [],
    });
    expect(milestones.find((m) => m.key === "secondKind")?.at).toBe(1_787_300_000);
  });

  it("keeps the second protocol type unearned for a single-kind promoter", () => {
    const one = membership();
    const milestones = milestonesOf({
      memberships: [one],
      credits: [credit({promoterId: one.promoterId}), credit({promoterId: one.promoterId})],
      payouts: [],
      kindsOfCredit: () => ["Swap"],
    });
    expect(milestones.find((m) => m.key === "secondKind")?.earned).toBe(false);
  });

  it("returns every milestone in a stable order, earned or not", () => {
    // The unearned ones are the point of the empty card — it shows what is next.
    const keys = milestonesOf({
      memberships: [],
      credits: [],
      payouts: [],
      kindsOfCredit: noKinds,
    }).map((m) => m.key);
    expect(keys).toEqual([
      "firstJoin",
      "firstCredit",
      "firstTier",
      "firstPaid",
      "fifthCampaign",
      "firstRepeatProject",
      "secondKind",
    ]);
  });
});

// ── blocks into dates ────────────────────────────────────────────

/**
 * `Promoter` is indexed with `joinedAtBlock` and no timestamp, so three of the seven milestones
 * arrive as block numbers. These cases are about the resolution being additive: a lookup that fails
 * must leave a true block number behind, never a dash and never 1 January 1970.
 */
describe("milestoneBlocks", () => {
  it("asks for the join blocks and nothing else", () => {
    const a = membership({joinedAtBlock: BigInt(45_857_100)});
    const card = foldHistory(
      history({
        memberships: [a],
        credits: [credit({promoterId: a.promoterId})],
        payouts: [payout({campaign: a.campaign.address})],
      }),
    );

    // firstCredit and firstTier came from rows carrying a timestamp, so they need no lookup.
    expect(milestoneBlocks(card)).toEqual([BigInt(45_857_100)]);
  });

  it("de-duplicates blocks shared by two milestones", () => {
    // Five joins in one transaction — which is exactly what a seed script does. `firstJoin` and
    // `fifthCampaign` then name the same block, and it must not be looked up twice.
    const block = BigInt(45_858_000);
    const memberships = Array.from({length: 5}, () => membership({joinedAtBlock: block}));
    expect(milestoneBlocks(foldHistory(history({memberships})))).toEqual([block]);
  });

  it("asks for nothing when a wallet has joined nothing", () => {
    expect(milestoneBlocks(foldHistory(history()))).toEqual([]);
  });
});

describe("withResolvedDates", () => {
  const joinedAt = BigInt(45_857_500);
  const joinedTime = 1_787_050_000;

  const oneJoin = () => {
    const m = membership({joinedAtBlock: joinedAt});
    return foldHistory(history({memberships: [m], credits: [credit({promoterId: m.promoterId})]}));
  };

  it("dates a join milestone from its block", () => {
    const card = withResolvedDates(oneJoin(), new Map([[joinedAt, joinedTime]]));
    const first = card.milestones.find((m) => m.key === "firstJoin");
    expect(first?.at).toBe(joinedTime);
    // The block is kept, not replaced. It is the fallback if a later render has no map.
    expect(first?.atBlock).toBe(joinedAt);
  });

  it("fills promotingSince from the earliest join block", () => {
    expect(withResolvedDates(oneJoin(), new Map([[joinedAt, joinedTime]])).promotingSince).toBe(
      joinedTime,
    );
  });

  it("leaves a milestone on its block when the lookup did not resolve it", () => {
    // One failed `getBlock` against a flaky public RPC. The milestone is still true.
    const card = withResolvedDates(oneJoin(), new Map([[BigInt(1), 1_787_000_000]]));
    const first = card.milestones.find((m) => m.key === "firstJoin");
    expect(first?.at).toBeUndefined();
    expect(first?.atBlock).toBe(joinedAt);
    expect(card.promotingSince).toBeUndefined();
  });

  it("never overwrites a timestamp that came from a Credit", () => {
    const m = membership({joinedAtBlock: joinedAt});
    const c = credit({promoterId: m.promoterId, timestamp: BigInt(1_787_111_000)});
    const folded = foldHistory(history({memberships: [m], credits: [c]}));

    // A credit's own block is not in the map, but if it were, its indexed timestamp still wins.
    const card = withResolvedDates(folded, new Map([[c.blockNumber, 1]]));
    expect(card.milestones.find((k) => k.key === "firstCredit")?.at).toBe(1_787_111_000);
  });

  it("returns the card untouched when nothing resolved", () => {
    const folded = oneJoin();
    expect(withResolvedDates(folded, new Map())).toBe(folded);
  });

  it("changes no count and no earned flag", () => {
    const folded = oneJoin();
    const card = withResolvedDates(folded, new Map([[joinedAt, joinedTime]]));
    expect(card.campaignsJoined).toBe(folded.campaignsJoined);
    expect(card.level).toBe(folded.level);
    expect(card.milestones.map((m) => m.earned)).toEqual(folded.milestones.map((m) => m.earned));
  });
});

describe("nextMilestone", () => {
  it("names the first campaign for a wallet that has done nothing", () => {
    const card = foldHistory(history());
    const next = nextMilestone(card.milestones);
    expect(next?.key).toBe("firstJoin");
    // The unearned copy is an instruction, not an achievement written in the past tense.
    expect(next?.todo).toMatch(/^Join/);
  });

  it("skips the rungs already earned", () => {
    const m = membership();
    const card = foldHistory(
      history({memberships: [m], credits: [credit({promoterId: m.promoterId})]}),
    );
    expect(nextMilestone(card.milestones)?.key).toBe("firstTier");
  });

  it("is undefined once every rung is earned", () => {
    expect(nextMilestone([])).toBeUndefined();
  });
});

describe("orderedMilestones", () => {
  const m = (key: string, earned: boolean, at?: number): Milestone => ({
    key: key as Milestone["key"],
    label: key,
    todo: `do ${key}`,
    earned,
    ...(at === undefined ? {} : {at}),
  });

  it("reads oldest first, not in ladder order", () => {
    // The live case: the fifth-campaign rung is dated by a join and the reward rungs by settlements,
    // so ladder order prints 18 August below 23 August.
    const ordered = orderedMilestones([
      m("firstPaid", true, 1_787_300_000),
      m("fifthCampaign", true, 1_787_100_000),
      m("firstJoin", true, 1_787_000_000),
    ]);
    expect(ordered.map((x) => x.key)).toEqual(["firstJoin", "fifthCampaign", "firstPaid"]);
  });

  it("keeps the unearned rungs last, in ladder order", () => {
    const ordered = orderedMilestones([
      m("firstJoin", true, 1_787_000_000),
      m("firstCredit", false),
      m("firstTier", false),
    ]);
    expect(ordered.map((x) => x.key)).toEqual(["firstJoin", "firstCredit", "firstTier"]);
  });

  it("leaves the next milestone unchanged", () => {
    // Reordering must not move which rung is "next", or the empty card would point somewhere else.
    const list = [m("firstJoin", true, 1_787_900_000), m("firstCredit", false), m("firstTier", false)];
    expect(nextMilestone(orderedMilestones(list))?.key).toBe(nextMilestone(list)?.key);
  });

  it("puts an earned but undated rung after the dated ones", () => {
    // Only reachable when a block lookup failed. A block number cannot be compared against a unix
    // timestamp, so it sorts last rather than being guessed into place.
    const ordered = orderedMilestones([
      {...m("firstJoin", true), atBlock: BigInt(45_857_000)},
      m("firstCredit", true, 1_787_100_000),
    ]);
    expect(ordered.map((x) => x.key)).toEqual(["firstCredit", "firstJoin"]);
  });

  it("returns every milestone it was given", () => {
    const card = foldHistory(history());
    expect(orderedMilestones(card.milestones)).toHaveLength(card.milestones.length);
  });
});
