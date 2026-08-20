# Boney — creation to settlement

The end-to-end flow as the contracts actually implement it today.

Each diagram is a checked-in SVG with its Mermaid source collapsed underneath. The SVGs are
generated from that source (`mermaid-cli`, `htmlLabels: false` so GitHub's SVG sanitizer cannot
strip the labels), so they display regardless of whether a viewer renders Mermaid. Edit the source,
re-render, commit both.

Cast of contracts:

| Contract | Role |
|---|---|
| `Boney` | Optional facade. Holds no funds, has no privileged role — every call it makes could be made directly. |
| `CampaignRegistry` | Factory + directory. The only account that may bind a campaign to a token in the vault. |
| `Campaign` | One campaign. Immutable config, KPI specs, tier ladders, progress, settlement. |
| `EscrowVault` | Custody. Knows a campaign's token and balance, nothing about KPIs. |
| `AttributionRegistry` | Which promoter owns which end user, per campaign. LAST_TOUCH, user-signed. |
| `ReputationRegistry` | Composite score from attested metrics. Read once, at join. |
| `OracleCoordinator` | Staked reporting with an optimistic dispute window. |
| `*KpiVerifier` | Optional adapters that may only ever *reduce* a claim. |

<details>
<summary>Plain-text version of the whole flow (no rendering required)</summary>

```
CREATION                          Pending
  Project --createCampaign--> CampaignRegistry
                                |  Names.key(name) -> NameTaken if claimed
                                |  new Campaign(...) validates window/tiers/minReputation
                                +- EscrowVault.registerCampaign(campaign, token)
                                   only the registry may bind a campaign to a token

FUNDING + ACTIVATION              Pending --> Active
  Project --approve+deposit--> EscrowVault    credits what ACTUALLY arrived
  Project --activate()--> Campaign            balanceOf >= rewardPool, else NotFunded

PROMOTER                          join() allowed while Pending too
  KOL --join()--> Campaign --scoreOf--> ReputationRegistry   (read once, at join)
                     +- registerPromoter(keccak(campaign, promoter)) --> AttributionRegistry

ATTRIBUTION  <- the consent step, and the anti-abuse primitive
  KOL -link(promoterId)-> End user --signs EIP-712 Touch--+
  anyone relays --storeTouch()--> AttributionRegistry <---+
     lands only if: signedAt <= now < expiresAt <= now + min(attributionWindow, cap)
                    campaign not past endTime and not terminal
                    signedAt STRICTLY newer than stored          (LAST_TOUCH)

REPORTING --> SETTLEMENT          one transaction, no separate claim
  Project -------------+
                       +--> Campaign.reportUserAction(kpi, user, newTotal, evidence)
  Reporter -stake-> OracleCoordinator -submitUserReport-> [dispute window] -apply-+
                       +- governor disputes -> slashed, never applied

     resolve promoter --> live touch? yes -> them
                          no + Ended -> stored touch (expired OK)
                          no          -> revert NoAttribution
     verifier? --> GuardedKpiVerifier --always--> EventMetricKpiVerifier (relayer scan)
                                      +-optional-> project verifier
                    AGREE: diverge over tolerance -> revert   CAP: min(boney, project)
                    may only SHRINK a claim, never redirect the payee
     credit = verifiedTotal - alreadyCredited     (cumulative, so replay is a no-op)
     _settle() walks the tier ladder INLINE --> EscrowVault.release(promoter, tierPay)
                    tierPay = min(reward, pool - paidOut); tier marked settled either way
                    short -> PoolExhausted, never reverts

WIND-DOWN                         Active/Paused --> Ended
  end()            project anytime, or ANYONE once past endTime
  |- CLAIM_GRACE = 20 min: reporting still open
  +- reclaimUnspent()  only after grace -> EscrowVault.reclaim(project, remainder)

  reporting closes exactly where reclaim opens - never both, so escrow is never
  reclaimable while credit is still owed
```

</details>

---

## 1. The happy path

