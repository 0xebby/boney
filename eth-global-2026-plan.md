# ETHGlobal 2026 — Boneyard plan

Five additions, planned against the code as it stands on `boneypoints` (read 2026-09-05). Each section
says what exists today, what changes, what breaks, and how it is verified.

Baseline: 7 campaigns on registry `0x3e0a2fc4…` (Base Sepolia), Gyndore and Uniswap gated, the other
five ungated. **Do not quote SuperBridge or Venus totals in a demo** — both carry pre-2026-09-04
indexer inflation (~1.9× and smaller); Sdy Labs and the two gated campaigns measured clean.

---

## 0. The constraint that orders everything

Campaign configuration is immutable and `CampaignRegistry` mints each campaign with `new Campaign`.
Three of the five features change `Campaign.sol`. Every redeploy carries a fixed tax:

- `pnpm abis` (no type-level link — skipping it fails at runtime, not at build)
- `pnpm deployments <chainId>`
- subgraph redeploy + a new version label in `NEXT_PUBLIC_SUBGRAPH_URL`
- `web/src/lib/campaignGuide.ts` `CATALOG` re-key — it is keyed by campaign address and fails silently
- `web/scripts/relay-loop.sh` `TARGETS` addresses
- `SeedDevRep` before any gated seed, or `UnreachableReputation` blocks creation

**So: land all contract work in one change set, one redeploy, one reseed.** Features 2, 3 and 4 then
build on a single stable deployment. Doing the contract features separately triples the tax.

---

## 1. Fair campaign extensions and reward top-ups

### Today

`endTime` and `rewardPool` are `immutable` (`src/campaign/Campaign.sol:52-56`). `_requireWindow`
bounds reports to `[startTime, endTime]`; once `Ended`, `_requireReportWindow` skips the window and
`_requireReportableStatus` allows reports for `CLAIM_GRACE`. `_settle` caps every payout at
`rewardPool - paidOut`. `EscrowVault.deposit(campaign, amount)` is already additive and callable by
anyone, and `reclaimUnspent` returns the whole vault balance after grace.

So a top-up **already lands in escrow today and can never be paid out** — `rewardPool` is the ceiling.

### Changes

**`Campaign.sol`** — `endTime` and `rewardPool` become private mutable storage with public getters of
the same name. `config()` already returns both, so no view changes shape and the frontend's decode is
untouched.

- `extend(uint64 newEndTime, uint256 newWindowEndBlock)` — project only, `Active` or `Paused` only,
  `newEndTime > endTime`, bounded by a `MAX_EXTENSION` constant. Emits `Extended(oldEnd, newEnd)`.
- `topUp(uint256 amount)` — project only, pulls through `escrowVault.deposit`, raises `rewardPool`,
  emits `PoolIncreased(oldPool, newPool)`. Assert vault balance ≥ `rewardPool - paidOut` afterwards.
- **No setter for `_kpis`, `_tiers`, `minReputation`, `startTime` or `token`.** They have none today;
  the guarantee is enforced by absence, which is the strongest form of it. Add a test that reads every
  tier threshold and reward before and after `extend` + `topUp` and asserts equality, so the
  guarantee is asserted rather than assumed.

**The verifier window has to move in the same call.** `EventMetricKpiVerifier.setKpiConfig` re-run
with only a later `windowEndBlock` deliberately leaves `lastScannedBlock` and every stored total
alone — extension is already designed for. But it is `onlyOwner` (the protocol), not the project, and
`resolveScanRange` clamps at `windowEndBlock`, so an extension without it leaves a gated KPI's
ceiling frozen: reports keep succeeding and crediting nothing, the same silence as running the
indexer before the relayer. Two options:

- **(a) preferred** — add `extendWindow(campaign, kpiIndex, newEndBlock)` to the verifier, callable by
  a registered campaign (`campaignRegistry.isCampaign(msg.sender)`), and have `Campaign.extend` call
  it for every gated KPI. That is what the second `extend` argument is for. One click, no ops step.
