import Link from "next/link";

/**
 * `/docs` — how the protocol works.
 *
 * A static server component: nothing here reads the chain, so it renders without a wallet, a
 * deployment, or a network round trip. It is the page a KOL or project lands on before they have
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
          Escrow is real custody, not an accounting entry. A campaign cannot be activated until the
          vault actually holds the tokens, which is why funding is a distinct step from creation.
        </p>
      </Section>

      <Section title="Lifecycle">
        <p>
          A campaign moves through <Term>Pending</Term> → <Term>Active</Term> →{" "}
          <Term>Ended</Term>, with <Term>Paused</Term> and <Term>Cancelled</Term> as off-ramps.
          Each transition is guarded on chain, so the UI mirrors those guards rather than guessing:
          a blocked action renders disabled with the contract&rsquo;s own reason.
        </p>
        <List
          items={[
            ["Create", "Define the token, pool, window, KPIs, and minimum promoter BoneyScore."],
            ["Fund", "Transfer the reward pool into the escrow vault."],
            ["Activate", "Open the campaign to promoters. Requires funded escrow."],
            ["End", "Close the campaign. Opens the claim grace window."],
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
          payout, and it is campaign-scoped by construction: a link issued for one campaign cannot
          farm another.
        </p>
        <p>
          Campaigns may set a minimum <Term>BoneyScore</Term>. The score combines two attested
          signals: a promoter&rsquo;s Ethos credibility, which reflects vouches and reviews from
          other people, and their X reach. Trust counts for 70% and reach for 30% — followers are
          purchasable, vouches are not, but an audience still matters for promotion.
        </p>
        <p>
          Reach is scaled logarithmically rather than counted directly. Follower counts are
          power-law distributed, so counting them linearly would let a single large account
          outweigh every genuine mid-tier promoter combined, turning the reach term into a whale
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

      <Section title="Attribution">
        <p>
          Each promoter gets a <Term>tracking link</Term> carrying the campaign address and their
          promoter id. A user arriving through that link signs an EIP-712 <Term>Touch</Term>: an
          explicit, wallet-signed statement that they were referred by that promoter.
        </p>
        <p>
          The signature matters. Attribution is not a cookie or a query parameter the server
          trusts — the chain accepts a touch only when the user&rsquo;s own signature recovers to
          it. A touch expires after the campaign&rsquo;s attribution window, and a fresher touch
          from another promoter replaces an older one, so credit reflects the most recent referral
          rather than the first.
        </p>
      </Section>

      <Section title="Rewards and settlement">
        <p>
          When a promoter&rsquo;s progress is reported, settlement happens{" "}
          <em className="text-ink">inline</em>: any tiers newly cleared pay out in the same
          transaction. That is why a healthy promoter&rsquo;s <Term>claimable</Term> balance is
          often zero while their <Term>earned</Term> figure is large — the rewards already landed.
        </p>
        <p>
          Claims stay open through a grace window after a campaign ends. The project&rsquo;s
          reclaim right is the mirror image: it opens only once that window closes, so the two can
          never both be open.
        </p>
      </Section>

      <Section title="What this interface is">
        <p>
          A read-heavy terminal over the deployed contracts, plus the write paths a project or
          promoter needs. It holds no keys, runs no backend, and stores nothing about you: every
          number comes from a chain read, and every action is a transaction you sign.
        </p>
        <p className="text-ink-muted">
          Running on a testnet and unaudited. Do not point it at funds you care about.
        </p>
      </Section>

      <div className="flex flex-wrap gap-2 border-t border-hairline pt-6">
        <Link
          href="/"
          className="rounded-md border border-hairline-strong px-3 py-1.5 text-xs font-medium text-ink hover:bg-surface-hover"
        >
          Browse the boneyard
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
