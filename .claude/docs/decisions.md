# Decisions

Background rationale for choices the source no longer explains — measurements, rejected alternatives,
and failure modes. Source comments are **descriptions only**, so this is where the *why* lives.

Entries are keyed to **`file` : `symbol`**, never a line number. There is deliberately **no
back-pointer from the code**: the source stays clean and this file is a reference you come to, not a
link you follow.

**Coverage is partial.** It documents `Campaign.sol`, `AttributionRegistry.sol`,
`EventMetricKpiVerifier.sol`, `web/scripts/indexer.ts`, `web/scripts/relay-loop.sh`,
`subgraph/subgraph.yaml`, `globals.css`, `ui/Bone.tsx`, `useBoneyChain.ts`, `lib/attributions.ts` and
`campaignGuide`'s write path. Rationale stripped from the other files during the sweep is not here
— it is in `git log -p` on those paths, which is the durable record either way.

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

## `web/src/components/ui/Bone.tsx`

### `BoneField` — the page wallpaper, and why it is this quiet

The card's watermark bone, tiled behind every route. It is decoration with no informational load, so
every choice in it is about staying subordinate.

**Weight.** Brand yellow at **6%** over `--plane` (`#0a0a09`) composites to about `rgb(25,21,8)`. The
same yellow at **14%** is `--border`, and `--gridline` is `rgb(42,39,33)` — so a field bone lands at
well under half a hairline, readable in the gutters and between cards but never competing with
`--text-primary` (`#ffe9a3`). The second layer is painted at `opacity="0.6"`, an effective **3.6%**.
The `visual-redesign` skill's atmosphere gate allows 0.05 for grain and 0.3 for gradients; a full-page
line texture belongs at the grain end of that range, not the gradient end.

**An inline SVG, not a CSS `background-image`.** A data-URI background cannot read a custom property,
so the same wallpaper in CSS would have meant writing `#ffc800` into the stylesheet — a token
regression. Serving it as markup lets the stroke be `var(--brand)`, which is the only reason the field
is a component at all.

**Two tiles, not one.** A single tile reads as a grid the moment two rows are on screen. The primary
tile is 360px with three bones; the second is 260px with two more, offset by
`patternTransform="translate(90 40)"`. Their combined period is `lcm(360, 260)` = **4680px** in each
axis, taller and wider than any viewport, so the repeat has nowhere to become visible.

**`strokeWidth = FIELD_HAIRLINE / scale` per `<use>`.** The bones are scaled 0.17–0.34, and a shared
`stroke-width` would render between 0.27px and 0.55px — sub-pixel, and unevenly so, which makes the
small bones fade out and the field look patchy rather than sparse. Dividing pins every bone to 1.6 CSS
px. `vector-effect="non-scaling-stroke"` would do the same; the arithmetic is kept because it puts the
weight next to the scale it corrects.

**`fixed inset-0`.** The field holds still while content scrolls, which is the opposite of
scroll-linked parallax — that is out of bounds in the product. `-z-10` paints it above the body canvas
and below every in-flow element; the root `AppShell` div sets no background and opens no stacking
context, and `main`/`footer` are transparent, so the field shows through wherever no opaque surface
covers it.

**Absent where it would cost something.** `contrast-more:hidden` because a user who asked for more
contrast has not asked for a texture that lowers it, and `print:hidden` because 6% yellow prints as
grey noise. `aria-hidden` and `pointer-events-none` throughout — it carries nothing and must never
take a click.

Mounted once, as the first child of `AppShell`. Every route renders through that shell, the
server-rendered `/b/[wallet]` included, so one mount is what "every page" means here.

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

**Cumulative per user, but no longer credited to a single promoter.** Until 2026-08-29 the payee was
resolved once, at report time, by `_resolvePromoterId(user)`. Since the watermark
`_userCredited[user][kpiIndex]` is keyed by user alone and spans every promoter that user ever had, any
delta that had not been reported yet was paid to whoever happened to hold the touch when the report
landed. Two clean instances on Base Sepolia (campaign `0x938E0c2E…`, reconstructed from
`TouchStored` + `KpiAction` + `ProgressCredited`):

