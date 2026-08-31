import Link from "next/link";

import {
  ETHOS_WEIGHT,
  MAX_BONEY_SCORE,
  MAX_ETHOS,
  REACH_WEIGHT,
  ethosLevel,
  followersForReach,
  reachFromFollowers,
  scoreSplit,
} from "@/lib/boneyscore";
import {
  PURE_REACH_CEILING,
  PURE_TRUST_CEILING,
  minEthosAtFullReach,
  rankExamples,
  rankOf,
  ranksAscending,
} from "@/lib/ranks";
import {Notice} from "@/components/ui/Notice";

/**
 * `/docs` — how the protocol works.
 *
 * A static server component: nothing here reads the chain, so it renders without a wallet, a
 * deployment, or a network round trip. It is the page a promoter or project lands on before they have
 * connected anything.
 */
export function DocsPage() {
  return (
    <div className="max-w-3xl space-y-8">
      <header>
        <h1 className="font-display text-2xl text-ink">Boneyard Docs</h1>
      </header>

      <Section title="What is Boneyard">
        <p>
          Boneyard is a performance-based growth marketplace. Projects escrow rewards for the onchain
          activity they need — swaps, deposits, volume, mints, transfers, sign-ups, bridges,
          liquidity — and promoters earn from that escrow by referring users who produce it.
        </p>
        <p>
          Boney, the protocol underneath, handles attribution, KPI verification and reward
          settlement. Instead of paying for attention and guessing what converted, a project pays for
          measured outcomes.
        </p>
      </Section>

      <Section title="How Campaigns Work">
        <p>
          A project escrows a reward pool and defines one or more <Term>KPIs</Term> — the outcomes
          it will pay for. Each KPI carries a ladder of <Term>tiers</Term>: thresholds that release
          progressively larger rewards as a promoter clears them. Nothing pays out on promises;
          rewards move only as verified milestones are met.
        </p>
        <p>
          A campaign cannot be <Term>activated</Term> until the escrow vault actually holds the
          reward tokens, which is why funding is a distinct step from creation.
        </p>
      </Section>

      <Section title="Campaign Lifecycle">
        <p>
          A campaign moves through <Term>Pending</Term> → <Term>Active</Term> →{" "}
          <Term>Ended</Term>, with <Term>Paused</Term> and <Term>Cancelled</Term> as off-ramps.
          Each transition is guarded on chain.
        </p>
        <List
          items={[
            ["Create", "Define the token, pool, window, KPIs, and minimum promoter BoneyScore."],
            ["Fund", "Transfer the reward pool into the escrow vault."],
            ["Activate", "Open the campaign to promoters."],
            ["End", "Close the campaign. Opens the settlement grace window."],
            [
              "Reclaim",
              "After the grace window closes, the project withdraws whatever escrow was never earned.",
            ],
          ]}
        />
      </Section>

      <Section title="Joining as a Promoter">
        <p>
          A promoter joins a campaign and receives a <Term>promoter id</Term> — a hash binding
          their address to that specific campaign. The id is the subject of every attribution and
          payout, and it is campaign-scoped by construction.
        </p>
        <p>
          Campaigns may set a minimum <Term>BoneyScore</Term>, which combines two attested signals:
          Ethos credibility, reflecting vouches and reviews from other people, and social reach.
          They are weighted {ETHOS_WEIGHT}:{REACH_WEIGHT} — followers are purchasable, vouches are
          not.
        </p>
        <p>
          Verifying reads both figures and records them through the protocol&rsquo;s attestation
          registry, so a campaign can require a track record without the project vetting anyone by
          hand. A <Term>claimed Ethos profile</Term> is required: Ethos returns a baseline score for
          any address it has never seen, and accepting those would let a freshly generated wallet
          clear a gate it never earned.
        </p>
      </Section>

      <Section title="BoneyScore Ranks">
        <p className="text-ink">
          BoneyScore = Ethos × {ETHOS_WEIGHT} + reach × {REACH_WEIGHT} — a whole number from 0 to{" "}
          {MAX_BONEY_SCORE.toLocaleString("en-US")}.
        </p>
        <List
          items={[
            [
              "Ethos",
              `0–${MAX_ETHOS.toLocaleString("en-US")}. Attested credibility: vouches and reviews from other people.`,
            ],
            [
              "Reach",
              `0–${MAX_ETHOS.toLocaleString("en-US")}. Follower count on a log scale — the ceiling takes about ${MAX_FOLLOWERS_MILLIONS} million followers.`,
            ],
          ]}
        />
        <p>
          Every rank floor sits one point above {ETHOS_WEIGHT} × an Ethos band floor, so it clears
          the score that credibility level reaches with no audience at all. The three columns after
          the range are one threshold from three directions: the Ethos that reaches it with no
          followers, the followers that reach it with no Ethos, and the Ethos still required once a
          maximum audience has contributed everything it can. That last figure is what a gate
          guarantees — a maximum audience is worth{" "}
          {PURE_REACH_CEILING.toLocaleString("en-US")} points, which is{" "}
          {(PURE_REACH_CEILING / ETHOS_WEIGHT).toLocaleString("en-US")} Ethos of credibility a
          promoter never has to earn.
        </p>

        <RankTable />
      </Section>

      <Section title="Comparing Two Real Accounts [Promoters]">
        <p>
          Both accounts hold a claimed Ethos profile, so both scores are ones the protocol would
          issue. Figures were read from Ethos and X in August 2026 and will have moved since — they
          show the shape of the arithmetic, not a live scoreboard.
        </p>

        <ScoreComparison />

        <p>
          <Term>frankdegods</Term> has {COMPARISON_FACTS.followerMultiple}× the audience and scores{" "}
          {COMPARISON_FACTS.scoreShortfallPct}% lower. The{" "}
          {COMPARISON_FACTS.followerGap.toLocaleString("en-US")}-follower advantage is worth{" "}
          {COMPARISON_FACTS.reachAdvantage.toLocaleString("en-US")} points, while the{" "}
          {COMPARISON_FACTS.ethosGap.toLocaleString("en-US")}-point Ethos gap is worth{" "}
          {COMPARISON_FACTS.trustAdvantage.toLocaleString("en-US")} — trust outweighs the audience
          advantage {COMPARISON_FACTS.trustLeverage}×.
        </p>
        <p>
          The ranks are the caveat. Trust alone would place frankdegods in{" "}
          <Term>{COMPARISON_FACTS.trustOnlyRank}</Term>; the audience carries the account{" "}
          {COMPARISON_FACTS.bandsCarried} bands up, to <Term>{COMPARISON_FACTS.carriedRank}</Term>.
          That is what the minimum-Ethos column is for, and why a gate meant to filter for trust
          belongs above {PURE_REACH_CEILING.toLocaleString("en-US")}.
        </p>
      </Section>

      <Section title="Choosing a Minimum BoneyScore [Campaign Creators]">
        <p>
          The gate is immutable once the campaign is created and cannot be lowered afterwards, so a
          number chosen carelessly is a campaign nobody can join. Two figures bracket the useful
          range, and both fall out of the {ETHOS_WEIGHT}:{REACH_WEIGHT} weighting:
        </p>
        <List
          items={[
            [
              PURE_REACH_CEILING.toLocaleString("en-US"),
              "The most an account with zero credibility can score, with a maximum audience. A gate at or below this is clearable on follower count alone: it looks like a credibility filter and is not one.",
            ],
            [
              PURE_TRUST_CEILING.toLocaleString("en-US"),
              "The most an account can score on perfect credibility with no audience. Above this, a promoter needs maximum Ethos and a large following at once, which is nearly nobody.",
            ],
          ]}
        />
        <p>
          Set the gate between them. {DEFAULT_GATE_RANK.min.toLocaleString("en-US")} — the{" "}
          <Term>{DEFAULT_GATE_RANK.name}</Term> floor — is a sound default: it takes reputable
          standing, or weaker standing carried by a genuine audience, and it is where the cost of
          each additional sybil wallet starts to bite, since every one needs its own claimed Ethos
          profile and X account. Promoters see ranks, so a rank floor reads better than a round
          number.
        </p>
        <p>
          One threshold cannot separate trust from audience. An untrusted account with a large
          following and a neutral account with a small one land within a few hundred points of each
          other. If credibility is the point, set the gate above{" "}
          {PURE_REACH_CEILING.toLocaleString("en-US")} and read the composition alongside it.
        </p>
        <p>
          Scores also expire. An attestation stops counting once it ages past its schema&rsquo;s
          freshness window, because credibility is not constant — an Ethos score moves with vouches
          and slashing, and a follower count moves when an account changes hands. A promoter who
          qualified for a campaign last year may not qualify today until they re-verify.
        </p>
      </Section>

      <Section title="Referral Attribution">
        <p>
          Each promoter gets a <Term>boney link</Term> carrying the campaign address and their
          promoter id. A <Term>referral</Term> — someone who arrives through that link — signs an
          EIP-712 <Term>Touch</Term>: a typed message their wallet displays in full, stating that
          they were referred by that promoter.
        </p>
        <p>
          The chain accepts a touch only when the signature recovers to the referral&rsquo;s own
          address, so a promoter cannot claim someone who never signed. A touch expires after the
          campaign&rsquo;s attribution window, and a fresher touch from another promoter replaces an
          older one, so credit reflects the most recent referral rather than the first.
        </p>
      </Section>

      <Section title="Rewards and Settlement">
        <p>
          When a promoter&rsquo;s progress is reported, settlement happens{" "}
          <em className="text-ink">inline</em>: any tiers newly cleared transfer to the
          promoter&rsquo;s wallet in the same transaction.
        </p>
        <p>
          After a campaign ends, a grace window holds the remaining pool while any final progress
          is reported and settled. The project&rsquo;s reclaim right opens only once that window
          closes, so unspent funds cannot be pulled out from under a tier that is still settling.
        </p>
      </Section>

      <Section title="Disclaimer">
        <Notice tone="critical" title="Beta, on testnet, and unaudited.">
          Do not point it at real funds.
        </Notice>
      </Section>

      <div className="flex flex-wrap gap-2 border-t border-hairline pt-6">
        <Link
          href="/"
          className="rounded-md border border-hairline-strong px-3 py-1.5 text-xs font-medium text-ink hover:bg-surface-hover"
        >
          Browse campaigns
        </Link>
        <Link
          href="/create"
          className="rounded-md border border-hairline px-3 py-1.5 text-xs text-ink-secondary hover:bg-surface-hover hover:text-ink"
        >
          Create a campaign
        </Link>
      </div>
    </div>
  );
}

