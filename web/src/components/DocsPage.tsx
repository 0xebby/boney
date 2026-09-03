import Link from "next/link";

import {ETHOS_WEIGHT, ethosLevel, reachFromFollowers, scoreSplit} from "@/lib/boneyscore";
import {PURE_REACH_CEILING, PURE_TRUST_CEILING, rankOf, ranksAscending} from "@/lib/ranks";
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

      <Section title="Promoting a Campaign">
        <p>
          Promoting a campaign mints a <Term>promoter id</Term> — a hash binding the promoter&rsquo;s
          address to that specific campaign. The id is the subject of every attribution and
          payout, and it is campaign-scoped by construction.
        </p>
        <p>
          Campaigns may set a minimum <Term>BoneyScore</Term>, which combines two attested signals:
          Ethos credibility, reflecting vouches and reviews from other people, and social reach.
          Credibility counts for the most — followers are purchasable, vouches are not.
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
          BoneyScore is powered by the <Term>Ethos</Term> credibility score, read alongside social
          reach.
        </p>
        <List
          items={[
            ["Ethos", "Attested credibility: vouches and reviews from other people."],
            ["Reach", "Follower count, on a curve that flattens as an audience grows."],
          ]}
        />
        <p>
          A rank is a band of the score, so read a badge as a statement about score rather than
          about character: a large audience can carry modest credibility several bands up. The{" "}
          <Term>reach-only</Term> ranks are the ones an account with no credibility at all can hold.
        </p>

        <RankTable />
      </Section>

      <Section title="Comparing Two Real Accounts [Promoters]">
        <p>
          Both accounts hold a claimed Ethos profile, so both scores are ones the protocol would
          issue. Figures were read from Ethos and X in August 2026 and will have moved since — they
          illustrate rather than track.
        </p>

        <ScoreComparison />

        <p>
          <Term>frankdegods</Term> has {COMPARISON_FACTS.followerMultiple}× the audience and still
          scores lower. Vouches outweigh followers, which is the whole point of the gate.
        </p>
        <p>
          The ranks are the caveat. Credibility alone would place the account in{" "}
          <Term>{COMPARISON_FACTS.trustOnlyRank}</Term>, a reach-only band; its audience carries it
          up to <Term>{COMPARISON_FACTS.carriedRank}</Term>. Nothing is wrong with the score, but a
          project reading that rank as exemplary standing has misread it.
        </p>
      </Section>

      <Section title="Choosing a Minimum BoneyScore [Campaign Creators]">
        <p>
          The gate is immutable once the campaign is created and cannot be lowered afterwards, so a
          number chosen carelessly is a campaign nobody can promote. Two figures bracket the useful
          range:
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
          One threshold cannot separate trust from audience: an untrusted account with a large
          following and a neutral account with a small one can land at the same score. If
          credibility is the point, set the gate above{" "}
          {PURE_REACH_CEILING.toLocaleString("en-US")} — clear of every reach-only rank.
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
          promoter id. A <Term>referral</Term> — someone who arrives through that link — signs a{" "}
          <Term>Touch</Term>: a message their wallet displays in full, stating that they were
          referred by that promoter.
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
 * 2026. The score and the rank come from `boneyscore.ts` and `ranks.ts`, so if a weight or a band
 * moves, this table moves with it instead of quietly becoming a lie in the one place a host is most
 * likely to trust it.
 *
 * The pair is an account whose score is mostly credibility against one whose score is mostly
 * audience, both with claimed profiles. A promoter refused for want of an Ethos profile has no score
 * to show, which is a different lesson and belongs in the section above.
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
 * Computed from `COMPARISON` for the same reason the table is: a hardcoded multiple or rank name
 * would survive a weight change as a falsehood sitting next to a table that had already corrected
 * itself.
 */
const COMPARISON_FACTS = (() => {
  const [, popular] = COMPARISON.map((c) =>
    scoreSplit({ethos: c.ethos, reach: reachFromFollowers(c.followers)}),
  );
  const [trustedRaw, popularRaw] = COMPARISON;

  return {
    followerMultiple: (popularRaw.followers / trustedRaw.followers).toFixed(1),
    trustOnlyRank: rankOf(popular.ethosPoints).name,
    carriedRank: rankOf(popular.total).name,
  };
})();

function ScoreComparison() {
  const columns = COMPARISON.map((account) => {
    const {total} = scoreSplit({ethos: account.ethos, reach: reachFromFollowers(account.followers)});
    return {
      ...account,
      total,
      level: ethosLevel(account.ethos),
      rank: rankOf(total),
    };
  });

  const rows: ReadonlyArray<{label: string; render: (c: (typeof columns)[number]) => string}> = [
    {label: "Ethos score", render: (c) => `${c.ethos.toLocaleString("en-US")} (${c.level})`},
    {label: "Followers", render: (c) => c.followers.toLocaleString("en-US")},
    {label: "BoneyScore", render: (c) => c.total.toLocaleString("en-US")},
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
 * The `reachOnly` marker flags the ranks a promoter reaches on follower count alone, which is the
 * one thing a score range does not say about the rank it belongs to.
 */
function RankTable() {
  const rows = ranksAscending().reverse();

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <caption className="sr-only">
          BoneyScore ranks and the score range each one covers
        </caption>
        <thead>
          <tr className="border-b border-hairline">
            <th scope="col" className="px-2 py-2 text-left text-xs font-medium text-ink-muted">
              Rank
            </th>
            <th scope="col" className="px-2 py-2 text-right text-xs font-medium text-ink-muted">
              BoneyScore
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((rank) => (
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
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
