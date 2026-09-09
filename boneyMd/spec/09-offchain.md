# 09 — The off-chain stack

Nothing on chain can read historical event logs, so every KPI number originates off chain. This chapter
describes the processes that produce those numbers, and the one operational rule that ties them together.

Four things run outside the contracts, and they are not interchangeable:

|                   | What it is                        | Writes to                                                               |
| ----------------- | --------------------------------- | ----------------------------------------------------------------------- |
| `pnpm index`    | the project's indexer             | `Campaign.reportUserAction`                                           |
| `pnpm relay`    | Boney's KPI relayer               | `EventMetricKpiVerifier.reportBatch`                                  |
| `boney-indexer` | a Graph subgraph for Base Sepolia | nothing — it is the app's read-only enumeration[should retire indexer] |
| `web/`          | the Next app                      | wallet transactions only                                                |

## Two roles, deliberately separate

|                       | Claims                        | Runs as                  | Command        | Writes to                              |
| --------------------- | ----------------------------- | ------------------------ | -------------- | -------------------------------------- |
| **The project** | "Alice made 2 deposits"       | `PRIVATE_KEY`          | `pnpm index` | `Campaign.reportUserAction`          |
| **Boney**       | "we independently observed 2" | `REPORTER_PRIVATE_KEY` | `pnpm relay` | `EventMetricKpiVerifier.reportBatch` |

On a **gated** KPI a claim is credited at the **smaller of the two**. One process doing both, with one
key, would make the cap a formality. 

On an ungated KPI (`verifier == address(0)`) there is no ceiling and the campaign credits the reported figure as-is, which is why relaying one is pointless.

> **Both must run, on a gated KPI.** The indexer alone leaves every progress bar at zero, because a claim
> capped against an unreported observed total credits nothing — and it does not revert, it *succeeds* and
> credits nothing, with nothing to surface it. The relayer alone credits nothing either, because nobody is
> claiming.
>

---

## `pnpm index` — the project's indexer

`web/scripts/indexer.ts`, with all the logic that can be *wrong* in `web/src/lib/indexerCore.ts` where
fixture logs prove it. The script itself is RPC pagination, key handling, and transaction sending.

```bash
pnpm index [--rpc <url>] [--campaign <address>] [--from-block N] [--dry-run]
```

**What it does, per campaign per KPI:**

1. Reads `Boney.browseCampaigns(0, 1000)`, then each campaign's `status`, window, `project`, `kpiCount`.
   Addresses come from the Foundry broadcast receipt (`readBroadcast`), not `lib/deployments.ts`, which
   can lag a redeploy.
2. Decodes `KpiSpec.params` as an event source (`lib/kpiSource.ts`). **A KPI whose params are not an
   event-source blob is skipped entirely** — which is why running this against a live chain cannot
   disturb campaigns seeded before the feature existed.
3. Runs pre-flight checks that mirror the contract's own guards, so a skip prints a reason instead of
   burning gas on a revert: not `Active` → `WrongStatus`; outside the window → `OutsideWindow`;
   `aggregate` → `AggregateKpi`; signer is not the `project` → `NotReporter`.
4. Scans `TouchStored` for the campaign and builds per-user attribution windows
   (`lib/attributionWindows.ts`), the off-chain mirror of `AttributionRegistry.promoterAt`. This comes
   *before* the activity scan, because it decides where that scan starts, and it is resolved **once per
   campaign** — lazily, so a campaign with no event-sourced KPI never pays for it.
5. Fetches matching logs in `MAX_LOG_RANGE = 2000`-block chunks, from one block after the campaign's
   earliest touch to the head, narrowed node-side by `topic0` and any fixed-topic filter.
6. Resolves a timestamp for every block holding a matched log — **off the logs themselves** where the
   node supplies one, from a cache shared with the relayer where an earlier pass already paid for it, and
   only otherwise by reading the block. See *What a pass costs* below.
7. `aggregateByActor` extracts the acting wallet from the configured actor topic, re-applies the topic
   filter, drops any action nobody held attribution for at that action's own block, applies `scale`, and
   folds per user. Referrals seen acting who were never attributed at all are printed rather than dropped
   in silence — losing that line would make a busy source look quiet.
8. Per user, reads `userCreditedOf`, then `decideReport` decides whether the report is worth sending at
   all. The *live* touch is deliberately not consulted — a report can pay a promoter whose touch has
   since been superseded.
9. Builds evidence: `encodeActions(foldToLimit(actions, MAX_EVIDENCE_ACTIONS = 256))`, for **every** KPI.
   `Campaign` decodes `Types.Action[]` itself to credit each action to whoever held the referral at that
   action's block, so omitting it for an unverified KPI would fall back to crediting whoever holds the
   touch now.
10. Sends `reportUserAction(kpiIndex, user, newTotal, evidence)`.

**Two properties worth stating plainly:**

- **It cannot credit strangers.** Every action is resolved against who held that wallet at the action's
  own block, and a touch needs the user's own EIP-712 signature. Indexing all traffic on a contract and
  crediting it is not a thing this can do, by construction.
- **Reports are cumulative and idempotent.** `newTotal` is a running total, so a re-run over the same
  range decides to send nothing. Rescanning costs RPC calls, not double-crediting.

