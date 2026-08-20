# Walkthrough: a deposit-count campaign, end to end

The flow in `KPI_VERIFICATION.md` with concrete numbers. Campaign creation → attribution → activity →
verification → crediting → settlement → reclaim.

**Example project:** DriftLend, a lending protocol on Base Sepolia
**KPI:** deposits per user — `COUNT`, because whether a deposit happened matters and how large it was
does not
**Reward pool:** 50,000 bUSD, escrowed for the campaign's duration

Every getter, error and constant named here is the real one. `CLAIM_GRACE` is **20 minutes**
(`Campaign.sol:59`), not a placeholder.

---

## Phase 0 — One-time, protocol level

`DeployBoney` deploys all three verifiers once. They are configured per KPI after a campaign exists,
so they are never redeployed per campaign.

```
EventMetricKpiVerifier  owner = deployer, reporter = BONEY_KPI_REPORTER (defaults to deployer)
GuardedKpiVerifier      owner = deployer, boneyVerifier = the above (immutable)
TouchWindowVerifier     stateless, no constructor args
```

The reporter should be a **different key** from the project's. It is the whole basis of the cap being
worth anything: `REPORTER_PRIVATE_KEY` observes, `PRIVATE_KEY` claims.

---

## Phase 1 — Campaign creation (DriftLend)

```solidity
kpis[0] = Types.KpiSpec({
    kind: Types.KpiKind.Deposit,          // a hint for indexers and UIs; settlement never branches on it
    verifier: address(guardedVerifier),   // immutable from here on
    target: 5_000,
    aggregate: false,
    params: abi.encode(vault, depositTopic, uint8(1), uint8(0), uint256(1))
});
```

This transaction is what **assigns `kpiIndex = 0`** and fixes `startTime` / `endTime`. None of them
exist beforehand, which is why every verifier call in Phase 2 has to come after it.

Escrow is pulled in, `activate()` is called, status becomes `Active`.

Note `verifier` is fixed at creation and cannot be changed afterwards. Pointing it at
`GuardedKpiVerifier` rather than straight at `EventMetricKpiVerifier` is what leaves room to add or
remove a second verifier later — the guard's config is mutable even though the campaign's KPI spec is
not.

---

## Phase 2 — Wire up verification (Boney ops)

```bash
pnpm report-window --campaign 0xDriftLendCampaign --rpc $BASE_SEPOLIA_RPC
```

```
Campaign 0xDriftLendCampaign on chain 84532
  startTime:      1755400000  (2025-08-17T04:26:40.000Z)
  endTime:        1758000000  (2025-09-16T06:40:00.000Z)
  CLAIM_GRACE:    1200s
  status:         1
  reporting ends: 1758001200  (2025-09-16T07:00:00.000Z)  [projected]

  windowStartBlock: 8912004
  windowEndBlock:   9210558

  Note: this campaign has not been ended yet, so the close is the earliest it could
  be. Calling end() late pushes it later — re-run this afterwards to extend.
```

That note matters. The campaign is still `Active`, so `endedAt` is 0 and the real close is unknown —
it depends on when someone calls the permissionless `end()`. The projection is the *earliest* it
could be. Re-running after `end()` lands and calling `setKpiConfig` again extends the window without
touching the checkpoint or any stored total.

```solidity
kpiVerifier.setKpiConfig(
    /* campaign */         0xDriftLendCampaign,
    /* kpiIndex */         0,
    /* targetContract */   0xDriftLendVault,
    /* eventSignature */   "Deposit(address indexed user, uint256 amount)",
    /* userParamIndex */   0,          // `user` is param 0 in declaration order
    /* aggregation */      Aggregation.COUNT,
    /* valueParamIndex */  0,          // ignored for COUNT, kept for the struct shape
    /* scale */            1,          // COUNT counts events; nothing to scale
    /* windowStartBlock */ 8_912_004,
    /* windowEndBlock */   9_210_558
);

guardedVerifier.setGuardConfig(
    /* campaign */         0xDriftLendCampaign,
    /* kpiIndex */         0,
    /* projectVerifier */  address(0), // Boney alone; see the variant at the end
    /* toleranceBps */     0,
    /* mode */             Mode.AGREE
);
```