![Boney happy path: creation, funding, activation, promoter join, attribution, reporting and settlement, wind-down](flow/happy-path.svg)

<details>
<summary>Mermaid source</summary>

```mermaid
sequenceDiagram
    autonumber
    actor P as Project
    actor K as Promoter (KOL)
    actor U as End user
    participant R as CampaignRegistry
    participant C as Campaign
    participant V as EscrowVault
    participant A as AttributionRegistry
    participant Rep as ReputationRegistry

    note over P,V: CREATION — status Pending
    P->>R: createCampaign(cfg, kpis, tiers)
    R->>R: Names.key(name) — reverts NameTaken if claimed
    R->>C: new Campaign(...) validates window, tiers, minReputation
    R->>V: registerCampaign(campaign, token)
    V-->>V: emit CampaignRegistered
    R-->>R: emit CampaignCreated

    note over P,V: FUNDING + ACTIVATION — Pending to Active
    P->>V: approve + deposit(campaign, rewardPool)
    V-->>V: credits amount actually received, emit Deposited
    P->>C: activate()
    C->>V: balanceOf(this) at least rewardPool, else NotFunded
    C-->>C: emit Activated, StatusChanged

    note over K,A: PROMOTER ONBOARDING
    K->>C: join()
    C->>Rep: scoreOf(promoter) clears minReputation, else InsufficientReputation
    C->>A: registerPromoter(promoterId = keccak(campaign, promoter))
    C-->>C: emit PromoterJoined

    note over U,A: ATTRIBUTION — the consent step
    K-->>U: tracking link carrying promoterId
    U->>U: sign EIP-712 Touch{campaign, promoterId, signedAt, expiresAt}
    K->>A: storeTouch(user, touch, sig, relayer)
    A->>C: staticcall attributionWindow / endTime / status
    A-->>A: emit TouchStored, only if strictly newer signedAt

    note over P,V: REPORTING to SETTLEMENT — one call
    P->>C: reportUserAction(kpiIndex, user, newTotal, evidence)
    C->>A: resolve promoter (activePromoter, or stored touch once Ended)
    C->>C: verifier.verify(...) may only reduce
    C-->>C: credit newTotal minus alreadyCredited, emit ProgressCredited
    C->>C: _settle() walks the tier ladder inline
    C->>V: release(promoter, tierPay)
    V-->>V: emit Released
    C-->>C: emit TierSettled, plus PoolExhausted if pool ran short

    note over P,V: WIND-DOWN
    P->>C: end() — or anyone, once past endTime
    note over C: CLAIM_GRACE = 20 min, reporting still open
    P->>C: reclaimUnspent() — only after grace
    C->>V: reclaim(project, remainder)
```

</details>

---

## 2. Lifecycle

`Paused` blocks reporting but cannot strand anyone: `end()` is permissionless once `endTime` passes,
which converts a parked campaign into an `Ended` one and starts the grace clock.

![Campaign lifecycle state machine: Pending, Active, Paused, Ended, Cancelled](flow/lifecycle.svg)

<details>
<summary>Mermaid source</summary>

```mermaid
stateDiagram-v2
    [*] --> Pending: createCampaign
    Pending --> Active: activate() — onlyProject, fully funded, before endTime
    Pending --> Cancelled: cancel() — onlyProject, Pending only
    Active --> Paused: pause()
    Paused --> Active: unpause()
    Active --> Ended: end()
    Paused --> Ended: end()
    Cancelled --> [*]: reclaimUnspent() immediately
    Ended --> [*]: reclaimUnspent() after endedAt + CLAIM_GRACE

    note right of Pending
        join() already allowed,
        so KOLs can prepare links
    end note
    note right of Active
        reports accepted inside
        [startTime, endTime]
    end note
    note right of Ended
        reports still accepted for
        CLAIM_GRACE (20 min).
        Expired touches honoured here.
    end note
```

</details>

**The key invariant:** reporting and reclaim are exact complements. Reporting closes at
`endedAt + CLAIM_GRACE`; `reclaimUnspent` opens strictly after it. Escrow is never reclaimable
while credit is still owed, and the two windows can never both be open.

