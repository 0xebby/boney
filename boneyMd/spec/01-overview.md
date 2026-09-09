# 01 — Overview

## What Boney is

Boney is an escrow-and-verification layer for performance-based collaborations. A project locks a
reward pool in a vault, declares what counts as progress, and the vault pays promoters automatically
as verified, attributed progress crosses thresholds. Nobody approves a payout. Nobody can move the
goalposts after the work is done.

The first application is a KOL marketplace — projects hiring creators to drive on-chain activity —
but nothing in the contracts knows about marketing. A campaign is "escrow + a measurable objective +
a payout ladder", which is also what a grant milestone, a bug bounty, an affiliate program and a
gaming quest are.

## The problem it removes

Web3 growth deals settle on trust and screenshots:

- **No accountability** — off-chain metrics are trivially manipulated, and the party reporting them
  is the party being judged on them.
- **Upfront payment** — projects pay for promises. A promoter who delivers nothing keeps the money.
- **Opaque settlement** — promoters wait on manual approval and goodwill.
- **Identity leakage** — qualifying for a deal usually means handing over social accounts.
- **Sybil risk** — bot traffic inflates every off-chain number, and there is no cost to inflating it.

Boney replaces each with a mechanism: 

- escrow instead of trust.
- cumulative on-chain reporting instead of screenshots.
- consent-signed attribution instead of claimed attribution.
- attested numeric reputation instead of handing over accounts.

## Actors

| Actor                      | Holds                                      | Can                                                                                                                                | Cannot                                                                                                                  |
| -------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Project**          | The campaign's`project` key              | Create, fund, activate, pause, end, report per-user progress, reclaim unspent escrow after the grace window                        | Change config or KPIs, cancel once active, reclaim while the claim window is open, credit more than the verifier allows |
| **Promoter** (KOL)   | Their own wallet                           | Join a campaign, get a campaign-bound`promoterId`, get a unique tracking link(boneylink), share a tracking link, receive payouts | Attribute a user without that user's signature, report their own progress, join twice, join below the reputation gate   |
| **End user**         | Their own wallet                           | Sign a`Touch` binding their wallet to one promoter for one campaign, act on chain                                                | they never transact with Boney; a relayer submits the signature                                                         |
| **Boney relayer**    | `EventMetricKpiVerifier.reporter`        | Push independently observed metrics that*cap* what a project may credit                                                          | Credit anyone anything; but under-reporting is possible                                                                |
| **Oracle reporter**  | Native-token stake in`OracleCoordinator` | Submit aggregate or per-user reports that land after a dispute window                                                              | Bypass the dispute window, exit stake while a report is in flight                                                       |
| **Governor**         | `OracleCoordinator` owner                | Dispute a report inside its window, slash the reporter, withdraw the slash pool                                                    | Apply a report early, dispute after the window closes                                                                   |
| **Attestor**         | A key in`AttestationVerifier`            | Sign attestations about a wallet's off-chain metrics                                                                               | Write reputation directly, replay a signature, satisfy a k>1 threshold alone                                            |
| **Schema registrar** | `ReputationRegistry` owner               | Register schemas, set weights, freshness windows and value ceilings                                                                | Erase attested data                                                                                                     |
| **Vault admin**      | `EscrowVault` admin                      | Wire the registrar, exactly once                                                                                                   | Move any campaign's funds                                                                                               |

There is deliberately no protocol-wide owner that can touch escrow. 

The governor and the registrar are governance over *scoring* and *reporting*, never over custody.

## The core loop

