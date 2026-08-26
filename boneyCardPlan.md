# BoneyCard — build plan

Scope: a fun, progressive card showing what a promoter has actually done on Boneyard. Their history,
accumulating, in a shape worth sharing. **Not a ranking, not a discovery filter, not a gate** — see
*What this is not*, because that boundary is what keeps the build small.

Companion to `boneyMd/todo.md` (D1–D9) and `boneyMd/todo-frontend.md` (F1–F8). Written 2026-08-26.

Status legend: `[ ]` todo · `[~]` in progress · `[x]` done + verified

---

## What this is not

Stating this first because three earlier drafts of this plan were much larger, and every extra piece
came from assuming the card would be ranked on:

- **Not a leaderboard.** Nothing sorts promoters by these numbers. That removes the need for
  aggregate counter entities in the subgraph entirely — you cannot `orderBy` a derived value, but
  nothing needs ordering.
- **Not a gate.** Delivery never enters `ReputationRegistry.scoreOf`, so `minReputation` is
  untouched, `MAX_BONEY_SCORE` doesn't move, and the whole rank-ladder migration in `ranks.ts`
  (every boundary is `ETHOS_WEIGHT × ethos_floor`, resting on `7·1200 == 3·2800 == 8400`) never
  has to happen.
- **Not an anti-sybil surface.** Nothing is at stake on the card, so there is nothing to farm. A
  promoter inflating their own bone is lying to themselves.
- **Not comparative.** Which is why the card carries **cumulative counts, not percentages** — see
  *Counts, not rates*. That single decision is what removes the only subgraph change this plan
  otherwise needed.

If any of those change later, this document is the wrong starting point.

---

## Two stages, and the card is mostly stage 1

**Stage 1 — onboarding.** A KOL connects a wallet and immediately sees a BoneyScore, a rank, a
level-1 bone, and *the campaigns they qualify for*. No campaigns joined, no history, no gas. This is
the whole point of the card for most of its life, and it needs **nothing from the subgraph**.

**Stage 2 — progression.** The card regenerates as campaigns are joined, referrals convert, and tiers
pay. That is the history half, and it is where the subgraph comes in.

Stage 1 ships on code that already exists. Everything below is ordered accordingly.

---

## Two scores, and conflating them reverts transactions

The single most important thing in this plan.

**Today a KOL who connects a wallet sees `0`.** `usePromoterReputation` reads
`ReputationRegistry.scoreOf` from the chain, and the registry returns 0 for any wallet it has no
records for. Ethos is never consulted in the render path — the only place it is read is
`/api/attest`, which *signs attestations for submission*. So the current first-run experience is the
exact opposite of the one described: a promoter with a strong Ethos profile and 200k followers reads
as zero until they pay gas.

That means there are two different numbers, and the card needs both:

| | Prospective score | On-chain score |
|---|---|---|
| Source | Ethos + X, computed off-chain | `ReputationRegistry.scoreOf` |
| Cost | Free, instant, no wallet signature | One transaction per schema, promoter pays gas |
| Exists for a new wallet | Yes | **No — reads 0** |
| What it's for | The card, the rank, "campaigns you qualify for" | What `Campaign.join()` actually gates on |

The card shows the **prospective** score — otherwise every gated campaign reads as barred and the
onboarding is worthless. But joining checks the **on-chain** one. So the qualify list must say
*"you qualify — verify to join"*, never *"qualified"*.

`canJoin` (`web/src/lib/promoter.ts:84`) already encodes exactly this distinction: it returns
`actionable: "attest"` when a reputation gate is the only blocker, with the comment *"an un-attested
wallet reads as score 0 and would otherwise look permanently barred from every gated campaign"*. Use
it; do not write a second gate check.

Getting this wrong reproduces a bug the repo has already paid for once. From `useScoreCeiling`: *"The
form's local constant said 28,000, the chain said 0, and the disagreement surfaced as a reverted
transaction the user had already paid for."*

### The score is live and dated. Only the bone is cumulative.

`discovery.ts` has already litigated this and named its field `scoreAtJoin` rather than `score`,
because two things make a stored score drift:

- **Attestations expire.** `scoreOf` counts only values inside their schema's `maxAge`, so *"a
  promoter who joined at 19,494 can score 5,256 today having done nothing at all."*
- **Weights are governable.** `setSchemaWeight` reprices every score retroactively.

Its conclusion applies unchanged here: *"presenting it as a current score would be a lie."* So the
card does **not** bake a score in at connect time. It recomputes on view, and any stored figure
carries its date.

This gives the card two rules at once, which is fine as long as they are labelled:

- **Score half — live, and can go down.** Ethos moves, followers move, attestations expire.
- **History half — cumulative, and never goes down.** Campaigns, tiers, referrals, bone level.

---

## The other fact the build follows from

**BoneyScore contains no delivery data.**

```
BoneyScore = 7 * ETHOS_SCORE + 3 * X_REACH        web/src/lib/boneyscore.ts:4
```

Both inputs are pre-campaign: Ethos vouches and a log-normalised follower count. Neither moves when a
promoter delivers. That is precisely why it works for stage 1 — a promoter who has done nothing yet
still has one — and precisely why stage 2 has to read campaign history instead.

