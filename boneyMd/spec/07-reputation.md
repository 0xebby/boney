# 07 — Reputation and attestations

Two contracts. `AttestationVerifier` decides whether a signed claim about a wallet is authentic;
`ReputationRegistry` stores what it decided and turns the stored values into one number. Nothing else in
the protocol reads reputation except `Campaign.join()`, and it reads it exactly once.

## The privacy model

`ReputationRegistry` stores exactly one thing per pair:

```solidity
mapping(address wallet => mapping(bytes32 schemaId => Record { uint256 value; uint64 updatedAt; }))
```

A wallet, a metric id, a number, and a timestamp. **Social handles never touch the chain.** An attestor
sees them off chain and signs a figure. Projects read `scoreOf` / `qualifies`, so a promoter proves they
clear a bar without revealing which accounts back it.

That is the point of the whole layer: qualifying for a deal today means handing over social accounts.
Here it means presenting a number someone credible signed.

## Schemas

A schema is a registered metric that can be attested against.

```solidity
struct Schema {
    string  name;      // stable human-readable name, e.g. "ETHOS_SCORE"
    uint256 weight;    // contribution to the composite score. 0 disables without erasing data
    uint64  maxAge;    // seconds a value stays countable. 0 = never expires
    bool    exists;    // distinguishes a disabled schema from an unknown one
    uint256 maxValue;  // largest value an attestor may report. 0 = unbounded
}

schemaId = keccak256(bytes(name))     // exposed as schemaId(string name), pure
```

All four setters are `onlyOwner` (the schema registrar, which is `owner()` — `schemaRegistrar()` returns
it under a name that says what the role is for):

| Call | Effect | Reverts |
|---|---|---|
| `registerSchema(name, weight)` | Creates a schema. `maxAge` and `maxValue` default to 0 | `EmptyName()`, `TooManySchemas(max)`, `SchemaAlreadyRegistered(id)` |
| `setSchemaWeight(id, weight)` | Reprices every score including it. 0 retires without erasing | `UnknownSchema(id)` |
| `setSchemaMaxAge(id, maxAge)` | Sets the freshness window. **Retroactive** | `UnknownSchema(id)` |
| `setSchemaMaxValue(id, maxValue)` | Sets the value ceiling. Enforced **on write only** | `UnknownSchema(id)` |

`MAX_SCHEMAS = 64`, a `public constant`. The cap exists because `scoreOf` iterates every schema and is
called from `Campaign.join()` — an unbounded schema set would let governance make joining prohibitively
expensive, or impossible.

Order matters only in that `_schemaIds` is append-only: a schema can be disabled with weight 0 but never
removed, so the iteration cost of `scoreOf` never goes down.

### Why both defaults are 0 at registration

Adding either gate must not retroactively break existing data. `maxAge = 0` means "never expires", so
introducing the freshness gate could not silently void values attested before it existed. `maxValue = 0`
means "unbounded", so introducing the ceiling could not make an existing schema unwritable. Governance
opts each schema in.

`maxAge = 0` also remains *correct* for metrics derived from immutable history — a wallet's
first-transaction age cannot go down.

### Retroactivity, in both directions

**`setSchemaMaxAge` applies retroactively.** Lowering it can immediately drop records out of every score
that included them, which is the point: governance can tighten a stale metric without waiting for anyone
to re-attest. Raising it brings expired records back, so it is not a way to erase data.

**`setSchemaMaxValue` does not.** Lowering a ceiling leaves values already stored intact until they are
re-attested, because a stored value that silently changed meaning would be worse than one that is merely
out of date.

### The interaction with `minReputation`

