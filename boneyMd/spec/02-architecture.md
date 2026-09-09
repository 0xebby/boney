# 02 — Architecture

## The module map

Ten deployed contracts, in three tiers: a facade nobody has to use, six protocol modules, and three
KPI verification adapters. `Campaign` is the eleventh contract in the tree but is deployed per
campaign, by the registry, rather than once at setup.

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

## Responsibilities

### `Boney` — the facade

Deliberately thin and stateless. It resolves campaign ids to addresses, batches the token-approval
dance so a project needs one approval rather than one per campaign, and assembles the paginated views
a marketplace UI wants (`browseCampaigns`, `campaignView`).

It holds no funds, owns no campaign state, and has no privileged role in any module.

The one thing it adds is a check the registry deliberately omits: `createCampaign` reverts
`NotProject` unless `cfg.project == msg.sender`.

### `CampaignRegistry` — factory, directory, registrar

Deploys every campaign in full, assigns sequential ids, indexes by project, and enforces
**name uniqueness**.

It is also the escrow vault's **registrar**: the only account that may bind a campaign to a token.

That is what stops an attacker pre-registering a real campaign address against a token of their
choosing.

Deployment is permissionless — anyone may run a campaign — but every campaign the marketplace can see
came from here. `isCampaign(address)` is the membership test other modules use to reject spoofed
targets.

The registry does **not** require `cfg.project == msg.sender`. 

Requiring it would break every composable caller (facades, routers, multisig wrappers), which would see the wrapper rather than the
project.

It is safe because naming someone else as the project grants the caller nothing: `project` is
the address that must fund the campaign, and the only one that can activate it or reclaim escrow.

A campaign created for a project that never funds it is an inert `Pending` contract.

### `Campaign` — the machine

One contract per campaign. Everything except window(during extend and top-up) that determines a payout is frozen at construction: project,
token, reward pool, attribution window, minimum reputation, KPI specs, and tier ladders. 

A project cannot move the goalposts after promoters have worked.

It owns all progress accounting, resolves attribution, calls the KPI verifier, credits the delta, and
walks the tier ladder inline. See [chapter 05](./05-kpi-model.md).

### `EscrowVault` — custody, and nothing else

Tracks `campaign => (token, balance)`. Only the campaign itself may `release` or `reclaim`, so a
compromised campaign can never reach another campaign's escrow, 

spoofing is prevented  because the caller *is* the campaign.

Accounting uses an internal ledger rather than `token.balanceOf(this)`, so a fee-on-transfer token, a
rebase, or an unsolicited direct transfer cannot shift any campaign's spendable balance. [stablecoin only reward pools retires this]

Deposits credit the amount **actually received**.

### `AttributionRegistry` — who gets paid for whose actions

Stores one live touch per `(campaign, user)` pair, keyed on the user's signature, and keeps the full
touch **history** alongside it so a report can resolve who held a wallet at the block each action
landed in. 

LAST_TOUCH is ordered by the signed `signedAt`.

`storeTouch` also enforces the campaign's own bounds on chain: it reads the campaign's
`attributionWindow`, `endTime` and `status` through a minimal interface, caps the touch duration at
`min(campaign.attributionWindow, maxTouchDuration)` via `effectiveMaxDuration`, and rejects a touch
for a campaign that is closed. 

None of that is left to the client. See [chapter 04](./04-attribution.md).

Promoter ids are namespaced by registrant, so an id from one campaign cannot farm attribution in
another and no squatter can deny a campaign an id.

### `ReputationRegistry` + `AttestationVerifier` — the join gate(boneyscore)

The registry stores `(wallet, schemaId) => (value, updatedAt)` and computes a weighted score over
fresh values. 

The verifier authenticates k-of-n EIP-712 attestation bundles and consumes per-attestor
nonces. 

Handles never touch the chain. See [chapter 07](./07-reputation.md).

### `OracleCoordinator` — reporting without the project

Staked, optimistic reporting. A reporter posts native-token collateral, submits a report, and the
report lands only after a dispute window passes unchallenged. It carries both kinds:
`submitReport` → `applyAggregateUpdate` (campaign-level, credits nobody), and `submitUserReport` →
`reportUserAction` (credits a promoter and settles inline).

