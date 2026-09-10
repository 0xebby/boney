# 11 — API reference

Every external surface, per contract, then the interface an extension implements and the two libraries
whose shapes cross the ABI boundary. This is the flat lookup; the chapter that explains *why* a given
function behaves the way it does is linked from each section heading.

**Inherited surfaces are real and are not listed per contract.** Every `Ownable` contract carries
`owner()`, `transferOwnership(address)`, `renounceOwnership()`, the `OwnershipTransferred` event, and the
errors `OwnableInvalidOwner(address)` / `OwnableUnauthorizedAccount(address)`. Every `ReentrancyGuard`
contract can revert `ReentrancyGuardReentrantCall()`. Every `EIP712` contract carries `eip712Domain()`,
the `EIP712DomainChanged` event, and `InvalidShortString()` / `StringTooLong(string)`. Anything moving
tokens through `SafeERC20` can revert `SafeERC20FailedOperation(address)`, and anything recovering a
signature can revert OpenZeppelin's `ECDSAInvalidSignature()` / `ECDSAInvalidSignatureLength(uint256)` /
`ECDSAInvalidSignatureS(bytes32)`. The library is OpenZeppelin 5.7.0.

Errors are declared in each module's interface, so a single ABI import covers every revert a module can
produce. The lists below were taken from `forge inspect <Contract> abi`, not from the interfaces, so they
include what a caller actually sees.

---

## `Boney` — facade