- **(b) fallback** — `Campaign.extend` only emits, and a `pnpm extend-window` script re-runs
  `setKpiConfig` as owner. Correct but demo-hostile.

`SeedUniswap`'s `BLOCK_MARGIN = 10_000` (~5.5h at 2s) means short extensions have existing slack, so
(b) is survivable if the ownership plumbing turns awkward mid-hackathon.

### Two sharp edges worth naming

**Extending `endTime` does not extend existing touches.** Each touch expires at
`min(campaign.attributionWindow, MAX_TOUCH_DURATION)` from signing, and activity nobody held is
dropped rather than credited to nobody. A campaign extended by a week will have referrals whose touch
lapsed on day two; their later actions are unattributed and silently uncreditable. The extend
confirmation must say so and should count how many live touches expire before the new end. Re-signing
is the only remedy and it is the referral's action, not the project's.

**A tier settled while the pool was empty stays settled.** `_settle` advances `_settledTiers` past a
tier even when `PoolExhausted` fired and the payout was short. A top-up therefore pays *future* tiers
and never the promoter who crossed a tier during the drought — which is precisely the unfairness this
feature claims to fix. Recommended addition (small, and the most defensible thing in the feature):
record `_shortfall[promoterId][kpiIndex] += reward - tierPay` when a tier pays short, and pay
outstanding shortfalls first inside `_settle` once escrow allows. Without it, document the gap
explicitly rather than letting a judge find it.

### Web + subgraph

`useWriteCampaign` gains the two intents and `lib/txErrors.ts` the new reverts (extend it, never
surface a raw revert string). An extend/top-up panel on the project's own campaign page. The subgraph
indexes `Extended` and `PoolIncreased` onto the existing `Campaign` entity, which currently treats
both fields as fixed.

### Verification

`forge test` additions: extend backwards reverts; extend from `Ended` reverts; non-project caller
reverts; thresholds and tiers byte-identical after extend + top-up; a payout that exceeded the old
`rewardPool` succeeds after a top-up; `reclaimUnspent` returns the topped-up remainder; a gated KPI
keeps crediting past the old `windowEndBlock` after `extend`.

---

## 2. Automated reporting with Chainlink Automation

### Today

Nothing on chain wakes up. `relay-loop.sh` is a bash `while true`, and `indexer.ts` is run by hand or
by `dev-up.sh`. Both hold private keys, and `REPORTER_PRIVATE_KEY` must equal `PRIVATE_KEY` because
guarded verifiers accept only the project key as reporter.

### What Automation can and cannot do

`checkUpkeep` / `checkLog` are simulated off-chain by the DON but they execute **on-chain view code**:
no `eth_getLogs`, no HTTP. An upkeep therefore cannot replace the indexer's log scan. Two shapes are
available, and only one of them needs logs:

- A **log-trigger** upkeep is handed the matched log itself (`checkLog(Log, bytes)`), which is enough
  to build a one-action report.
- For a **gated** KPI the observed truth is already on chain — `EventMetricKpiVerifier.verifiedTotals`
  raw, `observedProgressOf` scaled. An hourly upkeep needs no log access at all: it reports the gap
  between `observedProgressOf(campaign, kpi, user)` and `Campaign.userCreditedOf(user, kpi)`.

That second observation is the whole feature. **Ungated KPIs have no observed total, so the sweeper
cannot see them** — so gate every KPI in the ETHGlobal fixture with `GuardedKpiVerifier`, which is
also the standing fix for the inflation class that hit SuperBridge and Venus.

### Design — one new contract, `src/automation/BoneyUpkeep.sol`

**Hourly sweeper (custom-logic upkeep).** `checkUpkeep` walks a campaign's observed users, collects
those where observed > credited, and returns the first N in `performData`; `performUpkeep` calls the
batch entrypoint from feature 3. Three prerequisites:

1. **User enumeration on the verifier.** `verifiedTotals` is a mapping and nothing enumerates it;
   `reportBatch` only ever sees a calldata `users[]`. Add an `address[]` per kpiKey appended on first
   sight, plus `observedUserCount` / `observedUserAt` views. Useful to the UI independently.