- **Aug 27, 15:55:02** — `0x0b5bFad0…` performed 8 bridge deposits between 15:48 and 15:51, entirely
  under `0xba954E89`. `0x450E4775` signed a touch at 15:53:44, *after every one of them*, and the
  15:55:02 report credited all 8 to them.
- **Aug 28, 12:24:32** — `0x5a597273…` did 6 actions from 12:03–12:08 under `0x98405c`. The 12:09:14
  report credited only 3, the relayer's ceiling not having caught up. The remaining 3 were credited at
  12:24:32 to `0x61768b71`, who by then held the touch and had driven nothing.

The fix is per-action segmentation. `evidence` is now decoded as `Types.Action[]` for **every** KPI,
verifier or not; `_creditSegments` asks `AttributionRegistry.promotersAt` who held the user at each
action's own block, tallies per promoter, and credits each one
`tally - _creditedTo[user][kpi][promoterId]`. The invariant is
`sum over promoters of _creditedTo == _userCredited[user][kpi]`, so the reporter still cannot exceed the
per-user ceiling and — since it never names a payee — cannot redirect credit either. Several
`ProgressCredited` events per transaction is now normal.

`_userCredited` advances by what was **actually** credited rather than to `verifiedTotal`. Actions
skipped for want of a budget stay retryable, which is what lets a ceiling-limited report be completed
later by a second one that still pays the promoter who drove the work — the Aug 28 case.

`MAX_EVIDENCE_ACTIONS` is 256 and non-ascending block numbers revert `UnorderedEvidence`, so the walk
is bounded and deterministic. Off chain, `indexerCore.foldToLimit` merges same-block actions first
(lossless) and only then folds runs onto their newest member, so a busy referral's evidence fits
without dropping amount the report still claims.

**Empty evidence resolves the live touch, but only when that is unambiguous.** With nothing to
segment, the chain has no better information than the live touch, so `_resolvePromoterId` still decides
and `NoAttribution` still reverts. That path is the dev reporting tool's
(`web/src/lib/reporting.ts` sends `"0x"`), not the indexer's — see the entry below for why it is now
also refusable.

### Empty evidence after a switch — `AmbiguousAttribution`

Segmentation closed the hole for every caller that sends per-action timing, and both real senders do
(`useReportUserAction` encodes `call.actions`, `scripts/indexer.ts` always encodes evidence). It left
one residual: an evidence-free report still handed the whole outstanding delta to whoever held the
touch at report time. Reachable from `planKolReport`'s simulate path and from any hand-rolled report.

Rather than guess, `reportUserAction` now refuses that case. `Campaign` records
`_lastReportBlock[user][kpiIndex]` after every report that credited anything, and asks
`AttributionRegistry.soleAttributionSince(campaign, user, sinceBlock)` whether one promoter held the
user for the whole span since. If the answer is not the promoter `_resolvePromoterId` would pay,
`AmbiguousAttribution(user, kpiIndex)` reverts and nothing moves — the work stays outstanding until a
report arrives that can place it. One promoter throughout, including a re-touch by the same promoter,
still credits exactly as before.

`soleAttributionSince` **walks** the history rather than comparing endpoints: an A→B→A sequence has
matching endpoints while B held the middle. It carries no expiry or gap logic, deliberately — an
`activePromoter` that has lapsed is exactly the case `_resolvePromoterId`'s post-end relaxation exists
to serve, and folding expiry in here would break it.

The guard needs a redeploy to take effect; the campaigns live on Base Sepolia have segmentation but not
this check, so there the evidence-carrying paths are the whole protection.

### `Types.Action` — why the block number, not just the timestamp

