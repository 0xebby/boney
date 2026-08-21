# KPI Verification — Architecture

How Boney decides what a project is allowed to credit a promoter for, and why the design is shaped
this way. The reasoning matters as much as the implementation; read this before changing any of it.

**The code:**
- `src/verifiers/EventMetricKpiVerifier.sol` — Boney's canonical, independently-fed verifier
- `src/verifiers/GuardedKpiVerifier.sol` — composes Boney's reading with a second one
- `src/verifiers/TouchWindowVerifier.sol` — attribution-timing lens, composable as that second one
- `web/src/lib/relayCore.ts` — the relayer's pure logic (decode, filter, aggregate, batch)
- `web/scripts/relay-kpi-metric.ts` — the relayer's I/O shell (`pnpm relay`)
- `web/scripts/compute-report-window.ts` — derives block bounds from campaign timestamps (`pnpm report-window`)

See `KPI_VERIFICATION_WALKTHROUGH.md` for the same flow worked through with concrete numbers.

---

## 1. The problem

`Campaign.reportUserAction(kpiIndex, user, newTotal, evidence)` lets `project` or
`oracleCoordinator` **claim** a user's cumulative KPI progress — "Alice has made 2 deposits".
Nothing in that call proves it. The project is claiming progress against its own escrow, and the
promoter being paid has no way to check.

Solidity cannot check it either: there is no `eth_getLogs` on chain, so a contract cannot read
historical event logs. The `IKpiVerifier` hook exists to bound the claim against something more
trustworthy before it becomes a payout.

**The hard constraint everything else respects:** a verifier may only ever *shrink* a claim.
`Campaign.reportUserAction` enforces it directly —
`if (verifiedTotal > newTotal) revert VerifierOvercredit(...)`. A verifier's job is to cap, never to
invent.

---

## 2. Why an off-chain relayer

Because contracts cannot read logs, "verification" has to mean: an independent process scans the
real logs via `eth_getLogs`, computes the real metric, and pushes it on chain *ahead of time*.
`verify()` is then a cheap stored-value lookup and comparison, not a live computation.

This centralises trust in whoever holds the relayer's key (`reporter` on the verifier). That is an
explicit, accepted tradeoff — this is not a trustless oracle and does not claim to be. What it does
buy is real: **a project can no longer credit itself more than an independent observer saw.**
Swapping the relayer for Chainlink Functions later is a reporter-side change, not a redesign.

There are therefore **two off-chain roles, deliberately separate, with separate keys**:

| | claims | runs as | script |
|---|---|---|---|
| The project | `Campaign.reportUserAction` | `PRIVATE_KEY` | `pnpm index` |
| Boney | `EventMetricKpiVerifier.reportBatch` | `REPORTER_PRIVATE_KEY` | `pnpm relay` |

One process doing both would make the cap a formality. **Both must run** — the indexer alone leaves
every progress bar at zero, because a claim capped against an unreported total credits nothing.

---

## 3. Why a full human-readable event signature

An earlier shape assumed a fixed 32-byte word offset in `log.data`. Rejected: projects hosting
campaigns emit wildly different event shapes — `Deposit(address,uint256)`,
`VolumeRecorded(address,address,uint256)`, different param counts, mixed indexed and non-indexed,
different uint widths. A manual offset breaks *silently* the moment the layout differs.

