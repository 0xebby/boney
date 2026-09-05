# Boneyard

**marketplace for verifiable web3 growth**

A project locks a reward pool in a vault, declares what counts as progress, and the vault pays
promoters automatically as verified, attributed progress crosses thresholds. 

Nobody needs to approves a payout. Nobody can move the goalposts after the work is done.


## What it replaces

Web3 growth deals settle on trust and screenshots. Each failure is replaced with a mechanism rather
than a policy:

| Instead of | Boneyard uses |
|---|---|
| Paying upfront for promises | Escrow that releases only against verified progress |
| Metrics reported by the party being judged on them | Cumulative on-chain reports, capped at an independent observer's reading |
| Claimed attribution | Attribution the end user signs, which expires |
| Handing over social accounts to qualify | Attested numeric reputation — the chain stores `(wallet, schemaId) => number` |
| Waiting on manual approval | Auto-settlement, in the same transaction as the report |

## The core loop

```
1. CREATE     project → CampaignRegistry.createCampaign(cfg, kpis, tiers)
                        deploys an immutable Campaign, claims the name, binds the escrow token

2. FUND       project → EscrowVault.deposit(campaign, rewardPool)
              project → Campaign.activate()          blocked while underfunded

3. JOIN       promoter → Campaign.join()             reputation gate, issues promoterId
                                                     (allowed while Pending, so links exist at launch)

4. ATTRIBUTE  promoter shares a link carrying promoterId
              end user signs EIP-712 Touch{campaign, promoterId, signedAt, expiresAt}
              anyone relays → AttributionRegistry.storeTouch(...)

5. ACT        end user transacts on the project's own contracts. Ordinary on-chain activity.

6. REPORT     project (or oracle) → Campaign.reportUserAction(kpi, user, newTotal, evidence)
                 resolve attribution → verifier caps the claim → credit the delta
                 → walk the tier ladder → EscrowVault.release(promoter, tierPay)

7. WIND DOWN  end() — project any time, or anyone once endTime passes
              CLAIM_GRACE: reporting stays open
              reclaimUnspent() — project only, strictly after the grace window
```

Step 6 is one transaction. There is no separate claim step: settlement runs inline at the end of every
crediting report, so by the time anyone calls the public `settle`, the ladder is already caught up.

## Architecture

Ten deployed contracts in three tiers: a facade nobody has to use, six protocol modules, and three KPI
verification adapters. `Campaign` is the eleventh, deployed per campaign.

```
                      ┌───────────────────────────────┐
                      │        Boney (facade)         │  marketplace ergonomics
                      │  create · fund · claim · views│  holds no funds
                      └───────────────┬───────────────┘  has no privileged role
                                      │ every call here could be made directly
      ┌───────────────────────────────┼──────────────────────────────┐
      │                               │                              │
┌─────▼──────────────┐    ┌───────────▼─────────┐    ┌───────────────▼────┐
│  CampaignRegistry  │    │  ReputationRegistry │    │ AttributionRegistry│
│  factory · index   │    │  scoreOf/qualifies  │    │ user-signed touches│
│  name uniqueness   │    │  schemas · freshness│    │ history + expiry   │
│  vault registrar   │    └───────────┬─────────┘    └───────────┬────────┘
└─────┬──────────────┘                │                          │
      │ deploys                       │ verified by              │ resolves the payee
      │                    ┌──────────▼──────────┐               │
┌─────▼──────────────┐     │ AttestationVerifier │               │
│      Campaign      │◄────┤   k-of-n EIP-712    │               │
│  lifecycle · KPIs  │     └─────────────────────┘               │
│  progress · tiers  │◄──────────────────────────────────────────┘
│  inline settlement │
└──┬──────────┬───────┬─────────────────────────┐
   │ releases │ aggregate + user reports        │ caps the claim
   │          │                                 │
┌──▼────────┐ │  ┌──────────────────┐   ┌───────▼──────────────┐
│EscrowVault│ └─►│ OracleCoordinator│   │  GuardedKpiVerifier  │
│ custody   │    │ stake · dispute  │   │   AGREE  or  CAP     │
│ only      │    │ slash · apply    │   └───┬──────────────┬───┘
└───────────┘    └──────────────────┘       │ always       │ optional
                                    ┌───────▼──────────┐ ┌─▼────────────────┐
                                    │EventMetricKpi    │ │TouchWindow       │
                                    │Verifier          │ │Verifier          │
                                    │relayer-fed totals│ │timing lens       │
                                    └──────────────────┘ └──────────────────┘
```