Evidence used to carry `{timestamp, amount}`. Attribution boundaries cannot be resolved from a
timestamp: `signedAt` is the **user's** clock, and on Base Sepolia it landed 12–34s behind the block
that carried the touch, so a new promoter's window already reached back before their touch was on
chain. The block number is the only boundary both sides can agree on, and the rule
`storedAtBlock < atBlock` settles the same-block case — a touch landing in an action's own block does
not capture it, so ties go to the older promoter.

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

**`TouchWindowVerifier` must not be wired as a `Mode.CAP` project verifier.** It was written to narrow
the promoter-switch leak by returning a window-scoped total, and it is deployed but pointed at nothing
(`guardOf(sygma, 0).projectVerifier == address(0)`). Wiring it would not have fixed the leak and now
actively breaks the fix: it can only deny the new promoter, never pay the old one, and the
window-scoped figure it returns would shrink the budget `_creditSegments` walks to the *current*
promoter's slice — starving every older segment. Worse, `Campaign` compares a verifier's return against
the lifetime `already`, so after a switch it would credit nobody, permanently. Segmentation lives in
`Campaign`; the adapter is kept only for off-chain window reads.

### `_settle` — pool exhaustion never reverts

`settle` is permissionless: anyone may push a promoter's earned rewards through, including during the
post-end grace window.

The ladder is walked per `(promoter, kpi)` pair, so the loop is bounded by the tier count, not the
promoter count. A tier the pool cannot cover pays what remains, emits `PoolExhausted`, and is **still
marked settled** — the ladder has to keep advancing. It never reverts, because reverting would let one
exhausted tier block all further reporting for everyone.

### `_resolvePromoterId` — the post-end relaxation

**Reached only on the empty-evidence path** since segmentation landed. A report carrying
`Types.Action[]` resolves each action against `promotersAt` instead, and never calls this. Everything
below therefore describes the fallback: the dev reporting tool, and any caller with no per-action timing
to offer.

While the campaign is live this is strictly `activePromoter`: an expired touch credits nobody, with the
deliberate consequence that a lapse hands everything to whoever the user signs for next — unless the
lapse straddles a switch, in which case `AmbiguousAttribution` refuses the report outright.

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
It is the exact complement of `reclaimUnspent`, which requires `block.timestamp > endedAt + CLAIM_GRACE` — so reporting closes on exactly the second reclaim opens and escrow is never reclaimable
while credit is still owed.

**Paused is intentionally excluded** from reportable statuses. Pausing halts reporting, and it cannot
be used to strand anyone because `end()` is permissionless once `endTime` passes, which converts a
parked campaign into an Ended one and starts the grace clock.

`_requireReportWindow` skips the window check once Ended: the grace window has already bounded the
report, and `endedAt` is necessarily past `startTime`, so re-checking `endTime` would reject **every**
post-end report.

---

## `src/attribution/AttributionRegistry.sol`

### `TouchAlreadyActive` — a live promoter's window is not refreshable

`storeTouch`'s only ordering rule used to be `TouchNotNewer`, so a user re-signing for the promoter who
already held them succeeded: it overwrote `_touches` with a later `signedAt`, pushed a redundant
`_history` record, and — the part that matters — extended `expiresAt` by a full window. A promoter could
therefore hold a user indefinitely by getting them to re-click the same boneylink, and the campaign's
`attributionWindow` would never actually elapse for that pair. Attribution stops being a window and
becomes a subscription the promoter renews.

So after `TouchNotNewer`, `storeTouch` reverts `TouchAlreadyActive(promoterId, expiresAt)` when the
stored touch is still live *and* names the same promoter. Two things it deliberately does not do:

- **Block a switch.** The check is per-promoter, not a lockout. A user with a live touch can still move
  to a different promoter at any time — that is the LAST_TOUCH model and the whole point of it.
- **Block a re-touch after expiry.** Once the window has lapsed the same promoter can be re-attributed
  normally, appending a second history record. `_promoterAt` reads the gap between the two as crediting
  nobody, which is correct: nobody held the user then.