**No cursor — the range is bounded by attribution instead.** `.indexer-state.json` was removed once
crediting became per-action: a resumed range produces a *window-scoped* total, which `Campaign` compares
against the lifetime watermark `_userCredited[user][kpiIndex]` and silently ignores. What replaces it is a
floor that can only exclude blocks nothing could ever have been credited for:

| Scan            | Starts at                                                  | Why nothing earlier matters                                                                                                                                           |
| --------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| activity        | one block after the campaign's earliest`TouchStored`     | a window covers actions*strictly after* its own block, so nothing at or before the first touch is creditable to anybody. No touch at all → the campaign is skipped |
| `TouchStored` | `startTime - effectiveMaxDuration(campaign)`, as a block | a touch expires at most`effectiveMaxDuration` after it is stored, and activity before `startTime` credits nobody                                                  |

`--from-block` overrides the activity floor as given, including on a campaign with no touches.
`lib/blockSearch.ts` does the timestamp→block conversion, with a probe cache shared across campaigns
because they all search the same `[deploymentBlock, head]` interval; `pnpm report-window` uses the same
search.

Neither bound replaces per-action resolution. Inside the range every action is still resolved against its
own user's windows, so a user first touched late in a long campaign is floored there rather than at the
scan's start.

### What a pass costs

A pass covers every event-sourced KPI on every campaign, and two economies are what make that finish at
all. Both were added 2026-09-02, both are measured on Base Sepolia, and both are shared with the relayer.

**Block timestamps come off the logs.** Attribution resolves at each action's own block, so every decoded
log needs its block's timestamp — and one `eth_getBlockByNumber` per block does not scale: 10 KPIs over 4
campaigns wanted 231,620 block timestamps summed, which at the ~42 blocks/s that twelve concurrent reads
managed is over 90 minutes of block reads on top of the log scans. A public endpoint's limiter ends the
pass long before that. `eth_getLogs` already answers the question: geth-family nodes put `blockTimestamp`
on every log and viem passes it through as a bigint, so `blockTimestamps.harvestLogTimestamps` takes it
from the response the scan already paid for. Over 904 blocks the log-carried value equalled
`eth_getBlockByNumber().timestamp` on every one, so this is not an approximation. Every KPI now reports
`0 timestamp read(s) needed`.

The block read remains as the fallback for nodes that omit the field — **anvil among them** — deduplicated
against the cache, packed `RPC_BATCH_SIZE = 100` calls to a JSON-RPC request and dispatched
`READ_CONCURRENCY = 300` blocks at a time. On the same endpoint that fallback runs at ~319 blocks/s
against ~42 for one request per call: the limiter counts requests, not calls.

**The cache outlives the process.** `scripts/timestampCache.ts` keeps one
`web/.cache/block-timestamps-<chainId>.json` that the indexer and the relayer both read and write — a
block's timestamp is the same fact whoever asked for it, and the relayer is one invocation per KPI, so an
in-memory cache would be discarded between passes whose ranges almost entirely overlap. Keyed by chain id,
capped at 150,000 entries with the lowest blocks dropped first, and written to a temp file then renamed
over the target, because `dev-up.sh` runs a relay loop and an indexer pass concurrently and a half-written
file reads back as an empty cache. A cached timestamp is wrong only if its block was reorged out, which is
the assumption the relayer's monotonic checkpoint already rests on. The indexer writes the file after each
fresh scan and once more at the end of the pass, since the last thing to gather timestamps need not be a
scan: a campaign whose touches were never stored costs a block search and then skips every KPI.

**Two KPIs naming the same event share one scan.** `logScanKey` keys an `eth_getLogs` sweep on what the
request actually carries — address, `topic0`, the indexed-topic filter, and the block range. `actorTopic`,
`amountMode` and `scale` are deliberately absent: they change how `aggregateByActor` reads the logs
afterwards, not which logs the node returns. On the current fixture that collapses 10 event-sourced KPIs
to 8 distinct scans, about 130 of ~570 chunk requests. The memo is scoped to the **campaign**, not the
run, because the activity floor is per-campaign and because holding several scans' logs at once is already
the pass's largest allocation.

### The event-source commitment in `params`

```
abi.encode(
    address source,      // contract whose logs credit this KPI
    bytes32 topic0,      // keccak of the event signature
    uint8   actorTopic,  // 1..3 — which indexed topic carries the acting wallet
    uint8   amountMode,  // 0 = count each log as 1, 1 = decode the first data word
    uint256 scale        // divisor. 0 reads as 1
)
```

160 bytes, five separate words rather than a packed struct — `abi.encode` pads to 32 bytes regardless, so
packing would buy nothing and cost the ability to read one field with `decodeAbiParameters` alone.

A source may also **pin one topic to a literal**, which appends two words for 224 bytes total:

```
    uint8   filterTopic,  // 1..3, or 0 for no filter — never equal to actorTopic
    bytes32 filterValue   // the raw word topics[filterTopic] must equal
```

The extension is strict, so the first five words decode identically either way and every blob written
before the filter existed still decodes; `filterTopic = 0` is the only sentinel for "no filter",
because a zero `filterValue` is a real value — `address(0)`, which is what a mint's `from` carries, and
which is exactly what the `erc721-mint-only` preset pins. `filterValue` is a raw word rather than an
address so the same field can constrain an indexed `uint`, `bytes32` or enum; a 20-byte address typed
into the form is left-padded by `normalizeTopicValue` the way the log itself pads it.