| Contract | Responsibility |
|---|---|
| `Campaign` | One per campaign. Immutable config, KPIs and tiers; resolves attribution, credits deltas, walks the tier ladder inline |
| `CampaignRegistry` | Factory, directory, and the vault's registrar — the only account that may bind a campaign to a token. Enforces project name uniqueness |
| `EscrowVault` | Custody only. Tracks `campaign => (token, balance)` on an internal ledger; only a campaign spends its own entry |
| `AttributionRegistry` | One live touch per `(campaign, user)` plus the full history, so a report resolves who held a wallet at each action's block |
| `ReputationRegistry` | `(wallet, schemaId) => (value, updatedAt)`, and a weighted score over the fresh ones |
| `AttestationVerifier` | k-of-n threshold EIP-712 attestations with per-attestor nonces. Handles never touch the chain |
| `OracleCoordinator` | Staked optimistic reporting. Carries both the aggregate path and the per-user path that credits promoters |
| `GuardedKpiVerifier` | What a campaign's `KpiSpec.verifier` should point at. Composes Boney's reading with an optional second verifier |
| `EventMetricKpiVerifier` | Boney's canonical reading, fed by an independent relayer scanning real event logs |
| `TouchWindowVerifier` | Stateless attribution-timing lens, for off-chain window reads. **Not** to be wired as a KPI's verifier |
| `Boney` | Facade. Resolves ids, batches approvals, assembles paginated views. Holds no funds and no privileged role |


There is deliberately no protocol-wide owner that can touch escrow. `EscrowVault`'s only authority is
binding a campaign to a token; the governor and the schema registrar are governance over *scoring* and
*reporting*, never over custody. Ownership is per-module rather than global, and `end()` becomes
permissionless once `endTime` passes so a project cannot park a finished campaign to stall payouts.

## KPIs, tiers and settlement

A KPI is one measurable objective:

```solidity
struct KpiSpec {
    KpiKind kind;       // Custom, Mint, Swap, TokenPurchase, Deposit, Stake, Bridge,
                        // Tvl, Volume, ActiveUser, signUps, downloads
    address verifier;   // address(0) = ungated; anything else caps every claim
    uint256 target;     // campaign-wide goal. Informational; tiers drive payouts
    bool    aggregate;  // campaign-level, oracle-reported, credits no individual
    bytes   params;     // the event source the off-chain scanners commit to
}

struct RewardTier { uint256 threshold; uint256 reward; }
```

`kind` is a label for the UI; what a KPI actually *means* is its `params` event source and its verifier.

A `Custom` KPI must name one (`CustomKpiNeedsVerifier`). 

Tiers are per-promoter, per-KPI, with strictly ascending thresholds, at most `MAX_TIERS_PER_KPI = 32` each.

**Reports are cumulative.** `reportUserAction(kpiIndex, user, newTotal, evidence)` states a user's
running total, not a delta, so a replayed or duplicated report is a no-op: the campaign credits
`newTotal - alreadyCredited` and returns early when that is zero. 

Evidence is `Types.Action[]`
(`{blockNumber, timestamp, amount}`) in ascending block order, bounded by `MAX_EVIDENCE_ACTIONS = 256`,
so each action is attributed at its own block rather than all of them at report time.

Settlement then walks the ladder in the same transaction and releases from the vault directly to the
promoter. 

Rewards draw from one shared pool, first-come. If the pool cannot cover a crossed tier the
campaign pays what remains and emits `PoolExhausted(shortfall)`, it never reverts, because reverting
would let one exhausted tier block reporting for everybody. `paidOut <= rewardPool` holds by
construction.

## Verification

Solidity cannot read historical event logs, so every KPI number originates off chain. What the protocol
enforces is that a project's claim is capped at an independent observer's reading.

**A verifier may only ever shrink a claim.** `Campaign` reverts `VerifierOvercredit(credited, max)` on
any adapter returning more than was claimed, independently of what the adapter does. So a malicious or
buggy adapter cannot mint progress and it cannot redirect the payee either: it can deny a promoter a
delta they did not earn, but not award that delta to whoever did. 

The uncredited portion stays uncredited, and a corrected report can land later.

A campaign should point `KpiSpec.verifier` at `GuardedKpiVerifier`. It **always** computes Boney's value
from `EventMetricKpiVerifier`, and optionally cross-checks a second verifier per KPI:

```
boneyValue = EventMetricKpiVerifier.verify(...)          // always
if projectVerifier == 0: return boneyValue

CAP:    return min(projectValue, boneyValue)
AGREE:  revert VerifierDisagreement(...) past toleranceBps, else return boneyValue
```

