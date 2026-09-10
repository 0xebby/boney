# Boney — Protocol Specification

The complete, self-contained description of the Boney protocol: what each contract does, what it
refuses to do, the off-chain processes it depends on, and the properties the whole thing is supposed
to hold.

This is written against the code in this repository, not against an intended design. Where the code
and an older document disagree, this book follows the code and says so.

---

## The book

| | Chapter | What it answers |
|---|---|---|
| 01 | [Overview](./01-overview.md) | What Boney is, who the actors are, the core loop, design principles |
| 02 | [Architecture](./02-architecture.md) | The module map, who may call whom, the deploy graph, trust assumptions, upgrade posture |
| 03 | [Campaign lifecycle](./03-lifecycle.md) | States, transitions, time windows, and the reporting/reclaim complement |
| 04 | [Attribution](./04-attribution.md) | Touches, LAST_TOUCH ordering, EIP-712, promoter ids, the post-end fallback |
| 05 | [KPI model and settlement](./05-kpi-model.md) | `KpiSpec`, tier ladders, cumulative reporting, the inline payout walk |
| 06 | [KPI verification](./06-verification.md) | `GuardedKpiVerifier`, `EventMetricKpiVerifier`, `TouchWindowVerifier` |
| 07 | [Reputation and attestations](./07-reputation.md) | Schemas, weights, freshness, k-of-n attestations, score ceilings |
| 08 | [Oracle layer](./08-oracle.md) | Staked optimistic reporting, disputes, slashing, the withholding path |
| 09 | [Off-chain stack](./09-offchain.md) | The indexer, the relayer, `report-window`, the subgraph, the web app |
| 10 | [Integration guides](./10-integration.md) | Step-by-step for projects, promoters, users, relayers, reporters, frontends |
| 11 | [API reference](./11-reference.md) | Every external function, event, error and constant, per contract, plus `IKpiVerifier`, `Types`, `Names` |

Eleven chapters, and that is the whole book. There is no separate security or deployments chapter:
the trust boundaries and assumptions are in [chapter 02](./02-architecture.md#trust-boundaries--who-may-call-what),
and live addresses are generated rather than written down — `web/src/lib/deployments.ts` comes from
Foundry's broadcast via `pnpm deployments <chainId>`, and the deploy runbook is in
[`../../README.md`](../../README.md).

## Reading order

- **New to the protocol** — 01, 02, 03, then 05. That is the whole mechanism.
- **Integrating a project** — 10 first, then 05 and 06 for what you are actually promising, then 09
  for the two processes you have to keep running.
- **Running a promoter-facing frontend** — 04, 10, and the frontend notes at the end of 09.
- **Operating the off-chain halves** — 09 and 06, in that order. Neither makes sense alone.
- **Reviewing for security** — 02 for the trust boundaries and assumptions, then 04 and 06, which
  hold the two rules most likely to credit the wrong person.

## Related documents

Outside this book, and still current:

| File | What it is |
|---|---|
| [`../../README.md`](../../README.md) | Quickstart, build, deploy, and the shortened-duration table |
| [`../FLOW.md`](../FLOW.md) | The same flows as diagrams (checked-in SVGs with Mermaid source) |
| [`../KPI_VERIFICATION.md`](../KPI_VERIFICATION.md) | The design *reasoning* behind the verification layer, decision by decision |
| [`../KPI_VERIFICATION_WALKTHROUGH.md`](../KPI_VERIFICATION_WALKTHROUGH.md) | The same flow worked through with concrete numbers |
| [`../todo.md`](../todo.md) | Implementation status and deferred work |

Chapter 06 covers *what* the verification layer does; `KPI_VERIFICATION.md` covers *why* each piece
is shaped that way. Read the second one before changing any of it.

## Two things to know before you read anything else

**This branch shortens every time constant.** `bscoretest` exists to make manual testing fast, so
`CLAIM_GRACE` is 20 minutes rather than 7 days, the oracle dispute window is 4 minutes rather than a
day, and so on. Every number in this book is the number this branch actually compiles, with the
protocol value named alongside it. The full table is in [chapter 03](./03-lifecycle.md#time-constants).

**The contracts are not audited.** [Chapter 02](./02-architecture.md#trust-assumptions) states the
trust assumptions plainly rather than burying them. None of them can move escrow; they bound how much
you should trust reported *progress*.

---

Source layout, for cross-referencing:

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
```
