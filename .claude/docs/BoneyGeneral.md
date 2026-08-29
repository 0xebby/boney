# BoneyGeneral — how Solidity, the off-chain processes, and the web app connect

Read this when a task crosses a layer boundary, or when you can't tell where a number on screen came
from. Protocol detail lives in `README.md` and `boneyMd/spec/`; **this doc is about the seams.**

---

## 1. What the product is

A project escrows a reward pool and defines KPIs with reward tiers. Promoters join and get a
campaign-bound promoter id encoded in a tracking link. A user who clicks that link **signs** a touch
binding their wallet to that promoter. When the user's on-chain actions are reported, progress credits
the attributed promoter and each newly crossed tier pays out of escrow automatically.

Identity is wallet-first: a project sees a reputation score and attestations, never a social handle.

---

## 2. The three layers

```
  ┌─ Solidity ───────────────────────────────────────────────────────┐
  │  Boney (facade, holds nothing, privileged nowhere)               │
  │  CampaignRegistry → Campaign  ·  EscrowVault                    │
  │  ReputationRegistry ← AttestationVerifier                       │
  │  AttributionRegistry  ·  OracleCoordinator                      │
  │  GuardedKpiVerifier → EventMetricKpiVerifier + TouchWindowVerifier│
  └───────────┬────────────────────────────────────┬────────────────┘
              │ two GENERATED artifacts            │ event logs
              │ (abis, deployments)                │
  ┌───────────▼────────────┐          ┌────────────▼────────────────┐
  │  web/src (Next 16)     │          │  off-chain processes         │
  │  app → components →    │◄─────────│  relay · indexer · ethos stub│
  │  hooks → lib → viem    │  reads   │  (all in web/scripts + lib)  │
  └────────────────────────┘          └──────────────────────────────┘
```

`flow/*.svg` draws the protocol side; `boneyMd/spec/02-architecture.md` has the full module map with
responsibilities. The rest of this doc is what those diagrams don't show.

---

## 3. The two generated seams

Everything the frontend knows about the contracts arrives through exactly two generated files. This is
the single most important thing to internalise: **the frontend cannot disagree with the compiled
contracts, unless you skip a regeneration.**

### `web/src/lib/abis/*.ts` ← `pnpm abis`

Reads Foundry's `out/<Contract>.sol/<Contract>.json` and writes a typed ABI per contract. The list of
contracts is `CONTRACTS` in `web/scripts/extract-abis.ts` — a new contract the frontend must talk to
gets added there, not copied by hand.

Skip this after changing an external function or event and the failure is a **runtime decode error**,
not a build error. There is no type-level link.

### `web/src/lib/deployments.ts` ← `pnpm deployments <chainId>`

Reads `broadcast/DeployBoney.s.sol/<chainId>/run-latest.json` and writes `GENERATED_DEPLOYMENTS`:
every module address plus a `startBlock` (the block the indexer and history scans start from). Two
chains are populated today — `31337` (anvil) and `84532` (Base Sepolia).

`lib/chains.ts` wraps it: `getDeployment(chainId)` returns `undefined` or a zero `boney` address when
the protocol isn't there, and every read helper in `lib/contracts.ts` returns an empty value rather
than throwing. That is why the UI can render an honest "not available on this network" instead of an
error boundary.

---

## 4. Vocabulary that diverges across the seam

| Concept | Solidity | web | note |
| --- | --- | --- | --- |
| the person promoting | `kol`, `kolId` | promoter, promoter id | **deliberate.** Don't rename across the seam. |
| reputation number | `scoreOf` | BoneyScore | |
| reputation inputs | `ETHOS_SCORE` / `X_REACH` / `X_FOLLOWERS` schema ids | same | the chain's spelling won a rename; match it |
| attribution event | `Touch` | touch / tracking link | |
| a KPI's definition | `KpiSpec {kind, verifier, target, aggregate, params}` | `lib/kpiSource.ts`, `lib/kpiUnits.ts` | |

When you grep, grep both spellings.

---

## 5. Reputation: how an off-chain number becomes an on-chain gate

The chain can't make HTTP calls, so reputation arrives by signed attestation. There are **two numbers
and they are not the same one**, which is the most common source of confusion in this codebase:

| | route | what it is |
| --- | --- | --- |
| display score | `GET /api/score` → `lib/score.ts` → `lib/ethos.ts` | reads Ethos + follower sources, computes BoneyScore. Nothing signed, no gas, no nonce. A wallet that has never sent a tx still gets a score, a rank, and a qualification list. |
| gate score | `ReputationRegistry.scoreOf` | **0 until attestations are submitted and gas is paid.** This is what `Campaign.join()` gates on. |

`POST /api/attest` bridges them: same upstream read, then one EIP-712 `Attestation` signed **per
weighted schema**. The promoter submits them (one tx each — `AttestationVerifier` consumes a nonce per
signature), and only then does `scoreOf` move. `web/src/app/card/page.tsx` refetches the on-chain
score after attesting for exactly this reason; forget that and the UI keeps asking for a verification
already paid for.