**What it is for.** An event that does not index the acting wallet cannot be sourced at all, and a
router is the common case: LiFi's `LiFiGenericSwapCompleted` indexes only a `transactionId`, so the
reachable proxy is the WETH `Transfer` the router makes to the receiver — `topics[2]` is the user,
`data` word 0 is the amount to the wei, and pinning `topics[1]` to the router is what separates that
swap from any other WETH arriving at the same wallet. That is the `router-transfer` preset; the token and
the sender are the campaign's to set.

**Where it is applied.** `topicFilterArray` builds the `eth_getLogs` topic slots for every scan path —
the indexer, the relayer, and the browser's `useObservedActions` — so all three narrow node-side
identically, and it builds them by index because the actor slot and the filter slot may fall in either
order. `matchesTopicFilter` then applies the same rule again inside `aggregateByActor` over whatever
comes back, and a log that does not carry the filtered topic at all fails rather than passes.

`actorTopic` is **1-based over `topics`**, because `topics[0]` is always the signature: an actor at index 0
cannot exist. **An event whose actor is not indexed cannot be sourced this way at all** — the address
would be in `data`, at an offset only the full ABI reveals. `kpiSource.actorTopicFindings` names that
case, and the create form's probe surfaces it from a sample log.

The chain does not read this blob as a consensus rule; `Campaign` forwards `params` to the verifier and
otherwise ignores it. It is a commitment published on chain so the off-chain halves agree on what a
campaign measures. See [chapter 05](./05-kpi-model.md#params) for the collision with
`TouchWindowVerifier`.

### Source probing

`kpiSource.probeEventSource` runs at campaign-creation time, advisory only:

1. **Is there code at the address?** `getCode` empty means an EOA or an address nobody deployed to on
   *this* chain — reported as an **error**, because no amount of promoter effort will move that KPI. This
   catches the specific trap of the ERC-721 presets shipping `source: address(0)` deliberately (the
   signature and topic layout are the reusable part; the collection never is).
2. **Has the event fired recently?** One `getLogs` over `PROBE_BLOCK_RANGE = 1900` blocks. A hit proves
   the signature hashes to a topic the contract really emits. A miss proves nothing, so it downgrades to
   a **warning** naming both plausible causes (idle contract, or wrong signature).
3. **Does the chosen actor topic exist, and is it a wallet?** A sample log is the only place the real
   topic count and topic *contents* are visible before launch. `actorTopicFindings` reports an
   `actorTopic` the event does not carry; `actorShapeFindings` reports one whose high 12 bytes are
   non-zero — a `bytes32` or a `uint256` sitting there would be read as its last 20 bytes and credit a
   wallet no referral can ever match. Both are **errors**: either way the KPI credits nobody.
4. **Would `Value` mode read something?** `dataWordFindings` decodes the sample's first data word, so a
   count-shaped event chosen in value mode is caught before launch rather than at report time.
5. **Do recent logs match the filter?** `topicFilterFindings` counts how many of the sampled logs carry
   `filterValue` at `filterTopic`. A filter aimed past the event's indexed arguments is an **error**,
   because nothing can ever match it. Zero matches on an existing topic is only a **warning**: over one
   1900-block window a deliberately narrow filter and a wrong one look identical.

It never throws. An RPC that is down or rate-limited must not block campaign creation.

---

## `pnpm relay` — Boney's KPI relayer

`web/scripts/relay-kpi-metric.ts`, with the pure logic in `web/src/lib/relayCore.ts`. One gated KPI per
invocation.

```bash
pnpm relay --campaign <address> --kpi <index> [--rpc <url>] [--verifier <address>] [--dry-run]
```

**What it does:**

1. Reads `configOf(campaign, kpiIndex)`. Unconfigured → hard error naming `pnpm report-window`.
2. `parseEventSignature` builds a real ABI decoder from the stored human-readable signature;
   `validateParamIndexes` checks `userParamIndex` / `valueParamIndex` against the parsed event **before**
   any log is fetched.
3. **Drift guard.** Reads `Campaign.kpi(kpiIndex).params`, decodes the indexer's event source, and
   `describeConfigDrift` compares topic0, source address, scale, aggregation mode and actor position. On
   disagreement it **refuses to run** — because the project would claim progress from one event while
   Boney verified another, so the cap would sit at 0 and every report would be a silent no-op.
4. `resolveScanRange` from `checkpointOf`, the configured window, the head, and `CONFIRMATIONS = 5`.
   Nothing new to scan → it says so and exits 0.
5. Fetches logs in 2000-block chunks — same node-side topic narrowing as the indexer — and
   `decodeUserEvents` decodes them, reporting how many matched the topic but failed to decode.
6. **Attribution filtering.** Scans the campaign's `TouchStored` history — from
   `startTime - effectiveMaxDuration` as a block, the same floor the indexer uses — and builds the shared
   attribution windows. `aggregateDeltas` then folds in only the logs whose own block falls inside a
   window that was live at that block. Users with no touch at all are skipped entirely, consistent with
   `Campaign` crediting nobody for them. A block whose timestamp could not be resolved is **excluded**
   rather than assumed to clear the floor.
7. `nextTotals` reads each user's current `verifiedTotalOf` and adds the delta — accumulating against the
   raw on-chain total, which is what makes the relayer stateless.
8. `planReportBatches` splits into `BATCH_SIZE = 200`-user transactions, with **only the last carrying
   the new checkpoint**.
9. Checks the key is actually the verifier's `reporter` before sending, and reports a clear mismatch if
   not. Sends `reportBatch`, or `advanceCheckpoint` for an empty batch.

Timestamps work exactly as they do in the indexer, and the same shared cache file backs both: harvested
from the KPI logs and from the touch logs, deduplicated by `missingTimestamps`, and read from the chain
only for what neither the logs nor an earlier pass supplied. The cache is written **before** the totals
reads and the transactions, so a failure in the reporting half still leaves the next pass what the scan
paid for. Reading one block at a time is what originally *broke* this script rather than merely slowing
it: three Gyndore KPIs wanted 84,750 individual block reads for one pass, a ~34-minute job the endpoint's
limiter cut off after ~2m20s, leaving the checkpoint stuck for ~30 hours. Both large passes now finish in
about a minute, spent almost entirely in `eth_getLogs`.

**Why per-user attribution filtering is the trickiest rule:** without it, activity a user performed
*before* they were ever attributed still credits the promoter who did not cause it. That rule is
implemented once, in `relayCore.aggregateDeltas`, and shared by the relayer and the browser rather than
reimplemented — see the subgraph note below.

**Why it stays behind the head.** The checkpoint is monotonic on chain and cannot be walked back, so a
checkpoint set on a block a reorg then discards is **permanent damage**. Five confirmations costs one
extra run's latency and removes the failure mode.

**Where attribution comes from.** The campaign holds no history of its own:

```
campaign.attributionRegistry() → the registry's TouchStored logs for that campaign
```

The live `touchOf(campaign, user)` is deliberately *not* what the filter reads. It answers "who holds
this user now", and a run that floored on it would drop every action performed under a touch that has
since been superseded — exactly the activity the chain still credits to the promoter who drove it.

### `relay-loop.sh` — one invocation per gated KPI

```bash
RPC=<url> ./scripts/relay-loop.sh [--once] [interval_seconds]
```

`pnpm relay` takes one KPI, so the target list lives in `web/scripts/relay-loop.sh` as `campaign:kpiIndex`
pairs — the current fixture's three Gyndore KPIs, which are the only gated ones. `--once` runs a single
pass and exits, which is what `dev-up.sh` needs: the indexer must not report before the ceiling has been
raised, so startup blocks on one synchronous pass and only then leaves a loop running behind it.

Three things about the list are worth knowing before editing it:

- **Only gated KPIs belong in it.** An ungated KPI has no ceiling to raise, so relaying it costs a
  transaction and changes nothing.
- **An empty list is a state, not a misconfiguration.** An all-ungated fixture prints `no gated KPIs` and
  exits 0; `dev-up.sh` greps for that line rather than starting a background loop whose pid has already
  exited.
- **Keep any KPI that watches the escrow token out of it.** A payout leaving the `EscrowVault` is a
  `Transfer` too, so it would raise the observed ceiling, which unlocks the next tier, which pays out
  again. Addresses also change with every redeploy, and a stale one is silent — the relayer reports
  against a dead campaign and the gated KPI simply stays flat.

Each cycle costs at most one transaction per KPI: `reportBatch` when there is creditable activity,
`advanceCheckpoint` when there are new blocks but nothing creditable, and nothing at all when no new blocks
have appeared. On Base's 2s blocks the middle case is the common one. Pass output goes through `tee` rather
than command substitution, because a pass now spends about a minute inside `eth_getLogs` per KPI and
capturing it made a working relayer indistinguishable from a hung one.

---

## `pnpm report-window` — deriving the block bounds

`web/scripts/compute-report-window.ts`.

```bash
pnpm report-window --campaign <address> [--rpc <url>]
```

`setKpiConfig` bounds the relayer in **blocks**; a campaign describes itself in **timestamps**. This
converts one to the other, printing `windowStartBlock` and `windowEndBlock` ready to paste.

**The window end is the subtle half.** A campaign's reporting close is *not* `endTime + CLAIM_GRACE`.
`Campaign._requireReportableStatus` closes reporting at `endedAt + CLAIM_GRACE`, and `endedAt` is set when
`end()` is actually called — permissionless but not automatic, so it can land well after `endTime`.

| Case                   | Result                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| Already`Ended`       | `endedAt` is known, so the close is **exact**                                       |
| Not yet ended          | Uses`endTime + CLAIM_GRACE` as the earliest it could be, flagged `[projected]`          |
| Close is in the future | Falls back to the current head, and says the script must be re-run as chain time catches up |

**Bias high when in doubt.** `windowEndBlock` only bounds how far the relayer may checkpoint, and
`Campaign` enforces its own report window regardless — so over-estimating wastes a little scanning, while
under-estimating stops the relayer early and under-credits promoters. `setKpiConfig` allows replacement
precisely so the window can be extended afterwards **without disturbing any stored total or the
checkpoint**.

The block search is `blockSearch.blockAtTimestamp`, the same one the indexer and relayer use, bounded below
by the protocol's own deployment block rather than genesis: a binary search over an L2's full height is ~25
sequential round trips against an endpoint that 502s often enough to matter, and every block before
deployment is known to be too early. Its probe map is per-run here — this script reads two timestamps and
exits, so it does not touch the shared on-disk cache.

---

## The subgraph

`subgraph/`, deployed to Studio as **`boney-indexer`** for Base Sepolia. Its query endpoint needs no API
key, which is why the URL can be a `NEXT_PUBLIC_` variable and be read from the browser at all.

### Entities

| Entity                | Key                          | From                                                                                                   |
| --------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------ |
| `Campaign`          | campaign address             | `CampaignCreated`, plus `StatusChanged`                                                            |
| `Kpi`               | `<campaign>-<index>`       | An`eth_call` for each new campaign's KPI specs, with the event-source blob decoded out of `params` |
| `Touch`             | `<campaign>-<user>`        | `TouchStored`, overwritten only on a strictly newer `signedAt`                                     |
| `Promoter`          | `<campaign>-<promoterId>`  | `PromoterRegistered` and `PromoterJoined`                                                          |
| `KpiAction`         | `<txHash>-<logIndex>`      | Preset data sources (WETH deposit/withdrawal, Aave supply, Sygma deposit, ERC-20 transfer)             |
| `Credit`            | `<txHash>-<logIndex>`      | `ProgressCredited`                                                                                   |
| `TierPayout`        | `<txHash>-<logIndex>`      | `TierSettled`                                                                                        |
| `SpawnedSource`     | `<templateName>-<address>` | Bookkeeping — a dedupe guard, see below                                                               |
| `UnsupportedSource` | `<source>-<topic0>`        | Bookkeeping — a KPI shape no template covers                                                          |

`Kpi.source` / `topic0` / `actorTopic` / `amountMode` / `scale` — and `filterTopic` / `filterValue`, for a
source that carries no filter — are **null** for a KPI whose params are not an event-source blob: every
campaign seeded before that feature, and any KPI carrying a `TouchWindowVerifier` lookback instead. Null
means "nothing observable", not an error.

The two bookkeeping entities exist because the failure they describe is otherwise invisible.
`SpawnedSource` dedupes dynamic data sources: two campaigns tracking the same contract with the same
preset would spawn the same source twice and handle every matching log twice, double-counting silently,
and graph-node does not dedupe this. `UnsupportedSource` records a KPI whose `topic0` no template
declares — a project can name any contract and event on chain, a subgraph can only index signatures in its
manifest, so an unrecognised shape means that KPI is not observable here and its campaign will look quiet
forever. Recorded so the gap is queryable rather than mistaken for inactivity: check
`unsupportedSources` first when a KPI shows no subgraph activity, and `spawnedSources` second — a spawned
template with **no** rows means a topic-count mismatch rather than a missing template.

### What it deliberately does not do

**It does not compute creditable progress.** `KpiAction` stores raw decoded events and `Touch` stores raw
attribution; the join between them — *only activity at or after this user's own `signedAt` counts* —
stays in `relayCore.aggregateDeltas`.

That is a correctness decision. The pre-attribution filter is the rule most likely to silently credit the
wrong promoter, and reimplementing it in AssemblyScript would create a second implementation that can
drift from the first. For the same reason nothing here applies `Kpi.scale`: raw values are stored and the
divide happens in the consumer, mirroring `EventMetricKpiVerifier`, which also holds raw totals and scales
only inside `verify`.

`KpiAction` is deliberately **not campaign-scoped**: one contract can serve many campaigns, and a user's
attribution can change after the fact via a promoter switch, so resolving the campaign at write time would
bake in an answer that later becomes wrong. Consumers filter by `source` + `topic0` + `user`. As of today
**nothing reads it** — the browser's `useObservedActions` fetches logs by raw `eth_getLogs`, and the
indexer and relayer decode logs themselves. A gap in the action templates is therefore an observability
gap only; it cannot break the UI or crediting.

**It does not apply a KPI's topic filter.** A `KpiAction` row keeps the decoded actor and amount, not the
log's topics, so the word a filter tests is gone by the time anything queries it. A filtered KPI read
through `indexerCore.aggregateActions` would therefore count logs the chain will not credit — the one
direction that over-credits. `aggregateByActor`, which sees whole logs, is the path that enforces it, and
that is the path both the indexer and the browser take. The filter is stored on `Kpi` all the same, so a
consumer can see it is there.

**It does not retain superseded touches.** `Touch` is keyed `<campaign>-<user>` and overwritten, exactly
as the registry is, so the subgraph answers "who holds this referral now" and cannot answer "who held it
in block N". Anything needing that history is still on the logs — see the horizon note under the web app.

### `startBlock` is the deployment block

Not a recent one. Templates only spawn from `CampaignCreated`, and a dynamically created data source
**never indexes blocks before it was spawned** — so starting late means already-deployed campaigns never
spawn their KPI templates at all, and the subgraph syncs clean while indexing nothing.

Addresses and `startBlock` come from `web/src/lib/deployments.ts`, which is generated from Foundry's
broadcast receipt, so they describe what actually landed on chain. Dead deployments must not be re-added.

### Commands

```bash
cd subgraph
pnpm codegen && pnpm build
pnpm auth <deploy-key>
pnpm run deploy --version-label vX.Y.Z   # boney-indexer on Studio
pnpm create:local && pnpm deploy:local   # against a local graph-node
```

`pnpm run deploy`, not `pnpm deploy` — pnpm has its own `deploy` subcommand that shadows the package script
and rejects `--version-label`.

**The version label is load-bearing.** Studio keeps every past version queryable forever and answers
cheerfully from a dead registry's history rather than erroring, so a stale label in
`NEXT_PUBLIC_SUBGRAPH_URL` looks like a working subgraph with the wrong data in it. Bump the label in the
same change as any redeploy. Query `_meta { block { number } hasIndexingErrors }` before trusting an answer
— `graph.META_SELECTION` and `graphLag` exist for exactly that.

### What reads it

The app reads the subgraph **first** for anything that needs enumeration, and falls back to `getLogs`:

| Reader                                      | Uses it for                              | Fallback                                        |
| ------------------------------------------- | ---------------------------------------- | ----------------------------------------------- |
| `useCampaignTouches`                      | the live touch per referral              | log scan, merged for superseded window history  |
| `useCampaignPromoters`                    | campaign membership                      | log scan over`PromoterJoined`                 |
| `useCampaignAttributions`                 | which referrals belong to which promoter | log scan over`TouchStored`                    |
| `useBoneyHistory` / `lib/cardServer.ts` | a promoter's whole BoneyCard history     | **none** — the chain cannot enumerate it |

Two rules govern the transport, both in `lib/graph.ts`:

- **A failed or partial read is never a zero.** `GraphResult` is a two-armed union and a consumer cannot
  reach the rows without first handling `unavailable`, because "0 campaigns, 0 tiers, 0 referrals" is a
  claim about a person and a fetch that did not complete has not earned the right to make one. A response
  carrying **both** `data` and `errors` is treated as a failure for the same reason: folding it into counts
  yields numbers that are quietly too low, which is worse than admitting the read failed.
- **Not configured is not an error.** `SUBGRAPH_CHAINS` is Base Sepolia only and the URL may be unset, so
  `unsupported-chain` and `not-configured` are distinct states from `network` / `http` / `graphql` /
  `malformed`. On anvil the copy can say history is not wired up on this deployment rather than blaming a
  service that was never called.

Paging is `GRAPH_PAGE_SIZE = 1000` rows over at most `GRAPH_MAX_PAGES = 10`, and hitting the cap sets
`truncated` — which the UI must surface, because a list that is quietly partial is worse than one that
admits its floor.

---

## The web app

`web/` — Next 16, wagmi + viem, Tailwind. Not part of the protocol, but it is the reference
implementation of every client-side rule.

| Route                   | Purpose                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------- |
| `/`                   | The campaign marketplace — list, filter, join                                                          |
| `/discover`           | Promoter discovery, ranked by BoneyScore, for a project deciding who to hire                            |
| `/campaign/[id]`      | Campaign detail: KPIs, tiers, progress, touches, promoters, reporting panel                             |
| `/create`             | Campaign creation form, including the KPI event-source builder and probe                                |
| `/my`                 | A project's own campaigns                                                                               |
| `/promoters`          | Promoter directory and BoneyScore                                                                       |
| `/card`               | The connected wallet's own BoneyCard                                                                    |
| `/b/[wallet]`         | The same card, public and server-rendered, with an`opengraph-image` — the share surface              |
| `/r`                  | The referral landing page — where a tracking link resolves and a user signs their touch                |
| `/docs`               | In-app documentation                                                                                    |
| `/api/attest`         | Signs the EIP-712 attestation bundle`submitAttestation` consumes                                      |
| `/api/score`          | The same reputation inputs,**unsigned** — a score for a wallet that has never sent a transaction |
| `/api/campaign-guide` | `GET` a stored campaign guide; `POST` one, signed by `Campaign.project()`                         |
| `/api/stub-wallets`   | Development stub                                                                                        |

`/api/score` and `/api/attest` read the same upstreams and must not be confused. Neither number is
what `join()` gates on: that reads `ReputationRegistry.scoreOf`, which stays 0 until attestations are
submitted on chain and gas is paid.

### Library modules worth knowing

| Module                                                               | Holds                                                                                                                                |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `lib/relayCore.ts`                                                 | Decode, attribution filter, aggregate, batch planning — shared by the relayer and the browser                                       |
| `lib/indexerCore.ts`                                               | Actor extraction, scaling, cumulative totals,`decideReport`, `encodeActions`, `logScanKey`                                     |
| `lib/attributionWindows.ts`                                        | `TouchStored` logs → per-user windows, the resolution rule `AttributionRegistry.promoterAt` applies, and the log/subgraph merge |
| `lib/blockTimestamps.ts`                                           | Timestamps harvested off logs, deduplicated and batched — the pass-wide cache both scanners share                                   |
| `lib/blockSearch.ts`                                               | Timestamp → block search, and the earliest touch a campaign can still be paying for                                                 |
| `lib/kpiSource.ts`                                                 | The`params` event-source encoding, presets, and the liveness probe                                                                 |
| `lib/graph.ts`                                                     | Subgraph transport:`GraphResult`, `_meta` lag, paging caps                                                                       |
| `lib/attributionGraph.ts` / `lib/promoterGraph.ts`               | Touch and promoter enumeration via the subgraph, with the log scan as fallback                                                       |
| `lib/boneyHistory.ts`                                              | A promoter's whole indexed history — subgraph-only, the BoneyCard's read half                                                       |
| `lib/boneycard.ts` / `lib/publicCard.ts` / `lib/cardServer.ts` | What the card decides, what its URL and share copy are, and the server-side assembly                                                 |
| `lib/promoters.ts`                                                 | `planWindows` — the log-scan window plan every browser scan uses, and its coverage floor                                          |
| `lib/settlements.ts`                                               | `TierSettled` logs → per-promoter payouts, because the contract stores only a total and a count                                   |
| `lib/validation.ts`                                                | Campaign-form validation, including the params/verifier collision warning                                                            |
| `lib/reporting.ts`                                                 | The reporting panel's state machine                                                                                                  |
| `lib/boneyscore.ts`                                                | BoneyScore assembly and freshness display                                                                                            |
| `lib/chains.ts` / `lib/deployments.ts`                           | Chain config and generated addresses                                                                                                 |
| `lib/txErrors.ts`                                                  | Maps custom-error selectors to human copy                                                                                            |

Every one has a colocated `.test.ts` run by `pnpm test` (vitest).

### Three frontend gotchas

**wagmi has no concept of "no chain".** `createConfig` seeds its store with `chains[0].id` and `getClient`
falls back to it, so a visitor who has never connected still resolves to a chain — which was `anvil`, a
developer's local node. Because `isDeployed(31337)` is true, the "not available on this network" empty
states did not fire either; the app simply issued reads against a dead endpoint and rendered an empty
marketplace. `DEFAULT_CHAIN_ID` is Base Sepolia, and **every read should pass an explicit chain id**
(`{chainId: useBoneyChainId()}`) rather than relying on the ambient one.

**Generated deployments win over env vars.** `GENERATED_DEPLOYMENTS` is spread **last** in `DEPLOYMENTS`,
because it is read from the broadcast receipt and describes what actually landed. Spread first, a real
deployment would be silently clobbered by unset env vars resolving to the zero address.

**A browser log scan reaches back about a day, not to the deployment.** `planWindows` covers
`MAX_WINDOWS` (24) × `MAX_LOG_RANGE` (1900) = 45,600 blocks — roughly 25 hours of Base's 2-second blocks
— and when the range is wider it keeps the **newest** span and reports `skippedBefore` rather than
pretending it looked everywhere. That is why enumeration moved to the subgraph: on a chain older than
that window a promoter who joined earlier is missing from a log-only list while every point lookup still
finds them. The scans that remain log-only are `useCampaignSettlements` (`TierSettled`) and
`useObservedActions`' KPI-event scan, and both surface their floor — a short total is presented as a
floor, never as complete.

### Development commands

```bash
pnpm dev:up             # the whole local stack in order — stub, Next, one relay pass, then the indexer
pnpm dev                # Next dev server alone
pnpm ethos:stub:dev     # reputation stub — run alongside `pnpm dev`, or the dev wallet scores 0
pnpm test               # vitest
pnpm lint               # eslint
pnpm abis               # regenerate lib/abis from forge artifacts
pnpm deployments [chainId]   # regenerate lib/deployments.ts from the broadcast receipt
pnpm seed               # local fixture
pnpm demo:seed          # the Base Sepolia demo fixture
pnpm index              # the project's indexer
pnpm relay              # Boney's KPI relayer
pnpm report-window      # derive a campaign's reporting block bounds
pnpm followers:health   # check the follower data sources
```

`pnpm dev:up` exists because the order matters: it health-checks the reputation stub, starts `next dev`,
runs `relay-loop.sh --once` **synchronously**, and only then runs `pnpm index`. An indexer report that
lands before the ceiling is raised succeeds and credits nothing.

> `pnpm typecheck` and `pnpm build` load the whole Next graph and peak around 8 GB. On a constrained
> machine, prefer `pnpm test` plus scoped `eslint` over a full typecheck.

---

## Environment

Two files, and which one is read depends on the process. The repo-root `.env` is read by the Foundry
scripts and — because they are plain node scripts that nothing else loads it for — by the indexer and the
relayer. `web/.env.local` is read by Next, and so by everything server-side in the app.

| Variable                                                                                                                                                                                        | Used by                                | Meaning                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `PRIVATE_KEY`                                                                                                                                                                                 | `DeployBoney`, seeds, `pnpm index` | The deployer / project key                                                                          |
| `REPORTER_PRIVATE_KEY`                                                                                                                                                                        | `pnpm relay`                         | Boney's relayer key. Must match the verifier's`reporter` — see the caveat under *Two roles*    |
| `ATTESTOR_PRIVATE_KEY`                                                                                                                                                                        | `/api/attest`                        | Signs reputation attestations. Can mint arbitrary score; the route refuses to start without it      |
| `BONEY_MIN_STAKE`                                                                                                                                                                             | `DeployBoney`                        | Oracle`minStake`. Default 100 ether                                                               |
| `BONEY_MAX_TOUCH`                                                                                                                                                                             | `DeployBoney`                        | `AttributionRegistry.maxTouchDuration`. Default 30 days                                           |
| `BONEY_INITIAL_ATTESTOR`                                                                                                                                                                      | `DeployBoney`                        | First attestor. Defaults to the dev wallet so the app's signing path works                          |
| `BONEY_KPI_REPORTER`                                                                                                                                                                          | `DeployBoney`                        | `EventMetricKpiVerifier.reporter`. Defaults to the deployer                                       |
| `REGISTRY_ADDRESS`, `VAULT_ADDRESS`, `ATTRIBUTION_ADDRESS`, `REPUTATION_ADDRESS`, `TOKEN_ADDRESS`, `KPI_VERIFIER_ADDRESS`, `GUARDED_VERIFIER_ADDRESS`, `TOUCH_VERIFIER_ADDRESS` | seed scripts                           | Targets for seeding                                                                                 |
| `WINDOW_START_BLOCK`, `CAMPAIGN`                                                                                                                                                            | seed scripts                           | KPI-config arguments for a seeded campaign                                                          |
| `NEXT_PUBLIC_DEFAULT_CHAIN_ID`                                                                                                                                                                | web                                    | Chain used when no wallet is connected                                                              |
| `NEXT_PUBLIC_*_RPC`                                                                                                                                                                           | web                                    | Per-chain RPC endpoints                                                                             |
| `NEXT_PUBLIC_*_START_BLOCK`                                                                                                                                                                   | web                                    | Log-scan floor per chain                                                                            |
| `NEXT_PUBLIC_<CHAIN>_<MODULE>`                                                                                                                                                                | web                                    | Per-chain module addresses, overridden by generated deployments                                     |
| `NEXT_PUBLIC_SUBGRAPH_URL`                                                                                                                                                                    | web                                    | Studio query endpoint.**The version label in it is load-bearing** — see the subgraph section |
| `NEXT_PUBLIC_SITE_URL`                                                                                                                                                                        | web                                    | Host that shared links are built against — the tunnel host in dev, the real host in production     |
| `ETHOS_API`                                                                                                                                                                                   | web                                    | Reputation source. Overriding it stubs*every* wallet                                              |
| `FXTWITTER_API` / `VXTWITTER_API`                                                                                                                                                           | web                                    | Follower sources                                                                                    |
| `KAITO_API`                                                                                                                                                                                   | web                                    | Additional reputation source                                                                        |
| `BONEY_STUB_WALLETS`                                                                                                                                                                          | web                                    | Wallets the reputation stub answers for, unioned with the committed defaults                        |
| `BONEY_STUB_PINS`                                                                                                                                                                             | web                                    | Fixed stub scores,`0xaddr:score:followers`, comma-separated                                       |
| `BONEY_STUB_ADMIN` / `BONEY_STUB_STORE`                                                                                                                                                     | web                                    | Who may edit the stub allowlist, and where it persists                                              |
| `BONEY_GUIDE_STORE`                                                                                                                                                                           | web                                    | Where campaign guides persist. Unset means the platform default                                     |
| `LIVE_ETHOS`, `LIVE_CHAIN`                                                                                                                                                                  | web tests                              | Opt into live-network tests                                                                         |

Per-wallet stubbing and a global `ETHOS_API` override are different tools: the first fabricates scores for
named wallets, the second replaces the upstream for everyone.

## Operational notes

- **Public RPC log range.** Base's public endpoint rejects wider `eth_getLogs` ranges outright
  (`-32602: query exceeds max block range 2000`). Both scanners chunk at 2000, the browser at 1900.
  Observed, not guessed.
- **`sepolia.base.org` 502s roughly one call in three.** Use a `publicnode` endpoint for anything
  sequential — the report-window binary search and the promoter log scans are the ones that notice.
- **Relay before you index.** Nothing on chain wakes up and scans logs, so a gated KPI's ceiling is 0
  until `pnpm relay` has run, and a report that lands first succeeds and credits nothing. `pnpm dev:up`
  enforces the order; `relay-loop.sh` keeps it true afterwards.
- **The block-timestamp cache is shared and disposable.** `web/.cache/block-timestamps-<chainId>.json`,
  written by both scanners and gitignored. Deleting it costs one slow pass, nothing more. It is written
  mid-pass as well as at the end, so a run that dies partway still leaves behind what it paid for.
- **A stale subgraph version label is silent.** Studio answers happily from a dead registry's history.
  Bump the label whenever the subgraph is redeployed, and check `_meta` before trusting a count.
- **Follower sources throttle back-to-back runs.** fxtwitter/vxtwitter rate-limit, so a live follower
  failure right after a previous run is usually that, not an outage. `pnpm followers:health` distinguishes
  them.
- **The relayer is safe to run repeatedly.** Stateless, checkpointed on chain, and retry-safe by design.
  The indexer is too: its totals are cumulative, so a repeated pass reports the same figure and the
  contract returns early.
- **`--dry-run` exists on both scanners** and needs no key. It is the right first move against an
  unfamiliar deployment.
