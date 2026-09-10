# 03 — Campaign lifecycle

## States

| # | Status        | Accepts                                                 | Notes                                                   |
| - | ------------- | ------------------------------------------------------- | ------------------------------------------------------- |
| 0 | `Pending`   | escrow deposits,`join()`                              | The state a campaign is born in. Cancellable            |
| 1 | `Active`    | reports, settlement, deposits,`join()`                | Reports additionally bounded by`[startTime, endTime]` |
| 2 | `Paused`    | deposits                                                | Reversible halt. Reporting and settlement both stop     |
| 3 | `Ended`     | reports and settlement for`CLAIM_GRACE`, then nothing | Terminal                                                |
| 4 | `Cancelled` | nothing                                                 | Terminal. Only reachable from`Pending`                |

Deposits are accepted in every state: escrow is
`EscrowVault.deposit(campaign, amount)`, which the campaign's status does not gate.

## Transitions

```
                    createCampaign
                          │
                          ▼
                     ┌─────────┐   cancel()  onlyProject, Pending only
                     │ Pending │──────────────────────────► Cancelled ──► reclaimUnspent()
                     └────┬────┘                                          (immediately)
      activate()          │  onlyProject · fully funded · before endTime
                          ▼
                     ┌─────────┐   pause()    ┌────────┐
                     │ Active  │─────────────►│ Paused │
                     │         │◄─────────────│        │
                     └────┬────┘  unpause()   └───┬────┘
                          │                       │
                          │   end()               │  end()
                          └──────────┬────────────┘
                                     ▼
                                ┌─────────┐
                                │  Ended  │  endedAt = block.timestamp
                                └────┬────┘
                                     │  reporting + settlement stay open for CLAIM_GRACE
                                     ▼
                             reclaimUnspent()  strictly after endedAt + CLAIM_GRACE
```

| Transition                 | Caller                                                                     | Preconditions                                                                    | Reverts                                                                         |
| -------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `→ Pending`             | anyone (via registry)                                                      | Name free, valid window, valid tiers, reachable gate                             | `NameTaken`, `InvalidWindow`, `EmptyTiers`, `UnreachableReputation`, … |
| `Pending → Active`      | `project`                                                                | `escrowVault.balanceOf(campaign) >= rewardPool`, `block.timestamp < endTime` | `NotProject`, `WrongStatus`, `NotFunded`, `OutsideWindow`               |
| `Pending → Cancelled`   | `project`                                                                | —                                                                               | `NotProject`, `WrongStatus`                                                 |
| `Active → Paused`       | `project`                                                                | —                                                                               | `NotProject`, `WrongStatus`                                                 |
| `Paused → Active`       | `project`                                                                | —                                                                               | `NotProject`, `WrongStatus`                                                 |
| `Active/Paused → Ended` | `project` any time, **anyone** once `block.timestamp >= endTime` | —                                                                               | `WrongStatus`, `OutsideWindow`                                              |

Every transition emits `StatusChanged(previous, current)`; activation additionally emits
`Activated(startTime, endTime)`. Both `end()` and `cancel()` stamp `endedAt`, which is what starts the
grace clock in one case and opens reclaim immediately in the other.

### Why each rule is the way it is

**`activate()` requires the full pool.** Promoters should never start working against a partially
funded campaign. 

The check is a vault balance read, not a transfer, so a project may deposit across as
many transactions as it likes.

**`activate()` does not require `startTime` to have passed.** A campaign can be `Active` before its
window opens; reports simply revert `OutsideWindow` until `startTime`. 

This is deliberate — activation is the project committing funds, and that should be possible ahead of launch. 

It does refuse a campaign whose `endTime` has already passed, since there would be no window left to report in.

**`cancel()` only from `Pending`.** Once active, promoters may have earned rewards, so cancellation
would be a rug. There is no "cancel with payouts" path.[will update]

**`end()` becomes permissionless after `endTime`.** Otherwise a project could refuse to end a finished
campaign, never start the claim grace clock, and keep the escrow parked indefinitely while promoters
who earned tiers could not be paid.[automated-reporting will solve this]

**`Paused` blocks reporting, and cannot be used to strand anyone.** Pausing halts crediting and
settlement, but because `end()` is permissionless once `endTime` passes, a parked campaign can always
be converted to an `Ended` one — which reopens reporting for the grace window. A project can delay
payment; it cannot prevent it.

