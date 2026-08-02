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

### KPI extensibility

KPIs are `KpiSpec { kind, verifier, target, aggregate, params }`. A `Custom` KPI **must** name an
`IKpiVerifier`; the adapter returns the credited amount and the campaign caps it at the amount
claimed — an adapter can discount a report but never inflate one.

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
6. On end, a 7-day claim grace window lets promoters settle; then the project reclaims the rest.

Rewards draw from one shared pool, first-come. If the pool cannot cover a crossed tier, the
contract pays what remains and emits `PoolExhausted` — it never reverts, since reverting would
let one exhausted tier block reporting for everyone.

## Build & test

```bash
forge build
forge test                    # 187 tests across 7 suites
forge test --mc CampaignTest  # a single suite

PRIVATE_KEY=0x... BONEY_INITIAL_ATTESTOR=0x... \
  forge script script/DeployBoney.s.sol:DeployBoney
```

Deploy order (encoded in `script/DeployBoney.s.sol`):

1. `AttributionRegistry`, `AttestationVerifier`, `ReputationRegistry` — no dependencies
2. `OracleCoordinator` — before the registry, which needs its address
3. `EscrowVault`, then `CampaignRegistry`; the registry becomes the vault's registrar via a
   one-time `setRegistrar`
4. Wire the coordinator to the registry, then deploy the `Boney` facade

## Security

Threat-model detail is in `BoneyDocs.md`. Summary of the enforced properties:

- **Fake conversions** — attribution needs a user signature; reports are cumulative so replay is
  a no-op; verifier adapters can only discount.
- **Escrow theft** — vault custody is isolated per campaign; `paidOut <= rewardPool` holds by
  construction; cancellation is only possible before activation.
- **Attribution fraud** — promoter ids are campaign-bound; touches expire; a new touch redirects
  only *future* credit and never claws back earned rewards.
- **Oracle manipulation** — reports land only after the dispute window; a disputed report slashes
  the reporter and is never applied; stake is locked while reports are in flight.
- **Replay** — EIP-712 domain binding throughout; per-attestor nonces; used attestation ids rejected.

Not yet audited. See `todo.md` for deferred work and known limitations.

## License

MIT
