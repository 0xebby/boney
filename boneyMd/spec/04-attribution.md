# 04 — Attribution

Attribution answers one question: **who gets paid for this wallet's actions?** It is the most
security-sensitive part of the protocol, because a wrong answer pays the wrong person out of real
escrow, and the wrong answer looks exactly like the right one on chain.

The model is **LAST_TOUCH, with user consent, expiry, and an on-chain history that can be read at a
past block.**

---

## Why user-signed

If a promoter could assert attribution, they would claim every active wallet on the chain. Nothing
about a promoter's own transaction proves they caused a user's behaviour.

So the *end user* signs. Their signature is the thing an attacker cannot forge, and it is the entire
anti-abuse primitive: a promoter cannot attribute a wallet without that wallet's consent, and consent
expires — so a promoter who goes quiet loses attribution for users who stop interacting.

The user never transacts with Boney. They sign a typed message off chain; anyone may relay it, which
is normally the promoter, paying the gas.

## The `Touch`

```solidity
struct Touch {
    address campaign;    // the campaign this consent applies to
    bytes32 promoterId;  // opaque, campaign-bound id of the promoter being endorsed
    uint64  signedAt;    // when the user signed. Orders touches against each other
    uint64  expiresAt;   // after this, the touch credits nobody
}
```

Signed as EIP-712 typed data:

| Field | Value |
|---|---|
| Domain name | `"Boney Attribution"` |
| Domain version | `"1"` |
| `chainId` | the chain the registry is deployed on |
| `verifyingContract` | the `AttributionRegistry` address |
| Type string | `Touch(address campaign,bytes32 promoterId,uint64 signedAt,uint64 expiresAt)` |
| `TOUCH_TYPEHASH` | `keccak256` of that type string, exposed as a public constant |

`DOMAIN_SEPARATOR()` and `domain()` (the full EIP-5267 tuple) are exposed so a frontend or wallet can
build the digest without duplicating the struct definition. OpenZeppelin's `EIP712` recomputes the
separator after a chain fork, so a forked chain cannot replay signatures from the original.

The digest, for anything building it by hand:

```
structHash = keccak256(abi.encode(TOUCH_TYPEHASH, campaign, promoterId, signedAt, expiresAt))
digest     = keccak256(0x1901 ‖ DOMAIN_SEPARATOR ‖ structHash)
```

## Promoter ids

```solidity
promoterId = keccak256(abi.encode(address(campaign), promoterWallet));
```

Derived by the campaign at `join()`, stored both ways on the campaign, and registered in the
attribution registry via `registerPromoter(promoterId)`.

Two properties come out of that:

**Campaign-bound.** The id includes the campaign address, and `storeTouch` requires that the campaign
named in the signed payload registered that id *itself*. An id from campaign A cannot farm attribution
in campaign B, and a user's signature for one campaign says nothing about another.

**Namespaced by registrant.** `_registered` is keyed `[msg.sender][promoterId]`, so `registerPromoter`
is permissionless and idempotent without granting anything. An id claimed by a non-campaign sits in
that sender's own namespace, which no campaign ever reads — so a squatter cannot deny a campaign an id
it needs, and cannot make a touch valid for a campaign that never issued the id.

The id is opaque on purpose: a tracking link carries `promoterId`, not a wallet address, so a link does
not publish who is being paid.

## `storeTouch` — the validation order

```solidity
storeTouch(address user, Touch calldata touch, bytes calldata signature, address relayer)
```

Checks run in this order. The order is deliberate: the cheap structural rejections come before the
staticcalls, and the signature recovery comes before either storage write.

| # | Check | Revert |
|---|---|---|
| 1 | `user != 0` and `touch.campaign != 0` | `ZeroAddress` |
| 2 | `touch.promoterId != 0` | `ZeroPromoterId` |
| 3 | `touch.signedAt <= block.timestamp` | `TouchNotYetValid(signedAt, now)` |
| 4 | `touch.expiresAt > block.timestamp` | `TouchExpired(expiresAt, now)` |
| 5 | `touch.expiresAt <= now + effectiveMaxDuration(campaign)` | `TouchTooLong(expiresAt, max)` |
| 6 | the campaign can still accrue creditable work | `CampaignOver(end, now)` / `CampaignTerminal(status)` |
| 7 | `campaign` registered `promoterId` in its own namespace | `PromoterNotRegistered(campaign, promoterId)` |
| 8 | signature recovers to `user` | `InvalidSignature` |
| 9 | `touch.signedAt > stored.signedAt` (strictly) | `TouchNotNewer(signedAt, stored)` |
| 10 | not a re-touch for the promoter already live | `TouchAlreadyActive(promoterId, expiresAt)` |

On success it **writes twice**: it overwrites the live touch at `_touches[user][campaign]`, and it
appends a `TouchRecord` to `_history[user][campaign]`. Then it emits
`TouchStored(campaign, user, promoterId, signedAt, expiresAt, relayer)`.

