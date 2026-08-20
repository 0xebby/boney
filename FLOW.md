# Boney — creation to settlement

The end-to-end flow as the contracts actually implement it today. Diagrams are Mermaid, so they
render on GitHub and in most editors.

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

---

## 1. The happy path

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

    rect rgb(238, 244, 255)
    note over P,V: Creation — status: Pending
    P->>R: createCampaign(cfg, kpis, tiers)
    R->>R: Names.key(name) → reverts NameTaken if claimed
    R->>C: new Campaign(...) validates window, tiers, minReputation
    R->>V: registerCampaign(campaign, token)
    V-->>V: emit CampaignRegistered
    R-->>R: emit CampaignCreated
    end

    rect rgb(240, 249, 240)
    note over P,V: Funding + activation — Pending → Active
    P->>V: approve + deposit(campaign, rewardPool)
    V-->>V: credits amount *actually received*, emit Deposited
    P->>C: activate()
    C->>V: balanceOf(this) ≥ rewardPool ? else NotFunded
    C-->>C: emit Activated, StatusChanged
    end

    rect rgb(255, 249, 235)
    note over K,A: Promoter onboarding
    K->>C: join()
    C->>Rep: scoreOf(promoter) ≥ minReputation ? else InsufficientReputation
    C->>A: registerPromoter(promoterId = keccak(campaign, promoter))
    C-->>C: emit PromoterJoined
    end

    rect rgb(252, 240, 250)
    note over U,A: Attribution — the consent step
    K-->>U: tracking link carrying promoterId
    U->>U: sign EIP-712 Touch{campaign, promoterId, signedAt, expiresAt}
    K->>A: storeTouch(user, touch, sig, relayer)
    A->>C: staticcall attributionWindow / endTime / status
    A-->>A: emit TouchStored (only if strictly newer signedAt)
    end

    rect rgb(240, 240, 248)
    note over P,V: Reporting → settlement, in one call
    P->>C: reportUserAction(kpiIndex, user, newTotal, evidence)
    C->>A: resolve promoter (activePromoter, or stored touch once Ended)
    C->>C: verifier.verify(...) → may only reduce
    C-->>C: credit newTotal − alreadyCredited, emit ProgressCredited
    C->>C: _settle() walks the tier ladder inline
    C->>V: release(promoter, tierPay)
    V-->>V: emit Released
    C-->>C: emit TierSettled (+ PoolExhausted if pool ran short)
    end

    rect rgb(250, 240, 240)
    note over P,V: Wind-down
    P->>C: end() — or anyone, once past endTime
    note over C: CLAIM_GRACE = 20 min: reporting still open
    P->>C: reclaimUnspent() — only after grace
    C->>V: reclaim(project, remainder)
    end