The second exists because without it the campaign's `project` key is the only account that can pay
anyone, which makes an absent or hostile project indistinguishable from one whose promoters simply
earned nothing. See [chapter 08](./08-oracle.md).


Automated Reporting(chainlink CRE)

### The verification layer

`GuardedKpiVerifier` is what a campaign's `KpiSpec.verifier` should point at. It always consults
`EventMetricKpiVerifier` (Boney's own reading, fed by an independent relayer scanning real logs) and
optionally cross-checks a second verifier per KPI, either requiring agreement or taking the stricter
of the two.

subgraph-fed verifier retires `GuardedKpiVerifier`--- [pending]

`TouchWindowVerifier` is **not** that second verifier, despite being deployed alongside them. It caps
a report at the *currently* attributed promoter's window, and `Campaign` already segments a report by
crediting each evidence action to whoever held the user at that action's block — so wiring it as a
`KpiSpec.verifier` or a `Mode.CAP` cross-check would starve the earlier segments. 

It is deployed for off-chain reads: `windowFloor(campaign, user, params)` gives the client the same cutoff the chain
would use. 

Its `params` is a bare abi-encoded `uint64` lookback, a different layout from the event
source blob a KPI's `params` carries, which is a second reason the two cannot share one spec. See
[chapter 06](./06-verification.md).

## Trust boundaries — who may call what

Every access control in the protocol, in one table. Anything not listed is permissionless.

| Target                                                                                                           | Restricted to                                                        | Enforced by                            |
| ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------- |
| `Campaign.activate / pause / unpause / cancel / reclaimUnspent`                                                | `project`                                                          | `onlyProject`                        |
| `Campaign.end`                                                                                                 | `project`, or **anyone** once `block.timestamp >= endTime` | inline check                           |
| `Campaign.reportUserAction`                                                                                    | `project` or `oracleCoordinator`                                 | `NotReporter`                        |
| `Campaign.applyAggregateUpdate`                                                                                | `oracleCoordinator`                                                | `NotOracle`                          |
| `Campaign.join / settle`                                                                                       | anyone (`join` gated on reputation, `settle` on membership)      | —                                     |
| `EscrowVault.registerCampaign`                                                                                 | `registrar` (the `CampaignRegistry`)                             | `onlyRegistrar`                      |
| `EscrowVault.setRegistrar`                                                                                     | `admin`, once                                                      | `NotAdmin` / `RegistrarAlreadySet` |
| `EscrowVault.release / reclaim`                                                                                | the campaign itself — spends only its own ledger entry              | `msg.sender` *is* the campaign     |
| `EscrowVault.deposit`                                                                                          | anyone, pulling from themselves                                      | pulls from`msg.sender` only          |
| `AttributionRegistry.registerPromoter`                                                                         | anyone — writes only the caller's own namespace                     | namespacing                            |
| `AttributionRegistry.storeTouch`                                                                               | anyone, with the user's valid signature                              | ECDSA recovery                         |
| `ReputationRegistry.registerSchema / setSchemaWeight / setSchemaMaxAge / setSchemaMaxValue / storeAttestation` | `owner`                                                            | `onlyOwner`                          |
| `ReputationRegistry.submitAttestation`                                                                         | anyone — authority comes from the signatures                        | threshold verification                 |
| `AttestationVerifier.setAttestor / setThreshold`                                                               | `owner`                                                            | `onlyOwner`                          |
| `OracleCoordinator.disputeReport / withdrawSlashPool / setCampaignRegistry`                                    | `owner` (governor)                                                 | `onlyOwner`                          |
| `OracleCoordinator.submitReport / submitUserReport`                                                            | anyone with`stake >= minStake`                                     | `NotAReporter`                       |
| `OracleCoordinator.applyReport / applyUserReport`                                                              | anyone, after the dispute window                                     | inline check                           |
| `EventMetricKpiVerifier.setKpiConfig / setReporter`                                                            | `owner`                                                            | `onlyOwner`                          |
| `EventMetricKpiVerifier.reportVerifiedTotal / reportBatch / advanceCheckpoint`                                 | `reporter`                                                         | `onlyReporter`                       |
| `GuardedKpiVerifier.setGuardConfig`                                                                            | `owner`                                                            | `onlyOwner`                          |
| `TouchWindowVerifier`                                                                                          | stateless and view-only                                             | —                                     |

Non Negotiables:

1. **No account can move another campaign's escrow.** Not the vault admin, not the registry, not a
   governor. The vault's only authority is binding a campaign to a token.
2. **`end()` is permissionless after `endTime`.** A project cannot leave a finished campaign in limbo
   to stall the claim grace window and keep the escrow parked.
3. **Ownership is per-module, not global.** `[DeployBoney` happens to point every `owner` at the
   deployer, which is a deployment choice, not a protocol one.]