`relayer` is **not authenticated**. It is an event field so an indexer can see who paid the gas; it
grants nothing and is not consulted anywhere. The `Boney` facade passes `msg.sender`.

### Checks 3 and 4 — the clock bounds

`signedAt` may not be in the future, so no single signature can pre-empt every later touch by claiming
a distant timestamp. `expiresAt` must be strictly in the future, so an already-dead touch cannot be
backfilled after the fact — which matters for the post-end fallback below.

### Check 5 — the effective horizon

```solidity
effectiveMaxDuration(campaign) = min(campaign.attributionWindow(), maxTouchDuration)
```

`maxTouchDuration` is a constructor argument on the registry, immutable, and a hard global cap: a
campaign returning a huge window still clamps to it, so a hostile or buggy campaign contract cannot
widen its own horizon. It can only narrow it, which is the campaign's own prerogative —
`attributionWindow` is immutable and set at creation.

That read is a **low-level staticcall**, not a typed call, for a specific reason: registration is
namespaced, so the registry deliberately does not require a registrant to be a `Campaign`. A typed
call would revert against an EOA registrant and turn documented independence into a hard dependency. A
target that does not answer — or answers with anything other than exactly one word — simply has no
window of its own, and the global cap stands.

The word is decoded as `uint256`, not `uint64`, so a dirty upper word clamps to the cap instead of
reverting. A zero window is read as "not a campaign" rather than "no attribution allowed", because
`Campaign`'s constructor rejects a zero window — so falling through to the cap keeps a decoding
surprise from bricking every touch for that address.

**This cap is silent.** A campaign whose `attributionWindow` exceeds `maxTouchDuration` still reports
its own longer window from `attributionWindow()`, which is what a UI renders. A frontend should build
`expiresAt` against `effectiveMaxDuration(campaign)`, not against the campaign's own field.

### Check 6 — bounded to the campaign's life

`_requireCampaignOpen` rejects a touch once the named campaign can no longer accrue creditable work.
Two bounds, and **both are load-bearing**:

- **`nowTs > endTime` → `CampaignOver`.** Catches a campaign whose window has closed but which nobody
  has called `end()` on yet. Reports are refused in that state, but a touch stored there would go live
  the instant the permissionless `end()` lands.
- **`status >= Ended` → `CampaignTerminal`.** Catches the opposite case: a project may `end()` early,
  and then `block.timestamp` never reaches `endTime` at all.

Both are read through the same forgiving staticcall as check 5, and a registrant that answers neither
is unbounded here rather than unusable. The status is decoded as `uint256`, not as the enum, and
compared numerically. `abi.decode` into an enum *panics* on an out-of-range value, which would let a
hostile campaign brick every touch naming it. Comparing numerically means any unknown value above the
terminal ones fails closed, and `Ended`/`Cancelled` are the last two members by construction. Both
errors carry the full word for the same reason — a truncated one could report a garbage status as
`Pending`. A zero `endTime` reads as "not a campaign", not "already over".

### Check 9 — LAST_TOUCH, ordered by signed intent

**Recency is `signedAt`, never relay order.** Relayers are the promoters competing for the credit, so
whoever transacts last would otherwise win: a displaced promoter could re-submit the user's *earlier*
signature and take the attribution back without fresh consent. Ordering therefore has to live inside
the signature.

Web2 last-touch gets ordering for free from a trusted server clock. On chain there is no trusted clock
for an off-chain event, so it goes in the payload.

Because the comparison is strict, replaying a superseded signature is a no-op rather than a rollback.

### Check 10 — no re-attribution while the same promoter is live

```solidity
if (prev.expiresAt > nowTs && touch.promoterId == prev.promoterId) {
    revert TouchAlreadyActive(prev.promoterId, prev.expiresAt);
}
```

A user already attributed to A cannot sign a *second* touch for A while the first is still live. Only
two things admit a new touch: a switch to a different promoter, or the current window lapsing.

This exists because the history is append-only and read at a block. Without it, a promoter could stack
records for itself — extending its own horizon indefinitely at the user's expense, and inflating a
history that `promoterAt` walks on every evidence-backed report. Renewal is still available; it just
has to wait for expiry, which is what makes expiry mean anything.

## The touch history

Every accepted touch is appended, oldest first:

```solidity
struct TouchRecord {
    bytes32 promoterId;
    uint64  signedAt;
    uint64  expiresAt;
    uint64  storedAtBlock;   // block.number at the write, not signedAt
}

mapping(address => mapping(address => TouchRecord[])) private _history;   // user => campaign => records
```

`storedAtBlock` is the registry's own clock, not the user's. `signedAt` orders touches against each
other because the user controls it; `storedAtBlock` places a touch against on-chain *activity*, and it
has to be a value the user cannot choose.

