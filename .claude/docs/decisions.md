# Decisions

Background rationale for choices the source no longer explains — measurements, rejected alternatives,
and failure modes. Source comments are **descriptions only**, so this is where the *why* lives.

Entries are keyed to **`file` : `symbol`**, never a line number. There is deliberately **no
back-pointer from the code**: the source stays clean and this file is a reference you come to, not a
link you follow.

**Coverage is partial.** It documents `Campaign.sol`, `EventMetricKpiVerifier.sol`, `globals.css` and
`useBoneyChain.ts`. Rationale stripped from the other files during the sweep is not here — it is in
`git log -p` on those paths, which is the durable record either way.

---

## `web/src/app/globals.css`

### Token system — why yellow is constrained

The brand is a bright yellow on a near-black surface. That choice constrains where yellow is allowed
to appear, and the constraint is **measured, not guessed**:

- As **ink and chrome**, brand yellow is excellent: `#ffc800` on `#0a0a09` is **12.75:1**, and the
  lightest ink step is **16.45:1**. Every text token clears WCAG AA — the worst is `--text-muted` at
  **5.82:1**.
- As a **categorical series** color it is illegal, and no amount of taste changes that. The dark
  lightness band is OKLCH **L 0.48–0.67**; every vivid yellow measured sits at **0.74–0.86**, so it
  fails the band outright. Series colors therefore keep the documented dark palette, whose yellow slot
  is the darker `#c98500` — re-validated against this surface, all six checks **PASS** (worst adjacent
  CVD ΔE **8.4**, normal-vision **19.3**, all ≥3:1).

Meters spend no categorical slot: they use the single-hue amber `--seq-*` ramp, validated as
`--ordinal` — monotone lightness, adjacent ΔL ≥ **0.06**, light end **2.04:1** on surface. Magnitude
therefore reads in the brand color without consuming an identity hue.

### `--series-1` … `--series-8` — slot order is the CVD mechanism

The **order** of the slots, not just the set, is what keeps them distinguishable under color-vision
deficiency. Leading with brand yellow was tried and collapsed magenta↔aqua to ΔE **1.6** under
deuteranopia. The documented order stays: never reordered, never cycled, never assigned by rank.

### `--status-warning` — why orange, not yellow

Moved off yellow deliberately. A yellow "Pending" pill on a yellow-branded page reads as *chrome*,
not as *state*, and status must never be ambiguous. Status colors are also never reused as a series
color, and always pair with a label.

### `.font-display` — weight is pinned, not chosen

Bagel Fat One ships exactly one weight (400), so the weight is pinned here with `!important` rather
than left to call sites. A Tailwind `font-extrabold` on a 400-only family does not pick a heavier cut
— there isn't one — it asks the browser to **synthesise a fake bold**, which smears the terminals of
an already very fat face. Tracking is tightened because bubble letters carry a lot of built-in
sidebearing.

### `.tnum` — why large figures stay proportional

Columns of numbers must align vertically, so table cells and axis ticks get tabular figures. Large
standalone values (stat tiles, hero figures) deliberately keep **proportional** figures — tabular
makes a number like `121` look loose at display sizes.

### `:focus-visible` — brand, never a series color

Never removed, only restyled. Brand yellow rather than a series color because focus is **chrome**, and
chrome must not borrow an identity hue.

### `.animate-blink` — four choices, each load-bearing

- **Opacity**, not `visibility` or a color swap, so the glyphs never reflow and the text stays
  selectable and legible to a screen reader throughout. A blink toggling `display` would remove the
  word from the accessibility tree twice a second.
- **Bottoms out at 0.25, not 0**, so the label is always faintly present. A chip that vanishes
  completely reads as a rendering fault; one that pulses reads as deliberate.
- **`steps(1, end)`** gives the hard on/off of a terminal cursor rather than a smooth fade, which is
  what "blinking" means for a status chip.
- The **reduced-motion** block pins this to a single iteration, so a user who asked for less motion
  gets a static chip at full opacity — not a chip stuck invisible.

---

## `src/campaign/Campaign.sol`

### `Campaign` — immutable once deployed (D8)

Parameters, KPIs and tiers cannot change, so a project cannot move the goalposts after promoters have
done the work. `minReputation` is immutable too, which means changing a gate is a redeploy and a
reseed, not an edit.

### `reportUserAction` — cumulative, not incremental

Reported amounts are **cumulative per user**. The contract credits only
`newTotal - alreadyCredited`, so a replayed report is a no-op rather than an inflation vector. This is
the central anti-fake-conversion property of the reporting path — an increment-based API would make
every retry a double-credit.

### `MAX_KPIS` / `MAX_TIERS_PER_KPI` — why bounded at all

Without a bound, a campaign could be created with a ladder large enough that settlement exceeds the
block gas limit — bricking payouts for promoters who already did the work. Validated once at
construction rather than per report, since the shape is immutable.

### `name` — validated here, uniqueness is the registry's