## Trust assumptions

The contracts are not audited. 

These are the assumptions they cannot remove, stated plainly. 

| You are trusting                                               | For what                                                         | If it is wrong                                                                                                                                        |
| -------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| The**project** key                                       | Reporting per-user progress at all                               | Promoters earn nothing.                                                                                                                               |
| The**relayer** key (`EventMetricKpiVerifier.reporter`) | Reporting the totals it actually observed                        | It can only lower the cap, so the failure mode is unpaid work, not overpayment.                                                                       |
| The**verifier owner**                                    | `setKpiConfig` naming the same event the KPI's `params` name | The cap sits at 0 and every report silently credits nothing.`pnpm relay` refuses to run on drift; nothing on chain checks it                        |
| The**attestor set**                                      | The figures they sign about a wallet                             | A fabricated BoneyScore clears a`minReputation` gate. It buys campaign membership                                                                   |
| The**schema registrar**                                  | Weights, freshness windows and ceilings                          | Scores move under promoters. Existing members keep membership —`join()` reads the score once — but a tightened window can put a gate out of reach |
| The**governor**                                          | Disputing only dishonest oracle reports                          | An honest reporter is slashed, or a dishonest report lands unchallenged. The governor cannot credit anyone directly                                   |
| The**escrow token**                                      | Behaving like an ERC-20                                          | Currently accepts mock ERC-20 tokens in a 1:1 with USDT                                                                                               |

Two structural limits worth naming with them:

- **Nobody can prove a number is complete.** Every KPI figure originates off chain; the protocol
  enforces `min(claim, observed)` and nothing more.
- Two parties under-reporting in the same direction agree, and agreement is all the chain can see.
- **A gated KPI whose relayer is behind is a silent no-op, not a revert.** `Campaign` returns early
  when the verified total does not exceed what is already credited, so the transaction succeeds and
  credits nothing.

## The deploy graph

```
1.  AttributionRegistry(maxTouchDuration)          no dependencies
    AttestationVerifier(admin, initialAttestor)     no dependencies
    ReputationRegistry(admin, attestationVerifier)

2.  OracleCoordinator(governor, minStake, disputeWindow, unstakeDelay)
        ↑ deployed before the registry, which needs its address at construction

3.  EscrowVault(admin)
    CampaignRegistry(vault, reputation, attribution, coordinator)
    vault.setRegistrar(registry)                    ← cycle 1 broken here

4.  coordinator.setCampaignRegistry(registry)       ← cycle 2 broken here
    Boney(registry)                                 reads the rest off the registry

5.  EventMetricKpiVerifier(owner, reporter)         depends on nothing above
    GuardedKpiVerifier(owner, eventMetricVerifier)
    TouchWindowVerifier()
```

`DeployBoney` points every `owner`/`admin`/`governor` at the deployer, and takes two overrides from
the environment: `BONEY_INITIAL_ATTESTOR` (default `DEV_ATTESTOR`) and `BONEY_KPI_REPORTER` (default
the deployer). The second is the one that matters operationally — leaving it at the default makes the
relayer key and the project key the same account, which is exactly what the independence of the cap
is supposed to prevent. [will update]

The verification layer sits outside the graph on purpose: all three are configured **per KPI after a
campaign exists**, not wired at deploy time, so one deployment of each serves every campaign.
`TouchWindowVerifier` is fully stateless and reads whichever attribution registry the *calling*
campaign uses, so it works across registries too. [will update]

`Boney` derives `escrowVault`, `reputationRegistry` and `attributionRegistry` from the registry in its
own constructor, so a facade cannot be wired to a mismatched set of modules.

The runbook, and the live addresses, are not written down here on purpose: they are generated.
`web/src/lib/deployments.ts` comes from Foundry's broadcast artifacts via `pnpm deployments <chainId>`
and is never hand-edited; the deploy sequence itself is in [`../../README.md`](../../README.md).[need the addresses here]