2. **An authorized-reporter slot on `Campaign`.** `performUpkeep`'s `msg.sender` is the Automation
   forwarder; `reportUserAction` accepts only `project` or the immutable `oracleCoordinator`. Add a
   project-settable `authorizedReporters` mapping checked alongside those two. Same change set as
   feature 1.
3. **Evidence-free reporting is attribution-fragile.** The sweeper cannot build `Types.Action[]` on
   chain, so it reports with empty evidence, which falls back to `soleAttributionSince(_lastReportBlock)`
   and reverts `AmbiguousAttribution` when the referral switched promoters in the span. `checkUpkeep`
   must pre-filter on that view and leave the ambiguous referrals to the off-chain indexer, which can
   segment. Automation covers the common case; per-action segmentation still needs evidence.

**Log-trigger upkeep (the better live demo).** One upkeep per gated KPI, filtered on that KPI's own
`topic0` at its `targetContract`. `checkLog` pulls the actor out of `topics[actorTopic]` (the on-chain
mirror of `indexerCore`'s actor decode), reads `promoterAt(campaign, user, log.blockNumber, now)`, and
returns a single-action evidence report; `performUpkeep` sends `reportUserAction`. Credit appears on
screen seconds after the user's transaction, which is a far stronger demo than an hourly tick.

**What stays manual, said plainly.** The relayer remains the ceiling authority, so `relay-loop.sh`
keeps running. Automation automates the project's *claim*, not Boney's *observation* — making the
observation side trustless needs Chainlink Functions (HTTP → `eth_getLogs`) and is out of scope for a
weekend. Frame it that way for judging rather than overclaiming.

### Dependencies and ops

`foundry.toml` has only `forge-std` and `openzeppelin-contracts` today. Only two interfaces are
needed (`AutomationCompatibleInterface`, `ILogAutomation`), so vendor them under
`src/automation/interfaces/` rather than adding a submodule. Registration and LINK funding are
per-chain and manual. **Confirm Automation is live on each target chain before promising it** — Base
Sepolia and Ethereum Sepolia are fine; a brand-new testnet very likely is not, and there the bash loop
remains the answer.

### Verification

`test/BoneyUpkeep.t.sol` with a mock registry driving `checkUpkeep` → `performUpkeep`: a second
`performUpkeep` in the same block credits nothing (idempotent by `_userCredited`), ambiguous referrals
are excluded by `checkUpkeep` rather than reverting in `performUpkeep`, the returned batch respects
its size bound, and an ungated KPI yields `upkeepNeeded == false` instead of a revert.

---

## 3. Batch user-action reporting

Ship this **with** feature 2 — they share one entrypoint.

### Today

`ReportPanel.tsx` (765 lines) plans one selected KOL at a time through `lib/reporting.ts`:
`buildKolTargets` is "one row in the KOL dropdown", `planKolReport` spreads an amount across that
KOL's live referrals, `planObservedReport` is the honest path. The campaign-wide version already
exists in `scripts/indexer.ts` — but it sends **one `writeContract` per referral per KPI**, inside
`for (const total of totals.values())`.

### Changes

**`Campaign.reportUserActions(uint256[] kpiIndexes, address[] users, uint256[] newTotals, bytes[] evidence)`**
— loops the existing internal path under one `nonReentrant`, bounded by `MAX_BATCH_REPORTS`. Start at
32 and gas-measure before fixing it: each item costs a `promotersAt` read, a tier-ladder walk, and
possibly several ERC20 transfers.

No per-item `try`/`catch`. The planner already mirrors every named revert off chain (`decideReport`,
plus the guard set `indexer.ts` enumerates before spending gas), so a bad item is a planner bug rather
than a runtime case, and one revert failing the batch is the honest semantic for "report everything I
just showed you". Multicall3 is not an option — it would make `msg.sender` the multicall, and
`reportUserAction` gates on `project`.

**Browser-side planning already exists.** `lib/indexerCore.ts` is browser-importable, so the same
`logRequest` → `aggregateByActor` → `AttributionLookup` → `decideReport` → `encodeActions` chain the
script uses runs in the app. New `lib/batchReporting.ts` composes it across every non-aggregate KPI of
one campaign; a `useCampaignBatchReport` hook owns the scan.

Two things the scan must respect: `client.request({method: "eth_getLogs", …})` with `logRequest`, never
viem's `getLogs` (which silently drops `topics` and returns every log the address emitted); and the
touch scan's floor at `startTime - effectiveMaxDuration`, since the log-horizon shortcut used elsewhere
loses older touches.

**UI.** One "Report all qualifying activity" button, a preview table of referral × KPI → delta with the
promoter each delta lands on (`tallyByPromoter`), then one confirmation. Keep the per-KOL panel as the
fallback for an over-large batch or a single blocked item. Copy stays terse — no explanatory second
sentences.

### Verification

Vitest over `batchReporting.ts` against fixture logs (the pattern `relayCore` and `indexerCore` tests
already use); `forge test` for the entrypoint: mixed KPIs in one batch, a duplicate `(user, kpi)` pair,
an item at `newTotal == already` (skipped, not reverted), one bad item reverting the whole batch, and
`MAX_BATCH_REPORTS + 1` rejected.

---

## 4. BoneyCards for projects as well as promoters

### Today

The promoter card exists twice: `/card` for the connected wallet, and the shareable public one at
`web/src/app/b/[wallet]/page.tsx` — 99 lines, server-rendered, `loadPublicCard` wrapped in React
`cache()` so the page and its `opengraph-image.tsx` (245 lines) share one fetch. Fold and milestone
logic is `lib/boneycard.ts` (`foldHistory`, `milestonesOf`, `boneLevel`, `qualify`, `nextMilestone`),
fed from the subgraph.

The project card already has a visual prototype: the untracked `web/public/gyndore-campaign-card.html`
and `web/public/superbridge-campaign-card.html`, both 1240px with Boneyard tokens copied out of
`globals.css`.

### Changes

1. `/c/[campaign]/page.tsx` + `opengraph-image.tsx`, mirroring `/b/[wallet]` exactly: server-rendered,
   one `cache()`d loader, no client fetching — that is what makes the card embed in a tweet.
2. `lib/projectCard.ts` — a `foldProjectHistory` over the subgraph entities that already exist:
   `Campaign`, `Kpi`, `Promoter`, `Credit`, `TierPayout` cover pool escrowed, paid out, promoters
   joined, tiers settled and per-KPI credited progress. Project milestones (first payout, N promoters,
   N tiers settled, pool fully distributed) parallel `milestonesOf` rather than inventing a second
   vocabulary.
3. Promoter cards gain the historical/cross-campaign view the ask describes — `foldHistory` already
   walks every campaign a wallet touched, so this is presentation plus a campaign-performance section,
   not new data plumbing.
4. Tokens only: no hex literals in components. Read `frontendspecskills.md` and the named VibeCurb
   skill before styling anything.

**One honest constraint on what a project card may claim.** The subgraph rebuilds credited and settled
state exactly but observes only 5 of 15 KPIs, and two campaigns' observed totals are inflated. So the
card renders *credited and paid* figures — which are exact — and not observed KPI progress.

### Verification

Vitest over `foldProjectHistory` with fixture subgraph responses; `pnpm lint` on the new paths. Check
the OG image renders at its declared size by hitting the route (headless chromium is unusable here —
`libnspr4.so` is missing — so judge by HTTP status and the returned bytes, not a screenshot).

---

## 5. Multi-chain campaigns

### Today — Ethereum Sepolia is most of the way there

`lib/chains.ts` already lists `anvil`, `sepolia`, `baseSepolia`, `mainnet` in `SUPPORTED_CHAINS`, and
`DEPLOYMENTS` already carries a **complete env-driven Sepolia slot** (`NEXT_PUBLIC_SEPOLIA_BONEY` …
`NEXT_PUBLIC_SEPOLIA_START_BLOCK`). `rpcUrlFor` and `explorerAddressUrl` handle it, and `wagmi.ts`
includes it. `GENERATED_DEPLOYMENTS` is spread last so a real deploy overrides the env slot. Sepolia is
therefore a deploy-and-seed exercise, not a code change.

### Per chain, in order

1. `DeployBoney` → **`SeedDevRep`** (not optional; a fresh `ReputationRegistry` reports
   `maxScore() == 0` and `Campaign`'s constructor rejects any `minReputation` above it with
   `UnreachableReputation`) → the campaign seed.
2. `pnpm deployments <chainId>` from `broadcast/DeployBoney.s.sol/<chainId>/run-latest.json`.
3. Escrow token and a KPI source. A fresh `OpenMintNFT` is the cheapest honest KPI source on a new
   chain — it is what Sdy Labs watches, and Sdy Labs is the one ungated campaign that measured clean.
4. **Reputation does not travel.** Attestations are per-chain and must be re-submitted through
   `/api/attest` + one tx per weighted schema on that chain. Confirm `AttestationVerifier`'s EIP-712
   domain separator includes the chain id before assuming a signature can't be replayed across chains.

### Single-valued globals that must become per-chain

- **`NEXT_PUBLIC_SUBGRAPH_URL`.** `subgraphUrl(chainId)` gates on `SUBGRAPH_CHAINS` but returns one
  global URL, and Studio needs a separate subgraph per network. Make it a per-chain map. A new testnet
  is unlikely to be a supported Studio network at all — `boneyHistory` already degrades through
  `GraphUnavailableReason`, so the fallback is direct-RPC history, and that path must be exercised
  rather than assumed.
- **`relay-loop.sh`.** One default `RPC` and a hardcoded `TARGETS` list of campaign addresses. Needs a
  per-chain target file or a chain argument. A stale address here is silent: the relayer reports against
  a dead campaign and the gated KPI just stays flat.
- **Reporter keys** in `web/.env.local`. The relayer and indexer already take `--rpc`.

### A chain viem doesn't know

`defineChain` for Robinhood's testnet, then entries in `SUPPORTED_CHAINS`, `DEPLOYMENTS`, `rpcUrlFor`,
`explorerAddressUrl` and `wagmi.ts`. Needs the chain id, a public RPC, an explorer URL pattern and a
faucet. Also check whether Chainlink Automation exists there before feature 2 is claimed for it.

### Verification

`pnpm test` covers `chains.ts` resolution; add a case per new chain id (deployed vs. not, RPC fallback,
explorer URL). In the app, verify every read passes `{chainId: useBoneyChainId()}` — a bare
`usePublicClient()` silently reads anvil, and every page load renders at least once with the wagmi
store on `chains[0]`.

---

## Sequencing

| Order | Work | Demoable on its own? |
| --- | --- | --- |
| 1 | **One `Campaign` change set**: mutable `endTime`/`rewardPool`, `extend`, `topUp`, `authorizedReporters`, `reportUserActions`, optional tier shortfalls. Verifier: `extendWindow` + observed-user enumeration. `forge test` green. | no |
| 2 | Redeploy + reseed once, gating **every** KPI. Then the full tax list from §0. | — |
| 3 | Batch reporting UI (feature 3). Highest visible payoff per hour, reuses `indexerCore` wholesale. | yes |
| 4 | Extend + top-up panel (feature 1's web half). | yes |
| 5 | `BoneyUpkeep` + registration on Base Sepolia (feature 2). Log-trigger first — it demos better than the hourly sweep. | yes |
| 6 | Project BoneyCards (feature 4). Pure `web/`, no chain risk, safe to run in parallel with 5. | yes |
| 7 | Ethereum Sepolia deploy + seed, then the new chain (feature 5). | yes |

Nothing after step 2 touches Solidity, so steps 3–7 can be reordered or dropped without a redeploy.
That is the point of the ordering: the irreversible work happens once, early, with tests.

## Verification rules for all of it

- Solidity: `forge test`, `forge fmt`.
- Web: `pnpm test` (vitest) + `pnpm lint <paths>`. **Never `pnpm typecheck` in `web/`** — it OOMs.
- `command grep` in every Bash call; plain `grep` is shadowed by a Copilot shell function.
- Regenerate, never hand-edit, `web/src/lib/abis/*` and `web/src/lib/deployments.ts`.
- Solidity says `kol`; the UI says promoter. Do not rename across the seam.
- Restore the `[bscoretest]` constants before anything merges to `main`.

## Submission rules (ETHGlobal)

The event's rules, then what each one means here.

**Continuity track** (Extend Open Source / Ship a Feature). Building on an existing codebase is
allowed under the selected track's rules. The submission must clearly document pre-existing work and
include new features or functionality developed during the hackathon. Partner-prize eligibility varies
by event and partner.

**Version control.** Track code throughout the event. Submissions with large single commits or a
missing history may be disqualified — progress has to be visible in the log.

**Open-source libraries and boilerplates.** Welcome, provided their use is stated.

**Include everything.** The submission carries a GitHub repo, Figma files or equivalent, proving the
work was done during the hackathon, with new and reused work clearly distinguished.

**AI tools** (Claude Code, Copilot, Cursor, ChatGPT) are permitted, with three conditions:

- *Attribution* — document where and how AI was used: which parts of the code, which files, which
  assets.
- *Involvement* — AI assists the team's development, it does not produce the project. Submissions
  relying entirely on AI without meaningful team contribution may lose partner-prize and finalist
  eligibility.
- *Spec-driven workflows* (OpenSpec, Kiro, spec-kit) are allowed, but **all spec files, prompts and
  planning artifacts must be in the submission repository**. Judges assess how the AI was directed,
  not only what it emitted.

### What that means for this repo

Boneyard is a continuity submission: the protocol, the Next app, the subgraph, the indexer and the
relayer all predate the event.

- **The demarcation line is `boneyard-eth-global-2026`, branched from `boneypoints` at `c037109` on
  2026-09-05.** Its first commit is pre-existing work that was still uncommitted in the tree at branch
  time. Every commit after it is hackathon work, and that boundary is the whole new-vs-reused answer.
- **Commit per coherent change, not per feature section.** The five features landing as five commits
  is exactly the shape the version-control rule warns about. §0 forces the contract work into one
  change set, not into one commit.
- **`*.md` is gitignored** except `/README.md`, so this plan — the planning artifact judges are told
  to look for — cannot be committed as things stand. See Open questions.
- **AI attribution needs a tracked file.** This plan was written with Claude Code and so was much of
  `web/`. A submission-time `AI_USAGE.md` naming the files and the direction given is the cheapest way
  to satisfy attribution, and it needs the same gitignore exception as the README.

## Open questions

- **Where the spec artifacts live.** ETHGlobal requires the planning artifacts in the submission repo;
  `.gitignore` excludes every `.md` but `/README.md` because this repo is public and the excluded set
  holds `boneyMd/findings.md` (unfixed high-severity bugs) and `testing.md` (throwaway Base Sepolia
  keys). Narrowing the rule to those two, or adding `!/eth-global-2026-plan.md` and `!/AI_USAGE.md`
  alongside the README exception, both work. Decide before the submission, not on the last day.
- **Robinhood testnet**: chain id, public RPC, explorer URL pattern, faucet, Chainlink Automation
  support. Everything in feature 5's last section is blocked on these five facts.
- **Tier shortfalls after a top-up** — in or out? It is the strongest fairness argument in feature 1 and
  the most invasive change to `_settle`.
- **`MAX_BATCH_REPORTS`** — gas-measure a worst-case item (new tier + several transfers) before fixing
  the bound.
- **`attributionWindow` on extension** — it is immutable and each touch is separately capped by
  `MAX_TOUCH_DURATION`, so extending a campaign cannot lengthen a live touch. Decide whether the extend
  flow prompts referrals to re-sign, or whether the campaign page just reports the expiry count.
- **Event date** — the sequencing above is in relative days; pin it once the schedule is known.

---

`*.md` is gitignored here except `/README.md`, so this file is untracked. That was deliberate while
it was working material; ETHGlobal now requires it in the submission repo. First Open question above.

