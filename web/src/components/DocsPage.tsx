import Link from "next/link";

import {ETHOS_WEIGHT, MAX_BONEY_SCORE, REACH_WEIGHT} from "@/lib/boneyscore";
import {
  PURE_REACH_CEILING,
  PURE_TRUST_CEILING,
  rankExamples,
  ranksAscending,
} from "@/lib/ranks";

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
        <h1 className="font-display text-2xl text-ink">How Boney works</h1>
        <p className="mt-0.5 text-xs text-ink-muted">
          Escrowed, performance-based campaigns between projects and promoters.
        </p>
      </header>

      <Section title="The shape of a campaign">
        <p>
          A project escrows a reward pool and defines one or more <Term>KPIs</Term> — the outcomes
          it will pay for. Each KPI carries a ladder of <Term>tiers</Term>: thresholds that release
          progressively larger rewards as a promoter clears them. Nothing pays out on promises;
          rewards move only as verified milestones are met.
        </p>
        <p>
          A campaign cannot be activated until the
          vault actually holds the tokens, which is why funding is a distinct step from creation.
        </p>
      </Section>

      <Section title="Lifecycle">
        <p>
          A campaign moves through <Term>Pending</Term> → <Term>Active</Term> →{" "}
          <Term>Ended</Term>, with <Term>Paused</Term> and <Term>Cancelled</Term>  as off-ramps.
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

      <Section title="Joining as a promoter">
        <p>
          A promoter joins a campaign and receives a <Term>promoter id</Term> — a hash binding
          their address to that specific campaign. The id is the subject of every attribution and
          payout, and it is campaign-scoped by construction.
        </p>
        <p>
          Campaigns may set a minimum <Term>BoneyScore</Term>. The score combines two attested
          signals: a promoter&rsquo;s Ethos credibility, which reflects vouches and reviews from
          other people, and their social media reach. Trust counts for 70% and reach for 30% — followers are
          purchasable, vouches are not.
        </p>
        <p>
          Reach is scaled logarithmically rather than counted directly. Follower counts are
          power-law distributed, so counting them linearly would let a single large account
          outweigh every genuine mid-tier promoter combined, turning the reach into a whale
          detector instead of an audience signal.
        </p>
        <p>
          Verifying reads both figures and records them through the protocol&rsquo;s attestation
          registry, so a campaign can require a track record without the project vetting anyone by
          hand. Only the numbers reach the chain — social handles stay off it. A claimed Ethos
          profile is required: Ethos returns a baseline score for any address it has never seen,
          and accepting those would let a freshly generated wallet clear a gate it never earned.
        </p>
      </Section>

      <Section title="BoneyScore ranks">
        <p>
          BoneyScore is a <Term>rank</Term> system to differentiate promoters based on calculated <Term>credibility </Term>. it ranges from <Term>0 to {MAX_BONEY_SCORE.toLocaleString("en-US")}.</Term>
        </p>
        <p>
          Every rank begins one point above {ETHOS_WEIGHT} × an Ethos band floor, so it sits
          strictly clear of the score that credibility level reaches with{" "}
          <em className="text-ink">no audience at all</em>. That single-point offset is what keeps{" "}
          <Term>Netrunner</Term> honest: its floor is{" "}
          {(PURE_REACH_CEILING + 1).toLocaleString("en-US")}, one past the most a zero-credibility
          account can ever score. Reach moves an account
          within its rank and can carry it into the next one, but cannot manufacture a rank on its
          own.
        </p>

        <RankTable />

        <p>
          The two columns after the range are the same threshold from opposite ends: the Ethos score
          that reaches it with no followers, and the followers that reach it with no Ethos. Where the
          second column reads <Term>impossible</Term>, no audience of any size clears the bar without
          real credibility.
        </p>
      </Section>

      <Section title="Choosing a minimum score [Campaign Creators]">
        <p>
          The gate is immutable once the campaign is created. It cannot be lowered afterwards, so a
          number chosen carelessly is a campaign nobody can join.
        </p>
        <p>
          Two numbers bracket the whole useful range, and both fall directly out of the{" "}
          {ETHOS_WEIGHT}:{REACH_WEIGHT} weighting:
        </p>
        <List
          items={[
            [
              PURE_REACH_CEILING.toLocaleString("en-US"),
              "The floor of usefulness — the most an account with zero credibility can score, with a maximum audience. Any gate at or below this is clearable on follower count alone. It looks like a credibility filter and is not one.",
            ],
            [
              PURE_TRUST_CEILING.toLocaleString("en-US"),
              "The ceiling of sanity — the most an account can score on perfect credibility with no audience. A gate above this demands maximum Ethos and a large following at once, which is nearly nobody.",
            ],
          ]}
        />
        <p>
          Between those two is where a gate does real work. A practical default is{" "}
          <Term>{(ETHOS_WEIGHT * 1800 + 1).toLocaleString("en-US")}</Term>, the floor of{" "}
          <Term>Ronin</Term>: it requires reputable standing, or weaker standing carried by a genuine
          audience, and it is where the cost of running each additional sybil wallet starts to bite —
          every one needs its own claimed Ethos profile and X account. Setting a gate to a rank floor
          rather than a round number keeps its meaning legible to promoters, who see ranks.
        </p>
        <p>
          A single threshold cannot separate trust from audience, so it will not express &ldquo;
          credible people only&rdquo;. An untrusted account with a large following and a neutral
          account with a small one can land within a few hundred points of each other. If
          credibility is what matters, set the gate above{" "}
          {PURE_REACH_CEILING.toLocaleString("en-US")} and read the ranks rather than trusting the
          number alone.
        </p>
        <p>
          Scores also expire. An attestation stops counting once it ages past its schema&rsquo;s
          freshness window, because credibility is not constant — an Ethos score moves with vouches
          and slashing, and followers count moves when an account changes hands. A promoter who
          qualified for a campaign hosted last year may not qualify for hosted today until they re-verify.
        </p>
      </Section>

      <Section title="Attribution">
        <p>
          Each promoter gets a <Term>tracking link</Term> carrying the campaign address and their
          promoter id. A <Term>referral</Term> — someone who arrives through that link — signs an
          EIP-712 <Term>Touch</Term>: an explicit, wallet-signed statement that they were referred
          by that promoter.
        </p>
        <p>
          The signature matters. The chain accepts a touch only when the referral&rsquo;s own signature recovers
          to it. A touch expires after the campaign&rsquo;s attribution window, and a fresher touch
          from another promoter replaces an older one, so credit reflects the most recent referral
          rather than the first.
        </p>
      </Section>

      <Section title="Rewards and Settlement">
        <p>
          When a promoter&rsquo;s progress is reported, settlement
          happens <em className="text-ink">inline</em>: any tiers newly cleared transfer to the
          promoter&rsquo;s wallet in the same transaction.
        </p>
        <p>
          After a campaign ends, a grace window holds the remaining pool while any final progress
          is reported and settled. The project&rsquo;s reclaim right opens only once that window
          closes, so unspent funds cannot be pulled out from under a tier that is still settling.
        </p>
      </Section>

      <Section title="What this Interface is">
        <p>
          A read-heavy front over the deployed contracts, plus the write paths a project or
          promoter needs. It holds no keys, runs no backend, and stores nothing about you: every
          number comes from a chain read, and every action is a transaction you sign.
        </p>
        <b>
          <p className="text-ink">
          In beta (testnet) and unaudited. Do not point it at REAL funds.
        </p>

        </b> 
        
      </Section>

      <div className="flex flex-wrap gap-2 border-t border-hairline pt-6">
        <Link
          href="/"
          className="rounded-md border border-hairline-strong px-3 py-1.5 text-xs font-medium text-ink hover:bg-surface-hover"
        >
        Browse Boneyard
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
 * The rank ladder, generated from `RANKS` rather than transcribed.
 *
 * A hand-written table would drift the moment a boundary moves, and this one is the reference a
 * campaign owner sets an immutable gate from. Highest rank last so it reads bottom-up as a ladder.
 *
 * The `reachOnly` marker is the point of the whole table: those rows are the ranks a promoter can
 * reach on follower count alone, so a gate inside them filters for audience, not credibility.
 */