```

---

## 2. Lifecycle

`Paused` blocks reporting but cannot strand anyone: `end()` is permissionless once `endTime` passes,
which converts a parked campaign into an `Ended` one and starts the grace clock.

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

**The key invariant:** reporting and reclaim are exact complements. Reporting closes at
`endedAt + CLAIM_GRACE`; `reclaimUnspent` opens strictly after it. Escrow is never reclaimable
while credit is still owed, and the two windows can never both be open.

---

## 3. Inside `reportUserAction`

Everything below happens in one transaction. There is no separate claim step — `_settle` runs at
the end of every crediting report.

```mermaid
flowchart TD
    S([reportUserAction]) --> ST{status reportable?}
    ST -->|"not Active, and not Ended-in-grace"| XW[revert WrongStatus]
    ST --> AU{caller is project<br/>or oracleCoordinator?}
    AU -->|no| XR[revert NotReporter]
    AU --> W{"inside [startTime, endTime]?<br/>(skipped once Ended)"}
    W -->|no| XO[revert OutsideWindow]
    W --> AG{aggregate KPI?}
    AG -->|yes| XA[revert AggregateKpi]
    AG --> M{"newTotal ≥ alreadyCredited?"}
    M -->|no| XM[revert NonMonotonic]
    M -->|equal| NOOP([no-op: replay])
    M --> AT{attribution resolves?}
    AT -->|no| XN[revert NoAttribution]
    AT --> VF{verifier configured?}
    VF -->|no| CR[credit raw newTotal]
    VF -->|yes| VC["verify() → verifiedTotal<br/>reverts VerifierOvercredit if &gt; claim"]
    VC --> CR
    CR --> D{"credited = verifiedTotal − already<br/>&gt; 0?"}
    D -->|no| NOOP2([no-op])
    D --> UP["update _userCredited, _progress,<br/>_totalProgress → emit ProgressCredited"]
    UP --> SET[["_settle: walk tier ladder"]]
    SET --> L{"progress ≥ next tier<br/>threshold?"}
    L -->|no| DONE([done])
    L -->|yes| PAY["tierPay = min(reward, pool − paidOut)<br/>mark tier settled either way"]
    PAY --> REL["escrowVault.release → emit TierSettled"]
    REL --> EX{"tierPay &lt; reward?"}
    EX -->|yes| PE[emit PoolExhausted — never reverts]
    EX --> L
    PE --> L
```

### Attribution resolution

```mermaid
flowchart LR
    Q([who gets paid for this user?]) --> LIVE{live touch?<br/>expiresAt &gt; now}
    LIVE -->|yes| PAY([that promoter])
    LIVE -->|no| E{status == Ended?}
    E -->|no| NONE([revert NoAttribution])
    E -->|yes| STORED([stored touch, expired or not])
```

The post-end relaxation exists so withheld reports filed during `CLAIM_GRACE` don't all revert
`NoAttribution` — which would hand the project back exactly the escrow the grace window protects.
It is safe only because `storeTouch` refuses a touch once the campaign is past `endTime` or
terminal, so the stored touch is the user's latest intent *from while the campaign was running*.

---

## 4. Two ways a report reaches the campaign

The oracle path is what makes a promoter payable without the project's cooperation.

```mermaid
flowchart TD
    subgraph direct["Direct — trusted project"]
        P([Project]) --> RUA[Campaign.reportUserAction]
    end

    subgraph oracle["Oracle — staked, optimistic"]
        REP([Reporter]) -->|stake ETH ≥ minStake| OC[OracleCoordinator]
        OC -->|submitUserReport| PEND[["pending, deadline = now + disputeWindow"]]
        PEND -->|governor disputes| SLASH[["slashed; never applied"]]
        PEND -->|window elapsed| AUR[applyUserReport → Campaign.reportUserAction]
        AUR --> RUA
        OC -->|"submitReport → applyReport"| AGG["applyAggregateUpdate<br/>(analytics only, credits nobody)"]
    end

    RUA --> SETTLE([credit + settle inline])
```

## 5. Verifier composition

A verifier may only ever shrink a claim, and can never redirect the payee. `Campaign` independently
rejects any verifier returning more than was claimed.

```mermaid
flowchart LR
    C([Campaign]) --> G[GuardedKpiVerifier]
    G -->|always| B["EventMetricKpiVerifier<br/>relayer-pushed observed totals,<br/>capped by eth_getLogs scan"]
    G -->|optional| PV["project's own IKpiVerifier<br/>e.g. TouchWindowVerifier"]
    B --> CMP{mode}
    PV --> CMP
    CMP -->|AGREE| AG["divergence &gt; toleranceBps → revert<br/>VerifierDisagreement; else Boney's value"]
    CMP -->|CAP| CP["credit min(boney, project)"]
```

`EventMetricKpiVerifier` exists because Solidity cannot read historical logs — there is no
`eth_getLogs` on chain. A trusted relayer scans the real logs off-chain and pushes totals ahead of
time; `verify` is then a stored-value lookup and a comparison.

---

## 6. Off-chain: what the UI and subgraph read

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
