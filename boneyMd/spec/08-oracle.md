# 08 — Oracle layer

One contract. `OracleCoordinator` is staked, optimistic reporting: a reporter posts native-token
collateral, submits a report, and the report lands only after a dispute window passes unchallenged.
A successful dispute slashes the reporter's whole stake and voids the report permanently.

It is the only path into a campaign that does not require the project's key, which makes it the load-bearing
half of the withholding protection described in [chapter 03](./03-lifecycle.md#what-the-grace-window-is-for).
It is also entirely unused by the running system — nothing off chain calls it, and the fixtures never
stake a reporter. Both facts matter, and this chapter states them in that order.

## Why it exists

Two jobs, and the second is the one that changed the protocol's shape.

**1. Aggregate KPIs have no per-user proof.** TVL and volume are campaign-level quantities. Nobody can
attribute them to a wallet, so no per-user reporting path can carry them. `Campaign.applyAggregateUpdate`
is `oracleCoordinator`-only, so those numbers arrive through this contract or they do not arrive at all.
Aggregate progress credits nobody and pays nobody — see [chapter 05](./05-kpi-model.md).

**2. Promoters must be payable without the project's cooperation.** `reportUserAction` admits exactly two
callers, `project` and `oracleCoordinator`. If the second of those cannot reach it, the project key is the
**only** account in the system that can pay anyone. That makes an absent project indistinguishable from a
hostile one, and both indistinguishable from a campaign whose promoters genuinely earned nothing: stop
reporting a week before `endTime` and the escrow comes back in full.

That is not hypothetical. Before `submitUserReport` existed, `OracleCoordinator` reached only
`applyAggregateUpdate`, which reverts `NotAggregateKpi` on a per-user KPI — so the `oracleCoordinator`
branch of `reportUserAction`'s authorization check was dead code, and a fully staked honest reporter could
not pay a promoter a single token. `test_AggregateReportStillRejectsPerUserKpi` in
`test/ReportWithholding.t.sol` pins that revert as still-correct behaviour for the aggregate entry point,
precisely so the two paths are never conflated again.

`submitUserReport` → `applyUserReport` closes it. The campaign resolves attribution, credits the promoter,
and settles every crossed tier inline, so **one permissionless call turns an unreported action into tokens
in a promoter's wallet.** `test_PromoterRecoversRewardsWithoutTheProject` walks the whole recovery: the
promoter ends the campaign themselves once its window closes (`end()` is permissionless past `endTime`),
stakes as a reporter, files the report, waits out the dispute window, and applies it. The project signs
nothing at any point.

## Collateral

Collateral is the chain's **native token**, not the campaign's ERC20 and not a protocol token.

```solidity
function stake()   external payable    // partial deposits accumulate
function unstake() external nonReentrant  // withdraws the caller's entire stake, or nothing
```

- `minStake` is immutable, set at deployment from `BONEY_MIN_STAKE` (default 100 ether).
- Eligibility is checked at **submission** — `if (_stake[msg.sender] < minStake) revert NotAReporter` — not
  at deposit. A reporter can top up across several transactions and become eligible on the last one, which
  `test_Stake_topUpReachesMinimum` pins. Below the minimum, stake confers nothing.
- `stake()` reverts `NothingStaked()` on zero value, so an accidental empty call is not silently accepted
  as a deposit that emitted an event for nothing.
- `unstake()` is all-or-nothing. There is no partial withdrawal, and no way to reduce stake to just above
  `minStake` while a report is in flight.

Both withdrawal paths — `unstake` and `withdrawSlashPool` — are `nonReentrant`, zero the balance before
sending, and use a raw `.call` with an explicit `TransferFailed()` on failure rather than `transfer`. The
raw call is deliberate: a governor treasury that is a contract with a non-trivial `receive` would fail
under `transfer`'s 2300-gas stipend.

### The lock, and why every submission extends it

```solidity
uint256 lockUntil = block.timestamp + disputeWindow + unstakeDelay;
if (lockUntil > stakeLockedUntil[msg.sender]) stakeLockedUntil[msg.sender] = lockUntil;
```

`unstake` reverts `StakeLocked(until)` while `block.timestamp < stakeLockedUntil[msg.sender]`.

The lock covers `disputeWindow + unstakeDelay`, not just `disputeWindow`, and it only ever moves forward.
Without it a reporter could file a false report and withdraw in the same block, leaving the governor a
dispute that slashes an empty balance — the report would still be voided, but the fraud would be free.
With it, collateral stays slashable until every report the reporter has filed has passed its window, plus
a cooldown. `test_Unstake_blockedWhileReportInFlight` and `test_Unstake_allowedAfterLockExpires` hold both
sides.

The `max` rather than an unconditional assignment matters for a reporter filing reports out of order in
time — a later submission never *shortens* the lock a previous one established.

### The contract holds nothing else

There is no `receive` and no `fallback`, so the only way ether enters is `stake()`. The invariant is
therefore simple enough to check by eye:

```
address(this).balance  ==  Σ stakeOf(reporter)  +  slashPool
```

Nothing in the contract depends on that identity, so a forced balance increase (`selfdestruct` from a
pre-`Cancun` contract, or a coinbase payout) is inert rather than dangerous. It would simply strand ether
that no function can move.

## Submitting

Two entry points over one shared path.

```solidity
struct Report     { address campaign; uint256 kpiIndex; uint256 amount;    bytes evidence; }
struct UserReport { address campaign; uint256 kpiIndex; address user; uint256 newTotal; bytes evidence; }

submitReport(Report)         returns (bytes32 reportId)   // → Campaign.applyAggregateUpdate
submitUserReport(UserReport) returns (bytes32 reportId)   // → Campaign.reportUserAction
```

`submitUserReport` rejects `user == address(0)` with `ZeroAddress()`, because `address(0)` is exactly what
marks a stored report as an aggregate. Admitting one would store a per-user submission that could only ever
be applied through the aggregate branch — `test_UserReportRejectsZeroUser` pins the rejection.

Shared checks, in order:

| Check | Failure |
|---|---|
| `_stake[msg.sender] >= minStake` | `NotAReporter(who)` |
| The registry is wired | `RegistryNotSet()` |
| `campaignRegistry.isCampaign(campaign)` | `UnknownCampaign(campaign)` |
| The derived id is unused | `ReportAlreadyExists(reportId)` |

The registry check is what stops a reporter naming an arbitrary address and having the coordinator call it.
`test_Submit_revertsBeforeRegistrySet` and `test_Submit_revertsUnknownCampaign` cover the two ways that
fails.

### The two entry points are not symmetric

`submitReport` silently discards `Report.evidence`:

```solidity
function submitReport(Report calldata report) external returns (bytes32 reportId) {
    return _record(report.campaign, report.kpiIndex, report.amount, address(0), "");
}
```

The field exists in the struct, and the interface documents it as "opaque reference to the evidence behind
the report", but `_record` is handed `""`. That is not a bug in the apply path — `applyAggregateUpdate`
takes no evidence parameter and no verifier ever sees an aggregate report — but it does mean a caller who
attaches an evidence hash to an aggregate report has recorded nothing on chain. The value is not stored, not
hashed into the id, and not emitted.

`submitUserReport` does forward `report.evidence`, and it has to: the stored bytes become the `evidence`
argument to `reportUserAction`, which is where per-action attribution segmentation happens. A user report
with well-formed `Action[]` evidence splits credit across the promoters who held the user at each action's
block; one without evidence falls back to whoever holds attribution now, and is refused with
`AmbiguousAttribution` if more than one promoter held them since the last report. See
[chapter 04](./04-attribution.md) for the resolver and [chapter 06](./06-verification.md) for what a
verifier does with the same bytes.

### Report ids

```solidity
uint256 seq = _sequence[msg.sender]++;
reportId    = keccak256(abi.encode(msg.sender, campaign, kpiIndex, amount, user, seq));
```

Keyed by content **plus the reporter plus a per-reporter sequence number**, which buys three properties:

- **Two reporters can make the same claim independently** and neither overwrites the other. Both reports
  exist, both have their own deadline, and either can be applied — the campaign's own monotonicity check
  makes the second a no-op rather than a double credit. `test_Submit_independentReportersDontCollide` and
  `testFuzz_ApplyIsMonotonicAcrossReporters` pin the pair.
- **One reporter can file the same claim twice.** A resubmission after a dispute is a fresh report with a
  fresh id, so a voided report is not a permanent ban on that exact claim.
- **Aggregate and per-user ids are disjoint**, because `user` is folded into the preimage. A report can
  never be replayed through the other kind's entry point, which
  `test_ReportKindsAreNotInterchangeable` holds.

`ReportAlreadyExists` is the guard behind all of that, and given the sequence increment it is
**unreachable**: for a fixed reporter every submission uses a distinct `seq`, and across reporters the
preimage differs in `msg.sender`. Reaching it requires a keccak256 collision. It is worth keeping as a
belt-and-braces check on any future change to the id derivation, but no test can trigger it and no client
should surface it — `web/src/lib/txErrors.ts` has a message for it that will never render.

### Stored state

```solidity
struct ReportState {
    address reporter;   // address(0) ⇒ no such report. The existence discriminator
    address campaign;
    uint256 kpiIndex;
    uint256 amount;     // campaign-level total, or the (user, kpi) cumulative total
    uint64  deadline;   // block.timestamp + disputeWindow
    bool    disputed;
    bool    applied;
    address user;       // address(0) ⇒ aggregate. The kind discriminator
    bytes   evidence;   // forwarded to reportUserAction; always empty for aggregates
}
```

Two zero-address discriminators doing two different jobs: `reporter` distinguishes a stored report from an
empty slot, `user` distinguishes the two kinds. Both are read on every apply.

`amount` is a **cumulative total, not a delta**, in both directions — the campaign-wide figure for an
aggregate KPI, the `(user, kpiIndex)` figure for a per-user one. A reporter who thinks in deltas will file
a total that the campaign rejects with `NonMonotonic` or accepts as an idempotent no-op.

`deadline` is an unchecked `uint64` downcast of `block.timestamp + disputeWindow`. With a sane
`disputeWindow` that cannot wrap this side of the year 584 billion, but it is a downcast rather than a
`SafeCast`, so a coordinator deployed with an absurd window would silently store a deadline in the past.

Submission emits `ReportSubmitted(reportId, campaign, reporter, deadline)`. **The report is not applied.**

## Applying

```solidity
applyReport(bytes32 reportId)      // aggregate only — NotAggregateReport for a user report
applyUserReport(bytes32 reportId)  // user only     — NotUserReport for an aggregate
```

Both `nonReentrant`. Both **permissionless once the window closes** — anyone at all can push a good report
through, which is the property the whole withholding fix rests on. The kind check runs first, then the
shared guard:

| Check | Failure |
|---|---|
| `r.reporter != address(0)` | `UnknownReport(reportId)` |
| `!r.disputed` | `ReportIsDisputed(reportId)` |
| `!r.applied` | `ReportAlreadyApplied(reportId)` |
| `block.timestamp >= r.deadline` | `DisputeWindowOpen(deadline)` |

Then, and only then, the external call: `applyAggregateUpdate(kpiIndex, amount)` or
`reportUserAction(kpiIndex, user, amount, evidence)`, followed by `ReportApplied(reportId, campaign)`.

### `applied` is set before the external call

```solidity
if (block.timestamp < r.deadline) revert DisputeWindowOpen(r.deadline);
r.applied = true;
```

`_clearForApply` writes the flag, then the caller makes the campaign call. Together with `nonReentrant`
that is belt and braces: a campaign that re-entered would find the flag already set even if the guard were
removed.

Note carefully what this does *not* protect against. If the campaign call reverts — paused, past the grace
window, verifier rejected the claim — the whole transaction reverts and the flag is never persisted. The
ordering defends against re-entrancy, not against a failed apply. A report the campaign rejects can be
retried later or resubmitted as a new one; only a *successful* apply is permanent.

### The asymmetry the campaign imposes

The two apply paths do not have the same reach, and the difference comes entirely from the campaign side:

| | `applyReport` → `applyAggregateUpdate` | `applyUserReport` → `reportUserAction` |
|---|---|---|
| Status gate | `onlyActive` | Active, **or Ended within `CLAIM_GRACE`** |
| Window gate | `_requireWindow()` — inside `[startTime, endTime]` | `_requireReportWindow()` — skipped once Ended |
| KPI gate | must be `aggregate` | must **not** be `aggregate` |
| Credits a promoter | no | yes, and settles crossed tiers inline |

So an aggregate report cannot land after the campaign ends, and a per-user one can. That is the right way
round — the grace window exists to let withheld *payments* through, and aggregate progress pays nobody —
but it means an aggregate report submitted close to `endTime` can pass its dispute window and then be
permanently unappliable. Nothing warns the reporter; `applyReport` simply reverts `WrongStatus` forever.

## Disputing

```solidity
function disputeReport(bytes32 reportId) external onlyOwner
```

The **governor** only, and only while the window is open:

| Check | Failure |
|---|---|
| `r.reporter != address(0)` | `UnknownReport(reportId)` |
| `!r.applied` | `ReportAlreadyApplied(reportId)` |
| `block.timestamp < r.deadline` | `DisputeWindowClosed(deadline)` |

Effects: `disputed` is set permanently, the reporter's **entire** stake moves to `slashPool`, and two events
fire — `ReporterSlashed(reporter, slashed)` then `ReportDisputed(reportId, campaign, disputer)`.

A disputed report can never be applied, in any state, forever. There is no un-dispute, no appeal, and no
partial slash: `test_Dispute_slashesEvenWhenAmountBelowCurrent` pins that the slash takes whatever is
staked at dispute time, which may be more than was staked at submission if the reporter topped up in
between, and may be nothing at all if a previous dispute already emptied it.

`withdrawSlashPool(to)` sends the accumulated pool to a treasury address. Governor only, `nonReentrant`,
rejects `to == address(0)`, and reverts on an empty pool with **`NothingStaked()`** — the same error name
`stake()` and `unstake()` use for a different condition. A client decoding that revert cannot tell "you
staked nothing" from "the slash pool is empty" without knowing which function was called.

### Disputing the same report twice

`disputeReport` checks `applied` but **not `disputed`**. Re-disputing an already-disputed report therefore
succeeds: it re-emits both events, and slashes again whatever the reporter has staked at that moment. In
the ordinary case the second slash takes zero and `ReporterSlashed` is skipped by the `if (slashed != 0)`
guard, so the only trace is a duplicate `ReportDisputed`. But a reporter who re-staked after being slashed
— which they must do to keep reporting — can have that fresh stake taken again for a report already voided,
with no new finding of fault.

The window bounds the exposure: once `deadline` passes, `DisputeWindowClosed` shuts the path for good. A
reporter who re-stakes only after the deadline of every disputed report cannot be double-slashed. Nothing
tells them that, and nothing in the contract enforces it.

## Timing

| Constant | Set by | Protocol value | This branch |
|---|---|---|---|
| `minStake` | `BONEY_MIN_STAKE` env, default 100 ether | — | 100 ether |
| `disputeWindow` | `DeployBoney.DISPUTE_WINDOW` | 1 day | **4 minutes** |
| `unstakeDelay` | `DeployBoney.UNSTAKE_DELAY` | 2 days | **10 minutes** |

`[bscoretest]` — the two windows are shortened on this branch so a full submit-and-apply cycle can be
driven by hand. The full table, and the rest of the protocol's clocks, are in
[chapter 03](./03-lifecycle.md#time-constants).

All three are immutable constructor arguments. Changing any of them means redeploying the coordinator,
which means redeploying `CampaignRegistry` too, since the registry takes the coordinator's address at
construction and every campaign it has already created holds it as an immutable. See the deploy graph in
[chapter 02](./02-architecture.md).

### The constraint against `CLAIM_GRACE`

**`disputeWindow` must stay well inside `Campaign.CLAIM_GRACE`.**

A report pushed through the oracle after `end()` has to clear its dispute window *while the campaign is
still reportable*. If `disputeWindow` were the longer of the two, the apply would land past the grace
period, `reportUserAction` would revert `WrongStatus`, and the withholding protection would stop working
with no error anywhere pointing at the cause — the report simply becomes unappliable.

On this branch: 4 minutes inside 20 minutes. At protocol values: 1 day inside 7 days.
`test/ReportWithholding.t.sol` sets its own coordinator durations rather than reusing the deploy script's,
and says why in a comment: they are scaled off `CLAIM_GRACE` so that shortening the campaign constant for
testing cannot silently invert the pair.

## Views

| View | Returns |
|---|---|
| `reportState(id)` | The whole `ReportState`, including `evidence` |
| `reportDeadline(id)` | When the window closes. `0` for an unknown report |
| `reportDisputed(id)` / `reportApplied(id)` | The two terminal flags |
| `stakeOf(reporter)` | Current collateral, in wei |
| `isReporter(who)` | Whether `stakeOf(who) >= minStake` |
| `stakeLockedUntil(reporter)` | When stake unlocks. A public mapping, not a function |
| `slashPool` | Total slashed collateral held |
| `minStake` / `disputeWindow` / `unstakeDelay` | The three immutables |
| `campaignRegistry` / `campaignContract()` | The wired registry, under two names |

Two aliases worth knowing about. `campaignRegistry` is the public state variable; `campaignContract()` is
the interface's name for the same address, and exists because `IOracleCoordinator` predates the variable.
And every `report*` view returns a zero value for an id that does not exist, so `reportDeadline(id) == 0`
means "unknown" rather than "expired at the epoch" — use `reportState(id).reporter != address(0)` to test
existence.

## Wiring

`campaignRegistry` is **not immutable**, and that is forced by a cycle: the registry needs the
coordinator's address at *its* construction, and the coordinator needs the registry's. Something has to
give.

The coordinator gives. It is deployed second in `DeployBoney.s.sol`, before the registry, with no registry
of its own, and is wired exactly once afterwards:

```solidity
function setCampaignRegistry(address registry) external onlyOwner {
    if (registry == address(0)) revert ZeroAddress();
    if (address(campaignRegistry) != address(0)) revert RegistryAlreadySet();
    ...
}
```

Governor only, `RegistryAlreadySet()` on a second call, and until it is set every submission reverts
`RegistryNotSet()`. `test_SetCampaignRegistry_onlyOnce` pins the write-once property. The consequence for
operators is that a coordinator wired to the wrong registry is scrap — there is no rewire.

The constructor's own `if (governor == address(0)) revert ZeroAddress();` is **unreachable**. `Ownable`'s
constructor runs first and reverts `OwnableInvalidOwner(address(0))` on the same input, so a client should
expect that error rather than this one.

## Nothing off chain calls it

Worth stating plainly, because the previous sections describe a live-looking mechanism.

The web app carries `OracleCoordinatorAbi` (extracted by `pnpm abis`), an `oracleCoordinator` address per
chain in `chains.ts` and `deployments.ts`, and decoders for eight of its errors in `txErrors.ts`. That is
the whole of it: no hook reads it, no route renders it, no script writes to it. The three off-chain
processes in [chapter 09](./09-offchain.md) — the indexer, the relayer, `report-window` — all report
through the project key or the verifier's reporter key, not through the coordinator. `DeployBoney.s.sol`
deploys and wires it but never stakes anything, so on every fixture `isReporter` is false for every
account and `slashPool` is zero.

Which means the withholding protection is **available, tested, and unexercised**. A promoter who needed it
today would have to stake 100 native tokens and drive `cast` by hand — the recipe is in
[chapter 10](./10-integration.md#for-an-oracle-reporter). Nothing in the product surfaces it.

---

## Open, not settled

- **Dispute authority is the governor's alone.** Permissionless disputes with challenger bonds are the
  intended end state, and they change only *who may call* `disputeReport` — not this contract's shape. A
  passive or absent governor weakens the guarantee from "false reports get slashed" to "reports land after
  a delay", which is a considerably weaker claim than optimistic reporting usually implies.
- **No reward for honest reporting, and none for disputing.** The slash pool goes to the treasury, not to a
  challenger, so the incentive to dispute is extrinsic and the incentive to report is entirely extrinsic. A
  promoter recovering their own rewards is the only actor with a concrete reason to stake.
- **Slashing is total, not proportional.** A reporter who is wrong once by one unit loses the same stake as
  one who fabricated a campaign's worth of progress. Combined with the missing `disputed` check in
  `disputeReport`, a re-staked reporter can be slashed twice for the same voided report.
- **Nothing enumerates reports.** Ids are content-derived, so a submitter knows theirs and an observer
  reads `ReportSubmitted` logs. There is no `reportsOf(reporter)`, no count, and no way to ask a campaign
  what is pending against it — a governor who wants to dispute must already be watching the logs.
- **`Report.evidence` is accepted and discarded.** An aggregate reporter can attach an evidence hash and
  nothing records it. Either the field should be hashed into the id or it should be removed from the
  struct; today it is neither.
- **`NothingStaked` covers two unrelated conditions** — no stake to withdraw, and no slash pool to
  withdraw. `ZeroAddress` similarly covers a zero governor, a zero registry, a zero user and a zero
  treasury recipient. Both are decodable only with the calling function as context.
- **Aggregate reports have no grace window**, so one submitted near `endTime` may clear its dispute window
  into a campaign that will never accept it. Per-user reports are covered; this path is not.
