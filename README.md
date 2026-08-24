# Boney Protocol

**The accountability layer for Web3 growth.**

Boney makes performance-based collaborations between projects and promoters (KOLs, creators,
communities, affiliates) trustless. Projects escrow campaign funds; rewards release
automatically as verified milestones are achieved. The first application is a KOL marketplace,
but the protocol generalizes to any workflow where funds should move only after objectively
verifiable work.

- **Wallet-first identity** — projects see reputation scores and attestations, never social handles.
- **Performance-based payouts** — tiered rewards released from escrow as attributed KPIs are met.
- **User-signed attribution** — the end user consents to attribution; consent expires.
- **Extensible KPIs** — mints, swaps, deposits, TVL, volume, or any custom metric via an
  `IKpiVerifier` adapter.
- **Escrow by default** — funds sit in a custody-only vault; a campaign can move only its own.

## Architecture

```
                        ┌──────────────────────────┐
                        │      Boney (facade)      │   marketplace UX
                        │  create · fund · claim   │   holds no funds
                        └────────────┬─────────────┘   no privileged role
                                     │
              ┌──────────────────────┼──────────────────────┐
              │                      │                      │
   ┌──────────▼─────────┐  ┌─────────▼────────┐  ┌──────────▼─────────┐
   │  CampaignRegistry  │  │ ReputationRegistry│  │ AttributionRegistry│
   │  factory · index   │  │ scoreOf/qualifies │  │ user-signed touches│
   │  vault registrar   │  └─────────┬─────────┘  │ LAST_TOUCH + expiry│
   └──────────┬─────────┘            │            └──────────┬─────────┘
              │ deploys              │ verified by           │ resolves
              │                      │                       │ promoter
   ┌──────────▼─────────┐  ┌─────────▼──────────┐            │
   │      Campaign      │◄─┤ AttestationVerifier│            │
   │  lifecycle · KPIs  │  │  k-of-n EIP-712    │            │
   │  tier settlement   │  └────────────────────┘            │
   └────┬──────────┬────┘◄───────────────────────────────────┘
        │          │
        │ releases │ aggregate updates
        │          │
   ┌────▼──────┐  ┌▼──────────────────┐
   │EscrowVault│  │ OracleCoordinator │
   │ custody   │  │ stake · dispute   │
   │ only      │  │ slash             │
   └───────────┘  └───────────────────┘
```

| Contract | Responsibility |
|---|---|
| `Campaign` | Immutable config, KPIs and tiers. Credits attributed actions, settles tiers from the pool. |
| `CampaignRegistry` | Factory + directory. The vault's registrar, so every campaign is token-bound and discoverable. |
| `EscrowVault` | Custody only. Per-campaign balances; only the campaign releases or reclaims its own funds. |
| `AttributionRegistry` | Maps users to promoter ids per campaign via signed EIP-712 touches. |
| `ReputationRegistry` | Weighted score from attested metrics. Stores numbers and schema ids only. |
| `AttestationVerifier` | k-of-n threshold EIP-712 attestations, per-attestor nonce replay protection. |
| `OracleCoordinator` | Staked reporters submit aggregate updates through an optimistic dispute window. |
| `EventMetricKpiVerifier` | Caps a KPI claim at a metric an independent relayer observed in the real event logs. |
| `GuardedKpiVerifier` | Composes Boney's reading with an optional second verifier — reject on divergence, or take the stricter. |
| `TouchWindowVerifier` | Credits only actions performed while the current promoter held attribution. |

### KPI extensibility

KPIs are `KpiSpec { kind, verifier, target, aggregate, params }`. A `Custom` KPI **must** name an
`IKpiVerifier`; the adapter returns the credited amount and the campaign caps it at the amount
claimed — an adapter can discount a report but never inflate one.