The cost is a visible revert on a path that used to be a silent no-op-shaped success: a referral who
re-opens a boneylink they already signed now gets an error rather than a refreshed window. That is the
honest report of what the chain will do, and `web/src/lib/attribution.ts::canStoreTouch` mirrors the
guard in the same position so the app can say so before asking for a signature.

---

### `_history` — why the registry remembers superseded touches

`_touches` keeps exactly one live record per `(user, campaign)`, which is all `activePromoter` and
`touchOf` need and is why they are cheap. But it means the chain could not answer the question
segmented crediting depends on: *who held this user at block N?* Once a user re-signs, the promoter who
actually drove their earlier actions is gone from storage.

So `storeTouch` appends a `TouchRecord {promoterId, signedAt, expiresAt, storedAtBlock}` — two slots —
to `_history[user][campaign]`, and `_touches` is left exactly as it was. Every touch now costs one extra
storage push; the relayer pays it, and it buys the only record from which retroactive credit can be
reconstructed.

`_promoterAt` walks newest-first and takes the first record with `storedAtBlock < atBlock`, returning
its `promoterId` only while `atTimestamp < expiresAt`. Two rules in that, both load-bearing:

- **Strictly earlier block.** A touch stored in an action's own block does not capture the action, so a
  same-block switch cannot take work from the promoter who was already holding it.
- **No fallback past a lapsed record.** If the newest record before that block has expired, the answer
  is `bytes32(0)` — resolution does not keep walking to an older record that is still live. Falling back
  would pay a promoter the user had already replaced. The consequence is that work done in a gap
  (touch expired, no successor yet) credits **nobody** rather than falling to whoever appears next,
  which is consistent with `activePromoter` returning zero in the same state.

`promotersAt` is the batched form, so one report costs one external call rather than one per action;
mismatched array lengths revert `LengthMismatch`. `soleAttributionSince` reads the same array for a
different question — *did only one promoter hold this user across a span?* — which is what lets
`Campaign` refuse an evidence-free report it cannot place. `touchHistoryLength` / `touchHistoryAt` exist
so the off-chain mirror can be checked against the chain rather than trusted.

`web/src/lib/attributionWindows.ts` reimplements this walk, and both the relayer's ceiling and the
indexer's claim go through it. That is deliberate duplication of a rule rather than an abstraction:
if the two disagree, `min(claim, observed)` silently credits less than either intended.

---

## `web/scripts/indexer.ts`

### No cursor — why `.indexer-state.json` was removed

The indexer used to persist a per-`(chainId, campaign, kpiIndex)` cursor and resume from it. That is
incompatible with cumulative reporting, and had been quietly limiting credit for as long as both
existed.

`newTotal` is a lifetime figure and `Campaign` compares it against the lifetime watermark
`_userCredited[user][kpiIndex]`. A run resuming from a cursor only sees the logs after it, so it
computes a *window-scoped* total — necessarily lower than what is already credited — and `decideReport`
correctly declines to send it. Where a report did go out, `Campaign`'s
`if (verifiedTotal <= already) return;` made it a silent success that credited nothing. This is why the
Aug 28 deferred credit only appeared after a full rescan.

So there is no cursor. Re-scanning is the cheap half of the trade — re-reporting an unchanged total is
an early return on chain rather than a double-credit.

### The scan range is bounded by attribution, not by the deployment block

A cursor is unsafe; a *wider than necessary* range is merely slow, and on a long-lived L2 a full rescan
from the protocol's deployment block per campaign per KPI is very slow. The bound that is safe is the one
that only leaves out blocks which could never have been credited.

Two follow from the segmentation rules, and the indexer uses both:

- **Activity scan.** A window covers actions *strictly after* the block its touch landed in, so nothing
  at or before a campaign's first `TouchStored` is creditable to anybody. The activity scan therefore
  starts at `earliestAttributedBlock(windows)` — one block after the campaign's earliest touch. A campaign
  with no touch at all is skipped outright: there is nobody to credit.