---

## 3. Inside `reportUserAction`

Everything below happens in one transaction. There is no separate claim step — `_settle` runs at
the end of every crediting report.

![Control flow inside reportUserAction, ending in the inline tier-ladder settlement](flow/report-user-action.svg)

<details>
<summary>Mermaid source</summary>

```mermaid
flowchart TD
    S([reportUserAction]) --> ST{"status reportable?"}
    ST -->|"not Active, and not Ended-in-grace"| XW[revert WrongStatus]
    ST --> AU{"caller is project or oracleCoordinator?"}
    AU -->|no| XR[revert NotReporter]
    AU --> W{"inside [startTime, endTime]?<br/>(skipped once Ended)"}
    W -->|no| XO[revert OutsideWindow]
    W --> AG{"aggregate KPI?"}
    AG -->|yes| XA[revert AggregateKpi]
    AG --> M{"newTotal ≥ alreadyCredited?"}
    M -->|no| XM[revert NonMonotonic]
    M -->|equal| NOOP(["no-op: replay"])
    M --> AT{"attribution resolves?"}
    AT -->|no| XN[revert NoAttribution]
    AT --> VF{"verifier configured?"}
    VF -->|no| CR[credit raw newTotal]
    VF -->|yes| VC["verify() → verifiedTotal<br/>reverts VerifierOvercredit if above claim"]
    VC --> CR
    CR --> D{"credited above zero?"}
    D -->|no| NOOP2([no-op])
    D --> UP["update _userCredited, _progress,<br/>_totalProgress → emit ProgressCredited"]
    UP --> SET["_settle: walk tier ladder"]
    SET --> L{"progress ≥ next tier<br/>threshold?"}
    L -->|no| DONE([done])
    L -->|yes| PAY["tierPay = min(reward, pool minus paidOut)<br/>mark tier settled either way"]
    PAY --> REL["escrowVault.release → emit TierSettled"]
    REL --> EX{"tierPay below reward?"}
    EX -->|yes| PE["emit PoolExhausted, never reverts"]
    EX --> L
    PE --> L
```

</details>

### Attribution resolution

![Attribution resolution: live touch, or the stored touch once Ended, else revert](flow/attribution-resolution.svg)

<details>
<summary>Mermaid source</summary>

```mermaid
flowchart LR
    Q(["who gets paid for this user?"]) --> LIVE{"live touch? expiresAt after now"}
    LIVE -->|yes| PAY([that promoter])
    LIVE -->|no| E{"status == Ended?"}
    E -->|no| NONE([revert NoAttribution])
    E -->|yes| STORED([stored touch, expired or not])
```

</details>

The post-end relaxation exists so withheld reports filed during `CLAIM_GRACE` don't all revert
`NoAttribution` — which would hand the project back exactly the escrow the grace window protects.
It is safe only because `storeTouch` refuses a touch once the campaign is past `endTime` or
terminal, so the stored touch is the user's latest intent *from while the campaign was running*.

---

## 4. Two ways a report reaches the campaign

The oracle path is what makes a promoter payable without the project's cooperation.

![The two report paths: direct from the project, or staked through the OracleCoordinator](flow/report-paths.svg)

<details>
<summary>Mermaid source</summary>

```mermaid
flowchart TD
    subgraph direct["Direct — trusted project"]
        P([Project]) --> RUA[Campaign.reportUserAction]
    end

    subgraph oracle["Oracle — staked, optimistic"]
        REP([Reporter]) -->|stake ETH ≥ minStake| OC[OracleCoordinator]
        OC -->|submitUserReport| PEND["pending, deadline = now + disputeWindow"]
        PEND -->|governor disputes| SLASH["slashed, never applied"]
        PEND -->|window elapsed| AUR[applyUserReport → Campaign.reportUserAction]
        AUR --> RUA
        OC -->|"submitReport → applyReport"| AGG["applyAggregateUpdate<br/>(analytics only, credits nobody)"]
    end

    RUA --> SETTLE([credit + settle inline])
```