So the config stores the full signature, and the relayer builds a real ABI decoder from it
(`relayCore.parseEventSignature` → viem's `decodeEventLog`). `userParamIndex` and `valueParamIndex`
become positions in declaration order rather than byte-math guesses, and any shape decodes
correctly.

```solidity
struct KpiConfig {
    address targetContract;
    string eventSignature;      // "Deposit(address indexed user, uint256 amount)"
    uint8 userParamIndex;
    uint8 valueParamIndex;      // ignored for COUNT
    Aggregation aggregation;    // COUNT | SUM
    uint256 scale;              // see §6
    uint256 windowStartBlock;
    uint256 windowEndBlock;
    bool configured;
}
```

`relayCore.validateParamIndexes` checks those indexes against the parsed event *before* any log is
fetched, because both failure modes are quiet: a `userParamIndex` pointing at a `uint256` yields
garbage addresses matching no attributed user, so the run reports nothing and merely looks like a
quiet period.

---

## 4. Why the config lives on the verifier, not in `KpiSpec.params`

`params` is already overloaded. The indexer reads a 160-byte event-source blob from it
(`web/src/lib/kpiSource.ts`), and `TouchWindowVerifier` reads it as a bare `uint64` lookback —
returning 0 unless it is *exactly* 32 bytes. The two encodings cannot share the field;
`web/src/lib/validation.ts` warns about the collision, and `SeedEventKpi` used to set
`verifier: address(0)` purely to sidestep it.

Keeping this verifier's config in its own storage removes it from that contest, and lets one
deployment serve every campaign.

**The cost is two descriptions of the same event**, which can drift. The failure is quiet and
expensive: the project claims progress from one event while Boney verifies another, so the cap sits
at 0 and every report is a silent no-op. So the relayer refuses to start when they disagree —
`relayCore.describeConfigDrift` compares topic0, source address and scale. Change one side, change
the other.

---

## 5. Why the checkpoint is on chain

A relayer with a local cursor rescans everything after a crash or a host move, and two instances
disagree about where they are. So the verifier stores `lastScannedBlock` per `(campaign, kpiIndex)`,
and any instance anywhere — with no local state at all — asks the chain where it left off.

`reportBatch` moves totals *and* the checkpoint in one transaction, so a crash can never leave a
checkpoint claiming a range whose totals were never stored. The checkpoint is enforced monotonic, so
it cannot be walked back to re-credit a range.

That monotonicity is also why **only the last transaction of a multi-transaction run carries the new
checkpoint** (`relayCore.planReportBatches`). If every transaction advanced it, a run that died
halfway would leave a permanent gap that nothing can reopen. Holding the old value until the final
transaction makes a partial failure safely retryable — the re-reported totals are idempotent anyway.

For the same reason the relayer stays `CONFIRMATIONS` blocks behind the head: a checkpoint set on a
block a reorg then discards is permanent damage.

---

## 6. Why `scale` is applied on chain

Token-valued KPIs are reported in display units — the indexer divides by `scale` so
`RewardTier.threshold` can stay a human number. If the verifier compared against raw wei, the cap
would sit ~1e18 too high and never bind. So `KpiConfig.scale` mirrors the indexer's divisor.

The division happens inside `verify()`, and `verifiedTotals` holds the **raw, unscaled** metric.
That ordering is what keeps the relayer stateless: it accumulates by reading the stored total and
adding a delta, so a pre-scaled stored value would be re-divided every run and sub-scale activity
would floor away to nothing instead of accumulating. Keeping the raw figure on chain means the only
state the relayer needs is state the chain already holds. `observedProgressOf` exposes the scaled
ceiling for UIs.

---

## 7. Why the scan window is bounded on chain

`[windowStartBlock, windowEndBlock]`, enforced by `reportBatch` and `advanceCheckpoint` both.

Scanning before a campaign starts tracking is wasted work. Scanning *past* its reporting close is
worse than wasted — `Campaign` has stopped accepting reports by then, so the whole run does its work
and then reverts. Enforcing the bound on chain costs one stored-word comparison and means even a
buggy or compromised reporter cannot push past it.

**Deriving the close is the subtle part**, and it is not `endTime + CLAIM_GRACE`.
`Campaign._requireReportableStatus` closes reporting at `endedAt + CLAIM_GRACE`, and `endedAt` is
set when `end()` is actually called — permissionless, but not automatic, so it can land well after
`endTime`. `pnpm report-window` handles both cases: exact when the campaign is already `Ended`,
otherwise `endTime + CLAIM_GRACE` as the earliest it could be, flagged as provisional.

`setKpiConfig` deliberately allows replacement so the window can be extended afterwards without
disturbing any stored total or the checkpoint. **Bias the estimate high**: the bound only limits the
relayer, while `Campaign` enforces its own window regardless — so over-estimating wastes a little
scanning, and under-estimating under-credits promoters.

---

## 8. Why per-user attribution filtering

The trickiest correctness rule. Without it, activity a user performed *before* they were ever
attributed to a promoter still credits that promoter — who did not cause it.

So the relayer decodes logs first *without* aggregating, resolves each unique user's attribution
timestamp (one read per user touched this run, not per log), resolves each unique block's timestamp
(deduped — many logs share a block), and only then folds in the logs at or after each user's own
`signedAt`. Users with no touch at all are skipped entirely, consistent with `Campaign` reverting
`NoAttribution` for them.

In this repo the attribution timestamp is **not** a getter on the campaign. It is:

```
campaign.attributionRegistry() → registry.touchOf(campaign, user).signedAt
```

A block whose timestamp could not be resolved is excluded rather than assumed to clear the floor.

The relayer floors at the **current** touch, and that is right *for the relayer*: `nextTotals` adds
this run's deltas onto the figure already stored on chain, so an earlier promoter's era is already
banked in `verifiedTotals` and must not be recounted. A consumer that recomputes an **absolute** total
from scratch needs the earliest touch instead — see below. The distinction is the additive-versus-
absolute model, not a disagreement about the rule.

### The rule belongs to every reader, not just the relayer

This was written as a property of the relayer, and for a long time that is all it was. Three other
code paths read the same logs and folded them **without** the floor, so they credited activity from
before a user's `signedAt` — and, on a young campaign, from before the campaign existed at all:

| path | what it did |
| --- | --- |
| `scripts/indexer.ts` | cold-start range was `head - 50_000` with no reference to the campaign, then folded every actor unfiltered — and it *writes on chain* |
| `useObservedActions` | scanned from the **registry deployment** block and folded unfiltered, so the report panel showed a referral's whole history on the source contract |
| `aggregateActions` | the subgraph-fed fold, which the subgraph's own handler comment explicitly defers the attribution decision *to* |

The last one is the sharpest: `subgraph/src/transfer.ts` stores actions deliberately unfiltered,
because a promoter switch moves `signedAt` afterwards and baking the answer in at index time would
be wrong. That deferral is only sound if the consumer applies the floor.

Nothing downstream caught it. `reportUserAction` receives a total, never the blocks behind it, so the
contract cannot tell an inflated figure from an honest one. `EventMetricKpiVerifier.verify` returns
`min(amount, observed)` and so bounds a gated KPI by the relayer's correctly-filtered ceiling — but
with `verifier == address(0)` the campaign credits the reported number as-is, and there was nothing
between a wide scan and a wrong credit.

The fix puts the rule in the shared fold rather than in each caller. `aggregateByActor` and
`aggregateActions` both take a **required** `floors` argument — `max(firstSignedAt, startTime)` per
actor, keyed lowercase — and an actor missing from the map is dropped, matching `NoAttribution`. It is
required rather than optional so that opting out is a visible decision at the call site instead of an
omission; `null` means "diagnostics, attribution is not the question" and is used only by the
`scripts/__check-*` scratch tools.

### The floor is the referral's *first* touch, not its current one

This is the subtle part, and getting it wrong is a silent money bug in the other direction.

`Campaign` credits `newTotal - _userCredited[user][kpiIndex]` (`Campaign.sol:331`), and that replay
guard is **keyed by user alone** — one cumulative ledger spanning every promoter the referral ever
had. A reported total must therefore be cumulative over the referral's whole *attributed* history, or
the subtraction compares two different windows.

Floor at the current `signedAt` and a referral who switches promoters becomes permanently
uncreditable. Observed on campaign 2 of the 08-21 fixture, with `0x98bEf229` moving from promoter A
to B after A had banked 3:

| floor | B's recomputed total | `already` | credited to B |
| --- | --- | --- | --- |
| current `signedAt` | 3 (B's era only) | 3 | **0, forever** |
| earliest `signedAt` | 6 (both eras) | 3 | **3** — B's own era |

A keeps its 3, B gets its 3, and the six actions are credited once between them. Activity from before
the referral was *ever* attributed is still excluded, which is the whole point of §8 — it is only the
per-promoter slicing that was wrong.

`touchOf` returns only the live touch, so the earliest comes from the `TouchStored` history:
`earliestSignedAt` in `lib/reporting.ts`, fed by the indexer's own log scan and, in the browser, by
`useCampaignTouches` — which already scans that history for the KOL rows and now derives both from one
pass. `signedAt` is strictly increasing per referral (`AttributionRegistry.sol:122` reverts
`TouchNotNewer`), so the minimum really is the first touch ever stored.

The tempting alternative — giving each promoter its own replay ledger — is wrong. It removes the only
thing stopping B from re-reporting the same actions A was already paid for, out of one shared
`rewardPool`, and no off-chain honesty can restore a guard the contract no longer has.

Two further consequences worth naming:

- `useObservedActions` now resolves block timestamps for **every** KPI, not just verifier-gated ones.
  It previously skipped them when nothing would read the evidence, which is no longer true — the
  floor is a timestamp comparison, and a log carrying `0` is dropped rather than assumed to clear it.
  Skipping the fetch would have blanked every ungated KPI's panel.
- The indexer's block range is now clamped to the deployment block. That is an **RPC bound, not the
  correctness boundary** — the floor is. Clamping only stops blocks from before the protocol existed
  being scanned; it says nothing about when any particular campaign began.

---

## 9. Why `GuardedKpiVerifier` has two modes

`EventMetricKpiVerifier` alone already caps a claim at Boney's observed value — safe, but silent: a
project running its own verifier would be quietly overridden every time, and nobody would learn the
two ever disagreed. `GuardedKpiVerifier` is what a campaign's `KpiSpec.verifier` actually points at.
Boney's value is always computed; the second verifier is a check, never an alternate source of truth.

The delivered design had one behaviour — require agreement, revert otherwise. That is right for one
case and wrong for the other, so there are two:

**`Mode.AGREE`** — for a project independently measuring *the same quantity*. The two should match,
so divergence past `toleranceBps` (basis points of the larger value) reverts the report with
`VerifierDisagreement`, surfacing a broken indexer or disputed metric as an actionable error instead
of hiding it. `toleranceBps = 0` is right for `COUNT`; `SUM`/volume KPIs may want a small nonzero
tolerance to absorb rounding between two independent scans. Boney's value is credited on success.

**`Mode.CAP`** — credits `min(boney, project)`, for layering a *stricter lens on a narrower
quantity*.

`TouchWindowVerifier` is why `CAP` exists. It floors credit at the **current** touch's `signedAt`,
so after a promoter switch it deliberately discards pre-switch activity that Boney's cumulative
totals still retain. Those two numbers differ *by construction, not by fault* — under `AGREE` every
legitimate post-switch report would revert. `CAP` reads the smaller number as the stricter bound it
is. `test_Verify_touchWindowUnderCapSurvivesPromoterSwitch` pins both halves of that claim.

Either way the result can only shrink a claim, because `Campaign` independently rejects any verifier
returning more than was claimed.

Note that `TouchWindowVerifier` credits nothing without `evidence`, so a KPI composing it only moves
for reporters that send it — the indexer does.

---

## 10. Both verifiers fail closed

`verify()` reverts on an unconfigured KPI rather than returning 0. A KPI wired to a verifier before
its config lands is then loudly broken, instead of silently crediting nothing forever.

---

## 11. Full picture

```
Campaign creation (assigns kpiIndex, startTime, endTime)
        │
        ▼
pnpm report-window  ──►  windowStartBlock / windowEndBlock
        │
        ▼
kpiVerifier.setKpiConfig(campaign, kpiIndex, targetContract, eventSignature,
                         userParamIndex, aggregation, valueParamIndex, scale,
                         windowStartBlock, windowEndBlock)
guardedVerifier.setGuardConfig(campaign, kpiIndex, projectVerifier, toleranceBps, mode)
        │
        ▼
KpiSpec.verifier = address(guardedVerifier)      // fixed at campaign creation
        │
        ▼
Users get attributed (signed touch) → users act on chain
        │
        ├──────────────────────────────┬──────────────────────────────┐
        ▼                              ▼                              │
pnpm relay (Boney)              pnpm index (project)                  │
  read checkpoint                  scan logs                          │
  scan new blocks, bounded         aggregate per referral             │
  decode via real ABI              build TouchWindowVerifier evidence │
  filter pre-attribution                                             │
  aggregate per user                                                  │
  reportBatch()  ◄── atomic totals + checkpoint                       │
        │                              │                              │
        │                              ▼                              │
        │                    campaign.reportUserAction(kpiIndex, user, newTotal, evidence)
        │                              │                              │
        └──────────────────────────────┼──────────────────────────────┘
                                       ▼
                    GuardedKpiVerifier.verify()
                      ├─ EventMetricKpiVerifier: min(claim, observed / scale)
                      └─ optional second verifier: AGREE (revert on divergence) or CAP (min)
                                       │
                                       ▼
                    credit promoter progress → _settle() → payout
                                       │
                                       ▼
        endedAt + CLAIM_GRACE elapses: reporting closes exactly as reclaimUnspent() opens
                                       │
                                       ▼
                    project reclaims unspent escrow
```

---

## 12. Open, not settled

- **The `reporter` key is a single key**, with no rotation ceremony or multi-sig. `setReporter`
  exists, but the operational story around it does not. Worth revisiting before this touches real
  value.
- **Two descriptions of the same event** (`KpiConfig` and `KpiSpec.params`). The drift guard catches
  disagreement at relayer startup, but nothing prevents it being introduced.
- **`windowEndBlock` is an estimate** for any campaign not yet ended, and nothing re-runs
  `report-window` automatically once `end()` lands.
- **No single script** ties campaign creation → `setKpiConfig` → `setGuardConfig` together.
  `SeedDemo` does it inline for the fixture; a project doing it for real does three steps by hand.
- **A compromised reporter can under-report**, denying promoters credit. It cannot over-credit. This
  is the same exposure as a reporter that simply stops running, which is why lowering a stored total
  is allowed rather than blocked — reorg corrections need it and it grants no new power.