`AGREE` is for a project independently measuring the *same* quantity  divergence past tolerance should
surface as an actionable error, not quietly take the smaller number. 

`CAP` on the other hand is for layering a stricter lens on a *different* quantity, where every legitimate report would diverge by construction. Both fail
closed: an unconfigured KPI reverts `NotConfigured(campaign, kpiIndex)` rather than passing ungated.

### Two keys, two processes

| | Claims | Runs as | Command | Writes to |
|---|---|---|---|---|
| **The project** | "Alice made 2 deposits" | `PRIVATE_KEY` | `pnpm index` | `Campaign.reportUserAction` |
| **Boney** | "we independently observed 2" | `REPORTER_PRIVATE_KEY` | `pnpm relay` | `EventMetricKpiVerifier.reportBatch` |

On a gated KPI a claim is credited at the smaller of the two, so one process doing both with one key
would make the cap a formality.

> **Both must run.** The indexer alone leaves every progress bar at zero: a claim capped against an
> unreported observed total credits nothing, and it does not revert it *succeeds* and credits nothing.
> The relayer alone credits nothing either, because nobody is claiming.

## Attribution

Consent is the anti-abuse primitive. A promoter cannot claim a user; the **user** signs, and the
signature expires:

```solidity
struct Touch {
    address campaign;    // the campaign this consent applies to
    bytes32 promoterId;  // opaque, campaign-bound id of the promoter being endorsed
    uint64  signedAt;    // when the user signed. Orders touches against each other
    uint64  expiresAt;   // after this, the touch credits nobody
}
```

EIP-712 under domain `"Boney Attribution"` / version `"1"`, bound to the chain id and the
`AttributionRegistry` address. Anyone may relay it, the signature is the authority, so the end user
never pays gas and never transacts with Boney directly.

- **`promoterId = keccak256(abi.encode(campaign, promoter))`**, namespaced by registrant, so an id from
  one campaign cannot farm attribution in another and no squatter can deny a campaign an id.
  
- **LAST_TOUCH is ordered by the signed `signedAt`, not by relay order**, because relayers are
  adversarial. A touch signed no later than the stored one reverts `TouchNotNewer`, so holding a
  signature back and relaying it late wins nothing.
  
- **The registry enforces the campaign's own bounds on chain**, not in the client: it reads the
  campaign's `attributionWindow`, `endTime` and `status`, caps the touch at
  `min(campaign.attributionWindow, maxTouchDuration)`, and refuses a touch for a closed campaign.
  
- **Credit is resolved per action, at that action's own block.** A report carrying evidence asks who
  held the user at each action's block and tallies oldest-first, so activity predating a touch goes to
  whoever held the wallet at the time or to nobody, rather than to whoever holds the touch when the
  report happens to land. A promoter who knows the reporting cadence has nothing to farm.
  
- **Without evidence, an ambiguous report is refused rather than guessed.** If more than one promoter
  held the user since the last report closed, `reportUserAction` reverts `AmbiguousAttribution`. The fix
  is to resend it with evidence.

A new touch redirects only *future* credit. Per-promoter credited totals are high-water marks, so
nothing already earned can be clawed back.

## Reputation

The chain stores `(wallet, schemaId) => (value, updatedAt)` and computes a weighted sum over the values
still inside their freshness window. Handles never touch the chain: an attestor sees them off chain and
signs a figure, and `AttestationVerifier` authenticates k-of-n EIP-712 bundles with per-attestor nonces.
The app calls the resulting number **BoneyScore**.

`Campaign.join()` reads the score **once**, at join. A promoter whose score later decays keeps their
membership; a gate of `0` skips the read entirely. Construction rejects a `minReputation` above
`ReputationRegistry.maxScore()` (`UnreachableReputation`), so a campaign can never be created with a gate
nobody could clear.

Governance can add schemas and change weights, freshness windows and ceilings; attested data is never
erased. `AttestationVerifier`'s attestor set and threshold rotate, k-of-n from day one and configured
down to 1-of-1.

## Lifecycle

| # | Status | Accepts | Notes |
|---|---|---|---|
| 0 | `Pending` | escrow deposits, `join()` | The state a campaign is born in. Cancellable |
| 1 | `Active` | reports, settlement, deposits, `join()` | Reports additionally bounded by `[startTime, endTime]` |
| 2 | `Paused` | deposits | Reversible halt. Reporting and settlement both stop |
| 3 | `Ended` | reports and settlement for `CLAIM_GRACE`, then nothing | Terminal |
| 4 | `Cancelled` | nothing | Terminal. Only reachable from `Pending` |

