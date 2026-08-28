# BoneyFrontend — starting, reading and changing the web app

`web/` is a **Next 16** App Router app: React 19, wagmi 3 + viem 2, TanStack Query 5, Tailwind v4,
vitest under a node environment. Read this before touching `web/src/**`.

For anything about how it *looks*, read `frontendspecskills.md` too. For where a number comes from,
`BoneyGeneral.md`.

> `web/AGENTS.md` (via `web/CLAUDE.md`) says it and means it: **this is not the Next.js in your
> training data.** Before writing an API you haven't used in this repo, read the relevant guide in
> `web/node_modules/next/dist/docs/`. Existing code cites the exact doc path in comments — e.g.
> `app/campaign/[id]/page.tsx` on `params` being a Promise. Follow those citations.

---

## 1. Starting it

**Use the `start-servers` skill.** It has the pre-flight kills, the one-server-per-directory lock, the
stale-`.next` rule and the verification commands. Don't re-derive them here.

The one-line version: `cd /home/ebby/boney/web && pnpm dev:up`, in the **background** (the script ends
in `wait` and its EXIT trap kills the whole process group). That runs `scripts/dev-up.sh`, which starts
four processes in the only order that works — ethos stub → next dev → **relay (blocking first pass)** →
indexer — and health-checks each rather than sleeping. Logs in `/tmp/boney-dev/`.

The relay-before-indexer ordering is not cosmetic and fails **silently**: see `BoneyGeneral.md` §6.

App on `localhost:3000`, ethos stub on `127.0.0.1:8787`.

---

## 2. The layering, and why it exists

```
app/**/page.tsx      thin. imports one component, returns it. route-level concerns only.
components/*.tsx     markup + composition. one file per page or panel.
components/ui/*.tsx  primitives, reused everywhere.
hooks/*.ts           IO. useQuery / useReadContract / useWriteContract. "use client".
lib/*.ts             PURE logic. no React, no wagmi. this is where the thinking lives.
lib/abis/*.ts        GENERATED (pnpm abis). never hand-edit.
lib/deployments.ts   GENERATED (pnpm deployments). never hand-edit.
```

The reason is the test setup, and it's worth internalising because it dictates where your code goes:
`vitest.config.mts` runs `src/**/*.test.ts` + `scripts/**/*.test.ts` under a **node** environment.
There is no jsdom, no React Testing Library, **no component test at all**. `lib/nav.ts` says it
plainly: logic lives there so it's provable by fixture, while components stay thin enough not to need
a DOM.

**So: behaviour you want tested must go in `lib/`.** Behaviour written inside a component is
untestable in this repo by construction. Every substantial `lib/*.ts` has a `*.test.ts` beside it —
match that.

Off-chain processes follow the same split: `scripts/relay-kpi-metric.ts` is a thin CLI over
`lib/relayCore.ts`; `scripts/indexer.ts` over `lib/indexerCore.ts`. Both cores are tested.

---

## 3. The sections

Six nav routes plus three unlisted ones. That is the **whole** route table — `src/app/*/page.tsx` plus
`/r` and `/b/[wallet]`. There is no `/campaigns`.

| Route | Component | What it is |
| --- | --- | --- |
| `/` | `CampaignsPage` | the marketplace. `boneyard` hero, then the campaign list. Public. |
| `/my` | `MyCampaignsPage` | the same list filtered to the connected wallet's projects. Needs a wallet. |
| `/discover` | `DiscoverPage` | browse **promoters** by BoneyScore rank. Public — a project evaluating the marketplace shouldn't have to connect first. |
| `/card` | `BoneyCard` via `useBoneyCard` | the connected wallet's own card: score, scale, qualification, history, earnings. The verify-to-join affordance lives *inside* the card, never in the header. |
| `/promoters` | `PromoterDashboard` (+ `PromoterDirectory`) | memberships and tracking links. Appears only once the wallet actually holds a promoter id. |
| `/docs` | `DocsPage` | the explainer. A **pitch surface**. |
| `/campaign/[id]` | `CampaignDetailPage` | the workhorse. Composes `KpiPanel`, `ReportPanel`, `PromoterPanel`, `ProjectActions`, `ProjectPromotersPanel`, `CampaignGuidePanel`. `params` is a Promise; ids are validated before reaching a contract read. |
| `/create` | `CreateCampaignPage` | the create form — the largest component in the app. Config, KPIs, tiers, funding. |
| `/r?c=&p=` | inline in `app/r/page.tsx` | tracking-link landing. Signs the Touch, relays it, redirects to the campaign. |
| `/b/[wallet]` | `PublicBoneyCard` | **the share surface.** The only fully server-rendered page: no wallet, no wagmi, no client fetching, so it works for a crawler, an embed, and a phone with no extension. `opengraph-image.tsx` beside it renders the preview card. |

### Nav

Shape and active state live in **`lib/nav.ts`**, not in JSX — two components render the same nav (top
bar from `sm` up, `NavDrawer` below), so "which items, in what order" has to be one answer. Add a link
there.