- **Touch scan.** A touch stored at `T` expires no later than `T + effectiveMaxDuration(campaign)`, and
  activity before `startTime` credits nobody, so a touch older than `startTime - effectiveMaxDuration`
  covers nothing this campaign will ever pay for. That timestamp becomes a block through
  `blockSearch.blockAtTimestamp`, bounded below by the deployment block.

Both are *lower* bounds on a scan, never a substitute for the per-action resolution — inside the range
every action is still resolved against its own referral's windows, which is what actually decides credit.
The per-referral floor the range cannot express (a referral touched late in a long campaign) lives there
too, so narrowing the scan changes cost, not any total. `--from-block` overrides the activity floor as
given, including on a campaign with no touches.

`blockAtTimestamp` takes a shared probe cache because every campaign searches the same
`[deploymentBlock, head]` interval and so probes the same midpoints; the second campaign onward is nearly
free. `compute-report-window.ts` used to hold its own copy of the search and now imports this one.

Two related changes came with the cursor removal. Evidence is now sent for **every** KPI, including
`verifier == address(0)`, because `Campaign` decodes it itself to segment the report — previously it was
only attached when a verifier would read it. And the `activePromoter` read before each report is gone:
gating on the live touch is exactly what would drop the retroactive credit segmentation exists to pay.

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

---

## `web/src/lib/attributions.ts`

### The directory shows *current* attributions, not a touch history

`AttributionRegistry` keeps one touch per `(campaign, user)` and accepts a new one only when
`signedAt` is strictly greater, so "who is attributed to this promoter" has exactly one answer per
wallet. `currentAttributions` reproduces that reduction rather than listing every `TouchStored` log,
because a referral who re-signed under a second promoter would otherwise appear under both — and only
one of them is what the chain will credit.

This is the *opposite* choice from `lib/attributionWindows.ts`, which deliberately keeps the
superseded records: crediting follows whoever held the referral at each action's own block, so the
indexer needs the history. The directory answers a different question — who is attributed *now* — and
the two must not be conflated.

Ties on `signedAt` fall to the later block. The registry cannot store two touches at the same second
for the same pair (`storeTouch` requires strictly greater), so a tie only arises from an overlapping
log window or a re-org replay, where the later block is the one that stuck.

### Two sources, and only one of them has no floor

Same split as the promoter directory, for the same reason. The subgraph's `Touch` entity is indexed
from the campaign's first block and is tried first; the `TouchStored` log scan covers
`MAX_WINDOWS * MAX_LOG_RANGE` ≈ 45,600 blocks clamped to the newest span, which on Base Sepolia is
about a day. An attribution signed before that is absent from the log path while `touchOf` still
finds it, so the hook reports `scannedFrom` and both surfaces say the list is partial. A subgraph
result that is not `ok` falls through to the scan rather than rendering as "nobody is attributed".

Grouping is keyed `campaign:promoterId`, not `promoterId` alone: a promoter id is minted per campaign
by `Campaign.join`, so the same wallet holds a different id on each campaign it promotes.

---

## `web/src/hooks/useCampaignTouches.ts`

### The report panel reads two sources at once, because neither answers the whole question

`ReportPanel` disabled every promoter in its KOL dropdown once a campaign was about a day old. The
touch scan was log-only, so `planWindows`' ~45,600-block floor passed the campaign's touches,
`buildKolTargets` saw no referrals, and each option rendered `no attribution touch: revert with
NoAttribution` — for touches `touchOf` still returns and `reportUserAction` would still accept.
Measured on 2026-09-02: 29 of the 30 touches on the Base Sepolia fixture were live with 27–29 days
left and below the floor, and three of the four campaigns showed none at all.

The list of live attributions now comes from the subgraph, the same `Touch` entity and the same
fall-through rule as `useCampaignAttributions`. The log scan still runs, because the two sources
answer different questions and only one of them can answer each:

- `touches` needs the touch the registry currently holds per referral. `Touch` is keyed
  `<campaign>-<user>` and overwritten by a newer `signedAt`, so a subgraph row *is* that answer, with
  no block floor.