`promoterAt(campaign, user, atBlock, atTimestamp)` answers who held the user then. The walk is
newest-first and takes the first record already on chain before `atBlock`:

- **`storedAtBlock >= atBlock` is skipped.** Strict, so a touch landing in the action's own block
  belongs to the *previous* promoter. A promoter watching the mempool cannot back-date itself onto a
  transaction already in flight.
- **The winning record must be unexpired at `atTimestamp`.** An action that happened during a gap
  credits nobody rather than falling back further, which matches the live rule.
- A user with no history, or activity predating their first touch, returns `bytes32(0)`.

`promotersAt` is the batch form, one call for a whole evidence array, reverting
`LengthMismatch(blocks, timestamps)` on ragged input.

`soleAttributionSince(campaign, user, sinceBlock)` answers a different question: **did exactly one
promoter hold this user across the whole span?** It walks newest-first, stops at the first record
already on chain at or before `sinceBlock`, and returns `bytes32(0)` the moment two records disagree.
Note what `sinceBlock == 0` means — no report has closed a span yet, so the whole history must name one
promoter. This is the guard the evidence-free report path uses; see below.

## Reading attribution

Seven views, and the difference between them is the difference between "who holds this wallet now" and
"who held it then":

| View | Returns | Used by |
|---|---|---|
| `activePromoter(campaign, user)` | The promoter id, or `bytes32(0)` if `expiresAt <= block.timestamp` | `Campaign._resolvePromoterId` first |
| `touchOf(campaign, user)` | The stored live touch verbatim, expired or not | `TouchWindowVerifier`, the post-end fallback, `lib/referrals`, `lib/viewerRole` |
| `promoterAt(campaign, user, atBlock, atTimestamp)` | Who held the user at that block, or `bytes32(0)` | The reference for every off-chain mirror |
| `promotersAt(campaign, user, atBlocks[], atTimestamps[])` | The batch form | `Campaign._ownersOf`, once per evidence-backed report |
| `soleAttributionSince(campaign, user, sinceBlock)` | The single id covering the span, else `bytes32(0)` | `Campaign.reportUserAction`, evidence-free path |
| `touchHistoryLength(campaign, user)` | Record count | Enumeration |
| `touchHistoryAt(campaign, user, index)` | One `TouchRecord`, oldest first | Enumeration |
| `effectiveMaxDuration(campaign)` | `min(attributionWindow, maxTouchDuration)` | Any client building `expiresAt` — `lib/attribution` |

Superseded touches **are** retained, so `promoterAt` can be trusted for a past block without an
indexer. Only the *live* row is single: `_touches[user][campaign]` is one slot, and `activePromoter`
reads exactly that.

Off chain, `web/src/lib/attributionWindows.ts` reconstructs the same walk from `TouchStored` logs,
because the relayer's ceiling and the indexer's claim have to measure the activity the chain will
attribute, not the activity the live touch would suggest.

## Per-action attribution

`reportUserAction(kpiIndex, user, newTotal, evidence)` takes a cumulative total, and where that total
came from in time is what decides who earns it. There are two paths, and `evidence.length` picks
between them.

### With evidence — segmented per action

`evidence` decodes to `Types.Action[]` (`{blockNumber, timestamp, amount}`), bounded by
`MAX_EVIDENCE_ACTIONS` (256, `TooManyActions(provided, max)`) and required non-decreasing by
`blockNumber` (`UnorderedEvidence(index)`). Then:

1. **`_ownersOf`** asks `promotersAt` who held the user at every action's block, in one call. It also
   enforces the block ordering, since the tally walk depends on it.
2. **`_tally`** walks oldest first, adding each action's `amount` to its own promoter's column, and
   stops at the verifier's `verifiedTotal`. Oldest-first matters: when a ceiling cuts the report short,
   the part that lands is the oldest work, so the next report resumes cleanly instead of leaving a hole.
   An action nobody held stays uncredited and reportable later.
3. **`_credit`** applies each promoter's column *less what that promoter already holds* for this
   `(user, kpi)` pair — `_creditedTo[user][kpiIndex][promoterId]`, exposed as
   `creditedToOf(user, kpiIndex, promoterId)`. It is a per-promoter high-water mark, so re-sending the
   same evidence credits nothing and a verifier that revised a total downward cannot claw anything back.
4. `_userCredited` advances by **what was actually credited**, not to `verifiedTotal`, so skipped
   actions remain reportable.
5. Each promoter that gained progress is settled, so a report can pay several promoters in one
   transaction.

This is what closes the granularity gap. Attribution is resolved per action at that action's own block,
so activity predating a touch is credited to whoever held the wallet at the time — or to nobody —
rather than following whoever happens to hold the touch at report time. A promoter who knows the
reporting cadence has nothing to farm.