function Section({title, children}: {title: string; children: React.ReactNode}) {
  return (
    <section className="space-y-2.5">
      <h2 className="font-display text-base text-brand">{title}</h2>
      <div className="space-y-2.5 text-[13px] leading-relaxed text-ink-secondary">{children}</div>
    </section>
  );
}

function List({items}: {items: [string, string][]}) {
  return (
    <dl className="space-y-1.5 border-l border-hairline pl-4">
      {items.map(([term, desc]) => (
        <div key={term} className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
          <dt className="w-24 shrink-0 text-[13px] font-medium text-ink">{term}</dt>
          <dd className="text-[13px] leading-relaxed text-ink-secondary">{desc}</dd>
        </div>
      ))}
    </dl>
  );
}

function Term({children}: {children: React.ReactNode}) {
  return <span className="font-medium text-ink">{children}</span>;
}

/**
 * The audience the reach ceiling takes, in millions.
 *
 * Rounded rather than exact: the precise figure is 9,999,999, and "about 10 million" is what that
 * number means in a sentence. Derived so a change to the reach curve moves it.
 */
const MAX_FOLLOWERS_MILLIONS = Math.round(followersForReach(MAX_ETHOS) / 1_000_000);

/**
 * The rank whose floor is recommended as a default gate: reputable Ethos standing, no audience.
 *
 * Looked up by score rather than named, so the floor and the rank name in the prose both follow a
 * band boundary that moves. `rankOf` always resolves — the bands cover the whole range.
 */