Length and charset are checked here; uniqueness is not, because it requires an index across all
campaigns and only `CampaignRegistry` has one. A campaign constructed directly therefore carries a
well-formed name that may duplicate another's.

### `constructor` — rejecting an unreachable reputation gate

`minReputation` is immutable and `join()` is the only thing that reads it, so a value above the
registry's ceiling produces a campaign that deploys cleanly, accepts escrow, reports Active, and
**silently admits nobody for its whole life** — with no way to correct it short of redeploying and
re-funding. Hence the up-front `maxScore()` check.

The `maxScore()` call is wrapped in `try/catch` (a registry that doesn't implement it shouldn't block
deployment) but the `revert UnreachableReputation` sits **outside** the `try`, so a genuine revert
cannot be swallowed by the `catch`.

### Lifecycle guards — `activate`, `end`, `cancel`, `join`

- **`activate`** requires the full reward pool escrowed. Promoters should never start working against
  a partially funded campaign.
- **`end`** is permissionless once `endTime` has passed, so a project cannot leave a finished campaign
  in limbo to stall the claim grace window.
- **`cancel`** is reachable only from `Pending`. Once active, promoters may have earned rewards, so
  cancellation would be a rug. This is also why the registry is effectively append-only.
- **`join`** is allowed while `Pending`, so promoters can prepare tracking links before launch.

### KPI verifiers — adapters may discount, never inflate

A `Custom` KPI has no protocol-defined meaning, so it is only trustworthy with an adapter that can
substantiate reports — hence `CustomKpiNeedsVerifier`. The verifier receives the cumulative total and
returns what may be credited; `VerifierOvercredit` enforces that the return can only be **lower**. An
adapter can therefore discount a report but never inflate one, which is what makes a third-party
verifier safe to point at.

### `_settle` — pool exhaustion never reverts

`settle` is permissionless: anyone may push a promoter's earned rewards through, including during the
post-end grace window.

The ladder is walked per `(promoter, kpi)` pair, so the loop is bounded by the tier count, not the
promoter count. A tier the pool cannot cover pays what remains, emits `PoolExhausted`, and is **still
marked settled** — the ladder has to keep advancing. It never reverts, because reverting would let one
exhausted tier block all further reporting for everyone.

### `_resolvePromoterId` — the post-end relaxation

While the campaign is live this is strictly `activePromoter`: an expired touch credits nobody, with the
deliberate consequence that a lapse hands everything to whoever the user signs for next.

After `end()` that rule would defeat the reporting grace window it sits next to. Touch TTLs are days
and campaigns run for weeks, so by the time a withheld report can finally be filed most touches have
lapsed, and every one of those reports would revert `NoAttribution` — handing the project back exactly
the escrow the grace window exists to protect. So once the campaign is Ended, and only then, the stored
touch is honoured even if expired.

That relaxation cannot be used to steal credit, but only because `storeTouch` bounds touch creation to
the campaign's life. **Four things hold together:**

1. the registry rejects a touch once this campaign is past `endTime` or terminal, so a post-end
   signature cannot displace the promoter who did the work;
2. it overwrites only on a strictly newer `signedAt`, so the stored touch is the user's latest
   in-campaign intent;
3. it rejects an already-expired `expiresAt`, so nobody can backfill a stale touch after the fact;
4. reporting is bounded to `CLAIM_GRACE`, after which it closes entirely.

Drop the first and the rest do not save it — a promoter who did nothing could collect a withheld report
by having the user re-sign during the grace window.

### Reporting windows — why they can never overlap escrow return

`_requireReportableStatus` mirrors `settle`'s guard, so crediting and paying open and close together.
It is the exact complement of `reclaimUnspent`, which requires `block.timestamp > endedAt +
CLAIM_GRACE` — so reporting closes on exactly the second reclaim opens and escrow is never reclaimable
while credit is still owed.

**Paused is intentionally excluded** from reportable statuses. Pausing halts reporting, and it cannot
be used to strand anyone because `end()` is permissionless once `endTime` passes, which converts a
parked campaign into an Ended one and starts the grace clock.

`_requireReportWindow` skips the window check once Ended: the grace window has already bounded the
report, and `endedAt` is necessarily past `startTime`, so re-checking `endTime` would reject **every**
post-end report.

---

## `src/verifiers/EventMetricKpiVerifier.sol`

### Trust model — trusted reporter, not a trustless oracle

Whoever holds the `reporter` key is trusted to report honestly. This is **not** a trustless oracle and
is not pretending to be one. The only property the contract guarantees is the one that matters for
escrow safety: **a claim can never be credited above what was independently reported.**

A reporter can under-report, denying promoters credit — but the same is true of a reporter that simply
stops running, so overwriting a total *downward* is allowed rather than blocked. It is needed for reorg
corrections and grants no new power.

Swapping this for Chainlink Functions is the intended upgrade path.

### `eventSignature` — why the full ABI string is stored

Projects hosting campaigns emit wildly different event shapes: differing param counts, mixed
indexed/non-indexed, different uint widths. A manual byte offset breaks **silently** the moment the
layout differs. Storing the full human-readable signature lets the relayer build a real ABI decoder
instead of guessing.