```
1. CREATE     project → CampaignRegistry.createCampaign(cfg, kpis, tiers)
                        deploys an immutable Campaign, claims the name, binds the escrow token

2. FUND       project → EscrowVault.deposit(campaign, rewardPool)
              project → Campaign.activate()          blocked while underfunded

3. JOIN       promoter → Campaign.join()             reputation gate, issues promoterId
                                                     (allowed while Pending, so boneylinks exist at launch)

4. ATTRIBUTE  promoter shares a boneylink carrying promoterId
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

Step 6 is one transaction.

There is no separate claim step: 

- settlement runs inline at the end of every crediting report,
- so by the time anyone calls the public `settle`, the ladder is already caught up.
- The public entry point is permissionless.

## Design principles

| Principle                                           | How it shows up in the code                                                                                                                                   |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Escrow by default                                   | `activate()` reverts `NotFunded(balance, required)` until the full `rewardPool` is in the vault                                                         |
| Custody knows nothing                               | `EscrowVault` has no concept of KPIs, tiers or reputation; only a campaign spends its own balance                                                           |
| Immutability where funds are at stake               | Campaign config, KPIs and tiers are`immutable` / write-once at construction                                                                                 |
| Fail open on exhaustion, closed on misconfiguration | A tier that outruns the pool pays partial and emits`PoolExhausted(shortfall)`; a verifier with no config credits nothing                                    |
| Consent is the anti-abuse primitive                 | Attribution requires the*end user's* EIP-712 signature, and it expires after the max-touch-duration                                                         |
| A verifier may only shrink a claim                  | `Campaign` reverts `VerifierOvercredit(credited, max)` on any adapter returning more than was claimed                                                     |
| Ordering lives inside signatures                    | Touch recency is`signedAt`                                                                                                                                  |
| Bound anything that loops                           | `MAX_KPIS`, `MAX_TIERS_PER_KPI`, `MAX_EVIDENCE_ACTIONS`, `MAX_SCHEMAS`, `MAX_ATTESTATIONS` all exist to keep a payout path from exceeding block gas |
| The facade is not trusted                           | `Boney` holds no funds and has no privileged role; every call it makes could be made directly                                                               |
| Progressive decentralization                        | k-of-n attestations and staked reporting are in the contracts from day one, configured down to 1-of-1                                                         |

## What the protocol does not do

- **It does not measure anything itself.** Solidity cannot read historical event logs. Every KPI
  number originates off chain. What the protocol enforces is that a project's claim is *capped* at an
  independent observer's reading — see [chapter 06](./06-verification.md).
- **It does not redirect credit.** A verifier can deny a promoter a delta they did not earn; it
  cannot hand that delta to the promoter who did. The uncredited portion stays uncredited and a
  corrected report can land later.
- **It does not credit aggregate metrics to individuals.** TVL and volume have no per-user proof, so
  they advance campaign totals for display and pay nobody.
- **It does not know social identity.** The reputation registry stores `(wallet, schemaId) => number`.
  Handles are seen off chain by an attestor, who signs a figure.

## Glossary

| Term                    | Meaning                                                                                                                                                               |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Campaign**      | One contract holding immutable config, KPI specs, tier ladders, and all progress accounting                                                                           |
| **Project**       | The campaign's owner: funds it, controls its lifecycle, receives unspent escrow                                                                                       |
| **Promoter**      | A KOL/creator/affiliate earning from the campaign.`promoterId = keccak256(abi.encode(campaign, wallet))`                                                            |
| **Promoter id**   | An opaque, campaign-bound id. Registered by the campaign at`join()`, encoded in tracking links                                                                      |
| **Touch**         | A user-signed EIP-712 message binding their wallet to one promoter id in one campaign, with an expiry                                                                 |
| **KPI**           | One measurable objective:`KpiSpec { kind, verifier, target, aggregate, params }`                                                                                    |
| **Aggregate KPI** | Campaign-level, oracle-reported, credits no individual promoter                                                                                                       |
| **Gated KPI**     | One whose`KpiSpec.verifier` is non-zero, so every claim is capped. `verifier == address(0)` is ungated and credits the claim as given                             |
| **Tier**          | `{threshold, reward}`. Per-promoter, per-KPI, strictly ascending thresholds                                                                                         |
| **Verifier**      | An`IKpiVerifier` adapter that caps a reported claim. May only shrink it                                                                                             |
| **Evidence**      | `Types.Action[]` (`{blockNumber, timestamp, amount}`) passed with a report, so each action is attributed at its own block. Bounded by `MAX_EVIDENCE_ACTIONS`    |
| **Reporter**      | Whoever may call`reportUserAction`: the project, or the oracle coordinator or chainlink automated reporting                                                        |
| **Relayer**       | The off-chain process feeding`EventMetricKpiVerifier` with observed metrics. Distinct from the oracle                                                               |
| **Attestor**      | Off-chain signer of reputation attestations                                                                                                                           |
| **Schema**        | A registered reputation metric (`ETHOS_SCORE`, `X_REACH`, `X_FOLLOWERS`) with a weight, freshness window and ceiling                                            |
| **BoneyScore**    | The app's name for`ReputationRegistry.scoreOf(wallet)` — the weighted sum of fresh attested values                                                                 |
| **Claim grace**   | `CLAIM_GRACE` after `end()`, during which reporting and settlement stay open and reclaim does not                                                                 |
| **Checkpoint**    | The relayer's cursor, kept on chain so the relayer is stateless. Stored in`EventMetricKpiVerifier.lastScannedBlock`, read with `checkpointOf(campaign, kpiIndex)` |

## A note on vocabulary

The Solidity says `KOL` and `promoter`; the web app says **Promoter** and **referral** in user-facing
copy. Some on-chain identifiers cannot be renamed without breaking deployed ABIs. This book uses
"promoter" for the earner and "end user" for the wallet whose activity is measured, and names the
on-chain identifier when it differs. [will update]