`src/Boney.sol` · `IBoney` · no funds, no privileged role ·
[chapter 02](./02-architecture.md#boney--the-facade)

### Immutables

| Getter | Type | Notes |
|---|---|---|
| `registry()` | `ICampaignRegistry` | Set at construction |
| `escrowVault()` | `IEscrowVault` | Read off the registry |
| `reputationRegistry()` | `IReputationRegistry` | Read off the registry |
| `attributionRegistry()` | `IAttributionRegistry` | Read off the registry |

`constructor(address registry_)` — reverts `ZeroAddress`. The three module addresses are read from the
registry rather than passed in, so a facade cannot be wired to a mismatched module set.

### Functions

| Function | Access | Reverts |
|---|---|---|
| `createCampaign(CampaignConfig, KpiSpec[], RewardTier[][]) → (uint256 campaignId, address campaign)` | anyone | `NotProject(cfg.project, msg.sender)` if they differ, plus everything `Campaign`'s constructor and the registry can raise |
| `fundCampaign(uint256 campaignId, uint256 amount)` | anyone | `UnknownCampaign`, `CampaignNotRegistered`, `SafeERC20FailedOperation` |
| `registerAttribution(uint256 campaignId, address user, Touch, bytes signature)` | anyone | `CampaignMismatch(expected, provided)`, plus every `storeTouch` revert |
| `claimRewards(uint256 campaignId, address promoter, uint256 kpiIndex)` | anyone | `NotJoined`, `UnknownKpi`, `WrongStatus` |
| `campaignJoinTarget(uint256 campaignId) → address` | view | `UnknownCampaign` |
| `campaignAddress(uint256 campaignId) → address` | view | `UnknownCampaign` |
| `campaignView(uint256 campaignId) → CampaignView` | view | `UnknownCampaign` |
| `browseCampaigns(uint256 offset, uint256 limit) → CampaignView[]` | view | — (empty past the end) |
| `campaignCount() → uint256` | view | — |
| `reputationOf(address wallet) → uint256` | view | — |
| `promoterProgress(uint256 campaignId, address promoter, uint256 kpiIndex) → uint256` | view | `UnknownCampaign`, `UnknownKpi` |

`fundCampaign` pulls the token to the facade, `forceApprove`s the vault, and deposits — so a project
approves the facade once rather than each campaign's vault allowance separately.

`createCampaign` is the only place the caller-binding check lives. `CampaignRegistry.createCampaign`
does not have it, so a script signing as one address can create a campaign owned by another.

### `CampaignView`

```solidity
struct CampaignView {
    uint256 campaignId;  address campaign;  address project;  string name;
    address token;       uint256 rewardPool;  uint256 paidOut;
    uint64  startTime;   uint64  endTime;     uint256 minReputation;
    CampaignStatus status;  uint256 kpiCount;
}
```

Listing fields only. KPI specs, tier ladders and per-promoter progress come from the campaign itself.

### Errors

`ZeroAddress` · `NotProject(address project, address caller)` ·
`CampaignMismatch(address expected, address provided)` · `SafeERC20FailedOperation(address token)`

---

## `CampaignRegistry` — factory, directory, registrar

`src/campaign/CampaignRegistry.sol` · `ICampaignRegistry` ·
[chapter 02](./02-architecture.md#campaignregistry--factory-directory-registrar)

### Immutables

`escrowVault()` · `reputationRegistry()` · `attributionRegistry()` · `oracleCoordinator()` — all
`address`. `constructor(escrowVault_, reputationRegistry_, attributionRegistry_, oracleCoordinator_)`
reverts `ZeroAddress` on any zero.

### Functions

| Function | Access | Reverts |
|---|---|---|
| `createCampaign(CampaignConfig, KpiSpec[], RewardTier[][]) → (uint256, address)` | anyone | `NameTaken(name, existing)`, `EmptyName`, `NameTooLong(got, max)`, `InvalidNameChar(index, char)`, plus every `Campaign` constructor revert |
| `isNameAvailable(string name) → bool` | view | — (returns `false` for a malformed name) |
| `campaignByName(bytes32 nameKey) → address` | view | — |
| `campaignCount() → uint256` | view | — |
| `campaignAt(uint256 campaignId) → address` | view | `UnknownCampaign(campaignId)` |
| `isCampaign(address) → bool` | view | — |
| `campaignsOf(address project) → address[]` | view | — |
| `browse(uint256 offset, uint256 limit) → address[]` | view | — (empty past the end) |

`createCampaign` deploys the campaign, records the id/index/name claim, then calls
`EscrowVault.registerCampaign(campaign, cfg.token)`. It does **not** require `cfg.project == msg.sender`.

`isCampaign` is the registry's only job for the oracle coordinator, which uses it to reject a report
naming an address that is not a campaign at all.

### Events

`CampaignCreated(uint256 indexed campaignId, address indexed campaign, address indexed project, address token, string name)`

`name` is unindexed: an indexer searching by name needs the normalized key, which it can read from
`campaignByName`.

### Errors

`ZeroAddress` · `UnknownCampaign(uint256)` · `NameTaken(string name, address existing)` ·
`EmptyName` · `NameTooLong(uint256 got, uint256 max)` · `InvalidNameChar(uint256 index, bytes1 char)`

The last three bubble out of `Names.key`. See [chapter 02](./02-architecture.md#campaign-names).

---

## `Campaign` — one campaign

`src/campaign/Campaign.sol` · `ICampaign` · `ReentrancyGuard` · immutable after construction ·
[chapter 03](./03-lifecycle.md), [chapter 05](./05-kpi-model.md)

### Constants

| Constant | Value |
|---|---|
| `CLAIM_GRACE()` | `20 minutes` on this branch (protocol value 7 days) |
| `MAX_KPIS()` | 32 |
| `MAX_TIERS_PER_KPI()` | 32 |
| `MAX_EVIDENCE_ACTIONS()` | 256 |

Why each is bounded: [chapter 03](./03-lifecycle.md#shape-limits).

### Immutables and state

| Getter | Type | Mutability |
|---|---|---|
| `escrowVault()` `attributionRegistry()` `reputationRegistry()` | interface | immutable |
| `oracleCoordinator()` `project()` `token()` | `address` | immutable |
| `rewardPool()` `minReputation()` | `uint256` | immutable |
| `startTime()` `endTime()` `attributionWindow()` | `uint64` | immutable |
| `name()` | `string` | written once in the constructor |
| `status()` | `CampaignStatus` | mutable |
| `paidOut()` | `uint256` | mutable, monotonic |
| `endedAt()` | `uint64` | 0 until `end()` or `cancel()` |

### Lifecycle

| Function | Access | Reverts |
|---|---|---|
| `activate()` | `project` | `NotProject`, `WrongStatus`, `NotFunded(balance, required)`, `OutsideWindow` |
| `pause()` | `project`, `Active` | `NotProject`, `WrongStatus` |
| `unpause()` | `project`, `Paused` | `NotProject`, `WrongStatus` |
| `end()` | `project`, or **anyone** once `block.timestamp >= endTime` | `WrongStatus`, `OutsideWindow` |
| `cancel()` | `project`, `Pending` only | `NotProject`, `WrongStatus` |

Transition-by-transition, with the reason each rule exists:
[chapter 03](./03-lifecycle.md#transitions).

### Promoters, reporting, settlement

| Function | Access | Reverts |
|---|---|---|
| `join() → bytes32 promoterId` | anyone, while `Pending` or `Active` | `WrongStatus`, `AlreadyJoined`, `InsufficientReputation(score, required)` |
| `reportUserAction(uint256 kpiIndex, address user, uint256 newTotal, bytes evidence)` | `project` or `oracleCoordinator` | `WrongStatus`, `NotReporter`, `UnknownKpi`, `ZeroAddress`, `OutsideWindow`, `AggregateKpi`, `NonMonotonic(current, provided)`, `NoAttribution(user)`, `AmbiguousAttribution(user, kpiIndex)`, `TooManyActions(provided, max)`, `UnorderedEvidence(index)`, `VerifierOvercredit(credited, max)`, plus any verifier revert |
| `applyAggregateUpdate(uint256 kpiIndex, uint256 newTotal)` | `oracleCoordinator`, `Active` | `WrongStatus`, `NotOracle`, `UnknownKpi`, `NotAggregateKpi`, `OutsideWindow`, `NonMonotonic` |
| `settle(address promoter, uint256 kpiIndex)` | anyone | `UnknownKpi`, `NotJoined`, `WrongStatus` |
| `reclaimUnspent()` | `project` | `NotProject`, `WrongStatus`, `ClaimWindowOpen(until)`, `NothingToReclaim` |

`reportUserAction`, `settle` and `reclaimUnspent` are `nonReentrant`. `newTotal` is **cumulative**, and a
replay (`newTotal <= alreadyCredited`) returns without reverting. The exact order of the twelve steps
inside a report is in [chapter 05](./05-kpi-model.md#the-exact-order).

Two things worth stating separately, because they are easy to get wrong from the table alone:

- **`reportUserAction` gets the grace window; `applyAggregateUpdate` does not.** The per-user path is
  reachable while `Ended` until `endedAt + CLAIM_GRACE`; the aggregate path is `onlyActive` plus the raw
  window. [Chapter 08](./08-oracle.md#the-asymmetry-the-campaign-imposes) has what that costs an oracle
  reporter.
- **Empty evidence is not the same as no evidence rule.** `evidence == 0x` resolves attribution once,
  from the live touch, and refuses with `AmbiguousAttribution` when more than one promoter held the user
  across the increment. Non-empty evidence is `abi.encode(Types.Action[])`, must be in ascending block
  order, and is segmented per action. [Chapter 04](./04-attribution.md#per-action-attribution).

### Views

| Function | Returns |
|---|---|
| `config() → CampaignConfig` | The frozen parameters, reassembled from immutables |
| `kpiCount() → uint256` | Number of KPIs |
| `kpi(uint256 index) → KpiSpec` | One KPI spec. Reverts `UnknownKpi` |
| `tiers(uint256 kpiIndex) → RewardTier[]` | Ascending ladder. Reverts `UnknownKpi` |
| `promoterIdOf(address) → bytes32` | `bytes32(0)` if not joined |
| `promoterOf(bytes32) → address` | `address(0)` if unknown here |
| `progressOf(address promoter, uint256 kpiIndex) → uint256` | Cumulative attributed progress |
| `totalProgress(uint256 kpiIndex) → uint256` | Campaign-level total — summed for per-user KPIs, overwritten for aggregates |
| `userCreditedOf(address user, uint256 kpiIndex) → uint256` | The replay guard: the cumulative total already credited for that pair |
| `creditedToOf(address user, uint256 kpiIndex, bytes32 promoterId) → uint256` | That total's per-promoter split, for a user two promoters have held |
| `lastReportBlockOf(address user, uint256 kpiIndex) → uint64` | Block the last report for that pair landed in — the lower bound the next report's evidence is segmented from |
| `settledTiersOf(address promoter, uint256 kpiIndex) → uint256` | Count of settled tiers, also the next index |
| `remainingPool() → uint256` | `rewardPool - paidOut` |
| `getProject() → address` / `getOracle() → address` | Aliases for the `project` / `oracleCoordinator` immutables |

### Events

| Event |
|---|
| `Activated(uint64 startTime, uint64 endTime)` |
| `StatusChanged(CampaignStatus previous, CampaignStatus current)` |
| `PromoterJoined(address indexed promoter, bytes32 indexed promoterId, uint256 reputation)` |
| `ProgressCredited(uint256 indexed kpiIndex, bytes32 indexed promoterId, address indexed user, uint256 amount)` |
| `AggregateProgress(uint256 indexed kpiIndex, uint256 total)` |
| `TierSettled(bytes32 indexed promoterId, address indexed promoter, uint256 indexed kpiIndex, uint256 tier, uint256 paid)` |
| `PoolExhausted(uint256 shortfall)` |
| `Reclaimed(address indexed to, uint256 amount)` |

One report can emit several `ProgressCredited` — one per promoter the evidence was segmented across.
What each event is for: [chapter 05](./05-kpi-model.md#events-emitted-by-a-campaign).

### Errors

**Access / state:** `NotProject` · `NotReporter` · `NotOracle` · `WrongStatus(CampaignStatus actual)` ·
`ReentrancyGuardReentrantCall`

**Promoters:** `AlreadyJoined` · `NotJoined` · `InsufficientReputation(uint256 score, uint256 required)` ·
`UnreachableReputation(uint256 required, uint256 maxScore)`

**KPIs:** `UnknownKpi(uint256)` · `AggregateKpi(uint256)` · `NotAggregateKpi(uint256)`

**Reporting:** `NoAttribution(address user)` · `AmbiguousAttribution(address user, uint256 kpiIndex)` ·
`NonMonotonic(uint256 current, uint256 provided)` · `TooManyActions(uint256 provided, uint256 max)` ·
`UnorderedEvidence(uint256 index)` · `VerifierOvercredit(uint256 credited, uint256 max)` ·
`OutsideWindow(uint64 startTime, uint64 endTime)`

**Escrow:** `NotFunded(uint256 balance, uint256 required)` · `ClaimWindowOpen(uint64 until)` ·
`NothingToReclaim`

**Construction:** `ZeroAddress` · `InvalidWindow` · `ZeroRewardPool` · `NoKpis` · `TierLengthMismatch` ·
`EmptyTiers(uint256 kpiIndex)` · `TiersNotAscending(uint256 kpiIndex, uint256 tierIndex)` ·
`ZeroTierReward(uint256 kpiIndex, uint256 tierIndex)` · `CustomKpiNeedsVerifier(uint256 kpiIndex)` ·
`TooManyKpis(uint256 provided, uint256 max)` ·
`TooManyTiers(uint256 kpiIndex, uint256 provided, uint256 max)` · `EmptyName` ·
`NameTooLong(uint256 got, uint256 max)` · `InvalidNameChar(uint256 index, bytes1 char)`

The name errors are on `Campaign` as well as the registry: the constructor calls `Names.validate(cfg.name)`
itself, so a campaign deployed outside the registry is still name-checked.

---

## `EscrowVault` — custody

`src/escrow/EscrowVault.sol` · `IEscrowVault` · `ReentrancyGuard` ·
[chapter 02](./02-architecture.md#escrowvault--custody-and-nothing-else)

### State

`admin()` — `address` immutable. `registrar()` — `address`, write-once.
`constructor(address admin_)` reverts `ZeroAddress`.

### Functions

| Function | Access | Reverts |
|---|---|---|
| `setRegistrar(address registrar_)` | `admin`, once | `NotAdmin`, `ZeroAddress`, `RegistrarAlreadySet` |
| `registerCampaign(address campaign, address token_)` | `registrar` | `RegistrarNotSet`, `NotRegistrar`, `ZeroAddress`, `AlreadyRegistered` |
| `deposit(address campaign, uint256 amount)` | anyone, pulling from themselves | `CampaignNotRegistered`, `ZeroAmount`, `SafeERC20FailedOperation` |
| `release(address to, uint256 amount)` | the campaign itself | `CampaignNotRegistered`, `ZeroAddress`, `ZeroAmount`, `InsufficientBalance(available, requested)` |
| `reclaim(address to, uint256 amount)` | the campaign itself | same as `release` |
| `balanceOf(address campaign) → uint256` | view | — |
| `tokenOf(address campaign) → address` | view | — |

`deposit`, `release` and `reclaim` are `nonReentrant`. `release` and `reclaim` take no campaign
parameter — the caller **is** the campaign, so there is nothing to spoof. Both debit the ledger before
transferring.

`deposit` credits the balance **actually received**, which may be less than `amount` for a
fee-on-transfer token, and reverts `ZeroAmount` if nothing arrived.

The vault has no notion of promoters, KPIs, or lifecycle. It knows a campaign, a token, and a balance.

### Events

`RegistrarSet(address indexed registrar)` · `CampaignRegistered(address indexed campaign, address indexed token)` ·
`Deposited(address indexed campaign, address indexed from, uint256 amount)` ·
`Released(address indexed campaign, address indexed to, uint256 amount)` ·
`Reclaimed(address indexed campaign, address indexed to, uint256 amount)`

### Errors

`NotRegistrar` · `NotAdmin` · `ZeroAddress` · `AlreadyRegistered` · `CampaignNotRegistered` ·
`ZeroAmount` · `InsufficientBalance(uint256 available, uint256 requested)` · `RegistrarAlreadySet` ·
`RegistrarNotSet` · `SafeERC20FailedOperation(address token)` · `ReentrancyGuardReentrantCall`

---

## `AttributionRegistry` — who holds a user

`src/attribution/AttributionRegistry.sol` · `IAttributionRegistry` · `EIP712("Boney Attribution", "1")` ·
no admin · [chapter 04](./04-attribution.md)

### Constants and state

| Getter | Value |
|---|---|
| `TOUCH_TYPEHASH()` | `keccak256("Touch(address campaign,bytes32 promoterId,uint64 signedAt,uint64 expiresAt)")` |
| `maxTouchDuration()` | `uint64` immutable. 30 days as deployed — the one time constant this branch does **not** shorten |

`constructor(uint64 maxTouchDuration_)` reverts `ZeroWindow` on zero.

### Functions

| Function | Access | Reverts |
|---|---|---|
| `registerPromoter(bytes32 promoterId)` | anyone — writes only `msg.sender`'s namespace. Idempotent | `ZeroPromoterId` |
| `storeTouch(address user, Touch, bytes signature, address relayer)` | anyone holding a valid user signature | see below |
| `activePromoter(address campaign, address user) → bytes32` | view | — |
| `touchOf(address campaign, address user) → Touch` | view | — |
| `promoterAt(address campaign, address user, uint64 atBlock, uint64 atTimestamp) → bytes32` | view | — |
| `promotersAt(address campaign, address user, uint64[] atBlocks, uint64[] atTimestamps) → bytes32[]` | view | `LengthMismatch(blocks, timestamps)` |
| `soleAttributionSince(address campaign, address user, uint64 sinceBlock) → bytes32` | view | — |
| `touchHistoryLength(address campaign, address user) → uint256` | view | — |
| `touchHistoryAt(address campaign, address user, uint256 index) → TouchRecord` | view | **panics** out of range — bare array index, no custom error |
| `effectiveMaxDuration(address campaign) → uint64` | view | — |
| `isRegistered(address campaign, bytes32 promoterId) → bool` | view | — |
| `DOMAIN_SEPARATOR() → bytes32` | view | — |
| `domain() → (bytes1, string, string, uint256, address, bytes32, uint256[])` | view | The EIP-5267 tuple, named for callers that want it under this name |
| `eip712Domain() → (…)` | view | Inherited. Same values |

`storeTouch` reverts: `ZeroAddress` · `ZeroPromoterId` · `TouchNotYetValid(signedAt, now)` ·
`TouchExpired(expiresAt, now)` · `TouchTooLong(expiresAt, maxExpiresAt)` · `CampaignOver(endTime, now)` ·
`CampaignTerminal(status)` · `PromoterNotRegistered(campaign, promoterId)` · `InvalidSignature` ·
`TouchNotNewer(signedAt, storedSignedAt)` · `TouchAlreadyActive(promoterId, expiresAt)`.

All eleven in order, with what each one is defending against:
[chapter 04](./04-attribution.md#storetouch--the-validation-order). `TouchAlreadyActive` is the one a
frontend hits by accident — it fires when the *same* promoter re-touches a user whose touch has not
expired, so a UI should read it as "already yours" rather than as a failure
([chapter 04](./04-attribution.md#check-10--no-re-attribution-while-the-same-promoter-is-live)).

`relayer` is recorded in the event and otherwise unused. `activePromoter` returns `bytes32(0)` once the
live touch has expired; `touchOf` returns the struct regardless.

`effectiveMaxDuration` staticcalls `attributionWindow()` on the campaign and clamps it to
`maxTouchDuration`, falling back to `maxTouchDuration` when the call fails or the window is 0
([chapter 04](./04-attribution.md#check-5--the-effective-horizon)).

### The three history views

Every accepted touch appends a `TouchRecord`; nothing is overwritten. That history is what lets a report
name the promoter who held the user *at a past block* rather than the one holding them now
([chapter 04](./04-attribution.md#the-touch-history)).

```solidity
struct TouchRecord { bytes32 promoterId; uint64 signedAt; uint64 expiresAt; uint64 storedAtBlock; }
```

`promoterAt` walks newest-first and takes the first record with `storedAtBlock < atBlock` — strictly
before, so **a touch landing in the action's own block belongs to the previous promoter**. If that
record had already expired by `atTimestamp` it returns `bytes32(0)` rather than continuing the walk: an
expired touch is a gap, not a fall-through to whoever came earlier.

`promotersAt` is the batch form and the only function that raises `LengthMismatch`.

`soleAttributionSince` returns the single promoter who held the user across every block from
`sinceBlock` to now, or `bytes32(0)` if the holder changed. It walks back to the first record stored at
or before `sinceBlock` — that one covers the rest of the span — and bails the moment two adjacent
records disagree. This is the cheap check `Campaign` uses before crediting an evidence-free report
([chapter 04](./04-attribution.md#without-evidence--resolved-at-report-time-and-refused-when-ambiguous)).

### The `Touch`

```solidity
struct Touch { address campaign; bytes32 promoterId; uint64 signedAt; uint64 expiresAt; }
```

Four fields, all bound into the EIP-712 digest, so none can be rewritten in transit
([chapter 04](./04-attribution.md#the-touch)).

### Events

`PromoterRegistered(address indexed campaign, bytes32 indexed promoterId)` ·
`TouchStored(address indexed campaign, address indexed user, bytes32 indexed promoterId, uint64 signedAt, uint64 expiresAt, address relayer)` ·
`EIP712DomainChanged()`

### Errors

`ZeroAddress` · `ZeroPromoterId` · `TouchExpired(uint64, uint64)` · `TouchTooLong(uint64, uint64)` ·
`TouchNotYetValid(uint64, uint64)` · `TouchNotNewer(uint64, uint64)` ·
`TouchAlreadyActive(bytes32, uint64)` · `InvalidSignature` ·
`PromoterNotRegistered(address, bytes32)` · `ZeroWindow` · `CampaignOver(uint256, uint64)` ·
`CampaignTerminal(uint256)` · `LengthMismatch(uint256, uint256)`

---

## `ReputationRegistry` — the join gate's numerator

`src/reputation/ReputationRegistry.sol` · `IReputationRegistry` · `Ownable` ·
[chapter 07](./07-reputation.md)

### Constants and state

| Getter | Notes |
|---|---|
| `MAX_SCHEMAS()` | 64 |
| `verifier()` | `IAttestationVerifier` immutable |
| `usedAttestations(bytes32) → bool` | Consumed bundle ids |
| `schemaRegistrar() → address` | Alias for `owner()` |

`constructor(address admin, address verifier_)` reverts `ZeroAddress`.

### Governance

| Function | Access | Reverts |
|---|---|---|
| `registerSchema(string name, uint256 weight)` | `owner` | `EmptyName`, `TooManySchemas(max)`, `SchemaAlreadyRegistered(id)` |
| `setSchemaWeight(bytes32 id, uint256 weight)` | `owner` | `UnknownSchema(id)` |
| `setSchemaMaxAge(bytes32 id, uint64 maxAge)` | `owner` | `UnknownSchema(id)` |
| `setSchemaMaxValue(bytes32 id, uint256 maxValue)` | `owner` | `UnknownSchema(id)` |
| `storeAttestation(address subject, bytes32 id, uint256 value, bytes32 attestationId)` | `owner` | `UnknownSchema`, `ValueExceedsMax`, `AttestationAlreadyUsed` |

Both write paths land in the same slot; the owner path exists so an operator can seed a value it already
holds off chain ([chapter 07](./07-reputation.md#storeattestation--the-owner-path)). Weight and
`maxAge` both default to 0 at registration, which means a freshly registered schema contributes nothing
until it is configured — deliberately, so a half-set-up schema cannot move a score
([chapter 07](./07-reputation.md#why-both-defaults-are-0-at-registration)).

### Writes and reads

| Function | Access | Notes |
|---|---|---|
| `submitAttestation(address subject, bytes32 id, uint256 value, Attestation[], bytes[]) → bytes32` | anyone | Authority is the signatures, not the caller. Reverts `UnknownSchema`, `ValueExceedsMax(id, value, max)`, `AttestationAlreadyUsed(id)`, plus every verifier revert |
| `schemaId(string name) → bytes32` | pure | `keccak256(bytes(name))` |
| `scoreOf(address wallet) → uint256` | view | Weighted sum over **fresh** values only |
| `qualifies(address wallet, uint256 minScore) → bool` | view | `true` whenever `minScore == 0` |
| `maxScore() → uint256` | view | Sum of `weight × maxValue`; `type(uint256).max` means "no knowable ceiling" |
| `valueOf(address wallet, bytes32 id) → uint256` | view | Raw stored value, fresh or not |
| `updatedAtOf(address wallet, bytes32 id) → uint64` | view | 0 if never attested |
| `isValueFresh(address wallet, bytes32 id) → bool` | view | Whether it still counts toward `scoreOf` |
| `expiresAtOf(address wallet, bytes32 id) → uint64` | view | 0 when it never expires or was never attested |
| `isSchemaEnabled(bytes32 id) → bool` | view | Registered **and** weight > 0 |
| `schemaInfo(bytes32 id) → (string name, uint256 weight, bool exists)` | view | Three fields, destructured positionally by callers — deliberately not widened |
| `schemaMaxAge(bytes32 id) → uint64` | view | 0 = never expires |
| `schemaMaxValue(bytes32 id) → uint256` | view | 0 = unbounded |
| `schemaCount() → uint256` / `schemaIdAt(uint256) → bytes32` | view | Enumeration |

There is no `schemaWeight` getter — the weight comes out of `schemaInfo`'s second field. Adding one is
the standing temptation `schemaInfo` exists to resist
([chapter 07](./07-reputation.md#a-note-on-schemainfo)).

`maxScore` is what makes an unreachable gate detectable at construction rather than at join time; how
`Campaign` uses it is in [chapter 07](./07-reputation.md#maxscore-and-unreachable-gates). Freshness —
what `maxAge` measures from and what a decay looks like to a promoter — is
[chapter 07](./07-reputation.md#freshness).

### Events

`SchemaRegistered(bytes32 indexed schemaId, string name, uint256 weight)` ·
`SchemaWeightSet(bytes32 indexed schemaId, uint256 weight)` ·
`SchemaMaxAgeSet(bytes32 indexed schemaId, uint64 maxAge)` ·
`SchemaMaxValueSet(bytes32 indexed schemaId, uint256 maxValue)` ·
`AttestationStored(address indexed subject, bytes32 indexed schemaId, uint256 value, bytes32 attestationId)`

Both write paths emit `AttestationStored`; nothing distinguishes them on chain.

### Errors

`UnknownSchema(bytes32)` · `SchemaAlreadyRegistered(bytes32)` · `AttestationAlreadyUsed(bytes32)` ·
`ValueExceedsMax(bytes32, uint256, uint256)` · `ZeroAddress` · `EmptyName` · `TooManySchemas(uint256)`

Two more are declared on the interface and **never reverted anywhere in `src/`**:
`SchemaDisabled(bytes32)` and `StaleValue(uint256 storedAt, uint256 incomingAt)`. They are the only two
dead errors in the protocol's hundred. A disabled schema is handled by weighting it out of `scoreOf`
rather than by refusing the write, and an older value simply overwrites a newer one — the registry does
not order attestations by time. Do not write a client that waits for either.

---

## `AttestationVerifier` — k-of-n signatures

`src/reputation/AttestationVerifier.sol` · `IAttestationVerifier` ·
`EIP712("Boney Attestations", "1")` · `Ownable` ·
[chapter 07](./07-reputation.md#attestationverifier)

### Constants and state

| Getter | Notes |
|---|---|
| `ATTESTATION_TYPEHASH()` | `keccak256("Attestation(address attestor,address subject,bytes32 schemaId,uint256 value,uint256 nonce,uint64 expiresAt,bytes32 data)")` |
| `MAX_ATTESTATIONS()` | 16 |
| `threshold()` | Distinct signatures required. 1 as deployed |
| `attestorCount()` | Active attestors |
| `isAttestor(address) → bool` | — |
| `nonces(address) → uint256` | Next expected nonce for that signer |

`constructor(address admin, address initialAttestor)` starts at `threshold = 1` with one attestor,
emitting `AttestorAdded` and `ThresholdSet`. Reverts `ZeroAddress`.

### Functions

| Function | Access | Reverts |
|---|---|---|
| `setAttestor(address attestor, bool active)` | `owner` | `ZeroAddress`, `InvalidThreshold(threshold, newCount)` when a removal would drop the set below the threshold |
| `setThreshold(uint256 newThreshold)` | `owner` | `InvalidThreshold(newThreshold, attestorCount)` |
| `verifyAttestations(address subject, bytes32 schemaId, uint256 value, Attestation[], bytes[]) → bytes32` | anyone | see below |
| `DOMAIN_SEPARATOR() → bytes32` | view | — |
| `eip712Domain() → (…)` | view | Inherited EIP-5267 tuple |

`verifyAttestations` reverts: `LengthMismatch` · `TooManyAttestations` ·
`BelowThreshold(provided, required)` · `AttestationMismatch(index)` · `AttestationExpired(index)` ·
`NotAnAttestor(attestor)` · `DuplicateAttestor(attestor)` ·
`InvalidNonce(attestor, expected, provided)` · `InvalidSignature(index)`.

Note that `LengthMismatch` takes **no parameters** here, unlike `AttributionRegistry`'s and
`EventMetricKpiVerifier`'s two-parameter versions. Three same-named errors, three different selectors.

It is **not** a view and **not** access-gated: it consumes each signer's nonce, so anyone can burn a
bundle by submitting it. That is the intended anti-replay behaviour rather than an oversight
([chapter 07](./07-reputation.md#it-is-not-view-and-it-is-not-gated)), and the check order is in
[chapter 07](./07-reputation.md#verifyattestations--the-checks).

### The `Attestation`

```solidity
struct Attestation {
    address attestor; address subject; bytes32 schemaId; uint256 value;
    uint256 nonce;    uint64 expiresAt; bytes32 data;
}
```

`data` is an opaque commitment — a hash of whatever the attestor measured. Nothing on chain reads it
([chapter 07](./07-reputation.md#the-privacy-model)).

### Events

`AttestorAdded(address indexed attestor)` · `AttestorRemoved(address indexed attestor)` ·
`ThresholdSet(uint256 threshold)` · `AttestationVerified(bytes32 indexed attestationId)` ·
`EIP712DomainChanged()`

### Errors

`LengthMismatch` · `BelowThreshold(uint256, uint256)` · `TooManyAttestations` ·
`AttestationMismatch(uint256)` · `AttestationExpired(uint256)` · `NotAnAttestor(address)` ·
`DuplicateAttestor(address)` · `InvalidNonce(address, uint256, uint256)` · `InvalidSignature(uint256)` ·
`InvalidThreshold(uint256, uint256)` · `ZeroAddress`

---

## `OracleCoordinator` — staked optimistic reporting

`src/oracle/OracleCoordinator.sol` · `IOracleCoordinator` · `Ownable` · `ReentrancyGuard` ·
[chapter 08](./08-oracle.md)

### Constants and state

| Getter | Notes |
|---|---|
| `minStake()` `disputeWindow()` `unstakeDelay()` | `uint256` immutable |
| `campaignRegistry()` | `ICampaignRegistry`, write-once |
| `stakeLockedUntil(address) → uint256` | When a reporter's collateral unlocks |
| `slashPool()` | Total slashed collateral held |

`constructor(address governor, uint256 minStake_, uint256 disputeWindow_, uint256 unstakeDelay_)` reverts
`ZeroAddress` on a zero governor. As deployed on this branch: `disputeWindow` 4 minutes (protocol value
1 day), `unstakeDelay` 10 minutes (protocol value 2 days) — the whole table is in
[chapter 03](./03-lifecycle.md#time-constants).

### Functions

| Function | Access | Reverts |
|---|---|---|
| `setCampaignRegistry(address registry)` | `owner`, once | `ZeroAddress`, `RegistryAlreadySet` |
| `stake()` payable | anyone | — (a zero-value call adds nothing and emits `ReporterStaked(msg.sender, 0)`) |
| `unstake()` | anyone | `NothingStaked`, `StakeLocked(until)`, `TransferFailed` |
| `submitReport(Report) → bytes32` | stake ≥ `minStake` | `NotAReporter(caller)`, `RegistryNotSet`, `UnknownCampaign(campaign)`, `ReportAlreadyExists` |
| `submitUserReport(UserReport) → bytes32` | stake ≥ `minStake` | as above, plus `ZeroAddress` for a zero user |
| `applyReport(bytes32 reportId)` | anyone, after the window | `NotAggregateReport`, `UnknownReport`, `ReportIsDisputed`, `ReportAlreadyApplied`, `DisputeWindowOpen(deadline)`, plus every campaign revert |
| `applyUserReport(bytes32 reportId)` | anyone, after the window | `NotUserReport`, plus the same set |
| `disputeReport(bytes32 reportId)` | `owner` | `UnknownReport`, `ReportAlreadyApplied`, `DisputeWindowClosed(deadline)` |
| `withdrawSlashPool(address to)` | `owner` | `ZeroAddress`, `NothingStaked`, `TransferFailed` |

`unstake`, both apply paths, and `withdrawSlashPool` are `nonReentrant`.

Four things the table cannot say:

- **`submitReport` discards `Report.evidence`.** The aggregate path calls `_record(..., "")`
  unconditionally, so a verifier-backed aggregate KPI cannot be reported through the oracle. Only
  `submitUserReport` carries evidence through to `reportUserAction`
  ([chapter 08](./08-oracle.md#the-two-entry-points-are-not-symmetric)).
- **`ReportAlreadyExists` is unreachable.** The id is
  `keccak256(abi.encode(reporter, campaign, kpiIndex, amount, user, seq))` with `seq` from a
  per-reporter counter that post-increments on every call, so no two reports from one reporter can
  collide ([chapter 08](./08-oracle.md#report-ids)).
- **`disputeReport` does not check `disputed`.** Disputing an already-disputed report succeeds, re-emits
  `ReportDisputed`, and slashes again if the reporter has re-staked in the meantime
  ([chapter 08](./08-oracle.md#disputing-the-same-report-twice)).
- **`withdrawSlashPool` reuses `NothingStaked`** for an empty pool. It is not about the caller's stake.

`applyReport`/`applyUserReport` set `applied = true` **before** calling the campaign, so a campaign
revert rolls the whole transaction back rather than burning the report
([chapter 08](./08-oracle.md#applied-is-set-before-the-external-call)).

### Views

`reportState(bytes32) → ReportState` · `reportDeadline(bytes32) → uint256` ·
`reportDisputed(bytes32) → bool` · `reportApplied(bytes32) → bool` · `stakeOf(address) → uint256` ·
`isReporter(address) → bool` · `campaignContract() → address`

`isReporter` is `stake ≥ minStake`, the same test `_record` applies. `campaignContract` returns the
registry address under an older name.

### Structs

```solidity
struct Report     { address campaign; uint256 kpiIndex; uint256 amount; bytes evidence; }
struct UserReport { address campaign; uint256 kpiIndex; address user; uint256 newTotal; bytes evidence; }

struct ReportState {
    address reporter; address campaign; uint256 kpiIndex; uint256 amount;
    uint64 deadline;  bool disputed;    bool applied;
    address user;     // address(0) ⇒ aggregate
    bytes evidence;
}
```

`Report.evidence` exists in the calldata struct and is dropped on the way to storage. Field by field:
[chapter 08](./08-oracle.md#stored-state).

### Events

`RegistrySet(address indexed registry)` · `ReporterStaked(address indexed reporter, uint256 amount)` ·
`ReporterSlashed(address indexed reporter, uint256 amount)` ·
`ReportSubmitted(bytes32 indexed reportId, address indexed campaign, address indexed reporter, uint256 deadline)` ·
`ReportApplied(bytes32 indexed reportId, address indexed campaign)` ·
`ReportDisputed(bytes32 indexed reportId, address indexed campaign, address disputer)`

`ReportSubmitted` carries neither `kpiIndex` nor `amount`; a consumer needs `reportState` to learn what
was claimed.

### Errors

`ZeroAddress` · `NotAReporter(address)` · `NothingStaked` · `StakeLocked(uint256)` ·
`UnknownReport(bytes32)` · `ReportAlreadyExists(bytes32)` · `DisputeWindowOpen(uint256)` ·
`DisputeWindowClosed(uint256)` · `ReportIsDisputed(bytes32)` · `ReportAlreadyApplied(bytes32)` ·
`UnknownCampaign(address)` · `NotUserReport(bytes32)` · `NotAggregateReport(bytes32)` ·
`TransferFailed` · `RegistryAlreadySet` · `RegistryNotSet` · `ReentrancyGuardReentrantCall`

---

## `EventMetricKpiVerifier` — Boney's own reading

`src/verifiers/EventMetricKpiVerifier.sol` · `IEventMetricKpiVerifier` · `Ownable` ·
[chapter 06](./06-verification.md#eventmetrickpiverifier)

### State

| Getter | Notes |
|---|---|
| `reporter()` | The trusted metric pusher |
| `kpiConfigs(bytes32) → KpiConfig` | Keyed `keccak256(abi.encodePacked(campaign, kpiIndex))` |
| `verifiedTotals(bytes32) → uint256` | Keyed `keccak256(abi.encodePacked(campaign, kpiIndex, epoch, user))`. **Raw, unscaled** |
| `lastReportedAt(bytes32) → uint256` | Timestamp of the most recent report for that user key |
| `lastScannedBlock(bytes32) → uint256` | The per-KPI scan checkpoint |

`constructor(address owner_, address reporter_)` reverts `ZeroAddress` on a zero reporter and emits
`ReporterUpdated(address(0), reporter_)`.

The `epoch` in the user key is what makes reconfiguration safe: bump it and every previously reported
total for that KPI becomes unreachable rather than being reinterpreted under the new config
([chapter 06](./06-verification.md#replacement-and-the-epoch-that-makes-it-safe)).

### Functions

| Function | Access | Reverts |
|---|---|---|
| `setReporter(address newReporter)` | `owner` | `ZeroAddress` |
| `setKpiConfig(address campaign, uint256 kpiIndex, address targetContract, string eventSignature, uint8 userParamIndex, Aggregation aggregation, uint8 valueParamIndex, uint256 scale, uint256 windowStartBlock, uint256 windowEndBlock)` | `owner` | `ZeroAddress`, `EmptyEventSignature`, `BadWindow(start, end)`. Replaces an existing config |
| `reportVerifiedTotal(address campaign, uint256 kpiIndex, address user, uint256 verifiedTotal)` | `reporter` | `NotReporter(caller)`, `KpiNotConfigured(campaign, kpiIndex)` |
| `reportBatch(address campaign, uint256 kpiIndex, address[] users, uint256[] totals, uint256 scannedUpToBlock)` | `reporter` | `NotReporter`, `LengthMismatch(users, totals)`, `KpiNotConfigured`, `CheckpointRegression(current, provided)`, `PastReportWindow(windowEndBlock, provided)` |
| `advanceCheckpoint(address campaign, uint256 kpiIndex, uint256 scannedUpToBlock)` | `reporter` | as `reportBatch`, minus `LengthMismatch` |
| `verify(address campaign, uint256 kpiIndex, address user, uint256 amount, bytes, bytes) → uint256` | view | `KpiNotConfigured(campaign, kpiIndex)` |
| `configOf(address, uint256) → KpiConfig` | view | — |
| `verifiedTotalOf(address, uint256, address) → uint256` | view | Raw metric, at the current epoch |
| `observedProgressOf(address, uint256, address) → uint256` | view | Scaled ceiling — what `verify` compares against |
| `checkpointOf(address, uint256) → uint256` | view | — |

`verify` ignores `evidence` and `params` by design, and returns `min(amount, observedProgress)`. It
reverts rather than returning 0 when the KPI is unconfigured, which is what makes the whole layer fail
closed ([chapter 06](./06-verification.md#both-verifiers-fail-closed)).

**When the epoch bumps.** `setKpiConfig` compares the incoming config against the stored one field by
field and increments `epoch` — resetting `lastScannedBlock` and emitting `KpiTotalsInvalidated` — only if
*what is watched* changed: `targetContract`, `eventSignature`, `userParamIndex`, `aggregation`,
`valueParamIndex`, `scale`, or `windowStartBlock`. **`windowEndBlock` is excluded.** Extending or
trimming the end of the window keeps every reported total, which is what makes it the safe edit at
wind-down ([chapter 06](./06-verification.md#replacement-and-the-epoch-that-makes-it-safe)).

### Types

```solidity
enum Aggregation { COUNT, SUM }

struct KpiConfig {
    address targetContract;   string  eventSignature;
    uint8   userParamIndex;   uint8   valueParamIndex;
    uint8   aggregation;      uint256 scale;            // 0 reads as 1
    uint256 windowStartBlock; uint256 windowEndBlock;
    bool    configured;       uint256 epoch;
}
```

Field order matters for anything destructuring `configOf` positionally: `valueParamIndex` comes
**before** `aggregation`, the reverse of `setKpiConfig`'s argument order. Why each field is shaped this
way, including why the event signature is a full human-readable string:
[chapter 06](./06-verification.md#kpiconfig).

### Events

`ReporterUpdated(address indexed oldReporter, address indexed newReporter)` ·
`KpiConfigured(address indexed campaign, uint256 indexed kpiIndex, address targetContract, string eventSignature, uint8 userParamIndex, Aggregation aggregation, uint8 valueParamIndex, uint256 scale, uint256 windowStartBlock, uint256 windowEndBlock)` ·
`KpiTotalsInvalidated(address indexed campaign, uint256 indexed kpiIndex, uint256 epoch)` ·
`VerifiedTotalReported(address indexed campaign, uint256 indexed kpiIndex, address indexed user, uint256 verifiedTotal)` ·
`CheckpointAdvanced(address indexed campaign, uint256 indexed kpiIndex, uint256 scannedUpToBlock)`

`KpiConfigured` does not carry the epoch; `KpiTotalsInvalidated` is the only event that does, and it is
emitted only on an invalidating change.

### Errors

`ZeroAddress` · `EmptyEventSignature` · `BadWindow(uint256, uint256)` ·
`KpiNotConfigured(address, uint256)` · `LengthMismatch(uint256 users, uint256 totals)` ·
`CheckpointRegression(uint256, uint256)` · `PastReportWindow(uint256, uint256)` ·
`NotReporter(address caller)`

---

## `GuardedKpiVerifier` — the one a campaign points at

`src/verifiers/GuardedKpiVerifier.sol` · `IGuardedKpiVerifier` · `Ownable` ·
[chapter 06](./06-verification.md#guardedkpiverifier)

### State

`boneyVerifier()` — `address` immutable, always consulted.
`guardConfigs(bytes32) → (address projectVerifier, uint16 toleranceBps, Mode mode, bool configured)` —
keyed `keccak256(abi.encodePacked(campaign, kpiIndex))`, returning the fields flattened.
`guardOf(address, uint256)` returns the same thing as a `GuardConfig` struct; prefer it.

`MAX_TOLERANCE = 10_000` is the bound `toleranceBps` is checked against — an internal constant, so unlike
`Campaign`'s `MAX_KPIS` and `MAX_EVIDENCE_ACTIONS` it cannot be read on chain. 10,000 bps is 100%
divergence, which accepts anything.

`constructor(address owner_, address boneyVerifier_)` reverts `ZeroAddress`.

### Functions

| Function | Access | Reverts |
|---|---|---|
| `setGuardConfig(address campaign, uint256 kpiIndex, address projectVerifier, uint16 toleranceBps, Mode mode)` | `owner` | `ZeroAddress`, `BpsOutOfRange(toleranceBps)` above 10,000 |
| `verify(address campaign, uint256 kpiIndex, address user, uint256 amount, bytes evidence, bytes params) → uint256` | view | `NotConfigured(campaign, kpiIndex)`, `VerifierDisagreement(projectValue, boneyValue, diff, allowed)`, plus any inner verifier revert |
| `guardOf(address, uint256) → GuardConfig` | view | — |

### Types

```solidity
enum Mode { AGREE, CAP }

struct GuardConfig { address projectVerifier; uint16 toleranceBps; Mode mode; bool configured; }
```

`projectVerifier == address(0)` returns Boney's value unchanged — the single-source configuration, and
the right default. `AGREE` reverts when the two readings diverge past `toleranceBps`; `CAP` takes
`min(boney, project)` silently. Which to pick, and why both exist:
[chapter 06](./06-verification.md#why-two-modes).

An unconfigured `(campaign, kpiIndex)` reverts `NotConfigured` rather than passing the claim through.

### Events

`GuardConfigured(address indexed campaign, uint256 indexed kpiIndex, address projectVerifier, uint16 toleranceBps, Mode mode)`

### Errors

`ZeroAddress` · `BpsOutOfRange(uint16)` · `NotConfigured(address, uint256)` ·
`VerifierDisagreement(uint256 projectValue, uint256 boneyValue, uint256 diff, uint256 allowed)`

---

## `TouchWindowVerifier` — attribution-timing lens

`src/verifiers/TouchWindowVerifier.sol` · `ITouchWindowVerifier` · stateless, no constructor arguments,
no owner · [chapter 06](./06-verification.md#touchwindowverifier)

**Do not wire this as a `KpiSpec.verifier`, and do not wire it as a `CAP` `projectVerifier` either.** It
predates per-action attribution: it measures the *live* touch's window, so against a report segmented
across two promoters it caps the whole credit at the current promoter's slice and starves the earlier
segments. `script/SeedDemo.s.sol` and `GuardedKpiVerifier`'s own NatSpec still name it as the motivating
CAP case; both are stale. The rule and its consequences:
[chapter 06](./06-verification.md#it-must-not-be-wired-as-a-kpis-verifier).

`windowFloor` remains useful — it is a plain read of when the live touch began, which an off-chain
process can use as a scan floor.

### Functions

| Function | Reverts |
|---|---|
| `verify(address campaign, uint256, address user, uint256 amount, bytes evidence, bytes params) → uint256` | `FutureAction(timestamp, blockTimestamp)`, `EvidenceExceedsClaim(total, amount)` |
| `windowFloor(address campaign, address user, bytes params) → uint64` | — |

Both read `campaign.attributionRegistry()` and then `touchOf(campaign, user)`, so the verifier follows
whichever registry the calling campaign uses. Empty evidence or no stored touch returns 0.

### Encodings

```solidity
// Types.Action — three fields, not two
struct Action { uint64 blockNumber; uint64 timestamp; uint256 amount; }

evidence = abi.encode(Types.Action[])
params   = abi.encode(uint64 lookback)   // must be EXACTLY 32 bytes, else read as 0
```

`blockNumber` is what `Campaign` segments on; this verifier only reads `timestamp` and `amount`. A
`params` blob of any other length is not an error — the lookback is silently 0
([chapter 06](./06-verification.md#the-lookback-trade)).

### Errors

`EvidenceExceedsClaim(uint256 total, uint256 amount)` ·
`FutureAction(uint64 timestamp, uint64 blockTimestamp)`

---

## `IKpiVerifier` — the extension point

`src/interfaces/IKpiVerifier.sol` · one function, no state, nothing deployed ·
[chapter 05](./05-kpi-model.md#verifier) · [chapter 06](./06-verification.md#the-three-adapters)

The whole of the protocol's extensibility. A `KpiSpec.verifier` is any address implementing this
interface; the three adapters in `src/verifiers/` are only the three that ship.

```solidity
function verify(
    address campaign,         // the campaign asking
    uint256 kpiIndex,         // which KPI within it
    address user,             // the end user whose progress is being credited
    uint256 amount,           // the claim — a cumulative total, not a delta
    bytes calldata evidence,  // the report's evidence blob, forwarded verbatim
    bytes calldata params     // the KPI's configured params, forwarded verbatim
) external view returns (uint256 credited);
```

Four things bind an implementer:

- **`amount` is cumulative.** `Campaign.reportUserAction` passes `newTotal` — the user's running total for
  that KPI, not the increment. An adapter that reads it as a delta caps every report after the first.
- **`credited` may only shrink the claim.** `Campaign` re-checks the return and reverts
  `VerifierOvercredit(credited, max)` on anything larger, so an inflating adapter cannot overpay. It only
  makes the KPI unreportable.
- **`view`, so the call is a `staticcall`.** An adapter cannot record having been asked.
  `EventMetricKpiVerifier`'s checkpoint moves in `reportBatch`, a separate write path, never inside
  `verify`.
- **Reverting and returning 0 are different answers.** A revert fails the `reportUserAction` call; a 0 lets
  it succeed and credit nothing. Both shipped verifiers return 0 for "not observed yet" and revert for
  "the evidence contradicts the claim" — [chapter 06](./06-verification.md#both-verifiers-fail-closed).

`GuardedKpiVerifier` is itself an `IKpiVerifier` that calls two more, which is why composition needs no
second interface: all six arguments are forwarded unchanged to both the Boney verifier and the project's,
and only the rule combining the two answers differs
([chapter 06](./06-verification.md#why-two-modes)).

### Errors

None declared. An implementation's own reverts propagate through `Campaign` untouched, which is why the
`reportUserAction` row above ends in *plus any verifier revert*.

---

## `Types` — the shared vocabulary

`src/libraries/Types.sol` · `internal` library, nothing deployed · every shape here crosses the ABI
boundary, so clients decode them

Two enums and four structs, no code. It exists so `Campaign`, the registry, the verifiers and the web app
cannot drift into separate definitions of the same shape.

### Enums

```solidity
enum KpiKind {
    Custom, Mint, Swap, TokenPurchase, Deposit, Stake, Bridge,
    Tvl, Volume, ActiveUser, signUps, downloads, withdraw
}   // 0..12 — the last three are lowercase in the deployed ABI and stay that way

enum CampaignStatus { Pending, Active, Paused, Ended, Cancelled }   // 0..4
```

`kind` is a hint for indexers and UIs; settlement never branches on it, and the only rule the contract
enforces is that a `Custom` KPI names a verifier ([chapter 05](./05-kpi-model.md#kind)).
`CampaignStatus`'s numeric order is load-bearing — `AttributionRegistry` compares against `Ended`
numerically to detect a terminal campaign ([chapter 03](./03-lifecycle.md#states)).

### Structs

```solidity
struct KpiSpec    { KpiKind kind; address verifier; uint256 target; bool aggregate; bytes params; }
struct RewardTier { uint256 threshold; uint256 reward; }

struct CampaignConfig {
    address project;            // owner; receives unspent escrow on end or cancel
    string  name;               // stored as supplied — the normalized form is only the registry's key
    address token;              // ERC20 used for escrow and payouts
    uint256 rewardPool;         // escrow required before activation
    uint64  startTime;          // earliest activation
    uint64  endTime;            // reports rejected after this
    uint64  attributionWindow;  // seconds a touch stays valid for a user
    uint256 minReputation;      // the join gate
}

struct Action {
    uint64  blockNumber;  // must not decrease across an Action[]
    uint64  timestamp;    // that block's timestamp
    uint256 amount;       // this action's contribution to the KPI
}
```

`Action` is the canonical evidence element, and the one shape a reporter has to build correctly:
`abi.encode(Action[])` is what `Campaign` decodes to place each action with whoever held the user at that
block, what `TouchWindowVerifier` decodes to time them, and what `encodeActions` in
`web/src/lib/indexerCore.ts` produces ([chapter 04](./04-attribution.md#per-action-attribution)).

`config()`, `kpi(index)` and `tiers(kpiIndex)` on a campaign return the first three by value; there is no
getter for an `Action`, which only ever travels as calldata.

### Errors

None. The library declares no errors and no events.

---

## `Names` — what a campaign may be called

`src/libraries/Names.sol` · `internal` library, nothing deployed · its errors surface through `Campaign`'s
constructor and `CampaignRegistry.createCampaign` · [chapter 02](./02-architecture.md#campaign-names)

| Member | Behaviour |
|---|---|
| `MAX_NAME_BYTES` | `internal constant = 32`. Bytes, which is also characters — the charset is ASCII |
| `validate(string) internal pure` | Reverts unless the name is non-empty, at most `MAX_NAME_BYTES`, printable ASCII (`0x20`–`0x7E`) throughout, and not entirely spaces |
| `key(string) → bytes32` | `validate`, then `keccak256(normalize(name))`. The registry's uniqueness key |
| `normalize(string) → bytes` | Trim, collapse runs of inner spaces, lowercase `A-Z`. **Does not validate** |

`normalize` on its own is deliberately permissive — it treats every byte but `0x20` as visible and folds
only `A-Z`, so calling it directly will happily normalize bytes the protocol refuses. `key` is the guarded
entry point, and it validates first so a malformed name can never claim a key.

Excluding the high-bit range excludes all of UTF-8's multi-byte space, so a name is one byte per character
by construction. `InvalidNameChar` carries the offending index and byte, which is enough for a form to
point at the character.

`CampaignRegistry._tryKey` re-implements these rules in non-reverting form for `isNameAvailable`, returning
`(false, bytes32(0))` where the library would revert. The duplication is forced — `try` needs an external
call and this library is `internal` — and nothing on chain checks that the two agree. What checks it is
`test/CampaignNames.t.sol`, which runs the empty, all-space and 33-byte cases through both paths.

### Errors

`EmptyName()` · `NameTooLong(uint256 got, uint256 max)` · `InvalidNameChar(uint256 index, bytes1 char)`

An all-space name is `EmptyName`, not `InvalidNameChar`: spaces are legal bytes, and the check that fails
is the one requiring a visible character.

`IReputationRegistry` declares its own `EmptyName()` for empty schema names. Same selector, unrelated
meaning — a decoder cannot tell them apart, though no single call can raise both.