**Stage 2's history has to come from the subgraph.** `Campaign` exposes only point lookups
(`promoterIdOf`, `promoterOf`), so the chain can confirm a promoter but not enumerate one — the header
of `web/src/lib/promoters.ts` covers this. The existing directory rebuilds membership from
`PromoterJoined` logs, bounded by `MAX_WINDOWS` (24) × `MAX_LOG_RANGE` (1900) = **45,600 blocks, ~25
hours of Base**, with the rest reported as `skippedBefore`. Accumulated history cannot be built on a
25-hour window. `boney-indexer` is deployed and indexes everything needed; the web app has never read
it (`boneyMd/spec/09-offchain.md:248`).

---

## What already exists — do not rebuild

| Piece | Where | State |
|---|---|---|
| Every event the card needs | `PromoterJoined`, `ProgressCredited`, `TierSettled`, `StatusChanged` | Emitted and **already indexed** |
| Membership + score at join | `Promoter` entity | `wallet`, `promoterId`, `joinedAtBlock`, `reputation` at join |
| Credit history | `Credit` (`schema.graphql:123`) | `campaign`, `kpiIndex`, `promoterId`, `user`, `amount`, `timestamp` |
| Payout history | `TierPayout` (`schema.graphql:136`) | Carries the **wallet** and `paid`. Wallet-keyed already |
| KPI shape | `Kpi` entity | `kind`, `aggregate`, event source, `target` |
| Score display + bands | `boneyscore.ts`, `ranks.ts`, `ui/RankBadge`, `ui/TrustReachBar`, `ui/Meter` | Done, tested |
| UI kit | `ui/StatTile`, `ui/Card`, `ui/StatusPill`, `ui/DataTable` | Done |

**No subgraph changes are needed.** That is a consequence of *Counts, not rates*, below.

---

## The card is four queries and a fold

Everything derives from what is already indexed:

```graphql
promoters(where: {wallet: $w})            # memberships: campaign, promoterId, joinedAtBlock, reputation
tierPayouts(where: {promoter: $w})        # tiers crossed, with `paid` and `timestamp`
credits(where: {promoterId_in: $ids})     # credited actions: campaign, kpiIndex, user, amount, timestamp
kpis(where: {campaign_in: $campaigns})    # kind, aggregate flag, event source
```

Two round trips — queries 2–4 need `$ids` / `$campaigns` from the first — then pure arithmetic in
`lib/boneycard.ts`. That is where the math belongs per F6, so deriving rather than pre-aggregating
avoids a second implementation instead of adding one, which is the same reasoning the subgraph's own
schema header uses for keeping the pre-attribution filter out of AssemblyScript.

**`promoterId` is per-campaign; that costs one hop.** A wallet promoting three campaigns has three
unrelated ids and `Credit` carries only the id, so credits are reached through `Promoter`. The card's
key is `(chainId, wallet)` and `promoterId` never leaves the query layer.

**The hop is safe, and here is why.** `Promoter.wallet` is null when only `PromoterRegistered` was seen
(`schema.graphql:90`) — but such a row can never have credits. `join()` writes
`_promoterOf[promoterId]`, calls `registerPromoter`, and emits `PromoterJoined` **in one transaction**
(`Campaign.sol:266`); `_promoterOf` is written nowhere else; and `reportUserAction` reverts
`NoAttribution` on reading zero. So any `Credit` implies a join already landed with the wallet
recorded. `promoters(where: {wallet: $w})` is complete for everything credit-bearing, and there is no
event-ordering hazard to guard.

Minor: `registerPromoter` is permissionless by design (`AttributionRegistry.sol:79`), so anyone can
emit `PromoterRegistered` and create a wallet-less `Promoter` row pointing at a non-campaign.
Filtering by wallet excludes them for free — just never walk `Promoter` unfiltered.

---

## Counts, not rates

The pivotal design decision, and the reason this plan is short.

A percentage exists to be compared. "Deliverability 87%" only means something next to someone else's
94%, and the moment the card shows it, the card is a ranking whether or not anything sorts on it.
A *progressive* card wants the opposite: numbers that accumulate, that only ever go up, that make
opening it again feel like progress.

So the card carries **cumulative counts and milestones**. Not `25/27` — just `25 tiers crossed`.

Three things follow:

1. **No denominators, so no tier data, so no subgraph change.** The ratios were the only thing that
   needed `Kpi.tiers` (unindexed — `TierPayout` records which tiers were crossed, never how many
   existed). Dropping them drops the dependency. If ratios ever come back, that one field and one
   extra `eth_call` in `registry.ts:66` is the whole cost.
2. **No exclusion arithmetic.** A dozen fairness rules existed to keep unearned blame out of a
   denominator. With no denominators there is no blame to keep out — the remaining cases are display
   decisions, not maths. See *Two display rules*.
3. **Nothing can go down**, which is what makes the progression honest rather than a marketing curve.

---

## What the card shows

Stage-1 fields need no subgraph and exist for a wallet that has done nothing. Stage-2 fields are
counts over the four queries. Definitions stated so a fixture can pin them.