The verifier a campaign should point at is `GuardedKpiVerifier`, which consults Boney's
`EventMetricKpiVerifier` — fed by an independent relayer that scans the real event logs — and
optionally cross-checks a second verifier such as `TouchWindowVerifier`. That means a project cannot
credit itself more than an independent observer saw. It also means **two off-chain processes have to
run**: `pnpm index` for the project's claim and `pnpm relay` for Boney's observation. See
`boneyMd/KPI_VERIFICATION.md` for the design and `boneyMd/KPI_VERIFICATION_WALKTHROUGH.md` for a
worked example.

Aggregate KPIs (TVL, volume) are campaign-level and oracle-reported. They advance totals for
display but do not credit individual promoters; per-promoter aggregate attribution is tracked
as post-MVP work.

### Lifecycle

1. Project creates a campaign with config, KPIs, and per-KPI reward tiers.
2. Project escrows the full `rewardPool`, then activates. Activation is blocked while underfunded.
3. KOLs join (subject to `minReputation`), receive a campaign-bound promoter id, and share a
   tracking link encoding it.
4. A user signs a touch binding their wallet to that promoter id; anyone may relay it.
5. The project or oracle reports **cumulative** per-user actions. Progress credits the attributed
   promoter, and each newly crossed tier pays out automatically.