Three entries are personal and hidden until they'd show something: `/my` and `/card` need a
connection, `/promoters` needs `useIsPromoter`. All three stay hidden through the server render and
the first client render — wagmi rehydrates inside an effect, so there's no wallet to read at markup
time on either side. They appear a moment later rather than flashing wrong. **Don't "fix" that into a
conditional that reads the wallet during render; it's a hydration mismatch.**

### Shell

`AppShell` owns the sticky `header` (brand, nav, wallet button, rank badge, dev-stub-wallet manager),
`main.mx-auto.max-w-6xl`, and the `footer`. Pages don't re-implement chrome.

### API routes

| Route | Purpose |
| --- | --- |
| `GET /api/score` | BoneyScore inputs, nothing signed, no gas. **Not the number `join()` reads.** |
| `POST /api/attest` | the same read, then one signed EIP-712 attestation per weighted schema |
| `GET/POST /api/campaign-guide` | the off-chain "what am I supposed to do here" a campaign renders. GET returns the *stored* guide only — the committed catalog is already in the client bundle. |
| `/api/stub-wallets` | signed allowlist management for the ethos stub |

---

## 4. The rules that bite

**Never a bare `usePublicClient()`.** `wagmiConfig.chains[0]` is `anvil`, and wagmi rehydrates its
persisted state inside a `useEffect` with no `initialState` passed — so *every* page load, connected or
not, renders at least once with the store on anvil. Always:

```ts
const chainId = useBoneyChainId();
const client = usePublicClient({chainId});
```

`useBoneyChainId()` returns the connected chain when there is one, else `DEFAULT_CHAIN_ID`. It
deliberately keeps reporting an *unsupported* connected network so the page can say "not available
here" rather than quietly showing Base Sepolia's campaigns.

**Reads degrade, they don't throw.** `lib/contracts.ts` helpers return `0`/`[]`/`null` when the
protocol isn't deployed on the chain, and `isProtocolDeployed(chainId)` is the test pages use to render
an `EmptyState`. Keep that contract for any new read helper.

**Writes go through `hooks/useWriteCampaign.ts`**, which owns the tx lifecycle. Reverts become human
text via `lib/txErrors.ts` — extend that mapping rather than surfacing a raw revert string.

**After a write that changes on-chain reputation, refetch.** `useEthosAttestation` submits but owns no
query; `app/card/page.tsx` and `PromoterPanel` both call a refetch afterwards. Skip it and the UI keeps
asking for a verification already paid for.

**Never `pnpm typecheck`.** Full or scoped. It OOMs. `pnpm test` + `pnpm lint <paths>`.

**Playwright can't launch here** (missing `libnspr4.so`), so `scripts/drive-*.mjs` and `screenshot*.mjs`
are dead. Verify by HTTP status; the `scripts/__check-*.ts` probes are the working substitute for
"does this render the right data".

**A stale `web/.next` makes routes 404 with no log line.** Judge by status code, not by the HTML.

---

## 5. How to change things

### Add a route

1. `src/app/<name>/page.tsx` — thin, importing one component.
2. `src/components/<Name>Page.tsx` — the markup.
3. Logic into `src/lib/<name>.ts` + `<name>.test.ts`.
4. IO into `src/hooks/use<Name>.ts` with `{chainId: useBoneyChainId()}`.
5. Nav entry in `lib/nav.ts` if it should be reachable (and decide whether it's public or personal).
6. Verify: `pnpm test` + `pnpm lint` + `curl -w '%{http_code}'` on the new path.

### Add a panel to `/campaign/[id]`

New `components/<X>Panel.tsx` using `Card`/`CardHeader`, composed into `CampaignDetailPage`. Its data
comes from a new `hooks/use<X>.ts`; its decisions from a new `lib/<x>.ts` with a fixture test. Read a
neighbouring panel (`KpiPanel` is a good model) before starting.

### Add a field to the create form

`CreateCampaignPage` is ~46k of deliberate structure. The validation lives in `lib/validation.ts` and
the encoding in `lib/campaignArgs.ts`, both fixture-tested. **Add the rule and the encoding there
first, with tests**, then wire the input. A field validated inline in the component is invisible to the
test suite.

### Change how something looks

Read `frontendspecskills.md` first. Classify the surface, invoke the named skill, and honour the token
system. Files in `hooks/` and `lib/` are out of bounds for a visual change.

### Change a contract-facing shape

`forge build` → `pnpm abis` → fix the call sites the new ABI breaks. Redeployed? `pnpm deployments
<chainId>`.

---

## 6. Environment

`web/.env.local` holds `NEXT_PUBLIC_BASE_SEPOLIA_RPC` (publicnode — `sepolia.base.org` 502s ~1 call in
3), the attestor key, and the four `*_API` stub vars, **commented out by default**. Repo-root `.env`
holds `PRIVATE_KEY` and `REPORTER_PRIVATE_KEY` — those must be **equal**, because guarded verifiers
accept only the project key as reporter.

An `export` in a terminal only reaches processes that terminal starts; putting a key in the repo-root
`.env` is what makes it survive. `dev-up.sh` reads dotenv files without sourcing them, deliberately.