| Field | Stage | Definition |
|---|---|---|
| BoneyScore | 1 | Prospective score from `/api/score`, labelled *credibility & reach*. Live, dated |
| Rank | 1 | `rankOf(score)` — existing ladder, existing `ui/RankBadge` |
| Trust / reach split | 1 | `explainScore` — existing `ui/TrustReachBar` |
| Campaigns you qualify for | 1 | `canJoin` folded over `useCampaigns`, grouped three ways |
| Verification state | 1 | Attested / unattested / expired, from `usePromoterReputation` freshness |
| Campaigns joined | 2 | `count(distinct campaign)` from `promoters` |
| Projects worked with | 2 | `count(distinct campaign.project)` |
| Campaigns delivered on | 2 | `count(distinct campaign)` having ≥1 `Credit` |
| Referrals brought | 2 | `count(distinct Credit.user)` |
| Actions verified | 2 | `count(Credit)` |
| Tiers crossed | 2 | `count(TierPayout)` |
| Earned | 2 | `Σ TierPayout.paid`, **grouped by `campaign.token`** |
| Promoting since | 2 | timestamp of earliest `PromoterJoined` |
| Specialization | 2 | distribution of `Kpi.kind` over KPIs with credit |
| Bone level | 2 | 🦴 ×1–5 from the stage-2 counts. Level 1 is the stage-1 card |

Two things deliberately absent:

- **No lifetime sum of `Credit.amount`.** Amounts are per-KPI units with a per-KPI `scale`, so one
  campaign's amount is a swap count, another's is raw wei, another's a scaled token total. Adding
  them produces a large meaningless number — which is what "Verified actions: 31,847" was. Amounts
  appear on per-campaign rows, in their own units, never totalled.
- **No `progress / Kpi.target`.** `Types.sol:45` is explicit that `target` is the *campaign-wide*
  goal and "Informational; tiers drive payouts", so dividing one promoter's progress by it is wrong
  by however many promoters joined, and unbounded above — which is where "116%" came from.

**`Earned` is per token, never summed.** Base Sepolia alone has two mock bUSD deployments at different
addresses; a card that adds them asserts a 1:1 rate nobody set. Render the dominant token with
decimal-correct formatting via `lib/token.ts` and a "+2 other tokens" affordance.

---

## The progression

This is the feature, not a decoration on it. Three layers:

**Bone level, 🦴 ×1–5.** From cumulative counts only — campaigns delivered on, tiers crossed,
distinct projects. **Must never decrease**, asserted in tests. A level that drops takes away
something already earned, usually over something the promoter did not control.

**Milestones**, each with the date it happened, from `joinedAtBlock` / `Credit.timestamp` /
`TierPayout.timestamp`: first campaign joined · first action credited · first tier crossed · first
paid · 5th campaign · first repeat project · first second protocol type. A dated list of firsts is
the most direct expression of "progressive history", and every timestamp needed is already indexed.

**Specialization badges.** `Types.KpiKind` (Mint / Swap / Deposit / Stake / Bridge / …) earned by
having credit on that kind, with the tracked event named in words — `lib/eventNames.ts`
`catalogSignature` already does that naming for the campaign detail page.

**The empty card is the most important state.** It is what every new promoter sees, and it sets
whether the card reads as an invitation or a void. A blank level-1 bone with the milestone list
showing what is *next* — "join your first campaign" — not an error, not zeros, not a spinner.

---

## Two display rules

All that survives of the old exclusion machinery. Neither is arithmetic; both are "don't render a
confusing number".

1. **Aggregate KPIs are marked "not creditable", never counted as a miss.** `reportUserAction` reverts
   `AggregateKpi` before attribution or verification (`Campaign.sol:306`), and the only writable path
   `applyAggregateUpdate` moves `_totalProgress` and never `_progress[promoter]`. No promoter can
   score on one, ever. Confirmed live 2026-08-26: campaign 8 "Gyndore" (`0x6c44ad36…`, registry
   `0x6427217e`) carried one aggregate Swap KPI with a 3-tier, 27,000 bUSD ladder that could never
   pay, and was ended 3h in with `totalProgress` 0. Say so on the card row — it is a project-side
   error worth surfacing, not noise to hide.
2. **A campaign ended early by the project says so.** `end()` is project-callable at any time
   (`Campaign.sol:235`). A campaign killed hours after launch offered no chance to deliver, and the
   row should explain itself rather than sit there flat and unexplained.

---

## Phases

### P0 — Score on connect. Ships on existing code.

The whole of stage 1's number. Nothing here touches the subgraph or campaign history.

- [x] `web/src/app/api/score/route.ts` — read-only score. `buildScoreReport(wallet)`
      (`lib/ethos.ts:289`) already returns `{ethos, followers, smartFollowers, reach, handle,
      profileId, status}` with **no signature and no transaction**; `/api/attest` calls it and then
      signs. This route stops before the signing. That is the "precompute".
- [x] Cache it. `buildScoreReport` fans out to Ethos plus `fetchFollowers` / `fetchSmartFollowers`,
      and the follower sources throttle back-to-back requests. A TTL cache keyed by wallet is not an
      optimisation here, it is what stops the card failing on a refresh.
      *Done as a bounded per-process `Map`: 5 min for a success, 30 s for a failure, 500 entries
      with oldest-first eviction. Failures are cached far shorter so claiming a profile is not
      contradicted for the next hour.*