The **ethos stub** (`127.0.0.1:8787`, `pnpm ethos:stub:dev`) fabricates profiles. It matters in two
different modes:

- **allowlist mode** (the default) — a signed allowlist synthesises a profile in-process via
  `lib/stubProfile.ts`. The dev wallet `0x98405c…` is on it; real wallets go to live Ethos.
- **global stub mode** — the four `*_API` vars in `web/.env.local`, commented out by default.

The dev wallet is attestor *and* promoter, BoneyScore 24,620, and unclaimed on real Ethos — which is
why the stub path has to exist at all.

---

## 6. KPI verification: why two processes must run, in one order

A `Custom` KPI names an `IKpiVerifier`. The adapter returns a credited amount and `Campaign` caps the
claim at it — **an adapter can discount a report but never inflate one.**

The verifier a campaign should point at is `GuardedKpiVerifier`, which composes:

- `EventMetricKpiVerifier` — a ceiling fed by an **independent relayer** that scans the real event
  logs. This is what stops a project crediting itself more than an observer saw.
- `TouchWindowVerifier` is deployed but must **not** be wired as the `Mode.CAP` project verifier. It
  returns a window-scoped total, which would shrink the budget `Campaign` splits across promoters to the
  current promoter's slice. Segmentation lives in `Campaign` now; the adapter is kept for off-chain
  window reads. See `decisions.md` → *KPI verifiers — adapters may discount, never inflate*.

So two off-chain processes are required, and **the order between them is silent if you get it
wrong**:

1. **`pnpm relay`** (`scripts/relay-kpi-metric.ts` + `lib/relayCore.ts`) — Boney's observation. Until
   it has run, a gated KPI's ceiling is **0**.
2. **`pnpm index`** (`scripts/indexer.ts` + `lib/indexerCore.ts`) — the project's claim.

A report that lands before the relayer has observed **succeeds and credits nothing**. No revert,
nothing in the UI to surface it. `scripts/dev-up.sh` sequences relay-then-indexer and blocks on the
first relay pass for this reason, and the comment there says so at length.

Two more constraints worth not rediscovering:

- **`REPORTER_PRIVATE_KEY` must equal `PRIVATE_KEY`.** Guarded verifiers accept only the *project*
  key as reporter. The env var is named as if the reporter were independent — it isn't, in this
  fixture.
- **Aggregate KPIs (TVL, volume) are campaign-level and oracle-reported.** They advance display
  totals but credit no individual promoter, and `Campaign` now refuses an aggregate KPI that carries
  reward tiers. Per-promoter aggregate attribution is post-MVP.

### What `pnpm index` sends, since segmentation

Both processes resolve attribution through `web/src/lib/attributionWindows.ts` — the off-chain mirror of
`AttributionRegistry.promoterAt` — rather than reading the live touch, so the ceiling and the claim
measure the same activity the chain will segment.

- **Evidence is sent for every KPI**, `verifier == address(0)` included. `Campaign` decodes
  `Types.Action[]` itself to credit each action to whoever held the referral at that action's block.
- **There is no cursor.** `.indexer-state.json` is gone — a cursor produces a window-scoped total that
  `Campaign` compares against a lifetime watermark and silently ignores. Any doc still describing that
  file is stale.
- **The range is bounded by attribution instead.** The activity scan starts one block after the
  campaign's *first* touch (nothing earlier is creditable to anybody, so a campaign with no touch is
  skipped), and the `TouchStored` scan behind it starts at
  `startTime - effectiveMaxDuration` converted to a block by `lib/blockSearch.ts`. `--from-block` still
  overrides the activity floor. Both bounds only exclude blocks that could never have been credited;
  credit itself is decided per action, inside the range.
- **Activity nobody held is dropped**, including work done in a gap between an expired touch and the
  next one. Counting it would leave a `newTotal` that can never settle.

Design: `boneyMd/KPI_VERIFICATION.md`. Worked example: `boneyMd/KPI_VERIFICATION_WALKTHROUGH.md`.

---

## 7. Tracing one read and one write

**A read** — the campaign list:

```
app/page.tsx (thin)
  └─ components/CampaignsPage.tsx
       └─ hooks/useCampaigns.ts          useQuery + usePublicClient({chainId: useBoneyChainId()})
            └─ lib/contracts.ts          fetchBrowseCampaigns → boneyAddress → getDeployment
                 └─ lib/abis/Boney.ts    generated
                      └─ Boney.browseCampaigns(offset, limit) on chain
```

`lib/contracts.ts` decodes raw tuples into domain types (`CampaignView`, `statusFromIndex`) so no
component ever handles a `uint8` enum index.