const DEFAULT_GATE_RANK = rankOf(ETHOS_WEIGHT * 1800 + 1);

/**
 * Two attested accounts side by side, with every derived figure computed rather than transcribed.
 *
 * Only the four observed inputs are literals — the Ethos scores and follower counts read in August
 * 2026. Reach, the weighted subtotals, the total, and the rank all come from `boneyscore.ts` and
 * `ranks.ts`, so if a weight or a band moves, this table moves with it instead of quietly becoming
 * a lie in the one place a host is most likely to trust it.
 *
 * The pair was chosen for a specific reason: an account whose score is mostly trust against one
 * whose score is mostly audience, both with claimed profiles. A promoter refused for want of an
 * Ethos profile has no score to show, which is a different lesson and belongs in the section above.
 */
const COMPARISON: ReadonlyArray<{
  handle: string;
  note: string;
  ethos: number;
  followers: number;
}> = [
  {
    handle: "serpinxbt",
    note: "exemplary standing, modest audience",
    ethos: 2000,
    followers: 24_360,
  },
  {
    handle: "frankdegods",
    note: "questionable standing, mass audience",
    ethos: 1027,
    followers: 481_017,
  },
];

/**
 * Derived facts for the prose after the table.
 *
 * Computed from `COMPARISON` for the same reason the table is: the sentence "trust outweighs the
 * audience advantage 4.4×" is an arithmetic claim about the current weights, and a hardcoded 4.4
 * would survive a weight change as a falsehood sitting next to a table that had already corrected
 * itself. `bandsCarried` is counted along the ladder for the same reason — it is how far the
 * audience lifts the account, not a figure anyone should be trusted to keep up to date by hand.
 */