- [x] **Degrade, don't zero.** If the follower fetch throttles, show the Ethos component and mark
      reach *unavailable* — never 0. Reach is 30% of the score, so a silent zero is a 30% haircut
      presented as fact. Same principle `usePromoterReputation` already applies to distinguishing
      "never verified" from "verified, then expired".
      *`reachUnconfirmed`. Note the limit found while building it: `fetchFollowers` returns 0 on
      **every** failure path by design, so a throttle is indistinguishable from an empty account.
      The flag is therefore a heuristic — handle present, followers 0 — and the UI words it as one
      ("reach unconfirmed"), never as a fact.*
- [x] `useBoneyCard` returns the prospective score, its parts, and the rank from `rankOf`. Reuse
      `ui/RankBadge` and `ui/TrustReachBar` — the trust/reach split is already built and tested.

### P1 — Campaigns you qualify for

The hook that makes stage 1 worth opening. Also already half-built.

- [x] Fold `canJoin` (`lib/promoter.ts:84`) over `useCampaigns()` with the **prospective** score, and
      group the result three ways: *joinable now* · *qualify, verify to join* · *score too low*.
      `canJoin` already returns `actionable: "attest"` for the middle group.
      *Shipped as five groups: `joined` and `closed` split out, because membership is not a
      qualification question and no attestation fixes an Ended campaign. `canJoin` runs twice — once
      per score — rather than the gate being reimplemented.*
- [x] Pure function in `lib/boneycard.ts`, fixtures included. No new gate logic.
- [x] The copy matters more than the code here. Five of the eight live campaigns on registry
      `0x6427217e` set `minReputation` **0** (the SeedFive five) and are joinable with no verification
      at all; the gated ones are lynx 20,000, gravy labs 10,000, WETH2 20,000. So a brand-new wallet's
      honest first message is *"you can join 5 campaigns right now — verify to unlock 3 more"*, which
      is a far better opening than a score with nothing attached to it.
      *`qualificationHeadline`, with an `anonymous` voice for the no-wallet case — "you can join" is a
      claim about a reader whose address nobody knows.*
- [x] Check the gate ceiling with `useScoreCeiling`, not `MAX_BONEY_SCORE`. A registry with no
      schemas registered has a ceiling of 0, and that state is reachable on a redeploy that skips
      `SeedDevRep`.
      *`scoreScaleFrom` folds `maxScore()` into a meter denominator **and** a `verifiable` flag. The
      flag turned out to be the load-bearing half: on a ceiling of 0 the Verify button and every
      "verify to unlock" line are suppressed, because attesting there costs one transaction per
      schema and cannot raise `scoreOf` at all. Uncapped (`uint256` max) drops the meter rather than
      drawing every real score as an empty bar.*

### P2 — Verify from the card

- [x] Wire the attest CTA to `useEthosAttestation`, which already fetches the signed bundle and
      submits sequentially with nonce handling. Nothing new to build; it needs a home on the card.
- [x] After it lands, the on-chain score exists and the *qualify, verify to join* group collapses into
      *joinable now*. That transition is the card's first real moment of progress — worth animating.
      *Wired: `useEthosAttestation` owns no query, so `/card` refetches `usePromoterReputation` on a
      successful attest — the same thing `PromoterPanel` does. Without it the cached `scoreOf` left
      every just-unlocked campaign under "Verify to join", asking for a verification already paid
      for. **Not yet animated** — the transition is correct but abrupt.*
- [x] Show attestation freshness. `usePromoterReputation` already reads it, and a score that expired
      needs "re-verify", not "verify".

**Reachability, which the phases above did not list:** `/card` had no inbound link, so stage 1 was
shipping dead. Added to `lib/nav.ts` gated on the connection alone — the card is the one personal
entry worth opening with no history at all, which is the whole point of it — placed before Promoters.
The deeper linking in P5 (`/promoters`, campaign-detail promoter rows) still stands.

### P3 — History read path

Stage 2 begins. First consumer of the subgraph in the app;
`boneyMd/spec/09-offchain.md:248` stops being true here.

- [x] `web/src/lib/graph.ts` — typed POST to the Studio endpoint, `NEXT_PUBLIC_SUBGRAPH_URL` in
      `web/.env.local`. Needs no API key.
      *`GraphResult` is a two-armed union, so a caller cannot reach the rows without handling
      `unavailable` first — the fail-soft rule is a type, not a convention. Two findings worth
      keeping: a 200 carrying **both** `data` and `errors` is classified as a failure, because
      graph-node returns a filled `data` alongside a field-level error and folding that produces
      counts that are quietly too low; and every address in a filter goes through `hexLower`, because
      graph-node compares `Bytes` byte-wise and a checksummed address matches **nothing** while
      failing as an empty list rather than an error. Wallets arrive checksummed from wagmi, so that
      one was not hypothetical.*
- [x] The four queries in *The card is four queries and a fold*. Two round trips, `promoters` first.
      *`tierPayouts` rides along in trip 1 — `TierPayout.promoter` is the wallet, so it needs nothing
      from the `promoterId` hop — and trip 2 is **not sent at all** when trip 1 finds no memberships,
      since `Credit` is keyed by `promoterId` and there is nothing it could find. `_meta` selects only
      `block { number }` and `hasIndexingErrors`: a field the deployment does not have fails
      *validation*, which would take the whole document with it.*