### `scale` — applied in `verify`, so stored totals stay raw

Token-valued KPIs need scaling: a project reporting display units against a metric observed in raw wei
would be capped ~1e18 too high, making the cap vacuous.

The division happens in `verify`, **not** in the relayer, so `verifiedTotals` holds the raw unscaled
metric. That is what keeps the relayer stateless — it accumulates by reading the stored total and adding
a delta, so if the stored value were pre-scaled every run would re-divide an already-divided number and
sub-scale activity would floor away to nothing instead of accumulating. Keeping the raw total on chain
means the only state the relayer needs is the state the chain already holds.

### `epoch` — invalidating totals a config change would misdenominate

The checkpoint and the stored totals are both statements about a *specific* watched event, so carrying
them across a change of contract, signature, param index, aggregation, scale or window start would leave
the cap denominated in something nobody measured.

Concretely: a KPI configured against the wrong contract, relayed up to block `N`, then corrected, would
resume at `N+1` — so nothing in `[windowStartBlock, N]` is ever rescanned for the right event, while the
totals folded from the *wrong* event stay live as the ceiling a claim is trimmed to.

So `setKpiConfig` bumps `epoch`, which is part of every total's storage key, and resets the checkpoint.
Every figure observed under the old config becomes unreachable in the same transaction, and the relayer
rescans the window from the start.

**Clearing `verifiedTotals` entry by entry is not an option** — it is a mapping with no enumerable key
set, so a user who only ever appeared under the wrong config would never be overwritten at all.

`_watchesDifferentEvent` compares every field except `windowEndBlock`, because each one changes what an
already-stored total *means*: a different contract or signature is a different event, a different
`userParamIndex` credits a different wallet, a different aggregation is a different quantity rather than
a different magnitude, a different `scale` re-denominates every stored total retroactively, and raising
`windowStartBlock` leaves totals folded from blocks now out of scope. `valueParamIndex` is compared even
under `COUNT`, where it is unused: a needless rescan costs RPC, a missed one costs a wrong cap.

`windowEndBlock` is excluded because it is often provisional at campaign-creation time — a campaign's
real reporting close depends on when `Campaign.end()` is called, which is permissionless and therefore
not known in advance. Extending it must not disturb the checkpoint or any stored total.

### `lastScannedBlock` / `reportBatch` — the checkpoint is what makes the relayer stateless

Any relayer instance, on any machine, with no local state, can ask the chain where it left off. A relayer
that kept this locally would rescan everything after a crash or a host move.

`reportBatch`'s atomicity is the point: totals and checkpoint move together, so a crash can never leave a
checkpoint claiming a range whose totals were not stored. Only users whose total changed in the newly
scanned range need including — an untouched user's stored total is already correct.

For a run split across several transactions, only the **last** should carry the new checkpoint. A partial
failure then leaves the checkpoint untouched and the whole run is safely retryable, at the cost of
re-reporting totals that are idempotent anyway.

### `_requireAdvanceable` — the window bound is enforced on chain

Reports beyond the campaign's reporting close are moot, since `Campaign` has stopped accepting them.
Enforcing the bound here rather than only in the relayer means even a buggy or compromised reporter cannot
push past it, and it costs one stored-word comparison.

### `verify` — fails closed on an unconfigured KPI

Reverts rather than returning 0, so a KPI wired to this verifier before `setKpiConfig` runs is loudly
broken instead of silently crediting nothing.

### `_effectiveScale` — 0 reads as 1

0 is what an unconfigured field reads as, and "no scaling" is a better answer than a division-by-zero at
report time. Matches `effectiveScale` in `web/src/lib/kpiSource.ts`, which makes the same choice for the
same reason.

---

## `web/src/hooks/useBoneyChain.ts`

### `useBoneyChainId` — why a bare `usePublicClient()` is unusable

wagmi's `createConfig` seeds its store with `chains[0].id`, and `getClient` resolves
`config.chainId ?? store.getState().chainId`. `chains[0]` here is **anvil**, so a visitor with no
wallet silently gets a local node they cannot reach. That made the marketplace blank until you
connected a wallet, which is the funnel backwards for a public listing.

It is **not only a disconnected-visitor problem.** wagmi rehydrates its persisted state inside a
`useEffect` and this app passes no `initialState`, so *every* page load — connected or not — renders
at least once with the store still on `chains[0]`. Pinning the client to this value means that first
render reads the right chain rather than briefly reading anvil and throwing the result away.

Two shape choices follow from that:

- It keys on **`isConnected`** rather than a raw chain id, because a connected wallet on an
  unsupported network should keep reporting *that* network: `isDeployed` then correctly returns false
  and the page says so, which is more honest than quietly showing it Base Sepolia's campaigns.
- It returns a **plain id, not a client**, so callers stay in charge of `usePublicClient` vs
  `useWalletClient`. Writes must go to the wallet's real chain, never to a default.