function RankTable() {
  const rows = ranksAscending().reverse();

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <caption className="sr-only">
          BoneyScore ranks, their score ranges, and the Ethos score or follower count that reaches
          each one
        </caption>
        <thead>
          <tr className="border-b border-hairline">
            <th scope="col" className="px-2 py-2 text-left text-xs font-medium text-ink-muted">
              Rank
            </th>
            <th scope="col" className="px-2 py-2 text-right text-xs font-medium text-ink-muted">
              BoneyScore
            </th>
            <th scope="col" className="px-2 py-2 text-right text-xs font-medium text-ink-muted">
              Ethos alone
            </th>
            <th scope="col" className="px-2 py-2 text-right text-xs font-medium text-ink-muted">
              Followers alone
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((rank) => {
            const {ethosAlone, followersAlone} = rankExamples(rank);
            return (
              <tr key={rank.id} className="border-b border-hairline last:border-0 align-top">
                <td className="px-2 py-2.5">
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium text-ink">{rank.name}</span>
                    {rank.reachOnly ? (
                      <span
                        title="Reachable on follower count alone — no Ethos credibility required"
                        className="rounded border border-warning/50 px-1 text-[10px] text-warning"
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
                <td className="tnum px-2 py-2.5 text-right text-ink-secondary">
                  {rank.min === 0 ? "—" : ethosAlone.toLocaleString("en-US")}
                </td>
                <td className="tnum px-2 py-2.5 text-right text-ink-secondary">
                  {rank.min === 0
                    ? "—"
                    : followersAlone === null
                      ? <span className="text-ink-muted">impossible</span>
                      : followersAlone.toLocaleString("en-US")}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