Deposits work in every state because they are a vault call, not a campaign call.

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
```

**Reporting closes exactly where reclaim opens, and the two can never both be open.** A report is
accepted while `Active`, or while `Ended` and `block.timestamp <= endedAt + CLAIM_GRACE`; reclaim
requires `Cancelled`, or `Ended` and `block.timestamp > endedAt + CLAIM_GRACE`. 

Those are exact complements, so escrow is never reclaimable while credit is still owed and a report can never land
against a pool the project already emptied.

The grace window exists mainly so **withheld reports can still land**: a project that stops reporting
near the end would otherwise keep the escrow, and during the grace window anyone can push a report
through the `OracleCoordinator`, which credits the promoter and pays out. That is also why the oracle's
dispute window must stay well inside `CLAIM_GRACE` — a report submitted after `end()` has to clear its
dispute window while the campaign is still reportable.

`cancel()` is reachable only from `Pending`, since once promoters may have earned, cancellation would be
a rug. There is no cancel-with-payouts path, no way to retire an activated campaign, and no way to
release a claimed name — recycling one would silently repoint every link, screenshot and indexer row
that referenced the campaign it used to mean.

Names are validated and normalized by `libraries/Names.sol`: printable ASCII, at most 32 bytes, then
trimmed, inner-space-collapsed and lowercased before hashing, because uniqueness on raw bytes is defeated
by accident — `"Aave"`, `"aave"` and `"Aave "` read as one name to a person. The claim is recorded
*after* the campaign deploys, so a constructor revert leaves the name free rather than burning it.

## Trust and limits

**The contracts are not audited.** These are the assumptions they cannot remove, stated plainly. None of
them lets anyone move escrow; all of them bound how much a reported *number* is worth.

Everything that loops is bounded, so no payout path can exceed the block gas limit and brick payouts for
promoters who already did the work: `MAX_KPIS` 32, `MAX_TIERS_PER_KPI` 32, `MAX_EVIDENCE_ACTIONS` 256,
`MAX_SCHEMAS` 64, `MAX_ATTESTATIONS` 16, `MAX_NAME_BYTES` 32.

There are no proxies and no upgrade path. `Campaign` is fully immutable after construction; the vault's
`registrar` and the coordinator's `campaignRegistry` are write-once; `CampaignRegistry` is append-only.

## Build & test

```bash
forge build
forge test                    # 447 tests across 19 suites
forge test --mc CampaignTest  # a single suite

PRIVATE_KEY=0x... forge script script/DeployBoney.s.sol:DeployBoney
```

Deploy order, encoded in `script/DeployBoney.s.sol`. Two cyclic dependencies force it, and both are
broken with one-time setters rather than address prediction — `computeCreateAddress` fails *silently*
whenever the deployer's nonce differs between simulation and broadcast, producing a vault whose
registrar can never register anything.

```
1.  AttributionRegistry, AttestationVerifier, ReputationRegistry   no dependencies
2.  OracleCoordinator                       before the registry, which needs its address
3.  EscrowVault, CampaignRegistry
    vault.setRegistrar(registry)             ← cycle 1 broken here
4.  coordinator.setCampaignRegistry(registry) ← cycle 2 broken here
    Boney(registry)                          reads the rest off the registry