- [x] **Fail soft and visibly.** An unreachable or lagging subgraph renders "history unavailable",
      never a zeroed card. Zeros are a claim about someone; a fetch failure must not be able to make
      one. Surface `_meta { block { number } }` lag in the card footer.
      *Six reasons, because the copy differs and two of them are not errors: `not-configured` and
      `unsupported-chain` say "history is not indexed here" and offer no retry, since wagmi's
      `chains[0]` is anvil and every no-wallet render would otherwise blame an outage.*
- [x] Paginate `credits` at 1,000 rows (The Graph's per-query ceiling) and flag truncation rather
      than quietly folding a partial set.
      *Cursored on `id_gt`, not `skip` — graph-node caps `skip` at 5,000. The cursor's ordering is
      lexicographic (`<txHash>-<logIndex>`), so it is a total order and nothing else: everything
      time-ordered sorts on `timestamp` afterwards, or the milestones would be dated by transaction
      hash. Capped at 10 pages, and a full `kpis` page is flagged rather than walked — 1,000 KPIs
      already implies a wallet in a hundred campaigns, and a specialization badge is not worth ten
      more requests.*

### P4 — History fields and the progression

`web/src/lib/boneycard.ts` + `boneycard.test.ts`, per F6 (`todo-frontend.md:39`).

- [x] Every field in *What the card shows*, as pure functions over the query results.
- [x] `boneLevel()` and the milestone list in the same module. Monotonicity of level asserted.
      *The ladder takes the **highest** satisfied rung rather than scanning to the first failure —
      with `OR` rungs those are different functions, and a wallet with 30 tiers whose credit rows
      truncated would fail rung 2 on delivered campaigns and be handed level 1. Taking the maximum
      makes monotonicity structural instead of a property to test for, and it is asserted over a
      grid anyway. Tiers are an alternative to delivered campaigns at every rung, not a second
      requirement: crossing a tier implies delivery, so this is what keeps the level right when
      `credits` truncated and `tierPayouts` did not.*
- [x] Fixtures: aggregate KPI, campaign ended early, partial payout (`paid < reward`), a wallet-less
      `Promoter` row, a promoter displaced by a fresher touch, multi-token earnings.
- [x] Build fixtures from the **real 9 campaigns** on registry `0x6427217e` where possible — Gyndore
      is the aggregate case and campaign 2 is a second Ended one. Real payloads catch decode
      assumptions that hand-written ones agree with.
      *`web/scripts/__check-history.ts` runs the real read path and the real fold against the
      deployed subgraph, which is what the ladder is calibrated on: the dev wallet holds 8 delivered
      campaigns and 31 tier payouts and reaches level 5. **Distinct projects is deliberately not a
      rung** — one project address is behind every live campaign, so a rung demanding two would pin
      every wallet on this deployment below it forever, and a level nobody can reach is a locked
      door rather than a progression. It stays a milestone, where it costs nothing.*

Two things the fold surfaced that the plan above did not anticipate:

- **`orphanPayouts`.** A payout in a campaign with no membership row should be impossible —
  settlement pays a promoter who joined, and `join()` records the wallet in the same transaction — so
  a non-zero count means the index is inconsistent. Counted in `tiers` because the payout did happen,
  left out of `earned` because there is no membership to read a token from, and stated on the card
  rather than swallowed, since a silent drop understates what someone earned.
- **"Promoting since" needs an RPC call.** `Promoter` indexes `joinedAtBlock` and no timestamp, so
  three of the seven milestones arrive as block numbers. Neither approximation is acceptable —
  `Campaign.createdAt` is a lower bound that dates a promoter to before they joined, the earliest
  credit is an upper bound that dates them to after — so `useBlockTimes` resolves them, and a block
  that fails to resolve leaves the milestone rendering its block number rather than a dash.


### P5 — The bone

`web/src/components/BoneyCard.tsx`, `web/src/components/ui/Bone.tsx`.

SVG, not ASCII — it has to survive a screenshot, an OG image and a phone.

```
   ╭───────────────╮
 ╭─┤  🦴🦴🦴  LVL 3 ├─╮      head  → level + BoneyScore, labelled "credibility & reach"
 │ │   BONEYSCORE   │ │
 ╰─┤      892      ├─╯      shaft → the counts: campaigns, projects, tiers, referrals
   │  27 campaigns  │
   │  19 projects   │        left  → promoting since, milestones
   │  25 tiers      │        right → actions verified, earned (per token)
 ╭─┤  8,410 acts   ├─╮
 │ │ ── VERIFIED ── │ │      foot  → specialization badges
 ╰─┤ swaps · mints ├─╯
   ╰───────────────╯
```

- [x] Reuse `ui/StatTile`, `ui/Meter`, `ui/RankBadge`. Brand yellow for labels and headings, per
      commit `6400cd8`.
      *Four tiles, not seven. `StatTile`'s row is a 4-up grid and a second row of it would give "1
      project" the same weight as "25 tiers crossed" — so campaigns, tiers, referrals and earned are
      tiles, actions ride as the referral tile's hint (a referral is a distinct user across those
      actions), and projects and the start date read as a sentence underneath.*