- `windows` needs the superseded touches as well, since credit follows whoever held the referral at
  each action's own block. The subgraph overwrote those; only the logs still carry them.

`mergeAttributionWindows` therefore folds the subgraph's live touch under whatever history the scan
reached, deduplicated on `(fromBlock, promoterId)`. A referral whose touch predates the floor gains
one window instead of none, which is what `useObservedActions` needs — it drops a referral with no
window entirely.

**Why not just widen the budget.** `MAX_WINDOWS` buys hours per extra request against a rate-limited
public endpoint and never stops being a floor; the campaign only has to get older. An append-only
touch-event entity in the subgraph would retire the log scan altogether and is still the eventual
fix — this is the version that needs no redeploy.

**What is still floor-bound.** `useObservedActions`' own event scan, so an *action* older than the
floor remains uncounted and the panel says so separately. `scannedFrom` no longer means "touches are
missing" on the graph path, so `ReportPanel` renders that admission only when the touch list itself
came from logs.

---

## `web/src/lib/campaignGuide.ts`

### Publishing is the primary action after creation, because nothing carries the draft

The guide lives off chain (`Types.CampaignConfig` has no slot for prose), so `createCampaign`
confirming does **not** store the summary or the project link the form collected. Publishing is a
separate signature against `/api/campaign-guide`, and until 2026-08-29 the confirmation screen offered
it as a secondary button beside a brand-styled "View Campaign" — pressing the obvious one navigated
away and discarded the typed link silently. Nothing in the app then said the campaign had no guide, so
the symptom read as "the link I added does not show".

The buttons now swap emphasis on whether the draft is published, and the collapsed editor on the
campaign page is a bordered control rather than a 12px text link.

**The other half of that symptom is not a bug.** The editor is offered only to
`role === "project"`, and the route verifies the signature against `Campaign.project()`. The
`SeedTwo` fixture sets `project = vm.addr(PRIVATE_KEY)` — `0xba954E89…` on the 2026-08-29 Base
Sepolia deploy — while the app is normally driven from the dev wallet `0x98405c…`, which is the
*promoter*. A guide for a seeded campaign can only be published from the deployer wallet.

---

## `subgraph/subgraph.yaml`

### `TransferToActorCount` — the ERC-721 shape it is named for does not decode

graph-node matches an event handler on topic0 **and** on the indexed-argument count the declared ABI
implies. This template declares ERC-20's `Transfer(address indexed, address indexed, uint256)`: three
topics, one data word. An ERC-721 `Transfer` indexes the token id as well, so its log carries four
topics and empty data, and the handler never fires.

Verified live on 2026-08-29. The template spawned against the Sdy Labs NFT — `SpawnedSource`
`TransferToActorCount-0xc81db190…` exists — and three real mints produced **zero** `KpiAction` rows.

Left standing, because nothing reads `KpiAction`: the UI's `useObservedActions` fetches logs by raw
`eth_getLogs`, and the indexer and relayer decode logs themselves. Crediting was unaffected; the same
three mints credited Sdy Labs kpi 0 = 3 on chain. A fix is a *second* template over the same topic0
declaring `uint256 indexed tokenId` and spawned alongside this one — each triggers only on its own topic
count — plus a manifest release and a new Studio version label.

### Shapes the 2026-08-29 fixture leaves uncovered

`templateFor` returns null for two of the fixture's four KPIs: Venus kpi 1 (WETH `Deposit` in count
mode — only `dataWord0` is mapped) and Sdy Labs kpi 1 (`Minted(address indexed,uint256,uint256)`, which
no template declares). Each lands as an `UnsupportedSource` row with `kpiCount: 1` plus a `log.warning`.
That is the designed outcome for an event no manifest covers, not an indexing error, and it carries the
same no-consumer caveat as above.

---

## `web/scripts/relay-kpi-metric.ts`

### Block timestamps come off the logs, not from one `eth_getBlockByNumber` per block