The KPI is now fully wired. Until `setKpiConfig` lands, `verify()` reverts `KpiNotConfigured` — a
half-configured KPI is loudly broken rather than silently crediting nothing.

---

## Phase 3 — Campaign live

Promoter **Bob** shares his link. **Alice** clicks it and signs an EIP-712 touch binding her wallet
to Bob's `promoterId`; a relayer submits it and `AttributionRegistry` stores
`touchOf(campaign, alice).signedAt = T_attr`.

Alice then deposits into DriftLendVault three times:

| # | when | event | counts? |
|---|---|---|---|
| 1 | before `T_attr` | `Deposit(alice, 500)` | **no** — pre-attribution |
| 2 | after `T_attr` | `Deposit(alice, 1,200)` | yes |
| 3 | after `T_attr` | `Deposit(alice, 300)` | yes |

The KPI is `COUNT`, so 1,200 and 300 are irrelevant — two qualifying events happened. Deposit #1
happened before Alice was attributed to anyone, so it is creditable to no promoter and is excluded
upstream.

---

## Phase 4 — Boney's relayer (`pnpm relay`, periodically)

```bash
REPORTER_PRIVATE_KEY=$BONEY_RELAYER_KEY \
  pnpm relay --campaign 0xDriftLendCampaign --kpi 0 --rpc $BASE_SEPOLIA_RPC
```

1. Reads `configOf(campaign, 0)`, parses the signature into a real ABI event, derives topic0, and
   validates that param 0 really is an `address`.
2. Compares the config against the KPI's `params` blob. A mismatch in event, source or scale aborts
   the run — the project would otherwise claim one event while Boney verified another.
3. Reads `checkpointOf(campaign, 0)`. First run, so 0 → start at `windowStartBlock`.
4. `eth_getLogs` for `Deposit` on the vault across the range, chunked to 2,000 blocks (Base's public
   endpoint rejects wider outright), stopping 5 blocks behind the head.
5. Decodes every log: `user = alice`, `value = 1` each — `COUNT` ignores `amount`.
6. Resolves `attributionRegistry() → touchOf(campaign, alice).signedAt = T_attr`, one read per unique
   user.
7. Resolves each unique block's timestamp, deduped.
8. Filters: deposit #1 excluded, #2 and #3 kept.
9. `alice → delta = 2`. Reads `verifiedTotalOf(campaign, 0, alice)` = 0, so the new total is 2.
10. `reportBatch(campaign, 0, [alice, …], [2, …], 8_918_220)` — totals and checkpoint, atomically.

```
  47 matching log(s), 47 decoded
  3 user(s) skipped with no attribution touch — their activity is not creditable to any promoter
  1 log(s) excluded as pre-attribution activity
  creditable activity for 12 user(s)
    0xalice…: 0 → 2
  reporting as 0xBoneyRelayer
    tx 1/1 (12 user(s)): 0xabc123…

  done — checkpoint now at 8918220
```

Every subsequent run scans forward only, touches only users with new activity, and never passes
`windowEndBlock`. A re-run with nothing new prints `nothing new to scan yet` and sends no
transaction.

---

## Phase 5 — DriftLend reports (`pnpm index`, or its own indexer)

DriftLend claims whatever it believes Alice's cumulative deposit count is. It does not need to match
Boney's number — Boney's is the cap.

```solidity
campaign.reportUserAction(0, alice, 2, "");
```

Inside `reportUserAction`:

1. `_requireReportableStatus()` — `Active`, fine.
2. `_requireReportWindow()` — inside the campaign window, fine.
3. `already = _userCredited[alice][0]` = 0. `2 >= 0`, so not `NonMonotonic`, and not the
   `newTotal == already` idempotent-replay early return.