</details>

## 5. Verifier composition

A verifier may only ever shrink a claim, and can never redirect the payee. `Campaign` independently
rejects any verifier returning more than was claimed.

![Verifier composition: GuardedKpiVerifier over Boney's canonical verifier plus an optional project verifier](flow/verifier-composition.svg)

<details>
<summary>Mermaid source</summary>

```mermaid
flowchart LR
    C([Campaign]) --> G[GuardedKpiVerifier]
    G -->|always| B["EventMetricKpiVerifier<br/>relayer-pushed observed totals,<br/>capped by eth_getLogs scan"]
    G -->|optional| PV["project's own IKpiVerifier<br/>e.g. TouchWindowVerifier"]
    B --> CMP{"mode"}
    PV --> CMP
    CMP -->|AGREE| AG["divergence over toleranceBps reverts<br/>VerifierDisagreement; else Boney's value"]
    CMP -->|CAP| CP["credit min(boney, project)"]
```

</details>

`EventMetricKpiVerifier` exists because Solidity cannot read historical logs — there is no
`eth_getLogs` on chain. A trusted relayer scans the real logs off-chain and pushes totals ahead of
time; `verify` is then a stored-value lookup and a comparison.

---

## 6. Off-chain: what the UI and subgraph read

![Which on-chain events feed each subgraph handler and the web UI](flow/subgraph.svg)

<details>
<summary>Mermaid source</summary>

```mermaid
flowchart LR
    subgraph chain["On chain"]
        CC[CampaignCreated]
        TS[TouchStored / PromoterRegistered]
        PJ[PromoterJoined]
        PC[ProgressCredited]
        TSE[TierSettled]
        SC[StatusChanged]
        TR[ERC-20 Transfer]
    end

    subgraph sg["Subgraph — Base Sepolia"]
        CC --> H1[registry.ts → Campaign, Kpi<br/>spawns CampaignEvents template]
        TS --> H2[attribution.ts → Touch, Promoter]
        PJ --> H3[campaign.ts]
        PC --> H3
        TSE --> H3
        SC --> H3
        TR --> H4[transfer.ts → KpiAction<br/>TransferToActor preset]
    end

    subgraph web["web/"]
        H1 --> UI[discovery, campaign detail]
        H2 --> UI
        H3 --> UI
        H4 --> UI
        TS -.->|"direct getLogs fallback<br/>useCampaignTouches"| UI
        PJ -.->|"useCampaignPromoters"| UI
    end
```

</details>

`startBlock` is the `CampaignRegistry` **deployment** block, not a recent one: templates only spawn
from `CampaignCreated`, and a dynamically created data source never indexes blocks before it was
spawned. Starting late means already-deployed campaigns never spawn their KPI templates and the
subgraph syncs clean while indexing nothing.

---

## Notes on things that surprise people

- **There is no claim step.** `_settle` runs inline at the end of every crediting report, so by the
  time anyone calls the public `Campaign.settle` (or `Boney.claimRewards`), `_settledTiers` is
  already caught up and the ladder walk pays zero. The public entry point is permissionless and
  correct, but dormant by construction.
- **Reported amounts are cumulative per user, not deltas.** Only `newTotal − alreadyCredited` is
  applied, so a replayed report is a no-op rather than an inflation vector.
- **Pool exhaustion never reverts.** A crossed tier is marked settled even when the pool cannot
  cover it, and the shortfall surfaces as `PoolExhausted`. Reverting would let one exhausted tier
  block all further reporting for everyone.
- **The facade is not trusted.** `Boney` can be replaced, or several run in parallel for different
  frontends, with no migration of escrow or campaign state.
- **Deposits credit what actually arrived.** The vault uses an internal ledger rather than
  `token.balanceOf(this)`, so a fee-on-transfer token, a rebase, or an unsolicited transfer cannot
  shift another campaign's spendable balance.