6. On end, a claim grace window lets promoters settle; then the project reclaims the rest.
   Protocol value is 7 days; this branch (`bscoretest`) shortens it to 20 minutes for testing —
   see [Shortened durations](#shortened-durations-bscoretest).

Rewards draw from one shared pool, first-come. If the pool cannot cover a crossed tier, the
contract pays what remains and emits `PoolExhausted` — it never reverts, since reverting would
let one exhausted tier block reporting for everyone.

## Build & test

```bash
forge build
forge test                    # 331 tests across 15 suites
forge test --mc CampaignTest  # a single suite

PRIVATE_KEY=0x... \
  forge script script/DeployBoney.s.sol:DeployBoney
```

Deploy order (encoded in `script/DeployBoney.s.sol`):

1. `AttributionRegistry`, `AttestationVerifier`, `ReputationRegistry` — no dependencies
2. `OracleCoordinator` — before the registry, which needs its address
3. `EscrowVault`, then `CampaignRegistry`; the registry becomes the vault's registrar via a
   one-time `setRegistrar`
4. Wire the coordinator to the registry, then deploy the `Boney` facade

## Shortened durations (bscoretest)

`bscoretest` exists to make manual testing fast, so the time-based constants are far shorter
than the protocol values. **Restore the protocol values before merging to main.** Each source
constant carries a `[bscoretest]` comment with its protocol value.

| Constant | Protocol | bscoretest |
|---|---|---|
| `Campaign.CLAIM_GRACE` | 7 days | 20 minutes |
| `DeployBoney.DISPUTE_WINDOW` | 1 day | 4 minutes |
| `DeployBoney.UNSTAKE_DELAY` | 2 days | 10 minutes |
| `DeployBoney.MAX_TOUCH_DURATION` | 30 days | 30 days (unchanged — see below) |
| `attributionWindow` (`SeedLocal`, `SeedGated`, `SeedEventKpi`, create form) | 7–14 days | 30 minutes – 1 hour |
| `attributionWindow` (`SeedExpiry`, `SeedDemo`) | — | equal to each campaign's own length |

`MAX_TOUCH_DURATION` is deliberately **not** shortened. It is a per-touch ceiling the attribution
registry applies as `min(campaign.attributionWindow, maxTouchDuration)`, and it applies *silently* —
a campaign whose window exceeds the cap still reports its own longer window from
`attributionWindow()`, which is what the UI renders. Shortening it does not shorten what the app
says; it only makes the app disagree with the chain. `SeedExpiry` asserts the deployed cap covers
its longest campaign before spending gas, so a registry deployed with a short cap fails that seed
instead of truncating it.

Because `CLAIM_GRACE` is a `constant` compiled into `Campaign`, changing it requires a full
redeploy (`DeployBoney`) and regenerating `web/src/lib/deployments.ts` (`pnpm deployments` in
`web/`). The deploy script defaults `BONEY_INITIAL_ATTESTOR` to the dev wallet so the
stub-driven attestation path keeps working on the new deployment.

The reputation freshness windows (`ETHOS_MAX_AGE` / `REACH_MAX_AGE`, 180/90 days) are intentionally
**not** shortened: a shortened freshness window would expire seeded attestations mid-session and
drop wallets below their campaign gates.

Campaign `endTime` is a per-fixture choice rather than a constant. `SeedLocal`, `SeedGated`, and
`SeedEventKpi` run 30–60 days out, which puts expiry out of reach of a testing session; the
Base Sepolia fixture is seeded by `script/SeedDemo.s.sol` instead, whose six campaigns expire at
24 hours and 3/5/7/10/14 days so the window-closed → `end()` → grace → `reclaimUnspent` path is
reachable without warping a chain.

`SeedDemo` is a **whole-fixture** seed, not an append: it asserts `campaignCount() == 0`, because
`CampaignRegistry` is append-only and `Campaign.cancel()` is reachable only from `Pending`, so an
activated campaign can never be retired. `minReputation` is immutable too, so changing a gate is
also a reseed. Replacing the fixture therefore means redeploying, in this order:

```bash
# 1. fresh contracts
PRIVATE_KEY=0x… forge script script/DeployBoney.s.sol:DeployBoney --rpc-url … --broadcast --slow
# 2. point the app at them
cd web && pnpm deployments 84532
# 3. schemas + dev wallet score — MUST precede step 4
PRIVATE_KEY=0x… REPUTATION_ADDRESS=0x… \
  forge script script/SeedDevRep.s.sol:SeedDevRep --rpc-url … --broadcast --slow
# 4. the six campaigns
PRIVATE_KEY=0x… REGISTRY_ADDRESS=0x… VAULT_ADDRESS=0x… ATTRIBUTION_ADDRESS=0x… TOKEN_ADDRESS=0x… \
  forge script script/SeedDemo.s.sol:SeedDemo --rpc-url … --broadcast --slow
```

Step 3 is not optional. `DeployBoney` registers no reputation schemas, so a fresh
`ReputationRegistry` scores every wallet 0 **and** reports `maxScore() == 0` — and `Campaign`'s
constructor rejects any `minReputation` above that ceiling with `UnreachableReputation`, so step 4's
gated campaigns cannot even be created until the schemas exist. `SeedDevRep` registers
`ETHOS_SCORE`/`X_REACH`/`X_FOLLOWERS` at weights 7/3/0 with the same windows and ceilings
`SeedLocal` uses (fixing `maxScore()` at 28,000) and restores the dev wallet's 24,620 BoneyScore,
asserting that total rather than assuming it.

Three of the six campaigns are gated, placed around that score: 10,000 (cleared comfortably),
24,000 (cleared by 620, so a decayed record drops the wallet below it) and 26,000 (not clearable by
that wallet, so `InsufficientReputation` and the gate-blocked UI stay reachable). The 24-hour
campaign is deliberately ungated — it is the one a tester reaches for to watch an expiry.

`TOKEN_ADDRESS` is an existing mock bUSD rather than a fresh one: unlike `SeedLocal`, `SeedDemo`
deploys no token, so the fixture does not add another rival bUSD for the pool totals to split
across.

## Security

Threat-model detail is in `boneyMd/BoneyDocs.md`. Summary of the enforced properties:

- **Fake conversions** — attribution needs a user signature; reports are cumulative so replay is
  a no-op; verifier adapters can only discount.
- **Escrow theft** — vault custody is isolated per campaign; `paidOut <= rewardPool` holds by
  construction; cancellation is only possible before activation.
- **Attribution fraud** — promoter ids are campaign-bound; touches expire; a new touch redirects
  only *future* credit and never claws back earned rewards.
- **Oracle manipulation** — reports land only after the dispute window; a disputed report slashes
  the reporter and is never applied; stake is locked while reports are in flight.
- **Replay** — EIP-712 domain binding throughout; per-attestor nonces; used attestation ids rejected.

Not yet audited. See `boneyMd/todo.md` for deferred work and known limitations.

## License

MIT
