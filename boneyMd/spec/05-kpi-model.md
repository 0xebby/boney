# 05 — KPI model and settlement

## `KpiSpec`

KPIs are extensible by construction rather than enumerated in the contract.

```solidity
struct KpiSpec {
    KpiKind kind;      // category hint; Custom requires a verifier
    address verifier;  // optional IKpiVerifier adapter. address(0) credits the raw claim
    uint256 target;    // campaign-wide goal. Informational — tiers drive payouts
    bool    aggregate; // campaign-level, oracle-reported, credits no individual promoter
    bytes   params;    // opaque config forwarded to the verifier
}
```

Stored write-once at construction, indexed by `kpiIndex` everywhere. Read with `kpi(index)`;
`kpiCount()` is the length.

### `kind`

```solidity
enum KpiKind {
    Custom, Mint, Swap, TokenPurchase, Deposit, Stake, Bridge,
    Tvl, Volume, ActiveUser, signUps, downloads, withdraw
}
```

`kind` is a **hint for indexers and UIs — settlement logic never branches on it.** The only rule the
contract enforces is that a `Custom` KPI must name a verifier (`CustomKpiNeedsVerifier`), because a
`Custom` KPI has no protocol-defined meaning and is only trustworthy with an adapter that can
substantiate reports.

(The last three members carry lowercase names, inconsistently with the rest. They are part of the
deployed ABI's value ordering, so they are documented as they are rather than renamed.)

### `verifier`

The real extensibility point. `address(0)` means the raw reported amount is credited as-is, trusting
the reporter. Any non-zero address is called as:

```solidity
function verify(
    address campaign, uint256 kpiIndex, address user,
    uint256 amount, bytes calldata evidence, bytes calldata params
) external view returns (uint256 credited);
```

`Campaign` independently enforces `credited <= amount`, reverting `VerifierOvercredit(credited, max)`
otherwise. An adapter may discount a claim; it can never inflate one. A malicious or buggy adapter
cannot mint progress. See [chapter 06](./06-verification.md).

### `aggregate`

An aggregate KPI is campaign-level and oracle-reported only. It never credits an individual promoter:
`reportUserAction` reverts `AggregateKpi(kpiIndex)` for one, and `applyAggregateUpdate` reverts
`NotAggregateKpi(kpiIndex)` for anything else.

This exists because TVL and volume are pool-level metrics with no per-user proof, so crediting them to
an individual would be fabricated attribution. They advance `totalProgress` for display and pay
nobody. Aggregate KPIs may therefore legitimately carry **no tiers** — the only case where an empty
ladder is allowed.

Per-promoter attribution for aggregate metrics needs oracle attribution proofs and is deferred.

### `params`

Opaque to the campaign, which forwards it to the verifier and otherwise ignores it. Two conventions
currently read it, and **they are mutually exclusive**:

| Encoding | Length | Read by |
|---|---|---|
| `abi.encode(uint64 lookback)` | 32 bytes | `TouchWindowVerifier._lookback` — returns 0 unless *exactly* 32 bytes |
| `abi.encode(address source, bytes32 topic0, uint8 actorTopic, uint8 amountMode, uint256 scale)` | 160 bytes | The event-source commitment (`web/src/lib/kpiSource.ts`), read by the relayer and the indexer |
| the same five words, plus `uint8 filterTopic, bytes32 filterValue` | 224 bytes | The same commitment, narrowed to logs whose `topics[filterTopic]` equals `filterValue` |

The two event forms are one encoding, not two: the filtered blob is a strict extension, so the first
five words decode identically either way and a campaign created before the filter existed is
byte-identical to what it was. `filterTopic = 0` is the sentinel for *no filter* — a zero
`filterValue` is a real value (`address(0)`, which is what a mint's `from` carries), so it cannot
double as "unset". Length is what tells all three encodings apart, which is why a filtered source is
encoded in its long form only when it has a filter to carry.

A KPI carrying either event blob gets `lookback = 0` from `TouchWindowVerifier` — strict, which
is the *safe* direction (it credits less, never more), but silently not what whoever set the lookback
asked for. `kpiSource.eventSourceConflictsWithVerifier` exists so the create form can say so out loud,
and `web/src/lib/validation.ts` warns about the collision.

This collision is why `EventMetricKpiVerifier` keeps its own config in its own storage rather than
reading `params`. See [chapter 06](./06-verification.md#why-the-config-is-not-in-params).

### `evidence`

Not part of `KpiSpec`, but the other half of a report and decoded by `Campaign` for **every** KPI,
verifier or not:

```solidity
struct Action {
    uint64  blockNumber;  // must not decrease across the array
    uint64  timestamp;    // that block's timestamp
    uint256 amount;       // this action's contribution to the KPI
}
```

`abi.encode(Action[])`, built off chain by `encodeActions` in `web/src/lib/indexerCore.ts`. What it
buys is per-action attribution — see [chapter 04](./04-attribution.md#per-action-attribution). An empty
`evidence` is legal and takes a different, narrower path through the same function.

## Reward tiers

```solidity
struct RewardTier {
    uint256 threshold;  // attributed progress a promoter must reach
    uint256 reward;     // amount released from the shared pool when crossed
}
```

`tiers[kpiIndex]` is one ladder per KPI, outer index aligned to `kpis`. Validated at construction:

- Strictly ascending thresholds (`TiersNotAscending`) — this is what lets settlement walk the ladder in
  one forward pass with a single stored cursor.
- Non-zero rewards (`ZeroTierReward`).
- At most `MAX_TIERS_PER_KPI = 32` (`TooManyTiers(kpiIndex, provided, max)`).
- Non-empty, unless the KPI is `aggregate` (`EmptyTiers(kpiIndex)`).

**Tiers are per-promoter, per-KPI.** Each promoter walks their own ladder as their own attributed
progress accumulates. That resolves an ambiguity in aggregate-threshold designs — if a campaign-wide
threshold is crossed, who gets paid? — and matches how performance deals actually work. It also bounds
the settlement loop by the number of *tiers*, not the number of promoters.

**All ladders draw from one shared pool, first-come.** There is no per-promoter allocation and no
reservation. Two promoters crossing the same tier both get paid until the pool runs out.

## Reporting

```solidity
function reportUserAction(uint256 kpiIndex, address user, uint256 newTotal, bytes calldata evidence)
```

`nonReentrant`. Callable by `project` or `oracleCoordinator`.

**`newTotal` is cumulative per `(user, kpiIndex)`, not a delta.** This is the central anti-fake-
conversion property of the reporting path: the contract credits only `verifiedTotal - alreadyCredited`,
so a replayed report is a no-op rather than an inflation vector. It also makes the off-chain reporters
idempotent — losing an indexer cursor costs a rescan, not double-crediting.

### The exact order

| # | Step | Failure |
|---|---|---|
| 1 | Status is reportable: `Active`, or `Ended` within `CLAIM_GRACE` | `WrongStatus(status)` |
| 2 | Caller is `project` or `oracleCoordinator` | `NotReporter` |
| 3 | `kpiIndex < kpiCount` | `UnknownKpi(kpiIndex)` |
| 4 | `user != address(0)` | `ZeroAddress` |
| 5 | Inside `[startTime, endTime]` — **skipped once `Ended`** | `OutsideWindow(startTime, endTime)` |
| 6 | KPI is not `aggregate` | `AggregateKpi(kpiIndex)` |
| 7 | `newTotal >= _userCredited[user][kpiIndex]` | `NonMonotonic(already, newTotal)` |
| 8 | `newTotal == already` → **return, no-op** (idempotent replay) | — |
| 9 | **Evidence-free only:** attribution resolves, and one promoter held the user for the whole span | `NoAttribution(user)`, `AmbiguousAttribution(user, kpiIndex)` |
| 10 | If `spec.verifier != 0`: `verifiedTotal = verify(...)`, and `verifiedTotal <= newTotal` | `VerifierOvercredit(credited, max)` |
| 11 | `verifiedTotal > already`, else **return, no-op** | — |
| 12 | Credit — one promoter, or per-action segments | `TooManyActions(provided, max)`, `UnorderedEvidence(index)` |
| 13 | `_settle` for every promoter credited — inline | — |
| 14 | `_lastReportBlock[user][kpiIndex] = block.number` | — |

Step 12 is the fork. With no evidence, the whole delta goes to the single promoter step 9 resolved and
`_userCredited` advances to `verifiedTotal`. With evidence, `_creditSegments` splits it across the
promoters who held the user at each action's block, and `_userCredited` advances only by what actually
landed. [Chapter 04](./04-attribution.md#per-action-attribution) has the walk.

Four things to note about the ordering:

**Attribution is resolved before the verifier runs** on the evidence-free path. An unattributed action
has no payee, so there is nothing to verify. On the evidence path the order is reversed — the verifier
sets the ceiling first, and the tally then distributes what fits.

**Ambiguity is refused, not guessed.** An evidence-free report over a span in which the user changed
promoters reverts `AmbiguousAttribution`. Resending the same report *with* evidence is the fix.

**A verifier that discounts leaves the difference reportable.** Neither `_userCredited` nor `_creditedTo`
advances for the uncredited portion, so the reporter can retry later with better evidence rather than
permanently burning the difference. Step 11's early return means a report that verifies to nothing is a
no-op, not a revert — so it can simply be resubmitted.

**Step 14 closes the span, so it runs on both paths.** It is what a later evidence-free report is
checked over, and it is zero until the first report — which means the first evidence-free report on a
`(user, kpi)` pair requires the user's *entire* touch history to name one promoter.

### Accounting

Seven mappings, all private with accessors:

| Mapping | Meaning |
|---|---|
| `_userCredited[user][kpiIndex]` | Cumulative amount credited for this user across every promoter. The replay guard, and the bound on `newTotal`. `userCreditedOf` |
| `_creditedTo[user][kpiIndex][promoterId]` | The same, split per promoter. A high-water mark, so re-sent evidence credits nothing. `creditedToOf` |
| `_progress[promoter][kpiIndex]` | Cumulative attributed progress for a promoter. What the tier ladder is walked against. `progressOf` |
| `_settledTiers[promoter][kpiIndex]` | Tiers already paid — also the next tier index. `settledTiersOf` |
| `_lastReportBlock[user][kpiIndex]` | Block the last report closed at, the span `soleAttributionSince` is asked about. `lastReportBlockOf` |
| `_totalProgress[kpiIndex]` | Campaign-level total. `totalProgress` |
| `_promoterOf` / `_promoterIdOf` | The id↔wallet pair, both directions |

`_userCredited` and `_creditedTo` are not redundant: the first bounds what a report may claim for a
wallet, the second decides what each promoter earns from it. A referral who re-signed under a second
promoter carries one `_userCredited` figure and two `_creditedTo` entries.

`_totalProgress` behaves differently for the two report kinds, which is worth knowing before building
a dashboard on it: per-user reports **add** the credited delta, while `applyAggregateUpdate`
**overwrites** it with the reported total. For a per-user KPI it is the sum of all credited progress;
for an aggregate KPI it is the oracle's latest figure.

## Settlement

Settlement is **inline**. `_settle` runs at the end of every crediting report, once per promoter the
report credited:

```solidity
ladder   = _tiers[kpiIndex]
progress = _progress[promoter][kpiIndex]
next     = _settledTiers[promoter][kpiIndex]

while (next < ladder.length && progress >= ladder[next].threshold) {
    reward    = ladder[next].reward
    remaining = rewardPool - paidOut
    tierPay   = min(reward, remaining)

    _settledTiers[promoter][kpiIndex] = next + 1      // marked settled either way

    if (tierPay != 0) {
        paidOut += tierPay
        escrowVault.release(promoter, tierPay)        // emits Released
    }
    emit TierSettled(promoterId, promoter, kpiIndex, next, tierPay)
    if (tierPay < reward) emit PoolExhausted(reward - tierPay)

    ++next
}
```

One report can cross several tiers, emitting one `TierSettled` each — and with evidence spanning a
promoter switch, it can pay more than one promoter in a single transaction.

### There is no claim step

`Campaign.settle(promoter, kpiIndex)` is public and permissionless, and `Boney.claimRewards` routes to
it — but by the time anyone calls either, `_settledTiers` is already caught up and the ladder walk pays
zero. **The public entry point is correct and dormant by construction.** A UI's claim button has
nothing to do in any reachable state; it exists for a hypothetical where a report credited progress
without settling, which the code does not produce.

`settle` checks `kpiIndex` first (`UnknownKpi`), reverts `NotJoined` for a wallet that never joined, and
its status guard mirrors `_requireReportableStatus` exactly (`Active`, or `Ended` within `CLAIM_GRACE`).

### Pool exhaustion never reverts

When the pool cannot cover a crossed tier, the contract pays `min(reward, remaining)`, **marks the tier
settled anyway**, and emits `PoolExhausted(shortfall)`.

It does not revert, because reverting would let one exhausted tier block all further reporting for
every promoter in the campaign — a single over-earning promoter could freeze the campaign. Marking the
tier settled keeps the ladder advancing so the next report is not stuck retrying the same tier.

The consequence, stated plainly: **a promoter can be underpaid.** `PoolExhausted` is the signal, and
comparing `TierSettled.paid` against the tier's configured reward detects a partial payout. A project
sizing a pool below the sum of all reachable tiers across all promoters is choosing this outcome.

### `paidOut <= rewardPool` holds by construction

`tierPay` is clamped to `rewardPool - paidOut` on every iteration, and `paidOut` only ever increases by
`tierPay`. `remainingPool()` exposes the difference. Fuzz-tested in `test/Campaign.t.sol`.

## Aggregate updates

```solidity
function applyAggregateUpdate(uint256 kpiIndex, uint256 newTotal) external onlyActive
```

| Check | Failure |
|---|---|
| `status == Active` | `WrongStatus(status)` |
| `msg.sender == oracleCoordinator` | `NotOracle` |
| `kpiIndex < kpiCount` | `UnknownKpi(kpiIndex)` |
| KPI is `aggregate` | `NotAggregateKpi(kpiIndex)` |
| Inside `[startTime, endTime]` | `OutsideWindow(startTime, endTime)` |
| `newTotal >= _totalProgress[kpiIndex]` | `NonMonotonic(current, newTotal)` |

Emits `AggregateProgress(kpiIndex, total)`. No payout, no attribution, no verifier, no evidence. Note
this path is strictly `Active` — unlike per-user reports, it does **not** stay open during the claim
grace window, because nothing about it can pay anyone.

## Escrow return

```solidity
function reclaimUnspent() external nonReentrant onlyProject
```

| Status | Rule |
|---|---|
| `Cancelled` | Immediate. Nobody earned anything |
| `Ended` | Only when `block.timestamp > endedAt + CLAIM_GRACE`, else `ClaimWindowOpen(until)` |
| anything else | `WrongStatus(status)` |

Reclaims the vault's full remaining balance for the campaign, reverting `NothingToReclaim` at zero, and
emits `Reclaimed(project, amount)`. Always to `project` — there is no recipient parameter.

## Events emitted by a campaign

| Event | When |
|---|---|
| `Activated(startTime, endTime)` | The pool is fully escrowed and reporting opens |
| `StatusChanged(previous, current)` | Every status transition |
| `PromoterJoined(promoter, promoterId, reputation)` | A promoter clears the gate and joins |
| `ProgressCredited(kpiIndex, promoterId, user, amount)` | Progress credited to one promoter by one report — several per report when evidence spans a switch |
| `AggregateProgress(kpiIndex, total)` | A campaign-level total moves |
| `TierSettled(promoterId, promoter, kpiIndex, tier, paid)` | Per tier crossed |
| `PoolExhausted(shortfall)` | Earned rewards exceeded the remaining pool |
| `Reclaimed(to, amount)` | Unspent escrow returned to the project |