4. `_resolvePromoterId(alice)` → Bob's `promoterId`. A live touch exists, so no `NoAttribution`.
5. `spec.verifier != address(0)` → `GuardedKpiVerifier.verify(campaign, 0, alice, 2, "", params)`:
   - `EventMetricKpiVerifier.verify` → `verifiedTotals[alice] = 2`, `scale = 1`, so `observed = 2`.
     `min(claim 2, observed 2) = 2`.
   - `projectVerifier == address(0)`, so Boney's 2 is returned unchanged.
6. `verifiedTotal (2) > newTotal (2)`? No — `VerifierOvercredit` does not fire.
7. `credited = 2 - 0 = 2`.
8. `_userCredited[alice][0] = 2`; `_progress[bob][0] += 2`; `_totalProgress[0] += 2`.
9. `emit ProgressCredited(0, bobPromoterId, alice, 2)`.
10. `_settle(bob, bobPromoterId, 0)` walks Bob's tier ladder and pays every newly crossed rung from
    escrow.

**Had DriftLend claimed 5 instead of 2**, step 5 would return 2, `credited` would be 2, and the
remaining 3 would simply never be credited — no revert, no payout. That is the cap doing its job.

**Had the relayer not run yet**, `observed` would be 0, `verifiedTotal (0) <= already (0)`, and
`reportUserAction` would return early having credited nothing. Also no revert. This is the single
most common "why is progress stuck" cause, and it is not a bug: the indexer and the relayer both have
to be running.

---

## Phase 6 — End plus claim grace

- `endTime` passes. Reporting is **still open**: `_requireReportWindow` returns early once the status
  is `Ended`, and `_requireReportableStatus` allows reports through `endedAt + CLAIM_GRACE`.
- Someone calls the permissionless `end()`, setting `endedAt`. **Now** the real close is known — and
  if `end()` was called late, it is later than `report-window` originally projected, so re-run it and
  call `setKpiConfig` again to extend `windowEndBlock`.
- The relayer keeps running through the grace window, picking up deposits made just before the end.
- The moment `CLAIM_GRACE` elapses, `_requireReportableStatus` starts reverting `WrongStatus` and
  `reclaimUnspent` becomes callable — by design at exactly the same instant, so escrow is never
  reclaimable while a valid report could still land.

---

## Phase 7 — Settlement

```solidity
campaign.reclaimUnspent();
```

Returns whatever the ladder never paid out. If credited progress across all promoters came to 4,200
deposits and the ladder paid 42,000 bUSD, DriftLend reclaims the remaining 8,000.

Every credited unit is now backed by a deposit that (a) actually happened on chain, (b) happened
after that user's real attribution, and (c) was independently observed by Boney's relayer — not
merely asserted by DriftLend.

---

## Variant: DriftLend runs its own verifier too

Configure the guard with their verifier instead of `address(0)`:

```solidity
guardedVerifier.setGuardConfig(campaign, 0, 0xDriftLendVerifier, 0, Mode.AGREE);
```

Step 5 then calls both and compares. Beyond `toleranceBps` the report **reverts**
`VerifierDisagreement(projectValue, boneyValue, diff, allowed)` rather than quietly taking the
smaller number — a disputed metric becomes an alert instead of a silent haircut. `0` bps is right
here: two independent scans of a deposit *count* should agree exactly.

Everything else is unchanged.

## Variant: layering `TouchWindowVerifier`

```solidity
guardedVerifier.setGuardConfig(campaign, 0, address(touchVerifier), 0, Mode.CAP);
```

`CAP`, **not** `AGREE`. `TouchWindowVerifier` floors credit at the current touch's `signedAt`, so if
Alice later re-attributes to a different promoter it deliberately discards her pre-switch deposits,
while Boney's cumulative total still counts them. The two disagree by construction, and under `AGREE`
every legitimate post-switch report would revert. `CAP` credits `min` of the two.

This is worth doing: it moves attribution-timing enforcement back on chain rather than trusting the
relayer to have filtered correctly. The cost is that `TouchWindowVerifier` credits nothing without
`evidence`, so only reporters that send it — the indexer does — can move this KPI.