Attribution resolves at each action's own block, so every decoded log needs its block's timestamp.
Reading them a block at a time is what *broke* the relayer rather than merely slowing it. Measured
2026-09-02 on Base Sepolia: KPI 0 of the Gyndore fixture had 53,344 blocks pending carrying 88,316
matching `Swap` logs over 41,981 distinct blocks, and KPI 1 another 95,425 `Staked` logs over 42,769 —
84,750 individual `eth_getBlockByNumber` calls for one pass across the three KPIs. Twelve in flight
answered ~42 blocks/s, so a pass wanted ~34 minutes; publicnode's limiter cut it off after ~2m20s with
`Rate limit exceeded`, the run exited non-zero, and the checkpoint never moved. It had sat at
46,223,149 for ~30 hours.

`eth_getLogs` already answers the question. Geth-family nodes put `blockTimestamp` on every log, and
viem passes it through as a bigint even though it is absent from viem's `Log` type. Over 904 blocks the
log-carried value equalled `eth_getBlockByNumber().timestamp` on every one, so harvesting it is not an
approximation: `aggregateDeltas` receives the same map it always did, which is what keeps the
attribution result identical. Both large passes now report `0 timestamp read(s) needed` and finish in
about a minute, spent almost entirely in `eth_getLogs`.

The block read stays as the fallback for nodes that omit the field — anvil among them — deduplicated
against the cache, packed 100 calls to a JSON-RPC request and dispatched 300 blocks at a time. On the
same endpoint that fallback runs at ~319 blocks/s against ~42 for one request per call: the limiter
counts requests, not calls.

### The timestamp cache outlives the process, because each KPI is its own invocation

`relay-loop.sh` runs `pnpm relay` once per gated KPI, so a cache held only in memory is discarded
between the Swap pass and the Staked pass even though their ranges almost entirely overlap — 41,981 and
42,769 distinct blocks, 50,333 in the union. It is written to
`web/.cache/relay-block-timestamps-<chainId>.json` and read back by the next pass; the Staked pass now
opens holding the 42,207 blocks the Swap pass gathered.

A cached timestamp is wrong only if the block it names was reorged out. The relayer already stops
`CONFIRMATIONS = 5` short of the head and writes a monotonic on-chain checkpoint on that same
assumption, so persisting timestamps bets nothing new. The file is keyed by chain id, capped at 150,000
entries with the lowest blocks dropped first, and written before the totals reads so a failure in the
reporting half does not discard what the scan paid for.

### `eth_getHeaderByNumber` was measured and left alone

publicnode answers it, and at 1,733 bytes against 4,678 for `eth_getBlockByNumber` it would cut the
fallback's bandwidth 2.7× — a full block's response is mostly the transaction-hash array, which nothing
here reads. It is not a standard method, viem has no action for it, and the fallback is now rarely
taken, so the indirection buys nothing today.

## `web/scripts/relay-loop.sh`

### An empty `TARGETS` list is a state, not a misconfiguration

Only a **gated** KPI has a ceiling to raise; with `verifier == address(0)` the campaign credits the
reported figure as-is, so relaying it would cost a transaction and change nothing. Every KPI of the
2026-08-29 fixture is ungated, so the list is empty and the script prints `no gated KPIs` and exits 0.

`dev-up.sh` greps for that line rather than starting the background loop. Starting it anyway would leave
a pid in `PIDS` that has already exited, which `cleanup` then signals into a dead process group.

### The pass output goes through `tee`, not command substitution

`out=$(pnpm relay …)` buffers the whole pass and prints nothing until it exits. A pass now spends about
a minute inside `eth_getLogs` per KPI, so that made a working relayer indistinguishable from a hung one
— and when the rate limiter was killing passes, the failure was invisible for its whole duration. The
summary below still needs the full text to find `credited` lines, so the output is teed to a temp file
and read back rather than captured.

The scan lines are written with `\r` only when stdout is a TTY. Under `dev-up.sh`, which pipes the
first pass to `tee`, they fall back to one line every two seconds so the log stays readable.