## Immutability and upgrade posture

There are no proxies and no upgrade path. The posture is per-layer:

| Layer                   | Mutability                                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| `Campaign`            | Fully immutable after construction. No admin, no setters. Config, KPIs, tiers frozen          |
| `EscrowVault`         | `admin` immutable; `registrar` write-once. No other mutable state but balances            |
| `CampaignRegistry`    | Append-only. Deployed campaigns and claimed names are permanent                               |
| `AttributionRegistry` | `maxTouchDuration` immutable. No admin at all                                               |
| `ReputationRegistry`  | Governance can add schemas and change weights/windows/ceilings; attested data is never erased |
| `AttestationVerifier` | Governance can rotate the attestor set and threshold, never below a workable size             |
| `OracleCoordinator`   | `minStake`, `disputeWindow`, `unstakeDelay` immutable; `campaignRegistry` write-once  |
| Verifiers               | Per-KPI configs are replaceable by their owner; a campaign's*choice* of verifier is not     |
| `Boney`               | Replaceable freely — it is untrusted, so a new facade needs no migration                     |

Consequences worth planning around:

- **Changing `CLAIM_GRACE` means a full redeploy.** It is a `constant` compiled into `Campaign`, and
  `CampaignRegistry` deploys campaigns with `new Campaign(...)`.
- **A campaign cannot be retired.** `cancel()` is reachable only from `Pending`, and the registry is
  append-only. Replacing a demo fixture means redeploying the protocol.
- **A campaign's name is claimed forever.** Ending or cancelling does not release it, because
  recycling one would silently repoint every link, screenshot and indexer row that referenced the
  campaign it used to mean.
- **`minReputation` is immutable, but scores move.** Governance tightening a schema's freshness window
  can put a previously-clearable gate out of reach until a promoter re-attests. Promoters who already
  joined keep their membership: `join()` reads the score once.
- **Re-configuring what a KPI watches abandons its verified totals.** `EventMetricKpiVerifier` keys
  every total by a config `epoch`, and `setKpiConfig` bumps it whenever the new config watches a
  different event — target, signature, param indexes, aggregation, scale, or `windowStartBlock`.
- The bump also resets `lastScannedBlock` to 0 and emits `KpiTotalsInvalidated`, so the window has to be
  re-relayed from scratch. Extending `windowEndBlock` alone does not invalidate anything, which is
  what makes a reporting-close extension cheap.

## Campaign names

`Names` is a pure library so the rules are unit-testable on their own, and so `Campaign` (which
validates shape) and `CampaignRegistry` (which enforces uniqueness) cannot drift into two definitions
of what a name is.

- **Validation** — non-empty, at most `MAX_NAME_BYTES = 32`, printable ASCII only (`0x20`–`0x7E`), and
  not entirely spaces. The high-bit range is excluded, which is all of UTF-8's multi-byte space.
  Failures are `EmptyName()`, `NameTooLong(got, max)` and `InvalidNameChar(index, char)`.
- **Normalization** — trim, collapse runs of inner spaces, lowercase `A-Z`, then `keccak256`. The
  registry indexes on that hash.
- **Why normalize** — uniqueness on raw bytes is defeated by accident. `"Aave"`, `"aave"` and
  `"Aave "` are three distinct byte strings that read as one name to a person.
- **Where each is enforced** — a `Campaign` constructed directly still validates its own name's shape,
  but cannot know whether it duplicates another. Such a campaign never enters the registry's index, so
  it is also invisible to `campaignCount`, `browse`, and the vault. It is outside the marketplace in
  every respect.
- **`isNameAvailable(name)`** is the create form's pre-flight. It returns `false` for a malformed name
  rather than reverting: to a caller asking "may I use this?", an over-long or non-ASCII name is
  unusable, which is the same answer. Normalization happens on chain rather than in the client so the
  two cannot disagree about what counts as a duplicate.
- **When the claim is recorded** — *after* the campaign deploys, so a constructor revert (bad window,
  unreachable gate, malformed name) leaves the name free rather than burning it on a campaign that
  does not exist. A duplicate is `NameTaken(name, existing)`, which names the campaign already
  holding it.