### Without evidence — resolved at report time, and refused when ambiguous

An empty `evidence` has no timestamps to place work by, so attribution falls back to
`_resolvePromoterId(user)` and the whole delta goes to one promoter. That is only safe while nothing
changed hands, and the contract checks rather than assumes:

```solidity
bytes32 sole = attributionRegistry.soleAttributionSince(
    address(this), user, _lastReportBlock[user][kpiIndex]
);
if (sole != currentId) revert AmbiguousAttribution(user, kpiIndex);
```

If more than one promoter held the user since the last report closed
(`lastReportBlockOf(user, kpiIndex)`, zero until the first one), the report is **refused, not guessed**.
The fix is to send the same report with evidence.

### `TouchWindowVerifier` is not the answer here

`TouchWindowVerifier` predates per-action segmentation. It caps a claim at the activity at or after the
current touch's `signedAt`, less a lookback — a useful *reading* of attribution, and it is deployed for
that. But it must **not** be wired as a `KpiSpec.verifier` or as a `GuardedKpiVerifier` `Mode.CAP`
second verifier: `Campaign` already segments per action, so the adapter would cap the whole report at
the *current* promoter's slice and starve every earlier segment. Both `script/DeployBoney.s.sol` and the
contract's own `@dev` say so. See [chapter 06](./06-verification.md).

Note also that a verifier may only reduce `verifiedTotal`, never redirect a payee. It can deny a
promoter a delta they did not earn; it cannot award that delta to the promoter who did. Because neither
`_userCredited` nor `_creditedTo` advances for the denied portion, a corrected report can land later.

## The post-end fallback

`Campaign._resolvePromoterId(user)`, which only the evidence-free path calls:

```solidity
bytes32 live = attributionRegistry.activePromoter(address(this), user);
if (live != bytes32(0)) return live;                       // normal path
if (status != Ended) return bytes32(0);                    // → revert NoAttribution
return attributionRegistry.touchOf(address(this), user).promoterId;   // expired touch honoured
```

While the campaign is live the rule is strictly `activePromoter`: an expired touch credits nobody, with
the accepted consequence that a lapse hands everything to whoever the user signs for next.

Once `Ended`, and only then, the stored touch is honoured **even if expired**. Without that, the
reporting grace window would be useless: touch TTLs are days and campaigns run for weeks, so by the
time a withheld report can finally be filed most touches have lapsed, every one of those reports would
revert `NoAttribution`, and the project would get back exactly the escrow the grace window exists to
protect.

That relaxation cannot be used to steal credit, and it is worth being precise about why. **Four things
hold together:**

1. `storeTouch` rejects a touch once the campaign is past `endTime` or terminal, so a post-end
   signature cannot displace the promoter who did the work.
2. It overwrites only on a strictly newer `signedAt`, so the stored touch is the user's latest
   *in-campaign* intent.
3. It rejects an already-expired `expiresAt`, so nobody can backfill a stale touch after the fact.
4. Reporting is bounded to `CLAIM_GRACE`, after which it closes entirely.

Drop the first and the rest do not save it: a promoter who did nothing could collect a withheld report
by having the user re-sign during the grace window. This is why check 6 above exists, and why it is
enforced on touch *creation* rather than on touch *reading*.

An evidence-backed report never reaches this fallback — `promotersAt` resolves each action against the
history, expiry included, and a lapsed span simply credits nobody. The relaxation is the resolver for a
report carrying no evidence at all.

`test/PostEndTouch.t.sol` pins this; `test/ReportWithholding.t.sol` pins the withholding path it
protects.

## Accepted trade-offs

Stated plainly, because each is a real property of the design rather than an oversight:

- **A user can knowingly sell their signature.** Consent is the primitive; a consenting user colluding
  with a promoter is outside what the protocol can detect.
- **Replaying an older *unsuperseded* signature re-points attribution.** If a user signed for A, then
  for B, then A's signature is dead (not newer). But if a user signed two touches and only the older
  one was ever relayed, relaying the newer one later is a legitimate move by whoever holds it. The user
  consented to both.
- **A lapse hands credit to the next promoter, not back to the previous one.** Expiry is
  intentional — it is what makes a quiet promoter lose attribution — and the alternative (falling back
  to a previous touch) would make attribution effectively permanent. `promoterAt` applies the same
  rule to the past: an action inside a gap credits nobody rather than the promoter before it.
- **Last touch wins, forward only.** A newer touch redirects *future* credit. Progress already credited
  to the previous promoter is never clawed back, and their settled tiers are never unwound.
- **A report's accuracy is only as good as its evidence.** The chain can place an action it is told
  about; it cannot discover one it is not. Evidence comes from an off-chain log scan, and what caps a
  project's claim is an independent observer's reading of the same logs — see
  [chapter 06](./06-verification.md).