**`Cancelled` reclaims immediately.** Nobody earned anything, so there is nothing to wait for.

## The time windows

A campaign carries four time values and one constant.

| Value                 | Type                 | Meaning                                                                                             |
| --------------------- | -------------------- | --------------------------------------------------------------------------------------------------- |
| `startTime`         | `uint64` immutable | Earliest timestamp a report is accepted                                                             |
| `endTime`           | `uint64` immutable | Latest timestamp a report is accepted while`Active`; also when `end()` opens to anyone          |
| `attributionWindow` | `uint64` immutable | How long a touch for this campaign may live. Floored by the registry's global cap                   |
| `endedAt`           | `uint64`           | Set by`end()` or `cancel()`. Zero until then. Starts the grace clock[include extend and top-up] |
| `CLAIM_GRACE`       | `uint64 constant`  | How long after`endedAt` reporting and settlement stay open                                        |

Construction rejects `endTime <= startTime`, `endTime <= block.timestamp`, and
`attributionWindow == 0`, all as `InvalidWindow`.

```
        startTime                         endTime      endedAt   +CLAIM_GRACE
            │                                │            │           │
────────────┼────────────────────────────────┼────────────┼───────────┼──────────►
            │                                │            │           │
 activate() │  reports accepted (Active)     │            │           │
   allowed  ├────────────────────────────────┤            │           │
   earlier  │                                │ end() open │           │
            │                                │  to anyone │           │
            │                    reports accepted (Ended) ├───────────┤
            │                                             │           │
            │                              reclaimUnspent() opens ────┼──►
            │                                                         │
     touches may be created  ───────────────────────────────►│  refused past endTime
                                                              or once terminal
```

### The complement invariant

**Reporting closes exactly where reclaim opens, and the two can never both be open.**

- `Campaign._requireReportableStatus` allows a report when `status == Active`, or when
  `status == Ended && block.timestamp <= endedAt + CLAIM_GRACE`.
- `Campaign.reclaimUnspent` requires `status == Cancelled`, or
  `status == Ended && block.timestamp > endedAt + CLAIM_GRACE`.

Those two conditions are exact complements at `endedAt + CLAIM_GRACE`. Escrow is therefore never
reclaimable while credit is still owed, and a report can never land against a pool the project has
already emptied. `settle()`'s guard mirrors `_requireReportableStatus` exactly, so crediting and paying
open and close together.

`_requireReportWindow` deliberately skips the `[startTime, endTime]` check once `Ended`: the grace
window already bounded the report, and `endedAt` is necessarily past `startTime`, so re-checking
`endTime` would reject every post-end report — defeating the grace window it sits next to.

### What the grace window is for

Two distinct jobs:

1. **Promoters can settle.** In practice the ladder is already settled inline, so this matters mainly
   for a tier crossed by a report that arrives late.
2. **Withheld reports can still land.** A project that simply stops reporting near the end would
   otherwise keep the escrow. During the grace window anyone can push a report through the
   `OracleCoordinator`, which credits the promoter and pays out. This is why the oracle's
   `DISPUTE_WINDOW` must stay **well inside** `CLAIM_GRACE`.

The grace window also relaxes attribution: once `Ended`, `Campaign._resolvePromoterId` honours the
stored touch even if it has expired. Touch TTLs are days and campaigns run for weeks, so without that
relaxation most withheld reports would revert `NoAttribution` and hand the project back exactly the
escrow the grace window exists to protect.

That relaxation is safe only because touch *creation* is bounded to the campaign's life — see [chapter 04](./04-attribution.md#the-post-end-fallback).

Note what the fallback is *for*: it is the resolver for a report carrying **no evidence**. A report
with evidence resolves each action against the touch history at that action's block, so the fallback
never runs — see [chapter 05](./05-kpi-model.md).

## Promoter membership

`join()` is allowed while `Pending` **and** `Active`, so promoters can prepare tracking links before
launch. It is not allowed once `Paused`, `Ended` or `Cancelled`.

- One join per wallet per campaign: a second call reverts `AlreadyJoined`.
- The reputation gate is read **once(per campaign ?)**, at join. A promoter whose score later decays keeps their
  membership. A gate of `0` skips the read entirely.