- [x] Milestone timeline as a dated list, with the next unearned one shown greyed.
      *Each milestone carries two strings, `label` and `todo`, because an unearned achievement written
      in the past tense reads as a failure — a new wallet would be looking at seven things it has not
      done. `firstPaid`'s instruction is worded "have a reward pay out" rather than "cross a tier to
      get paid": a tier settles for whatever the pool could release, so it can be unearned while
      `firstTier` is earned, and the promoter may already have done everything asked.*
- [x] Empty state built first, not last.
      *And it renders **no** counts. Seven zeros would all be true and all be the wrong thing to show;
      the empty card gets the milestone list with the first rung named as an instruction instead.*
- [x] Read the `dataviz` skill before writing the stat row and specialization badges.
      *Its form heuristic says there is no chart on this card, which settled the question rather than
      leaving it to taste: the four counts are four different units (campaigns, tiers, wallets, money)
      with no shared scale, so a grouped bar of them would be the dual-axis mistake in another shape.
      The specialization badges are the one place identity could have become colour — they are words
      in hairline pills instead, because there is no magnitude to encode and a categorical hue would
      be something to decode for no added information.*
- [x] Link from `/promoters`, the promoter dashboard, and campaign-detail promoter rows.
      *`/promoters` **is** the promoter dashboard (`PromoterDashboard`), and its header now links to
      the card — that page is per-campaign, the card is the cumulative view of the same memberships.
      Campaign-detail promoter rows are **deferred to P6**: those rows are other people's wallets, and
      the only honest destination for one is `/b/<wallet>`, which does not exist yet. A link from them
      to `/card` would show a visitor their own card and look like a bug.*

Two decisions the build forced that are worth recording:

- **The level may be unknown, and that is not the same as 1.** `BoneLevel` takes an optional level and
  renders "lvl —" when it is absent, because the level is a fold over indexed history: an unreachable
  subgraph means unknown, and rendering 1 would take a level-5 promoter's card down to a beginner's
  over an outage. Exactly the same rule as never rendering a failed fetch as "0 campaigns".
- **The history section moves.** With campaigns behind it, it sits directly under the score, because
  that is what the promoter opened the card for. Empty, it goes last — the qualification list
  immediately above already says "join a campaign" with actual campaign names in it, so leading with
  the weaker version of that message would only repeat it.

The 🦴 emoji is gone from the level notches. It renders as a different picture per platform, it is a
font dependency and so is absent from the headless renderer P6's OG image needs, and it cannot be
recoloured onto the brand. `ui/Bone.tsx` draws the same shape as a path.

**Verified by rendering, because nothing else here can.** There is no component-test tooling in this
repo and headless chromium will not launch, so `web/scripts/__check-card-render.ts` pulls the dev
wallet's real history off the deployed subgraph, runs the real fold, and renders `BoneyCardHistory` to
static markup as text. That is what caught the one real defect in this phase: the milestone list came
out in *ladder* order, printing "5th campaign joined · 18 Aug" below "First reward paid · 23 Aug",
because the join rungs are dated by a `Promoter` block and the reward rungs by a settlement timestamp.
`orderedMilestones` now sorts the earned half oldest-first and leaves the unearned half in ladder order
at the end, so `nextMilestone` is unaffected. Live output for the dev wallet: level 5, 9 campaigns,
31 tiers, 25 actions, 114.6K bUSD across 7 campaigns, 7 specialization badges, Gyndore correctly
marked not-creditable.


### P6 — Shareable card

The fun payoff, and the only growth loop here.

- [x] `web/src/app/b/[wallet]/page.tsx` — public, walletless, server-rendered: `boneyard.xyz/b/0x…`.
      Handle URLs (`/b/alice`) need an off-chain handle→wallet map: `ReputationRegistry` stores no
      social handles by design (`ReputationRegistry.sol:10`) and X handles are re-assignable, so the
      address is canonical and a handle is at most an alias. Decide before shipping links.
      *Decided against handles — see open question 1. The page is the only one in the app rendered
      entirely on the server, which is what makes it shareable: a crawler, a chat embed and a phone
      with no extension all run none of the app's client hooks. `revalidate = 300` and a `cache()`
      wrapper around the load, because Next calls `generateMetadata` and the body separately and the
      subgraph read is a POST that nothing in the fetch cache deduplicates — without it every view
      queried the indexer twice. A malformed path 404s; a valid address with no profile and no history
      does **not**, because that is the empty card the whole onboarding half was written for.*
- [x] `opengraph-image.tsx` — the bone as a share image. Same fail-soft rule as P0: no history, no
      numbers, never zeros.
      *Satori is not a browser: no cascade, no custom properties, no Tailwind, and it errors on a
      multi-child element that does not declare `display`. So every colour is the hex from
      `globals.css` copied deliberately, and `BONE LEVEL 5` is one template string rather than text
      plus an expression — as two children it surfaced as "failed to pipe response" and a 500 on the
      image. No webfont is loaded on purpose: the one asset whose job is to render for a crawler
      should not gain a network dependency to match a typeface nobody compares side by side.*