const COMPARISON_FACTS = (() => {
  const [trusted, popular] = COMPARISON.map((c) =>
    scoreSplit({ethos: c.ethos, reach: reachFromFollowers(c.followers)}),
  );
  const [trustedRaw, popularRaw] = COMPARISON;

  const reachAdvantage = popular.reachPoints - trusted.reachPoints;
  const trustAdvantage = trusted.ethosPoints - popular.ethosPoints;

  const ladder = ranksAscending();
  const rungOf = (score: number) => ladder.findIndex((r) => r.id === rankOf(score).id);

  return {
    followerMultiple: (popularRaw.followers / trustedRaw.followers).toFixed(1),
    scoreShortfallPct: Math.round(((trusted.total - popular.total) / trusted.total) * 100),
    followerGap: popularRaw.followers - trustedRaw.followers,
    ethosGap: trustedRaw.ethos - popularRaw.ethos,
    reachAdvantage,
    trustAdvantage,
    trustLeverage: (trustAdvantage / reachAdvantage).toFixed(1),
    trustOnlyRank: rankOf(popular.ethosPoints).name,
    carriedRank: rankOf(popular.total).name,
    bandsCarried: rungOf(popular.total) - rungOf(popular.ethosPoints),
  };
})();

function ScoreComparison() {
  const columns = COMPARISON.map((account) => {
    const reach = reachFromFollowers(account.followers);
    const parts = {ethos: account.ethos, reach};
    const {total, ethosPoints, reachPoints, trustPct} = scoreSplit(parts);
    return {
      ...account,
      reach,
      total,
      ethosPoints,
      reachPoints,
      trustPct,
      level: ethosLevel(account.ethos),
      rank: rankOf(total),
    };
  });

  const rows: ReadonlyArray<{label: string; render: (c: (typeof columns)[number]) => string}> = [
    {label: "Ethos score", render: (c) => `${c.ethos.toLocaleString("en-US")} (${c.level})`},
    {label: "Followers", render: (c) => c.followers.toLocaleString("en-US")},
    {label: "Reach (normalised)", render: (c) => c.reach.toLocaleString("en-US")},
    {
      label: `Trust points (×${ETHOS_WEIGHT})`,
      render: (c) => c.ethosPoints.toLocaleString("en-US"),
    },
    {
      label: `Reach points (×${REACH_WEIGHT})`,
      render: (c) => c.reachPoints.toLocaleString("en-US"),
    },
    {label: "BoneyScore", render: (c) => c.total.toLocaleString("en-US")},
    {label: "Trust share", render: (c) => `${c.trustPct}%`},
    {label: "Rank", render: (c) => c.rank.name},
  ];

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <caption className="sr-only">
          BoneyScore composition for two attested accounts, one weighted to trust and one to reach
        </caption>
        <thead>
          <tr className="border-b border-hairline">
            <th scope="col" className="px-2 py-2 text-left text-xs font-medium text-ink-muted">
              Signal
            </th>
            {columns.map((c) => (
              <th key={c.handle} scope="col" className="px-2 py-2 text-right">
                <span className="block font-medium text-ink">@{c.handle}</span>
                <span className="block text-xs font-normal text-ink-muted">{c.note}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const emphasis = row.label === "BoneyScore";
            return (
              <tr key={row.label} className="border-b border-hairline last:border-0">
                <th
                  scope="row"
                  className={`px-2 py-2 text-left font-normal ${
                    emphasis ? "text-ink" : "text-ink-muted"
                  }`}
                >
                  {row.label}
                </th>
                {columns.map((c) => (
                  <td
                    key={c.handle}
                    className={`tnum whitespace-nowrap px-2 py-2 text-right ${
                      emphasis ? "font-medium text-ink" : "text-ink-secondary"
                    }`}
                  >
                    {row.render(c)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The rank ladder, generated from `RANKS` rather than transcribed.
 *
 * A hand-written table would drift the moment a boundary moves, and this one is the reference a
 * campaign owner sets an immutable gate from. Highest rank last so it reads bottom-up as a ladder.
 *
 * The `reachOnly` marker and the `min Ethos at full reach` column are the point of the whole table.
 * The first flags the ranks a promoter reaches on follower count alone; the second says how little
 * credibility every other rank truly requires, which is always less than its name suggests.
 */
function RankTable() {
  const rows = ranksAscending().reverse();

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <caption className="sr-only">
          BoneyScore ranks, their score ranges, the Ethos or follower count that reaches each
          threshold, and the minimum Ethos once a maximum audience is counted
        </caption>
        <thead>
          <tr className="border-b border-hairline">
            <th scope="col" className="px-2 py-2 text-left text-xs font-medium text-ink-muted">
              Rank
            </th>
            <th scope="col" className="px-2 py-2 text-right text-xs font-medium text-ink-muted">
              BoneyScore
            </th>
            {/*
              The two "alone" columns are worked examples of how a threshold is reached; the ladder
              itself and the minimum-Ethos figure are the reference. On a phone the examples yield so
              the reference stays readable without a sideways swipe.
            */}
            <th
              scope="col"
              className="hidden px-2 py-2 text-right text-xs font-medium text-ink-muted md:table-cell"
            >
              Ethos alone
            </th>
            <th
              scope="col"
              className="hidden px-2 py-2 text-right text-xs font-medium text-ink-muted md:table-cell"
            >
              Followers alone
            </th>
            <th scope="col" className="px-2 py-2 text-right text-xs font-medium text-ink-muted">
              Min Ethos at full reach
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((rank) => {
            const {ethosAlone, followersAlone} = rankExamples(rank);
            const minEthos = minEthosAtFullReach(rank);
            return (
              <tr key={rank.id} className="border-b border-hairline align-top last:border-0">
                <td className="px-2 py-2.5">
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium text-ink">{rank.name}</span>
                    {rank.reachOnly ? (
                      <span
                        title="Reachable on follower count alone — no Ethos credibility required"
                        className="rounded border border-brand-dim/50 px-1 text-[10px] text-brand"
                      >
                        reach-only
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-0.5 max-w-md text-xs leading-relaxed text-ink-muted">
                    {rank.blurb}
                  </p>
                </td>
                <td className="tnum whitespace-nowrap px-2 py-2.5 text-right text-ink-secondary">
                  {rank.min.toLocaleString("en-US")}
                  {rank.max > rank.min ? `–${rank.max.toLocaleString("en-US")}` : ""}
                </td>
                <td className="tnum hidden px-2 py-2.5 text-right text-ink-secondary md:table-cell">
                  {rank.min === 0 ? "—" : ethosAlone.toLocaleString("en-US")}
                </td>
                <td className="tnum hidden px-2 py-2.5 text-right text-ink-secondary md:table-cell">
                  {rank.min === 0 ? (
                    "—"
                  ) : followersAlone === null ? (
                    <span className="text-ink-muted">impossible</span>
                  ) : (
                    followersAlone.toLocaleString("en-US")
                  )}
                </td>
                <td className="tnum px-2 py-2.5 text-right text-ink-secondary">
                  {rank.min === 0 ? (
                    "—"
                  ) : minEthos === 0 ? (
                    <span className="text-brand">none</span>
                  ) : (
                    minEthos.toLocaleString("en-US")
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
