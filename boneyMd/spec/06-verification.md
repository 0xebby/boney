# 06 — KPI verification

## The problem

`Campaign.reportUserAction(kpiIndex, user, newTotal, evidence)` lets the `project` or the
`oracleCoordinator` **claim** a user's cumulative progress — "Alice has made 2 deposits". Nothing in
that call proves it. 

The project is claiming progress against its own escrow, and the promoter being paid has no way to check.

Solidity cannot check it either: **there is no `eth_getLogs` on chain**, so a contract cannot read
historical event logs. The `IKpiVerifier` hook exists to bound the claim against something more
trustworthy before it becomes a payout.

So "verification" here means an independent process scans the real
logs, computes the real metric, and pushes it on chain *ahead of time*; `verify()` is then a cheap
stored-value lookup and comparison.

Note what a verifier does **not** decide: who gets paid. `Campaign` resolves that itself, per action,
from the attribution history — see [chapter 04](./04-attribution.md#per-action-attribution). 

A verifier just sets a ceiling; the tally distributes what fits under it.

## The one hard constraint

**A verifier may only ever shrink a claim.**

```solidity
verifiedTotal = IKpiVerifier(spec.verifier).verify(campaign, kpiIndex, user, newTotal, evidence, params);
if (verifiedTotal > newTotal) revert VerifierOvercredit(verifiedTotal, newTotal);
```

Enforced by `Campaign`, independently of what any adapter does. A verifier's job is to cap, never to
invent. Two corollaries:

- A malicious or buggy adapter cannot mint progress.
- An adapter cannot **redirect** the payee either. It can deny a promoter a delta they did not earn; it
  cannot award that delta to whoever did.
- The uncredited portion leaves `_userCredited` and `_creditedTo` unadvanced, so a corrected report can land later.

Implementations are expected to be view-only, and to revert or return 0 when the evidence does not
substantiate the claim.

## The three adapters

| Contract                   | State                                                                   | Role                                                                                     |
| -------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `GuardedKpiVerifier`     | per-KPI guard config                                                    | **The one a campaign points at.** Composes Boney's reading with an optional second |
| `EventMetricKpiVerifier` | per-KPI watch config, per-user observed totals, per-KPI scan checkpoint | Boney's canonical, independently-fed(from relayer reading**eth-logs**) reading     |
| `TouchWindowVerifier`    | none — fully stateless                                                 | Off-chain window reads.**Not to be wired as a KPI's verifier**                    |

One deployment of each serves every campaign.

---

## `GuardedKpiVerifier`

This is what `KpiSpec.verifier` should be set to. Boney's value is **always** computed; a second
verifier is a check, never an alternate source of truth.

Without this wrapper, a project running its own verifier would be silently overridden by Boney's number
every time, and nobody would learn the two ever disagreed.

```solidity
struct GuardConfig {
    address projectVerifier;  // address(0) → trust Boney alone
    uint16  toleranceBps;     // allowed divergence in bps of the larger value. AGREE only
    Mode    mode;             // AGREE | CAP
    bool    configured;
}
```

Set with `setGuardConfig(campaign, kpiIndex, projectVerifier, toleranceBps, mode)` (owner only,
`toleranceBps <= 10_000` or `BpsOutOfRange(toleranceBps)`, replaceable). Read with
`guardOf(campaign, kpiIndex)`. 

`projectVerifier == address(0)` is equivalent to pointing the campaign straight at
`EventMetricKpiVerifier`, but kept routable through here so a KPI can gain a second verifier later
*without* the campaign's immutable KPI spec changing.

Every seed script configures exactly that — `address(0)` with `Mode.AGREE` — with one exception:
`SeedDemo._createFundedMultiKpi` passes `TouchWindowVerifier` under `Mode.CAP` on all of that
campaign's KPIs. That exception contradicts the do-not-wire rule stated in `script/DeployBoney.s.sol`
and in `TouchWindowVerifier`'s own `@dev`; see [the section below](#it-must-not-be-wired-as-a-kpis-verifier).

### `verify` logic

```
boneyValue = EventMetricKpiVerifier.verify(...)          // always
if projectVerifier == 0: return boneyValue

projectValue = projectVerifier.verify(...)

CAP:    return min(projectValue, boneyValue)

AGREE:  diff    = |boneyValue - projectValue|
        base    = max(boneyValue, projectValue)
        allowed = base * toleranceBps / 10_000
        if diff > allowed: revert VerifierDisagreement(projectValue, boneyValue, diff, allowed)
        return boneyValue                                 // Boney's stays canonical
```

### Why two modes

The second verifier can mean two different things, and one behaviour is wrong for one of them.

**`AGREE`** — for a project running its own *independent measurement of the same quantity*. The two
should match, so divergence past tolerance reverts the whole report rather than quietly taking the
smaller number. 

`toleranceBps = 0` (exact match) is right for `COUNT`; `SUM`/volume KPIs may want a small
nonzero tolerance to absorb rounding and timing differences between two independent scans.

**`CAP`** — for layering a *stricter lens on a different quantity*, crediting `min(boney, project)`.
`CAP` reads the smaller one as the stricter bound it is.

On success under `AGREE`, Boney's value is what gets credited, so the credited number comes from the
same source across every KPI whether or not a second verifier happens to be configured.

### Fails closed

An unconfigured KPI reverts `NotConfigured(campaign, kpiIndex)`. 

---

## `EventMetricKpiVerifier`

Boney's own reading. Caps a claim against a metric an independent relayer observed in the real event
logs.

### Trust model, stated plainly

Whoever holds the `reporter` key is trusted to report honestly. 

What it does buy is real: *a project can no longer credit itself more than an independent observer saw.*

A reporter can **under**-report, denying promoters credit.

Swapping the relayer for Chainlink Functions later is a reporter-side change, not a redesign.

The key is set at construction and rotatable with `setReporter` (owner only). Everything that writes is
`onlyReporter`, reverting `NotReporter(caller)`.

### `KpiConfig`

```solidity
struct KpiConfig {
    address targetContract;    // contract emitting the watched event
    string  eventSignature;    // full human-readable ABI, `indexed` keywords included
    uint8   userParamIndex;    // 0-based declaration-order position of the user-address param
    uint8   valueParamIndex;   // 0-based position of the summed param. Ignored for COUNT
    Aggregation aggregation;   // COUNT | SUM
    uint256 scale;             // divisor applied inside verify(). 0 reads as 1
    uint256 windowStartBlock;  // earliest block worth scanning
    uint256 windowEndBlock;    // latest block the relayer may report up to
    bool    configured;
    uint256 epoch;             // config generation. Part of every per-user storage key
}

enum Aggregation { COUNT, SUM }   // COUNT: each log contributes 1. SUM: each contributes its value param
```

Set with `setKpiConfig(...)` (owner only). Emits `KpiConfigured`. Validated: non-zero campaign and
target (`ZeroAddress`), non-empty signature (`EmptyEventSignature`),
`windowStartBlock <= windowEndBlock` (`BadWindow(start, end)`).

#### Replacement, and the `epoch` that makes it safe

`windowEndBlock` is often provisional at campaign-creation time, because a campaign's real reporting
close depends on when `Campaign.end()` is actually called, which is permissionless and therefore
unknowable in advance. 

So `setKpiConfig` is replaceable — but replacing it can mean two very different things, and the contract distinguishes them:

| Changed                                                                                                                              | Effect                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `windowEndBlock` only                                                                                                              | Nothing else moves. The checkpoint and every stored total survive                                                    |
| `targetContract`, `eventSignature`, `userParamIndex`, `valueParamIndex`, `aggregation`, `scale`, or `windowStartBlock` | `epoch += 1`, `lastScannedBlock` resets to 0, and `KpiTotalsInvalidated(campaign, kpiIndex, epoch)` is emitted |

Per-user totals are keyed `keccak256(campaign, kpiIndex, epoch, user)`, so **a bumped epoch abandons
every stored total rather than merely marking it stale.** That is what makes the invalidation real: a
KPI repointed at a different event cannot keep crediting against a total measured from the old one, and
the reset checkpoint makes the relayer rescan from `windowStartBlock`.

#### Why a full human-readable event signature

An earlier shape assumed a fixed 32-byte word offset in `log.data`. Projects hosting campaigns emit
wildly different event shapes — differing param counts, mixed indexed/non-indexed, different uint
widths — and a manual offset breaks *silently* the moment the layout differs.

Storing the signature lets the relayer build a real ABI decoder
(`relayCore.parseEventSignature` → viem's `decodeEventLog`), so `userParamIndex` / `valueParamIndex` are
positions in **declaration order** rather than byte-math guesses. `relayCore.validateParamIndexes`
checks them against the parsed event *before* any log is fetched, because the failure mode is quiet: a
`userParamIndex` pointing at a `uint256` yields garbage addresses matching no attributed user, so the
run reports nothing and merely looks like a quiet period.

#### Why the config is not in `params`

`KpiSpec.params` is already contested — the event-source commitment is a 160- or 224-byte blob, and
`TouchWindowVerifier` reads the same field as a bare `uint64`, returning 0 unless it is *exactly* 32
bytes. The encodings cannot share the field.

Keeping this verifier's config in its own storage removes it from that contest and lets one deployment
serve every campaign.

### Reporting paths

| Function                                                            | Moves totals | Moves checkpoint | Use                                        |
| ------------------------------------------------------------------- | ------------ | ---------------- | ------------------------------------------ |
| `reportBatch(campaign, kpi, users[], totals[], scannedUpToBlock)` | yes          | yes, atomically  | The normal incremental relayer run         |
| `advanceCheckpoint(campaign, kpi, scannedUpToBlock)`              | no           | yes              | A scanned range that held no matching logs |
| `reportVerifiedTotal(campaign, kpi, user, total)`                 | one user     | no               | Manual correction                          |

All three are `onlyReporter` and require the KPI to be configured. `reportBatch` reverts
`LengthMismatch(users, totals)` on ragged arrays.

**Atomicity is the point of `reportBatch`:** totals and checkpoint move together

Only users whose total changed in the newly scanned range need including, an untouched user's stored total is already correct.

### Guards on the checkpoint

`_requireAdvanceable` enforces both, on both paths:

- **Monotonic** — `scannedUpToBlock >= lastScannedBlock`, else `CheckpointRegression(current, provided)`.
  It cannot be walked back to re-credit a range.
- **Bounded** — `scannedUpToBlock <= windowEndBlock`, else `PastReportWindow(windowEndBlock, provided)`.
  Scanning past a campaign's reporting close is worse than wasted: `Campaign` has stopped accepting
  reports by then, so the whole run does its work and then reverts. 

An epoch bump is the one thing that moves the checkpoint backwards, and it does so by resetting it to 0
inside `setKpiConfig` rather than through either reporting path — so the monotonic guard is never
weakened, only re-based by the owner.

### Why the checkpoint is on chain

A relayer with a local cursor rescans everything after a crash or a host move, and two instances
disagree about where they are. Keeping `lastScannedBlock` per `(campaign, kpiIndex)` on chain means any
instance anywhere with **no local state at all** can ask the chain where it left off.

### `verify`

```solidity
observed = verifiedTotals[_userKey(campaign, kpiIndex, cfg.epoch, user)] / _effectiveScale(cfg.scale);
return min(amount, observed);
```

`evidence` and `params` are accepted for interface compatibility and **ignored**: this verifier trusts
its own stored config and the relayer's reports rather than anything passed in per call, which is what
makes it independent of the reporting project. 

Note the consequence — the ceiling is per *user*, not per promoter, so a report whose evidence spans a promoter switch is capped once and the tally then splits
what fits. 

That is the correct order: the cap is a statement about the wallet's observed activity, and who earned it is a separate question.

Fails closed on an unconfigured KPI (`KpiNotConfigured(campaign, kpiIndex)`) 

Token-valued KPIs are reported in **display units**, so `RewardTier.threshold` can stay a human number.


If the verifier compared against raw wei, the cap would sit ~1e18 too high and never bind. 

### Views

| View                                        | Returns                                                                                 |
| ------------------------------------------- | --------------------------------------------------------------------------------------- |
| `configOf(campaign, kpi)`                 | The full`KpiConfig`, `epoch` included, addressed directly rather than by hashed key |
| `verifiedTotalOf(campaign, kpi, user)`    | The**raw, unscaled** observed metric. What the relayer accumulates against        |
| `observedProgressOf(campaign, kpi, user)` | The**scaled** ceiling — what `verify` actually compares against                |
| `checkpointOf(campaign, kpi)`             | Last block fully incorporated. 0 if the relayer never ran, or if an epoch bump reset it |
| `lastReportedAt`                          | Timestamp of the most recent report for one user, keyed the same way as the totals      |

`observedProgressOf` exists so a frontend can show a promoter *why* a report credited less than the
project claimed, without reimplementing the scale arithmetic. It is what `lib/reporting.describeCeiling`
reads, and note it returns the *current* epoch's figure — after an invalidation it reads 0 until the
relayer rescans.

Storage keys are `keccak256(abi.encodePacked(campaign, kpiIndex))` for the per-KPI config and checkpoint,
and `keccak256(abi.encodePacked(campaign, kpiIndex, epoch, user))` for per-user totals.
`GuardedKpiVerifier` uses the same derivation for its per-KPI key, so both contracts can be reasoned
about against one key.

---

## `TouchWindowVerifier`

Credits only the actions a user performed **while the currently attributed promoter held the
attribution**. Stateless, view-only, and it reads whichever attribution registry the *calling* campaign
uses (`campaign.attributionRegistry()`), so one deployment works across registries.

### It must not be wired as a KPI's verifier

This adapter predates per-action segmentation. When a report's attribution was resolved once, at report
time, it was the only thing standing between a promoter and a batch of activity that predated their
touch. `Campaign` now does that job properly: `promotersAt` resolves every evidence action against the
touch history at that action's own block, and each promoter is credited their own segment.

Composing the adapter on top of that **breaks it**. It floors at the *current* touch's `signedAt`, so a
report spanning a promoter switch is capped at the current promoter's slice — and because the cap is a
single per-user number, the earlier promoter's segment is starved of the ceiling it needed. The 100/40
arithmetic in `test_Verify_touchWindowUnderCapSurvivesPromoterSwitch` is exactly that: 60 units of
legitimately earned progress that a `CAP` composition discards.

So: **not as `KpiSpec.verifier`, and not as a `Mode.CAP` `projectVerifier`.** `script/DeployBoney.s.sol`
step 5 says so, and so does the contract's own `@dev`. It is deployed for reads.

**The tree does not agree with itself on this yet**, and a reader will hit the disagreement:

| Where                                               | What it says                                                                 |
| --------------------------------------------------- | ---------------------------------------------------------------------------- |
| `script/DeployBoney.s.sol` step 5                 | Must not be wired as a`KpiSpec.verifier` or a `Mode.CAP` second verifier |
| `src/verifiers/TouchWindowVerifier.sol` `@dev`  | Same —`Campaign` segments reports itself now                              |
| `src/verifiers/GuardedKpiVerifier.sol` `@dev`   | Names`TouchWindowVerifier` as `CAP`'s motivating case                    |
| `script/SeedDemo.s.sol` `_createFundedMultiKpi` | Wires it as the`CAP` `projectVerifier` on every KPI of that campaign     |

The first two are the current rule. The last two predate per-action segmentation and were not updated
with it. Treat the fixture as a fixture: the composition it seeds under-credits a promoter switch
exactly as described above.

What remains is genuinely useful — reading one promoter's window in isolation, and `windowFloor` for
off-chain parity — which is what it is deployed for.

### Evidence and params

```solidity
evidence = abi.encode(Types.Action[])        // {blockNumber, timestamp, amount}, the same struct Campaign decodes
params   = abi.encode(uint64 lookback)       // must be EXACTLY 32 bytes, else read as 0
```

Only `timestamp` and `amount` are read here; `blockNumber` is what `Campaign` uses. One encoding serves
both, which is why the struct lives in `Types` rather than in either consumer.

### `verify` logic

```
if evidence is empty:              return 0          // fail closed, no revert
touch = registry.touchOf(campaign, user)             // the live row, expired or not
if touch.promoterId == 0:          return 0          // fail closed
floor = touch.signedAt > lookback ? touch.signedAt - lookback : 0

for each action:
    if action.timestamp > block.timestamp:  revert FutureAction(timestamp, now)
    total += action.amount
    if action.timestamp >= floor:  credited += action.amount

if total > amount:                 revert EvidenceExceedsClaim(total, amount)
```

- **Missing evidence or no touch credits nothing**, which `Campaign` treats as a no-op report rather
  than a revert — so the report can be resubmitted once evidence exists.
- **Future-dated actions revert** rather than being skipped, because a future timestamp clears any
  floor.
- **Evidence claiming *more* than the report reverts**; claiming less is just a discount. The two
  disagreeing about what happened is an error; the reporter being conservative is not.

`windowFloor(campaign, user, params)` exposes the cutoff so a frontend can show promoters which activity
currently counts for them. It returns 0 for a user with no stored touch, since an unset `signedAt`
credits nothing anyway.

### The lookback trade

A user typically clicks a link, acts, and only *then* is asked to sign — so the action legitimately
predates the touch. `lookback` is how far before `signedAt` an action still counts.

It is a direct trade: the window is also exactly how much history a **newly-signed touch can capture**.
Keep it near real click-to-sign latency. Zero means strict, and a KPI carrying an event-source blob in
`params` is strict whether or not that was intended — the blob is not 32 bytes, so `_lookback` returns 0.

`AttributionRegistry.promoterAt` has no lookback at all: an action strictly before the touch's
`storedAtBlock` belongs to whoever held the user then, or to nobody. The off-chain mirror in
`web/src/lib/attributionWindows.ts` follows the registry, not this adapter.

---

## Putting it together

One gated report, end to end. Four steps, three of them off chain.

```
1. ACT     users transact on the project's own contract
           ordinary activity, no Boney involvement

2. OBSERVE pnpm relay   ── REPORTER_PRIVATE_KEY ──►  EventMetricKpiVerifier.reportBatch
           scans from checkpointOf(campaign, kpiIndex) forward, folds per user,
           excludes activity predating each user's own signedAt, advances lastScannedBlock

3. CLAIM   pnpm index   ── PRIVATE_KEY ───────────►  Campaign.reportUserAction(kpi, user, newTotal, evidence)
           scans the same source, builds Types.Action[] evidence

4. CREDIT  Campaign → GuardedKpiVerifier → EventMetricKpiVerifier
           verifiedTotal = min(claim, observed);  VerifierOvercredit if a verifier inflates
           credit the part above `already`, segment it by evidence, settle each promoter
```

**Step 2 must precede step 3.** A claim that lands before the relayer has observed anything is capped at
zero, and because `Campaign` returns early when `verifiedTotal <= already` it **succeeds while crediting
nothing** — no revert, no event, no progress. 

`pnpm dev:up` runs them in that order for exactly this reason, and the reporting panel reads `observedProgressOf` before the click so the ceiling is visible
rather than inferred from a stuck progress bar (`describeCeiling` in `web/src/lib/reporting.ts`).

### The two keys, and how independent they really are

The design intends two parties: the project claims, Boney observes, and the claim is capped at the
observation. That separation is a **deployment property, not a protocol guarantee**:

```solidity
new EventMetricKpiVerifier(deployer, vm.envOr("BONEY_KPI_REPORTER", deployer))
```

Unset `BONEY_KPI_REPORTER` and the reporter *is* the deployer — the same account that owns the guard and
runs the seeds. Every local fixture and the Base Sepolia one run that way, so on those deployments one
key both claims and observes, and the cap only catches an honest indexer's mistakes. `setReporter`
rotates it to a genuinely separate key without redeploying; until that happens the ceiling is a
self-imposed one.

---

## What each layer can and cannot do

| Layer                      | Can                                                                                                                   | Cannot                                                                      |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `Campaign`               | Refuse a total that goes backwards, cap the verifier, place each evidence action with its promoter, credit and settle | Measure anything, or read an event log                                      |
| `GuardedKpiVerifier`     | Force Boney's reading to be consulted, cross-check a second one, revert on disagreement                               | Raise a claim —`min` and `AGREE` both return a value `<= boneyValue` |
| `EventMetricKpiVerifier` | Cap a claim at what an independent scan recorded per user                                                             | Credit anyone, or notice that a relayer under-reported                      |
| `TouchWindowVerifier`    | Say which timestamps fall inside one promoter's window                                                                | Distinguish*which* promoter — it reads only the live touch               |
| The relayer                | Under-report by being behind, or by excluding pre-`signedAt` activity                                               | Over-report above what the logs contain                                     |
| The indexer                | Claim any figure it likes                                                                                             | Get more than the relayer observed credited                                 |

### The failure this does not catch

Both halves under-reporting in the same direction. If the relayer never runs, the ceiling is zero and
nobody is paid — visibly wrong. If the relayer runs and the *indexer* never claims, escrow stays put
until `end()` and the grace window, and the promoter who earned it is not paid — also wrong, and
`reclaimUnspent()` eventually hands the money back to the project. That is what the claim grace window
and the permissionless oracle path exist to bound; see
[chapter 03](./03-lifecycle.md#what-the-grace-window-is-for) and [chapter 08](./08-oracle.md).

---

## Both verifiers fail closed

Every unconfigured or unobservable path credits zero rather than crediting the claim.

| Situation                                                    | Result                                                                                           |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `KpiSpec.verifier == address(0)`                           | Ungated. The claim is credited as given — the one open path, and it is explicit in the KPI spec |
| Wired to the guard,`setGuardConfig` never ran              | `NotConfigured(campaign, kpiIndex)` — the report reverts                                      |
| Guard configured,`setKpiConfig` never ran                  | `KpiNotConfigured(campaign, kpiIndex)` from Boney's verifier — reverts                        |
| Configured, relayer has not scanned                          | `verify` returns 0, report succeeds crediting nothing                                          |
| Configured, epoch just bumped                                | Totals read 0 again,`checkpointOf` reads 0, relayer rescans from `startBlock`                |
| `TouchWindowVerifier` with no evidence, or no stored touch | Returns 0                                                                                        |

A misconfiguration is loud (a revert), and a not-yet-observed metric is quiet (a zero). That split is
deliberate: the first is a mistake somebody must fix, the second is a race that time closes.

---

## Open, not settled

Stated so the guarantees are not over-read.

- **The relayer is trusted to run, and to run honestly downward.** Nothing on chain notices a scan that
  skipped a range. `lastScannedBlock` only ever moves forward, so a skipped range is skipped for good
  unless a config change bumps the epoch and forces a rescan.
- **One reporter key, unstaked.** `EventMetricKpiVerifier.reporter` is a single account with no bond and
  no dispute path. `OracleCoordinator` has both, but the two are separate systems — the verifier is not
  routed through it. See [chapter 08](./08-oracle.md).
- **`AGREE`'s tolerance is per KPI and per guard config**, so a project can set it wide. `10_000` bps is
  100% divergence, which accepts anything. Nothing forbids that.
- **A disagreement stops the pass, not just the row.** `reportUserAction` takes one user, so a
  `VerifierDisagreement` reverts only that user's report. But the indexer's report loop has no
  `try`/`catch` around `writeContract`, so the revert throws out of `main()` and every user and KPI still
  queued in that pass goes unreported until the next run.
- **Scale is a configured constant, not derived.** `_effectiveScale` defaults `0` to `1`, and a KPI whose
  `params` scale disagrees with the verifier config's scale silently measures two different units. The
  seeds keep them equal by hand; nothing checks it.
- **`GuardedKpiVerifier`'s own `@dev` is stale** on `TouchWindowVerifier`, as tabulated above. The rule
  in `DeployBoney.s.sol` is the current one.