- `promoterId = keccak256(abi.encode(campaign, promoter))`, stored both ways, and registered in the
  attribution registry so user-signed touches naming it are accepted.
- `PromoterJoined(promoter, promoterId, reputation)` records the score at join time, precisely because
  the gate is only checked once.

There is no leave, and no way to remove a promoter. A joined promoter with no attributed users simply
earns nothing.

## Time constants

`bscoretest` shortens every time constant to make manual testing fast. **Restore the protocol values
before merging to main.** Each source constant carries a `[bscoretest]` comment recording its protocol
value.

| Constant                              | Where                                          | Protocol      | This branch                         |
| ------------------------------------- | ---------------------------------------------- | ------------- | ----------------------------------- |
| `CLAIM_GRACE`                       | `src/campaign/Campaign.sol`                  | 7 days        | **20 minutes**                |
| `DISPUTE_WINDOW`                    | `script/DeployBoney.s.sol`                   | 1 day         | **4 minutes**                 |
| `UNSTAKE_DELAY`                     | `script/DeployBoney.s.sol`                   | 2 days        | **10 minutes**                |
| `MAX_TOUCH_DURATION`                | `script/DeployBoney.s.sol`                   | 30 days       | 30 days (**unchanged**)       |
| `attributionWindow`                 | `SeedLocal`, `SeedGated`, `SeedEventKpi` | 7–14 days    | 30 minutes – 1 hour                |
| `attributionWindow`                 | every other seed                               | —            | equal to each campaign's own length |
| `ETHOS_MAX_AGE` / `REACH_MAX_AGE` | `SeedLocal`, `SeedDevRep`                  | 180 / 90 days | 180 / 90 days (**unchanged**) |

Three of those deserve their reasons stated, because the obvious change is wrong in each case.

**`MAX_TOUCH_DURATION` is deliberately not shortened.** will be extended to 360 days .

**The reputation freshness windows are not shortened.**

**Campaign `endTime` is a per-fixture choice, not a constant.**

### Two ordering constraints

- **`DISPUTE_WINDOW` must stay well inside `CLAIM_GRACE`.** See the grace-window note above.
  `test/ReportWithholding.t.sol` sets its own coordinator durations for this reason.
- **`MAX_TOUCH_DURATION` must be at least the `attributionWindow` any seed script uses**, or seeding
  reverts `TouchTooLong`.

## Shape limits

Bounded at construction so no payout path can exceed the block gas limit; bricking payouts for
promoters who already did the work.

| Limit                                    | Value | Why                                                                                                              |
| ---------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------- |
| `Campaign.MAX_KPIS`                    | 32    | `kpiCount` bounds nothing at runtime, but a huge KPI set makes campaign construction and enumeration expensive |
| `Campaign.MAX_TIERS_PER_KPI`           | 32    | `_settle` walks the ladder in one pass; an unbounded ladder could exceed gas                                   |
| `Campaign.MAX_EVIDENCE_ACTIONS`        | 256   | One report decodes and segments every action it carries. Exceeding it is`TooManyActions(provided, max)`        |
| `Names.MAX_NAME_BYTES`                 | 32    | —                                                                                                               |
| `ReputationRegistry.MAX_SCHEMAS`       | 64    | `scoreOf` iterates every schema and is called from `join()`                                                  |
| `AttestationVerifier.MAX_ATTESTATIONS` | 16    | Bounds the O(n²) distinct-signer scan                                                                           |

Evidence is also required to arrive in ascending block order (`UnorderedEvidence(index)`), so the
segmentation walk is a single pass rather than a sort.

Construction also requires at least one KPI (`NoKpis`), no more than `MAX_KPIS` (`TooManyKpis`),


`tiers.length == kpis.length` (`TierLengthMismatch`), non-zero rewards (`ZeroTierReward`), 

strictly ascending thresholds (`TiersNotAscending`), 

a non-zero reward pool (`ZeroRewardPool`), 

a non-zero project, token and module address (`ZeroAddress`), 

a verifier on every `Custom` KPI (`CustomKpiNeedsVerifier`), 

a gate no higher than `ReputationRegistry.maxScore()`(`UnreachableReputation`), 

and at least one tier on every non-aggregate KPI (`EmptyTiers`). 

Aggregate KPIs may carry no tiers, since they pay nobody.