- [x] `lib/nav.ts` entry.
      *There isn't one, and that is the answer rather than an omission: the nav cannot name a wallet,
      so the public card has no generic destination to list. `/card` is the nav's entire surface for
      this feature (added in P2), and `/b/<wallet>` is reached by link — from `/card`'s "View your
      public card", and now from the promoter rows P5 deferred here. `isActiveNav` lights no tab on
      `/b/<wallet>`, which is correct: a visitor reading someone else's card is not on a personal tab,
      and lighting BoneyCard there would claim it was theirs.*
- [x] Link other people's wallets to it — the rows P5 deferred to this phase.
      *`ProjectPromotersPanel` (the project's own table) and `PromoterDirectory` (`/promoters` with no
      wallet connected) both rendered other people's addresses, one as an explorer link and one as
      plain text. Both now go to the card where there is one, which is what makes `/b/<wallet>` worth
      being walletless: a visitor browsing the directory can open any promoter's history without
      connecting anything. The panel keeps the explorer as its fallback and loses nothing by
      demoting it — the card carries an explorer link onward.*

Three things this phase forced:

- **`metadataBase` was missing, and that is a build failure rather than a blemish.** `generateMetadata`
  sets `openGraph.url` from `cardPath`, and Next's own docs are explicit that *"using a relative path in
  a URL-based metadata field without configuring a `metadataBase` will cause a build error"*. Dev papered
  over it: `og:url` stayed relative and `og:image` was resolved against an **inferred**
  `http://localhost:3000`, so every shared card would have carried a preview image URL that only this
  machine can fetch — the one failure mode the whole phase exists to avoid. `lib/site.ts` reads
  `NEXT_PUBLIC_SITE_URL`, assumes https for a bare host, and falls back to localhost rather than throwing,
  because it is evaluated as the root layout module loads and a typo there is a 500 on every route in the
  app to fix one `og:image` host.
- **A card is per-deployment, so a link to one has to check the chain.** `loadPublicCard` reads
  `DEFAULT_CHAIN_ID` and the path carries no chain — deliberately, per *Not in scope*. But
  `useBoneyChainId` returns anvil for a wallet connected locally, so an unguarded promoter row would have
  answered a question about an anvil campaign with Base Sepolia's history, which reads as a broken card
  rather than a link to the wrong deployment. `cardLink` returns undefined off that chain and each caller
  keeps what it already showed.
- **The watermark did not read as the mark.** Caught by looking at the PNG, which is the only way this
  file can be checked. Bled off the bottom-right corner at 620px, which put its shaft behind the opaque
  count tiles and left the two lobe pairs reading as a pair of unrelated blobs; moved into the one band
  nothing else occupies — right of the score, below the level notches, above the count row.

**Verified by rendering.** Live for the dev wallet: `/b/0x98405c…` 200 with the full history section,
`/b/alice` 404, and a 1200×630 PNG carrying level 5, 24,620 Legend, 9 campaigns, 31 tiers, 2 referrals,
25 actions. `0x…dEaD` renders the empty card at 200 — "No BoneyScore yet", "No campaigns yet", the
milestone ladder as seven instructions, and not a single zero.

### Not in scope

Leaderboard and sorted discovery · aggregate counter entities in the subgraph · delivery as an
on-chain schema or join gate · sybil mitigation · cross-chain merged cards (a card is per-deployment;
two registries and two bUSD tokens exist today) · on-chain / NFT bone.

---

## The stage-2 blocker — cleared

**Stage 1 was demoable; stage 2 was not, because there was not enough history.** Base Sepolia had
9 campaigns, mostly light activity, one project address behind all of them, and Gyndore at zero. The
history half of a card built then showed one or two campaigns, a handful of credits, one project —
level 1, no milestones past the first, no specialization badges.

This is why the ordering above matters: P0–P2 have a real first-run experience with the chain exactly
as it is, and nothing about stage 1 waited on this. But before P4 was worth building a UI around:

- [x] `script/SeedHistory.s.sol` — several projects × campaigns × promoters with **deliberately
      varied** outcomes: one over-delivering across protocol types, one that joined and never
      delivered, one campaign ended early, one pool exhausted, one aggregate KPI, one promoter with a
      long dated milestone trail. Existing seeds to build from: `SeedFive.s.sol`, `SeedDemo.s.sol`,
      `web/scripts/demo-seed.ts`, `script/promoter.sh`.
      *Five campaigns, two projects, three promoters, 45 transactions. **Append-only, unlike every
      other seed here** — `SeedFive` and `SeedDemo` assert `campaignCount() == 0` because they define
      a whole fixture, whereas this script's subject is what a *wallet* accumulates and the nine
      campaigns that already exist are part of that history. So it asserts every name is free instead,
      up front, and a second run refuses cleanly rather than reverting `NameTaken` partway through
      after funding.*

      *Two things had to be deliberate for the numbers to be a fixture at all. Every KPI has
      `verifier == address(0)`, so `reportUserAction` credits exactly what is reported and each
      promoter's totals are **chosen rather than discovered** — a fixture whose numbers depend on
      third-party contract activity is not a fixture. And every KPI has empty `params`, so `kpiSource`
      reads them as not event-sourced and the running relay ignores them; without that the loop would
      keep reporting its own view of these KPIs and overwrite the shapes below. Settlement needs no
      call, since `_settle` runs inline at the end of `reportUserAction`.*

      *The first broadcast died four transactions in, and the cause is worth writing down: the relay
      loop sends from `PRIVATE_KEY` too, so forge and the relayer picked the same nonce and the node
      rejected the second as an underpriced replacement. Stop the relay before broadcasting. Every
      transfer in `_fund` is guarded on the recipient's balance, which is what made the retry free.*