5.  EventMetricKpiVerifier, GuardedKpiVerifier, TouchWindowVerifier
```

The verification layer sits outside the graph on purpose: all three are configured **per KPI after a
campaign exists**, so one deployment of each serves every campaign.

`DeployBoney` points every `owner`/`admin`/`governor` at the deployer and takes two overrides from the
environment: `BONEY_INITIAL_ATTESTOR` (default `DEV_ATTESTOR`) and `BONEY_KPI_REPORTER` (default the
deployer). The second is the one that matters operationally — leaving it at the default makes the relayer
key and the project key the same account, which is exactly what the independence of the cap is meant to
prevent.

## Running the stack

`web/src/lib/abis/*` comes from `pnpm abis` and
`web/src/lib/deployments.ts` from `pnpm deployments <chainId>`, read out of Foundry's broadcast
artifacts. Neither is hand-edited, which is why live addresses are not written down anywhere.

```bash
cd web && pnpm install
pnpm dev:up             # the whole local stack in order — stub, Next, one relay pass, then the indexer
pnpm dev:down           # next dev detaches a server; this is how you stop it

pnpm dev                # Next dev server alone
pnpm test               # vitest
pnpm lint               # eslint
pnpm abis               # regenerate lib/abis from forge artifacts
pnpm deployments 84532  # regenerate lib/deployments.ts from the broadcast receipt
pnpm index              # the project's indexer     → Campaign.reportUserAction
pnpm relay              # Boney's KPI relayer       → EventMetricKpiVerifier.reportBatch
pnpm report-window      # derive a campaign's reporting block bounds
```

`pnpm dev:up` exists because the order matters: it health-checks the reputation stub, starts `next dev`,
runs one relay pass **synchronously**, and only then runs the indexer. 

Both scanners take `--dry-run`, which needs no key and is the right first move against an unfamiliar deployment. Both are safe to run
repeatedly — the relayer is stateless with its checkpoint on chain, and the indexer's totals are
cumulative, so a repeated pass reports the same figure and the contract returns early.

Two operational facts worth knowing before debugging an RPC: Base's public endpoint rejects
`eth_getLogs` ranges wider than 2000 blocks outright, and `sepolia.base.org` 502s roughly one call in
three — use a `publicnode` endpoint for anything sequential.

## Shortened durations (bscoretest)

`bscoretest` exists to make manual testing fast, so the time-based constants are far shorter than the
protocol values. **Restore the protocol values before merging to main.** Each source constant carries a
`[bscoretest]` comment naming its protocol value.

| Constant | Protocol | This branch |
|---|---|---|
| `Campaign.CLAIM_GRACE` | 7 days | **20 minutes** |
| `DeployBoney.DISPUTE_WINDOW` | 1 day | **4 minutes** |
| `DeployBoney.UNSTAKE_DELAY` | 2 days | **10 minutes** |
| `DeployBoney.MAX_TOUCH_DURATION` | 30 days | 30 days (unchanged — see below) |
| `attributionWindow` (`SeedLocal`, `SeedGated`, `SeedEventKpi`) | 7–14 days | 30 minutes – 1 hour |
| `attributionWindow` (every other seed) | — | equal to each campaign's own length |
| `ETHOS_MAX_AGE` / `REACH_MAX_AGE` (`SeedLocal`, `SeedDevRep`) | 180 / 90 days | 180 / 90 days (unchanged) |

`MAX_TOUCH_DURATION` is deliberately **not** shortened. The registry applies it as
`min(campaign.attributionWindow, maxTouchDuration)`, and it applies *silently* — a campaign whose window
exceeds the cap still reports its own longer window from `attributionWindow()`, which is what the UI
renders. Shortening it does not shorten what the app says; it only makes the app disagree with the chain,
which is a worse failure than a long window. `script/SeedExpiry.s.sol` asserts the deployed cap covers
its longest campaign before spending gas, so a registry deployed with a short cap fails that seed rather
than truncating it.

Campaign `endTime` is a per-fixture choice rather than a constant. `SeedLocal`, `SeedGated` and
`SeedEventKpi` run 30–60 days out, putting expiry out of reach of a testing session; the Base Sepolia
fixture (`script/SeedDemo.s.sol`) instead expires campaigns at 24 hours and 3/5/7/10/14 days, so the
window-closed → `end()` → grace → `reclaimUnspent` path is reachable without warping a chain.

## Repository layout

```
src/
  Boney.sol                       facade — no funds, no privileged role
  IBoney.sol
  campaign/
    Campaign.sol                  one campaign: config, KPIs, tiers, progress, settlement
    CampaignRegistry.sol          factory + directory + the vault's registrar
  escrow/EscrowVault.sol          custody only
  attribution/AttributionRegistry.sol
  reputation/
    ReputationRegistry.sol        weighted score from attested metrics
    AttestationVerifier.sol       k-of-n EIP-712 attestations
  oracle/OracleCoordinator.sol    staked optimistic reporting
  verifiers/
    GuardedKpiVerifier.sol        the one a campaign points at
    EventMetricKpiVerifier.sol    Boney's independently-fed reading
    TouchWindowVerifier.sol       attribution-timing lens
  interfaces/                     every error and event, declared per module
  libraries/
    Types.sol                     shared enums and structs
    Names.sol                     campaign-name validation and normalization
  mocks/OpenMintNFT.sol           the one KPI source the demo fixture deploys itself

script/                           DeployBoney, the seed fixtures, promoter.sh
test/                             19 Foundry suites
web/
  src/app/                        Next 16 routes, including /docs and the /r referral landing
  src/lib/                        every rule that can be wrong, with a colocated .test.ts
  scripts/                        indexer.ts, relay-kpi-metric.ts, dev-up.sh, generators
```

## License

MIT