**A write** — everything funnels through `hooks/useWriteCampaign.ts`, which owns the tx lifecycle and
maps reverts to human text via `lib/txErrors.ts` (a large, deliberate mapping — extend it rather than
surfacing a raw revert string).

**The chain id is never implicit.** `wagmiConfig.chains[0]` is `anvil`, and wagmi rehydrates its store
inside an effect, so *every* page load renders at least once with the store on anvil. Always
`usePublicClient({chainId: useBoneyChainId()})` — a bare `usePublicClient()` silently reads a local
node the visitor can't reach. See `hooks/useBoneyChain.ts`.

---

## 8. Lifecycle, and what is immutable

1. Project creates a campaign (config, KPIs, per-KPI tiers). Everything determining a payout is
   frozen at construction.
2. Project escrows the full `rewardPool`, then activates. Activation is blocked while underfunded.
3. Promoters join subject to `minReputation`; each gets a campaign-bound promoter id.
4. A user signs a touch (`/r?c=…&p=…` does this); anyone may relay it.
5. Cumulative per-user actions are reported. Progress credits the attributed promoter; each newly
   crossed tier pays out inline.
6. On end, a claim grace window; then the project reclaims the rest.

Immutable, so a change means a **reseed or redeploy**: `minReputation`, `CLAIM_GRACE` (a compiled
`constant`), and the registry itself (append-only — `Campaign.cancel()` is reachable only from
`Pending`, so an activated campaign can never be retired).

Rewards draw from one shared pool, first-come. An uncoverable tier pays what remains and emits
`PoolExhausted` — it never reverts, because reverting would let one exhausted tier block reporting for
everyone.

**`Campaign.settle` pays zero in every reachable state** — settlement is inline, at report time. The
claim button in the UI is dormant by design; don't "fix" it.

---

## 9. This branch's shortened durations

`bscoretest`-lineage branches shorten time constants so manual testing is fast. `CLAIM_GRACE` 7d→20m,
`DISPUTE_WINDOW` 1d→4m, `UNSTAKE_DELAY` 2d→10m, attribution windows down to 30–60m. Each source
constant carries a `[bscoretest]` comment with its protocol value. **Restore them before merging to
main.**

Two are deliberately *not* shortened:

- `MAX_TOUCH_DURATION` — a silent per-touch ceiling, `min(campaign.attributionWindow, cap)`. A
  campaign still *reports* its own longer window, which is what the UI renders, so shortening the cap
  makes the app disagree with the chain rather than making anything faster.
- Reputation freshness (`ETHOS_MAX_AGE` / `REACH_MAX_AGE`, 180/90d) — shortening it would expire
  seeded attestations mid-session and drop wallets below their gates.

---

## 10. Deploy + seed order

Full detail with commands in `README.md`. The order that matters:

1. `DeployBoney` — registries and verifiers with no deps, then `OracleCoordinator`, then
   `EscrowVault` → `CampaignRegistry` (one-time `setRegistrar`), wire coordinator, then the facade.
2. `web/ pnpm deployments <chainId>` — point the app at what landed.
3. **`SeedDevRep` — not optional, and must precede step 4.** `DeployBoney` registers no reputation
   schemas, so a fresh `ReputationRegistry` scores everyone 0 *and* reports `maxScore() == 0` — and
   `Campaign`'s constructor rejects any `minReputation` above that ceiling with
   `UnreachableReputation`. Gated campaigns literally cannot be created until the schemas exist.
4. The campaign seed (`SeedDemo` whole-fixture, or `SeedTwo` / `SeedFive` / `SeedHistory` /
   `SeedRealKpi` …).

Current Base Sepolia fixture (2026-08-29, second seed of the day): two `SeedTwo` campaigns on registry
`0x3e0a2fc4…` — `Venus` on canonical WETH, gated at BoneyScore **19,500**, and `Sdy Labs` on a freshly
deployed `OpenMintNFT`, open. Both campaigns' **KPIs** are still ungated, so `relay-loop.sh` has an
empty target list and `dev:up` skips the loop — the Venus gate is on *joining*, and the relayer neither
sees nor cares. This is the first deployment carrying the `AmbiguousAttribution` guard as well as
segmented crediting. Every earlier registry, `0x82fCc991…` and `0x6427217e…` included, is dead. Two
rival mock bUSD tokens exist on Base Sepolia — the current fixture prices everything in `0x2755…dCc2`,
so a seed that deploys a fresh token splits the pool totals.

A `boney-indexer` subgraph is live on Studio for Base Sepolia; its query endpoint needs no API key.
It is version-pinned — `NEXT_PUBLIC_SUBGRAPH_URL` names `v0.5.0`, which is the first version indexing
`0x3e0a2fc4…`, so a redeploy means a new version label *and* an env bump. `pnpm deploy` in `subgraph/`
runs pnpm's own builtin; the script is `pnpm run deploy --version-label vX.Y.Z`.