**What it produced, read back through the real path** (`web/scripts/__check-history.ts`, extended here
to cover the two new promoters):

- **The dev wallet's card moved on every axis the history half counts**: 9 → 12 campaigns, 31 → 43
  tiers, 25 → 32 actions, 114.6K → 126.7K bUSD, and **projects 1 → 2**, which was the point. All seven
  milestones now earned and correctly dated oldest-first.
- **The exhausted pool does not make the arithmetic disagree.** `sh dryrun` puts three 400 rungs
  against a 900 pool, so the third can only pay 100 and `remainingPool()` reads 0. Earnings rose by
  exactly 12,100 = 8,400 (alpha) + 900 (dryrun) + 2,800 (bravo) — the ladder asked for 1,200 there and
  the card counts three tiers crossed against 900 paid, which is the case P4 needed and could not
  previously construct.
- **The low end of the ladder was the untested half.** Every wallet on this deployment was either the
  dev wallet at level 5 or a one-campaign wallet, so levels 1–2 had no live instance. Promoter 3 is now
  level 1 — one campaign, ended under them, zero delivered — and promoter 2 is level 2, joined 2 and
  delivered on 1 for 600 bUSD, with `sh telemetry` rendering "No credited actions yet". The top rung is
  still uncalibrated against anything above it, because the dev wallet was already at 5 before this ran.
- **`endedEarly` is invisible to the probe, and that is the design rather than a gap.** It needs an
  on-chain `endTime` via `views`, which only the connected `/card` path supplies — `cardServer.ts:46`
  already records why the public card claims nothing there. `sh cutshort` is Ended with an `endTime` 30
  days out, so the precondition is confirmed on chain and the comparison itself is asserted at
  `boneycard.test.ts:683`.

That single script was the demo, the fixture set for P4, and the only way to find out whether the
progression actually feels good before the UI was built around it. On the answer: it does at the
bottom, where a wallet's first campaign and first paid tier are visible steps. But **levels 3 and 4
still have no live instance.** The five wallets that exist now land on 1, 2, 2 and 5 — the dev wallet
clears rung 5 by 11 delivered and 43 tiers against a 8/30 requirement, so it does not sit near a
boundary either. The middle of the ladder is asserted by `boneycard.test.ts`'s grid and by nothing
anyone has looked at. A wallet seeded to 3 delivered / 5 tiers is the fixture still missing, and it is
cheap to add now that the script is append-only.

---

## Unrelated, but do it anyway

Not part of this plan; it just prevents a repeat of what happened on 2026-08-25.

- [x] **Block aggregate KPIs carrying reward tiers in `validation.ts`.** Line 293 mirrors the Solidity
      rule exactly — tiers required *unless* aggregate — but there is no rule in the other direction,
      so an aggregate KPI *with* a paying ladder validates clean. That is how Gyndore escrowed
      350,000 bUSD against 27,000 of tiers nothing could ever settle. ~6 lines and a test.
      *Blocks rather than warns, because the escrow is real money locked behind rewards nothing can
      release. It is the second rule in the file with no Solidity counterpart — the contract accepts
      the combination — so the header note now says two. The message names **both** fixes ("remove the
      tiers, or untick aggregate") without choosing: which one is right depends on whether the project
      meant an analytics KPI or a paying one, and the form cannot know. No form change was needed —
      the tier editor stays visible when aggregate is ticked, so the error renders directly above the
      list it is about, with the checkbox that also resolves it a few lines up.*

Related and worth its own document: **a project-side card**. Promoters currently have no way to check
whether a project reports honestly, funds fully, or ends fair, and every input exists already
(`PoolExhausted`, early `end()`, campaigns with zero credits across all promoters). Arguably the
harder trust problem of the two.

---

## Open questions

1. ~~**Handle or address in the share URL**~~ **Address, and only the address.** Not on effort: an X
   handle is re-assignable, so `@alice` changing hands silently repoints every link ever shared at a
   different person's card, and there is no on-chain map to read one from anyway. A handle is still
   *displayed* when Ethos knows one — `subjectLabel` — and could later redirect to the address form,
   which is additive and needs no decision now. `parseCardWallet` is where the rule lives.
2. ~~**Does the card show campaigns joined but not delivered on?**~~ **Yes.** Joined is the tile value
   and delivered is its hint, and the per-campaign row says "No credited actions yet" — except where
   nothing was ever creditable, which says that instead. A card nobody can under-fill is a card nobody
   believes, and with no ranking at stake there is nothing to lose by showing it.
3. ~~**How many bone levels, and what earns each?**~~ **Five, calibrated against the live fixture**
   rather than in the abstract: `LEVEL_LADDER` in `boneycard.ts`, tuned so the dev wallet's real 8
   delivered campaigns and 31 tiers land on 5. Distinct projects is deliberately not a rung — see P4.