`Campaign.minReputation` is **immutable**, and scores **move**. Tightening a freshness window shrinks
scores, so a promoter who has not yet joined may find a previously-clearable gate now out of reach until
they re-attest. A promoter who has already joined keeps their membership, because `join()` reads the
score once — see [chapter 03](./03-lifecycle.md#promoter-membership).

## Freshness

```solidity
function _isStale(uint64 updatedAt, uint64 maxAge) private view returns (bool) {
    if (updatedAt == 0) return true;      // never attested is stale by definition
    if (maxAge == 0) return false;        // schema never expires
    return block.timestamp - updatedAt > maxAge;
}
```

Credibility is not a constant. An Ethos score moves with vouches, reviews and slashing; a follower count
moves when an account is sold, suspended, or inflated. The attestation's own `expiresAt` bounds only when
a signed bundle may be **submitted** — it says nothing about how long the resulting value should keep
counting. So each schema carries its own `maxAge`, and a promoter who verified once at a high score does
not keep clearing gates on it forever.

Two implementation details that are deliberate:

- **It subtracts rather than adding.** `updatedAt + maxAge` overflows for a large `maxAge`, and because
  this sits under `scoreOf` an overflow would revert `Campaign.join()` — a gate nobody could pass.
  `block.timestamp >= updatedAt` always holds, so the subtraction cannot underflow.
- **The never-attested check comes first**, so the answer does not depend on chain age:
  `block.timestamp - 0 > maxAge` is false on a young chain, which would report an absent record as fresh.

## Scoring

```solidity
function scoreOf(address wallet) public view returns (uint256 score) {
    for each registered schemaId:
        if (weight == 0) continue;                    // disabled or display-only
        if (_isStale(record.updatedAt, maxAge)) continue;
        score += record.value * weight;
}
```

`qualifies(wallet, minScore)` short-circuits `true` for `minScore == 0`, so an ungated campaign never
pays for the iteration.

**Stale records contribute nothing rather than reverting.** An expired attestation lowers a score
instead of making the wallet unscoreable — `join()` must still be able to tell a promoter what their
score *is* when refusing them.

Consequences for anything reading this:

- `scoreOf` can **fall over time with no transaction touching the wallet.** Do not cache it as a
  constant.
- It does **not** equal the sum of `valueOf` reads. A wallet can hold a large attested value that
  contributes nothing because it aged out, or because its schema carries weight 0.
- The multiplication is **checked**. A `value × weight` that overflows reverts, and it reverts inside
  `join()`. `maxValue` is what keeps that unreachable, which is a second reason to set it.

`isValueFresh(wallet, id)`, `updatedAtOf(wallet, id)` and `expiresAtOf(wallet, id)` exist precisely so a
UI can explain that gap — without them a frontend can only show the raw `valueOf` and a score that
silently disagrees with it, which reads as a bug rather than an expiry. `expiresAtOf` also lets a promoter
be told "re-verify before <date>" instead of discovering the drop when a join reverts; it returns 0 both
for a schema that never expires and for a record that was never attested, so callers pair it with
`updatedAtOf` to tell those apart.

## `maxScore` and unreachable gates

```solidity
function maxScore() external view returns (uint256)   // Σ (weight × maxValue) over weighted schemas
```

Returns **`type(uint256).max`** to mean "no knowable ceiling", which happens when any *weighted* schema
is unbounded. That sentinel rather than 0, because 0 is a legitimate answer — a registry whose every
schema carries weight 0 genuinely has a maximum score of 0 — and callers gating on it must be able to
tell the two apart.

It also makes the consumer's check degrade correctly: `minReputation > type(uint256).max` is false for
every `uint256`, so an unbounded registry imposes no constraint rather than blocking everything.

Unweighted schemas are skipped, so an unbounded display-only metric like `X_FOLLOWERS` cannot poison the
ceiling for everyone else. **An overflowing term returns the same sentinel** rather than reverting: this
sits under `Campaign`'s constructor, and a registry configured into an overflow would otherwise block
every campaign creation protocol-wide. Both the per-schema product and the running sum are checked by
hand inside an `unchecked` block for that reason.

### Where it is used

`Campaign`'s constructor rejects a gate no wallet could ever clear:

```solidity
uint256 cap = type(uint256).max;
try IReputationRegistry(reputationRegistry_).maxScore() returns (uint256 reported) { cap = reported; } catch {}
if (cfg.minReputation > cap) revert UnreachableReputation(cfg.minReputation, cap);
```

Without it, an unreachable `minReputation` produces a campaign that deploys cleanly, accepts escrow,
reports `Active`, and **silently admits nobody for its whole life** — with no way to correct it short of
redeploying and re-funding, since `minReputation` is immutable.

The comparison sits outside the `try` block so a genuine `UnreachableReputation` revert cannot be
swallowed by the `catch`. The `catch` itself exists so a registry that does not implement `maxScore` (or
reverts) leaves the cap at "unbounded" rather than blocking creation.

**This is a point-in-time check, not a permanent guarantee.** Governance moves `maxScore` with
`setSchemaWeight`, `setSchemaMaxValue` and `registerSchema`, so a campaign created against one ceiling can
outlive it.

> A practical consequence at deploy time: `DeployBoney` registers **no** schemas, so a fresh
> `ReputationRegistry` scores every wallet 0 *and* reports `maxScore() == 0`. Any gated campaign then
> fails to be created at all until schemas exist. This is why the seed order is reputation first,
> campaigns second — `SeedDevRep` before `SeedDemo`, which `SeedDemo`'s own docs state as a
> prerequisite.

## Writing values

Two paths, and only one of them is trusted.

### `submitAttestation` — the signature path

```solidity
submitAttestation(address subject, bytes32 id, uint256 value,
                  Attestation[] attestations, bytes[] signatures) returns (bytes32 attestationId)
```

**Permissionless to call.** Authority comes from the signatures, not the caller — which is what lets a
promoter (or a relayer on their behalf) submit their own reputation proof and pay their own gas, while
the attestor's key never leaves the server that holds it.

Order: schema must exist (`UnknownSchema(id)`) → `value <= maxValue` if bounded
(`ValueExceedsMax(id, value, maxValue)`) → `verifier.verifyAttestations(...)` → the returned
`attestationId` must be unused (`AttestationAlreadyUsed(attestationId)`) → store
`(value, block.timestamp)` → emit `AttestationStored(subject, id, value, attestationId)`.

The ceiling is checked **before** the signatures, so an out-of-bounds bundle fails without burning the
attestor's nonce.

### `storeAttestation` — the owner path

```solidity
storeAttestation(address subject, bytes32 id, uint256 value, bytes32 attestationId) external onlyOwner
```

Retained for migrations and for metrics sourced from on-chain history rather than a signed attestation.
Two things about it that are easy to get wrong:

- It is **bound by `maxValue` exactly as the signed path is** — the owner is trusted, but the ceiling
  `maxScore` reports is only sound if *every* write respects it. An owner-stored value above the bound
  would make a gate that campaign creation certified as reachable quietly reachable by a different
  amount than advertised.
- It **burns the `attestationId` too**. The caller picks that id, and a second write with the same one
  reverts `AttestationAlreadyUsed`. `SeedDevRep` therefore salts its ids with `block.number`
  (`keccak256(abi.encode(tag, block.number))`) so the script stays re-runnable; a fixed string would make
  its second run revert.

### Anti-replay is layered

Two independent guards, deliberately:

1. `AttestationVerifier` consumes a **sequential per-attestor nonce**, so each signature is single-use.
2. `ReputationRegistry` additionally rejects a previously seen **`attestationId`** (`usedAttestations` is
   public, so a client can check before spending gas), so the same verified bundle cannot be applied twice
   even if routed through a different caller.

## Reading it

| Read | Returns |
|---|---|
| `scoreOf(wallet)` | The weighted sum of fresh values. The BoneyScore |
| `qualifies(wallet, minScore)` | `scoreOf >= minScore`, short-circuiting `true` at 0 |
| `valueOf(wallet, id)` | The raw stored value, fresh or not |
| `updatedAtOf(wallet, id)` | When it was written, 0 if never |
| `isValueFresh(wallet, id)` | Whether it still counts |
| `expiresAtOf(wallet, id)` | When it stops counting. 0 if never, or never attested |
| `maxScore()` | Gate ceiling, or `type(uint256).max` for unknowable |
| `schemaInfo(id)` | `(name, weight, exists)` — a fixed three-tuple |
| `schemaMaxAge(id)` / `schemaMaxValue(id)` | The two later fields, separately |
| `isSchemaEnabled(id)` | `exists && weight > 0` |
| `schemaCount()` / `schemaIdAt(i)` | Enumeration, for a client that wants every schema |
| `usedAttestations(id)` | Whether a bundle id is spent |
| `schemaRegistrar()` | `owner()`, under a role name |
| `verifier` | The immutable `AttestationVerifier` address |

### A note on `schemaInfo`

Deliberately **not widened** when `maxAge` and `maxValue` were added: this tuple is destructured
positionally by callers (`SeedLocal.s.sol` reads the third element to decide whether to register), and
adding a field would break every one of them silently. `schemaMaxAge(id)` and `schemaMaxValue(id)` are
separate reads.

---

## `AttestationVerifier`

Verifies k-of-n threshold attestations signed off chain by a registered attestor set.

```solidity
struct Attestation {
    address attestor;   // must be the signer
    address subject;    // the wallet the data is about
    bytes32 schemaId;   // the metric
    uint256 value;      // the attested value
    uint256 nonce;      // must equal the signer's next nonce
    uint64  expiresAt;  // must be strictly in the future
    bytes32 data;       // optional payload hash. Not interpreted on chain
}
```

| Field | Value |
|---|---|
| Domain name | `"Boney Attestations"` |
| Domain version | `"1"` |
| `verifyingContract` | the `AttestationVerifier` address |
| Type string | `Attestation(address attestor,address subject,bytes32 schemaId,uint256 value,uint256 nonce,uint64 expiresAt,bytes32 data)` |
| `ATTESTATION_TYPEHASH` | `keccak256` of that string, a public constant |
| `DOMAIN_SEPARATOR()` | `_domainSeparatorV4()`, exposed for off-chain signers |

### `verifyAttestations` — the checks

```
n = attestations.length
require n == signatures.length                        → LengthMismatch()
require n <= MAX_ATTESTATIONS (16)                    → TooManyAttestations()
require n >= threshold                                → BelowThreshold(n, threshold)

for each i:
    require subject / schemaId / value match the caller's claim   → AttestationMismatch(i)
    require expiresAt > block.timestamp                           → AttestationExpired(i)
    require isAttestor[a.attestor]                                → NotAnAttestor(attestor)
    require no earlier entry has the same attestor                → DuplicateAttestor(attestor)
    require a.nonce == nonces[a.attestor]                         → InvalidNonce(attestor, expected, provided)
    require ECDSA.tryRecover(digest, sig) == a.attestor           → InvalidSignature(i)
    nonces[a.attestor]++
    acc = keccak256(abi.encode(acc, structHash))

attestationId = keccak256(abi.encode(subject, schemaId, value, acc))
emit AttestationVerified(attestationId)
```

The security properties this buys:

- **EIP-712 domain binding** (chain id + this contract) prevents cross-chain and cross-deployment
  replay. OpenZeppelin's `EIP712` recomputes the separator after a fork.
- **Sequential per-attestor nonces** make each signature single-use.
- **Distinct-signer enforcement** stops one attestor satisfying a `k > 1` threshold by submitting several
  signatures with consecutive nonces.
- **`ECDSA.tryRecover`** rejects malleable (high-s) signatures and never returns `address(0)` as a valid
  signer — it reports an error the caller must check, rather than a zero address the caller might not.
- **The bundle is order-sensitive but content-committed.** `attestationId` folds every struct hash into
  `acc` in order, so two different bundles about the same `(subject, schema, value)` produce different
  ids and are each single-use.

`MAX_ATTESTATIONS = 16` bounds the O(n²) distinctness scan.

### It is not `view`, and it is not gated

`verifyAttestations` writes (`nonces`), and **anyone may call it directly** — the registry is not a
privileged caller. A third party holding a valid bundle can therefore consume the nonce without storing
anything, after which the intended `submitAttestation` reverts `InvalidNonce`. Nothing is forged and no
value is written; the promoter simply has to fetch a freshly signed bundle. Worth knowing before treating
a signed bundle as a bearer token that is safe to leak.

### Managing the set

| Call | Rules |
|---|---|
| `setAttestor(attestor, active)` | Idempotent — a no-op returns early rather than double-counting. Removal that would drop `attestorCount` below `threshold` reverts `InvalidThreshold(threshold, newCount)`, because that would brick verification |
| `setThreshold(n)` | `0 < n <= attestorCount`, else `InvalidThreshold(n, attestorCount)` |

The verifier is deployed at `threshold = 1` with a single attestor — phase 1. Moving to k-of-n is a
`setThreshold` call. **No redeploy.**

---

## The live configuration

Seeded by `script/SeedDevRep.s.sol` (Base Sepolia and local alike). `SeedLocal` registers the same three
schemas with the same weights, windows and ceilings.

| Schema | Weight | `maxAge` | `maxValue` | Role |
|---|---|---|---|---|
| `ETHOS_SCORE` | 7 | 180 days | 2,800 | Primary credibility signal |
| `X_REACH` | 3 | 90 days | 2,800 | Secondary reach signal |
| `X_FOLLOWERS` | 0 | 0 (never expires) | 0 (unbounded) | **Display only** — attested and readable, contributes nothing |

That fixes `maxScore() = 7 × 2800 + 3 × 2800 = 28,000`, which is the ceiling every campaign's
`minReputation` is checked against at creation.

`X_FOLLOWERS` at weight 0 is the case the `maxScore` skip rule exists for: it is unbounded, and if
unweighted schemas were not skipped it would make the ceiling unknowable for everyone.

The dev wallet is seeded to `ETHOS_SCORE 2750`, `X_REACH 1790`, `X_FOLLOWERS 30000` — a BoneyScore of
**24,620**. `SeedDevRep` asserts that figure (`UnexpectedScore(actual, expected)`) rather than assuming
it: a fixture that silently produced a different score would move every gate that was tuned around it.
Both freshness windows are left at protocol length on this branch, unlike the lifecycle constants — a
shortened window would expire the seeded records mid-session and read as a broken gate rather than an
expired score (see [chapter 03](./03-lifecycle.md#time-constants)).

### The demo gates

`SeedDemo` seeds six campaigns whose durations ascend, so campaign id order is also expiry order. Three
carry gates, placed around 24,620 on purpose:

| # | Duration | Gate | Behaviour for the dev wallet |
|---|---|---|---|
| 0 | 24 hours | — | Ungated. The row a tester reaches for to watch an expiry |
| 1 | 3 days | — | Ungated. The multi-KPI campaign |
| 2 | 5 days | 10,000 | Cleared comfortably — the ordinary "gated but joinable" row |
| 3 | 7 days | — | Ungated |
| 4 | 10 days | 24,000 | Cleared by 620, so a decayed `ETHOS_SCORE` or `X_REACH` record drops the wallet below it |
| 5 | 14 days | 26,000 | Not clearable, so `InsufficientReputation` and the gate-blocked UI stay reachable |

Every gate sits under 28,000, or the campaign could not have been created at all.

---

## The app layer

The frontend calls `scoreOf(wallet)` the **BoneyScore** (`web/src/lib/boneyscore.ts`). It is the same
number; there is no separate computation. `MAX_BONEY_SCORE` mirrors the 28,000 ceiling, and
`ETHOS_WEIGHT`/`REACH_WEIGHT` mirror 7 and 3 — the TypeScript duplicates the registry's configuration
rather than reading it, so those constants have to be kept equal to what the seeds register.

### Where the two numbers come from

**Ethos** supplies its score directly. **Reach is derived, not raw**, because a follower count and an
Ethos score are not on the same scale — 30,000 followers against a 0–2,800 credibility score would make
the reach term a whale detector rather than an audience signal:

```ts
reachFromFollowers(followers) = min(2800, floor(400 * log10(1 + followers)))
```

A log curve puts the gap between 1k and 10k followers on par with the gap between 100k and 1M, which is
how audience size actually behaves, and the 2,800 ceiling puts reach on the same scale as Ethos so that
integer weights of 7 and 3 express a real 70/30 split. `followersForReach` inverts it for the join
panel's "you need N followers for this gate" copy; it returns `Infinity` above the ceiling, since no
audience reaches a reach of 2,801.

The raw follower count is attested separately under `X_FOLLOWERS` at weight 0 — readable, displayable,
and deliberately worth nothing.

### The signing route

`web/src/app/api/attest/route.ts` reads Ethos, computes reach, and signs one EIP-712 `Attestation` per
schema with `ATTESTOR_PRIVATE_KEY`. It never sends a transaction: the promoter's own wallet submits the
bundle to `submitAttestation`, which is why that function is permissionless. Bundles carry a 15-minute
TTL, matched by `expiresAt`.

The key can mint arbitrary reputation, so the route fails closed when it is unset and never echoes it.

`DeployBoney` defaults `BONEY_INITIAL_ATTESTOR` to `DEV_ATTESTOR`
(`0x98405c5776a63547E7Cb16000bA04cA53D9Fb2f8`) — the wallet that route signs with — precisely so the path
keeps working on a fresh deployment. Otherwise a redeployed verifier would not recognise the app's signing
key and every `submitAttestation` would revert `NotAnAttestor`.

Local development can substitute a stubbed Ethos source (`pnpm ethos:stub:dev`), which fabricates scores
for allowlisted wallets so gate behaviour is testable without a live Ethos profile. Real wallets go to
live Ethos; the stub does not change how anything is signed or verified, only where the number comes from.
See [chapter 09](./09-offchain.md).

### Explaining a decay before it bites

`daysUntilExpiry` and `combineFreshness` fold `expiresAtOf` across the two weighted schemas, and
`EXPIRY_NOTICE_DAYS = 14` is when the UI starts warning. That exists because the alternative is a promoter
discovering the decay as a reverted `join()`.

---

## Open, not settled

- **One attestor, threshold 1, in every deployment so far.** The k-of-n machinery is real and needs no
  redeploy, but nothing is currently configured above 1-of-1, so the honest description of today's trust
  model is "one server-side key decides reputation".
- **The registry owner can write any value up to `maxValue`.** `storeAttestation` bypasses signatures
  entirely. On the fixtures that owner is the same deployer key as everything else.
- **`X_REACH`'s meaning lives off chain.** The chain stores a number in 0–2,800; only
  `reachFromFollowers` in the web app knows it came from a log curve over follower counts. A second client
  implementing a different curve would write incomparable values under the same schema id.
- **Nothing revokes.** There is no negative attestation and no delete. A wallet's value can only be
  overwritten by a newer attestation, disabled schema-wide with weight 0, or left to age out.
