# 10 — Integration guides

Step-by-step for each actor. Every call named here is documented in full in
[chapter 11](./11-reference.md).

There is no addresses chapter to look them up in, deliberately: live addresses are *generated* rather
than written down. `web/src/lib/deployments.ts` comes from Foundry's broadcast via
`pnpm deployments <chainId>`, and the deploy runbook — order, wiring, the one-shot
`setRegistrar`/`setCampaignRegistry` steps — is in [`../../README.md`](../../README.md). A hand-copied
address list would be wrong within a deploy.

## Before anything

```bash
forge build
cd web && pnpm abis          # writes typed ABIs to web/src/lib/abis
```

You need three addresses to do anything: `Boney` (or `CampaignRegistry` directly), `EscrowVault`, and
`AttributionRegistry`. `Boney` exposes the rest — it reads them off the registry at construction, so a
facade cannot be wired to a mismatched module set.

The facade is optional everywhere. It buys one approval instead of one per campaign, paginated views, and
a caller-binding check on creation. Every call it makes can be made directly. See
[chapter 02](./02-architecture.md#boney--the-facade).

---

## For a project

### 1. Design the campaign

Decide these before writing any code, because **none of them can be changed after creation**:

| Decision | Field | Irreversible because |
|---|---|---|
| Who owns it | `cfg.project` | Only this address can fund, activate, end, or reclaim |
| What pays out | `cfg.token` | Bound in the vault at creation |
| How much | `cfg.rewardPool` | The ceiling on everything the campaign can ever pay |
| When | `cfg.startTime`, `cfg.endTime` | Reports outside the window revert |
| How long consent lasts | `cfg.attributionWindow` | Floored by the registry's global cap |
| Who may join | `cfg.minReputation` | Checked at `join()`; rejected at creation if unreachable |
| What counts | `kpis[]` | Including the verifier address |
| What it pays | `tiers[][]` | Strictly ascending thresholds, non-zero rewards |

There is no admin key that can edit any of it afterwards, and no upgrade path —
[chapter 02](./02-architecture.md#immutability-and-upgrade-posture) states what that costs and why it
was chosen.

Name rules: 1–32 bytes, printable ASCII, not all spaces, unique after trimming/collapsing/lowercasing.
Check with `CampaignRegistry.isNameAvailable(name)` before submitting. The stored name is what you
supplied; only the lookup key is normalized — [chapter 02](./02-architecture.md#campaign-names).

**Sizing the pool.** There is no per-promoter allocation. If the sum of all reachable tiers across all
promoters exceeds the pool, someone gets underpaid and `PoolExhausted` fires — see
[chapter 05](./05-kpi-model.md#pool-exhaustion-never-reverts).

The construction-time shape limits (32 KPIs, 32 tiers each, at least one tier on every non-aggregate
KPI) are tabulated in [chapter 03](./03-lifecycle.md#shape-limits).

### 2. Create it

```solidity
Types.CampaignConfig memory cfg = Types.CampaignConfig({
    project:           msg.sender,
    name:              "Acme Deposits",
    token:             TOKEN,
    rewardPool:        2_000e18,
    startTime:         uint64(block.timestamp),
    endTime:           uint64(block.timestamp + 14 days),
    attributionWindow: 7 days,
    minReputation:     10_000
});

Types.KpiSpec[] memory kpis = new Types.KpiSpec[](1);
kpis[0] = Types.KpiSpec({
    kind:      Types.KpiKind.Deposit,
    verifier:  GUARDED_KPI_VERIFIER,        // see step 4
    target:    500,
    aggregate: false,
    params:    abi.encode(SOURCE, TOPIC0, uint8(1), uint8(1), uint256(1e15))
});

Types.RewardTier[][] memory tiers = new Types.RewardTier[][](1);
tiers[0] = new Types.RewardTier[](3);
tiers[0][0] = Types.RewardTier({threshold: 10,  reward: 100e18});
tiers[0][1] = Types.RewardTier({threshold: 50,  reward: 400e18});
tiers[0][2] = Types.RewardTier({threshold: 200, reward: 1_500e18});

(uint256 campaignId, address campaign) = boney.createCampaign(cfg, kpis, tiers);
```

Through the facade, `cfg.project` must be `msg.sender` — `NotProject(expected, caller)` otherwise. Going
straight to `CampaignRegistry.createCampaign` drops that check, so a script can create a campaign owned
by an address it is not signing as.

`script/SeedDemo.s.sol` is a working end-to-end example, including the verifier wiring below.

From TypeScript:

```ts
const {result} = await publicClient.simulateContract({
  address: boney, abi: BoneyAbi, functionName: "createCampaign",
  args: [cfg, kpis, tiers], account,
});
const [campaignId, campaign] = result;
await walletClient.writeContract({address: boney, abi: BoneyAbi,
  functionName: "createCampaign", args: [cfg, kpis, tiers]});
```

### 3. Fund and activate

Through the facade — one approval, reusable across every campaign:

```bash
cast send $TOKEN "approve(address,uint256)" $BONEY 2000ether --private-key $PK
cast send $BONEY "fundCampaign(uint256,uint256)" $CAMPAIGN_ID 2000ether --private-key $PK
```

Or directly, approving the vault per campaign:

```bash
cast send $TOKEN "approve(address,uint256)" $VAULT 2000ether --private-key $PK
cast send $VAULT "deposit(address,uint256)" $CAMPAIGN 2000ether --private-key $PK
```

Then:

```bash
cast send $CAMPAIGN "activate()" --private-key $PK
```

`activate()` reverts `NotFunded(balance, required)` until the **full** pool is escrowed. Deposits may be
split across as many transactions as you like. For a fee-on-transfer token the vault credits what
actually arrived, so send enough to cover the fee.

### 4. Wire the verifiers

Only if the KPI names `GuardedKpiVerifier`, which it should. Do this **after** creation, because both
configs are keyed by `(campaign, kpiIndex)`.

```bash
# a. derive the block bounds
cd web && pnpm report-window --campaign $CAMPAIGN --rpc $RPC

# b. tell Boney's verifier what to watch
cast send $EVENT_METRIC_VERIFIER \
  "setKpiConfig(address,uint256,address,string,uint8,uint8,uint8,uint256,uint256,uint256)" \
  $CAMPAIGN 0 $SOURCE "Deposit(address indexed dst, uint256 wad)" 0 1 1 1000000000000000 \
  $WINDOW_START $WINDOW_END --private-key $OWNER_PK

# c. tell the guard how to combine readings
cast send $GUARDED_VERIFIER "setGuardConfig(address,uint256,address,uint16,uint8)" \
  $CAMPAIGN 0 0x0000000000000000000000000000000000000000 0 0 --private-key $OWNER_PK
#                                          ^ projectVerifier  ^ toleranceBps  ^ Mode.AGREE
```

Note the argument order on `setKpiConfig`: `userParamIndex`, then `aggregation`, then `valueParamIndex`.
`aggregation` is `0 = COUNT`, `1 = SUM`. `Mode` is `0 = AGREE`, `1 = CAP`. The whole config, field by
field, is in [chapter 06](./06-verification.md#kpiconfig).

**Re-running `setKpiConfig` does one of two very different things.** Moving `windowEndBlock` alone is the
routine edit: nothing else moves, and every stored total and the checkpoint survive. Changing anything
else — the target, the signature, either param index, `aggregation`, `scale`, or `windowStartBlock` —
bumps an `epoch` that is part of the storage key for every verified total, so the old readings become
unreachable, `lastScannedBlock` resets to 0, and the relayer rescans from `windowStartBlock`. That is
what makes re-pointing a KPI safe rather than a way to mix two event definitions into one number; see
[chapter 06](./06-verification.md#replacement-and-the-epoch-that-makes-it-safe).

**Pick the second verifier deliberately:**

| Second verifier | Mode | Tolerance |
|---|---|---|
| None (`address(0)`) | either — ignored | ignored |
| Your own independent measurement of the same quantity | **`AGREE`** | `0` for `COUNT`, small nonzero for `SUM` |
| `TouchWindowVerifier` | **neither — do not wire it** | — |

`address(0)` is the honest default: the KPI still routes through the guard, so a second verifier can be
added later, and until then Boney's reading stands alone. An unconfigured KPI is not the same thing — the
guard reverts `NotConfigured(campaign, kpiIndex)` rather than passing a claim through ungated.

**`TouchWindowVerifier` must not be wired here, and must not be a KPI's `verifier` either.** It predates
per-action segmentation. `Campaign` now places each evidence action with whoever held the user at that
action's block, while the touch-window adapter reads one per-user number off the *current* touch — so as
a `CAP` second verifier it caps a promoter-switch report at the current promoter's slice and starves the
earlier segment of the ceiling it needed. `script/SeedDemo.s.sol` and `GuardedKpiVerifier`'s own NatSpec
both still name it as `CAP`'s motivating case; they predate the change.
[Chapter 06](./06-verification.md#it-must-not-be-wired-as-a-kpis-verifier) works the arithmetic through
and lists which sources are stale. What it is still good for is `windowFloor` — an off-chain read of the
earliest creditable timestamp.

**The two event descriptions must agree.** `setKpiConfig`'s signature/target/scale and the KPI's
`params` blob describe the same event twice. The relayer refuses to start if they disagree, which is the
guard — but nothing stops the mismatch being introduced. Change one, change the other. See
[chapter 09](./09-offchain.md#the-event-source-commitment-in-params).

### 5. Report progress

Run both halves. See [chapter 09](./09-offchain.md) for the full behaviour.

```bash
cd web
pnpm relay --campaign $CAMPAIGN --kpi 0 --rpc $RPC --dry-run   # Boney's observation
pnpm relay --campaign $CAMPAIGN --kpi 0 --rpc $RPC
pnpm index --campaign $CAMPAIGN --rpc $RPC --dry-run            # your claim
pnpm index --campaign $CAMPAIGN --rpc $RPC
```

Order matters: the relayer sets the ceiling the indexer's claim is capped at, so an indexer pass that
runs first credits nothing and burns the monotonicity headroom for nothing.

Or report by hand — `newTotal` is **cumulative for that `(user, kpi)` pair**, not a delta:

```bash
cast send $CAMPAIGN "reportUserAction(uint256,address,uint256,bytes)" \
  0 $USER 42 0x --private-key $PK
```

Passing `0x` for evidence resolves attribution once, at report time, from the user's live touch. That is
only safe while one promoter has held the user for the whole increment; when more than one has, the
campaign refuses with `AmbiguousAttribution(user, kpiIndex)` rather than guessing. Evidence is an
`abi.encode(Types.Action[])` — ascending block order (`UnorderedEvidence(index)`), at most
`MAX_EVIDENCE_ACTIONS` = 256 (`TooManyActions(provided, max)`). Both paths are worked through in
[chapter 04](./04-attribution.md#per-action-attribution).

Payout is automatic. Every crossed tier settles in the same transaction —
[chapter 05](./05-kpi-model.md#settlement).

### 6. Wind down

```bash
cast send $CAMPAIGN "end()" --private-key $PK          # or anyone, once endTime passes
# ... wait out CLAIM_GRACE (20 minutes on this branch) ...
cast send $CAMPAIGN "reclaimUnspent()" --private-key $PK
```

Reporting stays open during the grace window, so a promoter can still be credited and paid. Reclaim
reverts `ClaimWindowOpen(until)` until it closes. This complement — escrow leaves only after crediting
closes, never both at once — is the invariant in
[chapter 03](./03-lifecycle.md#the-complement-invariant).

After `end()` lands, **re-run `pnpm report-window` and `setKpiConfig`** — the close is now exact rather
than projected, and the relayer's bound should reflect it. Change only `windowEndBlock` and nothing is
invalidated; that exclusion exists precisely so this edit is cheap.

`CLAIM_GRACE` is 20 minutes on this branch and 7 days in the protocol; the full shortened-constant table
is in [chapter 03](./03-lifecycle.md#time-constants).

### Pausing

`pause()` / `unpause()` halt and resume reporting. Pausing does not extend anything and cannot strand
anyone: `end()` becomes permissionless once `endTime` passes.

---

## For a promoter

### Join

```bash
cast send $CAMPAIGN "join()" --private-key $PROMOTER_PK
```

Allowed while `Pending` **and** `Active`, so you can prepare links before launch. Reverts
`InsufficientReputation(score, required)` below the gate, `AlreadyJoined` on a second attempt.

### Get your id and build the link

```bash
cast call $CAMPAIGN "promoterIdOf(address)(bytes32)" $PROMOTER
```

It is `keccak256(abi.encode(campaign, promoter))`, so a frontend can derive it without a read. Encode it
in a tracking link that lands on the referral page:

```
https://<app>/r?campaign=<campaignAddress>&promoter=<promoterId>
```

The id is opaque, so the link does not publish which wallet gets paid. `promoterOf(promoterId)` resolves
it back on chain — see [chapter 04](./04-attribution.md#promoter-ids) for what the id does and does not
hide.

### Clear a reputation gate

```bash
cast call $REPUTATION "scoreOf(address)(uint256)"  $PROMOTER
cast call $CAMPAIGN   "minReputation()(uint256)"
```

If short, attest more: get an attestor bundle and call `submitAttestation` (permissionless — the
signatures are the authority). `isValueFresh` and `expiresAtOf` tell you whether an existing value still
counts and when it stops. Note that the gate is read **once**, at join: joining early locks in your
eligibility, and a score that decays afterwards cannot unjoin you —
[chapter 07](./07-reputation.md#the-interaction-with-minreputation).

### Getting paid

Nothing to do. Settlement is inline on every crediting report. `Campaign.settle(promoter, kpiIndex)` and
`Boney.claimRewards(campaignId, promoter, kpiIndex)` are permissionless and correct, but dormant — by the
time you call them the ladder is already settled
([chapter 05](./05-kpi-model.md#there-is-no-claim-step)).

To watch progress: `progressOf(promoter, kpiIndex)`, `settledTiersOf(promoter, kpiIndex)`,
`tiers(kpiIndex)`, and the `TierSettled` / `PoolExhausted` logs.

---

## For an end user (and the frontend asking them to sign)

The user signs once, off chain, and never transacts with Boney.

### Build the touch

```ts
const registry = ATTRIBUTION_REGISTRY;
const maxDuration = await publicClient.readContract({
  address: registry, abi: AttributionRegistryAbi,
  functionName: "effectiveMaxDuration", args: [campaign],
});

const now = BigInt(Math.floor(Date.now() / 1000));
const touch = {
  campaign,
  promoterId,                      // from the tracking link
  signedAt:  now,
  expiresAt: now + maxDuration,    // must be ≤ now + effectiveMaxDuration
};
```

**Use `effectiveMaxDuration(campaign)`, not the campaign's own `attributionWindow()`.** The registry's
global cap applies as `min(...)` and applies *silently* — a campaign whose window exceeds the cap still
reports its own longer window, so building against that field produces a `TouchTooLong` revert.
[Chapter 04](./04-attribution.md#check-5--the-effective-horizon) has the derivation.

### Sign it

```ts
const signature = await walletClient.signTypedData({
  account: user,
  domain: {name: "Boney Attribution", version: "1", chainId, verifyingContract: registry},
  types: {Touch: [
    {name: "campaign",   type: "address"},
    {name: "promoterId", type: "bytes32"},
    {name: "signedAt",   type: "uint64"},
    {name: "expiresAt",  type: "uint64"},
  ]},
  primaryType: "Touch",
  message: touch,
});
```

The domain is readable on chain as `eip712Domain()` (or the alias `domain()`), and the struct hash as
`TOUCH_TYPEHASH()`, so a client never has to hardcode either.

### Relay it

Anyone can submit it — normally the promoter, paying the gas:

```ts
await walletClient.writeContract({
  address: BONEY, abi: BoneyAbi, functionName: "registerAttribution",
  args: [campaignId, user, touch, signature],
});
// or straight to the registry:
// storeTouch(user, touch, signature, relayer)
```

The facade's version additionally checks `touch.campaign` matches the campaign at `campaignId`, reverting
`CampaignMismatch`.

### Common reverts

| Revert | Cause |
|---|---|
| `TouchTooLong` | `expiresAt` beyond `effectiveMaxDuration` |
| `TouchExpired` | `expiresAt` already passed — the user sat on the signature |
| `TouchNotYetValid` | `signedAt` in the future (clock skew) |
| `TouchNotNewer` | A touch with an equal or newer `signedAt` is already stored |
| `TouchAlreadyActive` | That same promoter already holds a live touch for this user |
| `PromoterNotRegistered` | That promoter has not joined **this** campaign |
| `CampaignOver` / `CampaignTerminal` | The campaign is past `endTime`, or `Ended`/`Cancelled` |
| `InvalidSignature` | Wrong signer, wrong domain, or wrong chain id |

`TouchAlreadyActive` is the one worth handling rather than surfacing: re-clicking a live referral link is
a no-op, not a failure. The full validation order is in
[chapter 04](./04-attribution.md#storetouch--the-validation-order).

---

## For a relayer operator

You hold `EventMetricKpiVerifier.reporter`. You are trusted to report honestly; you cannot credit anyone.

```bash
# in web/
REPORTER_PRIVATE_KEY=0x... pnpm relay --campaign $CAMPAIGN --kpi 0 --rpc $RPC
```

- **Use a different key from the project's `PRIVATE_KEY`.** The whole point is an independent
  observation. On this branch they are the same key for gated KPIs, which collapses the guarantee —
  [chapter 06](./06-verification.md#the-two-keys-and-how-independent-they-really-are).
- Run `--dry-run` first. It needs no key and prints exactly what would be sent.
- The script refuses to run on config drift, and refuses to send if the key is not the on-chain
  `reporter`. Both are deliberate.
- It is stateless and idempotent. Run it on a timer; re-run it after a crash; move hosts freely. The
  checkpoint lives on chain.
- Re-run `pnpm report-window` and have the owner update `setKpiConfig` when a campaign's
  `windowEndBlock` is exhausted, or after `end()` lands. Moving only that field costs nothing; changing
  what is watched bumps the epoch and you rescan from `windowStartBlock`.
- `scripts/relay-loop.sh` runs one invocation per gated KPI, which is the shape you want on a timer —
  [chapter 09](./09-offchain.md#relay-loopsh--one-invocation-per-gated-kpi).

To rotate the key: `setReporter(newReporter)`, owner only. There is no ceremony around this yet, and it is
a single key — see the open items in [chapter 06](./06-verification.md#open-not-settled).

---

## For an oracle reporter

```bash
cast send $ORACLE "stake()" --value 100ether --private-key $REPORTER_PK

# per-user (credits a promoter, settles inline)
cast send $ORACLE "submitUserReport((address,uint256,address,uint256,bytes))" \
  "($CAMPAIGN,0,$USER,42,0x)" --private-key $REPORTER_PK

# ... wait out disputeWindow (4 minutes on this branch) ...
cast send $ORACLE "applyUserReport(bytes32)" $REPORT_ID --private-key $ANYONE
```

The `reportId` comes back from the submission — read it from the return value or from
`ReportSubmitted`. Nothing enumerates a reporter's outstanding reports, so keep the id.

Applying is permissionless, so anyone can push a good report through. This is the path that makes a
promoter payable without the project's cooperation — the point of the whole layer, and why
`reportUserAction` admits the coordinator alongside the project
([chapter 08](./08-oracle.md#why-it-exists)).

Aggregate reports use `submitReport` / `applyReport` and can only target a KPI marked `aggregate`. Two
things about them: `submitReport` accepts a `Report.evidence` field and silently discards it, and the
campaign gives aggregate updates **no** grace window — so an aggregate report submitted close to
`endTime` can clear its dispute window into a campaign that will never accept it. Both in
[chapter 08](./08-oracle.md#the-two-entry-points-are-not-symmetric).

Your stake stays locked until `disputeWindow + unstakeDelay` past your last submission, and every
submission extends the lock. A governor dispute inside the window slashes it entirely and voids the
report permanently — there is no partial slash and no reward for honest reporting
([chapter 08](./08-oracle.md#open-not-settled)).

---

## `script/promoter.sh` — the whole promoter side from a terminal

The promoter flow without a browser or a frontend. Useful for driving a deployed fixture, and the
shortest complete demonstration that the mechanism works end to end.

```bash
./script/promoter.sh status  $CAMPAIGN
./script/promoter.sh run     $CAMPAIGN 0 42
```

`run` is join → sign a touch → relay it → credit the user's cumulative total → push settlement, and
prints the promoter's token balance before and after. The subcommands (`join`, `touch`, `report`,
`settle`) are the same steps individually, for when one of them needs redoing.

Two keys, read from the repo-root `.env`:

| Env | Role |
|---|---|
| `ETHOS_PK` | The promoter. Joins, and receives the tier payouts |
| `PRIVATE_KEY` | The project. Relays touches, and is the only address besides the coordinator that `reportUserAction` accepts |

`run` checks `PRIVATE_KEY` against the campaign's on-chain `project()` first and fails early rather than
reverting `NotReporter` three steps in. Everything else is read off the campaign itself
(`attributionRegistry()`, `reputationRegistry()`, `token()` are public), so there is nothing to configure
per deployment beyond `RPC_URL` (default Base Sepolia) and `CHAIN_ID` (default 84532).

The user whose actions get credited is a throwaway wallet derived from `USER_SEED` (default
`boney-demo-user-1`), so a given seed always yields the same address and re-running credits the same
wallet instead of scattering attribution across new ones. It never needs gas — it only signs, and the
project relays. `--user` takes either a seed string or an `0x` address to name an existing user.

Exit codes distinguish the three failure kinds: `1` usage, `2` chain/RPC, `3` refused by a contract. A
refusal is decoded — the script carries the selector list for the errors this flow can actually provoke,
so you get `InsufficientReputation(12816, 20000)` rather than a hex blob.

Two details in there that are worth knowing before writing anything similar:

- **Every read pins a block.** Base's public RPC load-balances across nodes that are not always at the
  same height, and an unpinned read moments after a send can land on one a block behind — which reads
  as the transaction having silently done nothing —
  [chapter 09](./09-offchain.md#operational-notes) has the observed failure rate.
- **`cast wallet sign --data` must be given the payload with `--from-file`.** Handed the typed-data JSON
  inline it signs it as an opaque string, producing a well-formed signature over the wrong digest, and
  `storeTouch` reverts `InvalidSignature` with nothing to suggest the payload was the problem.

The script also nudges `signedAt` past the stored touch's when the chain's timestamp has not moved, since
LAST_TOUCH rejects a touch that is not strictly newer.

---

## For a frontend

### Reading a campaign

```ts
const view = await publicClient.readContract({
  address: BONEY, abi: BoneyAbi, functionName: "campaignView", args: [campaignId],
  // note: pass chainId explicitly — see below
});
```

`campaignView` covers the listing fields. Anything deeper — KPI specs, tier ladders, per-promoter
progress — comes from the campaign itself: `kpi(i)`, `tiers(i)`, `progressOf`, `totalProgress`,
`userCreditedOf`, `settledTiersOf`, `remainingPool`.

`browseCampaigns(offset, limit)` returns an empty array past the end rather than reverting.

### Always pass an explicit chain id

wagmi seeds its store with `chains[0].id` and falls back to it, so a disconnected visitor (and one render
of every load) resolves to whatever is first in the list. Pass `{chainId: useBoneyChainId()}` on every
read. A connected wallet's own chain always wins.
[Chapter 09](./09-offchain.md#three-frontend-gotchas) has this and two others.

### Showing why a report credited less than claimed

```ts
const observed = await publicClient.readContract({
  address: EVENT_METRIC_VERIFIER, abi: EventMetricKpiVerifierAbi,
  functionName: "observedProgressOf", args: [campaign, kpiIndex, user],
});
```

That is the **scaled** ceiling `verify` compares against. `verifiedTotalOf` is the raw unscaled metric.
`TouchWindowVerifier.windowFloor(campaign, user, params)` gives the earliest creditable action timestamp,
so a UI can say which activity currently counts.

### Showing who was credited for a shared user

A user can be credited across two promoters within one report. `creditedToOf(user, kpiIndex, promoterId)`
is the per-promoter split of `userCreditedOf(user, kpiIndex)`, and `lastReportBlockOf(user, kpiIndex)` is
the block the last report for that pair landed in — the lower bound the next report's evidence is
segmented from. `AttributionRegistry.promoterAt(campaign, user, atBlock, atTimestamp)` answers who held
the user at any past point, `promotersAt` does a batch of them in one call, and
`soleAttributionSince(campaign, user, sinceBlock)` returns the single promoter who held them for a whole
span — or `bytes32(0)` if more than one did, which is exactly the evidence-free ambiguity check.

### Decoding reverts

Every module declares its errors in its interface, and `web/src/lib/txErrors.ts` maps selectors to human
copy. The high-signal ones for a user-facing flow: `NoAttribution`, `AmbiguousAttribution`,
`InsufficientReputation`, `OutsideWindow`, `WrongStatus`, `NotFunded`, `TouchTooLong`, `TouchNotNewer`,
`TouchAlreadyActive`, `VerifierDisagreement`, `KpiNotConfigured`, `NotConfigured`.

### Things a UI should not do

- **Do not cache `scoreOf` as a constant.** It falls over time with no transaction touching the wallet.
- **Do not render a claim button as required.** Settlement is inline; the button has nothing to do.
- **Do not compute `paidOut` from `TierSettled` sums alone** when a pool has been exhausted — `paid` can
  be less than the tier's configured reward.
- **Do not reimplement the pre-attribution filter.** Import `relayCore.aggregateDeltas`. A second
  implementation is the rule most likely to silently credit the wrong promoter.
- **Do not read attribution from logs alone past about a day.** `planWindows` scans a bounded recent
  range, so an older touch is absent from a log-derived view while still perfectly live on chain —
  [chapter 09](./09-offchain.md#three-frontend-gotchas).

---

## Open, not settled

- **Nothing enumerates.** No per-reporter report list, no per-campaign promoter list, no per-user touch
  index across campaigns. Every integration here keeps its own ids, or reads the subgraph
  ([chapter 09](./09-offchain.md#the-subgraph)).
- **The verifier configs are owner-only and the owner is one key.** A project cannot configure its own
  KPI's guard; it asks whoever holds `GuardedKpiVerifier.owner()`. That is a coordination cost on every
  campaign creation, not just a trust assumption.
- **The wind-down step needs a key the project does not hold.** Re-pointing `windowEndBlock` after `end()`
  is cheap on chain and free of invalidation, but only the verifier's owner can do it — so the last step
  of a project's own campaign is somebody else's transaction.
- **The relayer and the indexer share a key on this branch.** Step 5 reads as two independent halves and
  is not, for gated KPIs.
- **`script/promoter.sh` drives the project key.** It is a fixture tool, and there is no promoter-only
  path through it — a real promoter cannot use it to get themselves credited, because reporting is not
  theirs to do.
