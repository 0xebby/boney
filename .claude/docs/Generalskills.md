# Generalskills — how to work in this repo

Loaded on demand from `CLAUDE.md`. This is the operating manual: what to run, what never to run,
how to verify, and the traps that cost a session an hour each time they're rediscovered.

---

## 1. The shape of the repo

```
/home/ebby/boney
├── src/                  Solidity — 10 deployed contracts (see BoneyGeneral.md)
├── test/                 Foundry tests, one .t.sol per contract or per attack
├── script/               Foundry deploy + seed scripts (DeployBoney, Seed*)
├── lib/                  git submodules (forge-std, openzeppelin) — never edit
├── out/                  Foundry build artifacts — source of truth for ABIs
├── broadcast/            deploy receipts — source of truth for addresses
├── subgraph/             The Graph indexer (deployed to Studio, Base Sepolia)
├── web/                  Next 16 app + the off-chain processes (see BoneyFrontend.md)
├── boneyMd/              long-form docs: spec/, KPI_VERIFICATION*, BoneyDocs, todo
├── flow/                 architecture diagrams as SVG
└── .claude/docs/         these four docs
```

Two directories are **generated and must never be hand-edited**:
`web/src/lib/abis/*` and `web/src/lib/deployments.ts`. Both regenerate in one command (§4).

---

## 2. Commands

### Solidity (from repo root)

```bash
forge build
forge test                       # whole suite
forge test --mc CampaignTest     # one suite
forge test --mt test_settle -vvv # one test, with traces
forge fmt
```

### Web (from `web/`)

```bash
pnpm test                        # vitest, node environment — THE verify step
pnpm test src/lib/boneycard.test.ts
pnpm lint src/lib/foo.ts         # scoped; eslint on the paths you touched
pnpm dev:up                      # whole dev fixture — use the start-servers skill
```

### The generated seams (from `web/`)

```bash
pnpm abis                        # out/ → src/lib/abis/*.ts
pnpm deployments 84532           # broadcast/ → src/lib/deployments.ts
```

---

## 3. The verify loop

**`pnpm typecheck` is forbidden.** Full or scoped, it OOMs after minutes and tells you nothing you
couldn't get faster. There is a `tsconfig.card.json` and a `tsconfig.scripts.json` in the tree; they
are not an exception — don't reach for them either.

What to run instead, in order, and only what the change touches:

| Changed | Run |
| --- | --- |
| `src/*.sol` | `forge build && forge test` |
| `web/src/lib/**` | `pnpm test <that test file>` then `pnpm test` |
| `web/src/components/**`, `web/src/app/**` | `pnpm lint <paths>` — there is no DOM test layer |
| `web/scripts/**` | `pnpm test scripts/` where a test exists; otherwise run the script |

Tests live **beside** their subject: `lib/boneycard.ts` ↔ `lib/boneycard.test.ts`. `vitest.config.mts`
runs `src/**/*.test.ts` and `scripts/**/*.test.ts` under a **node** environment with `@ → src`. There
is no jsdom, no React Testing Library, no component test. That is the reason for the architecture in
`BoneyFrontend.md`: logic lives in pure `lib/*.ts` so it is provable by fixture, and components stay
thin enough not to need a DOM.

So: **if you want new behaviour tested, put it in `lib/`.** Behaviour written inside a component is
untestable here by construction.

---

## 4. When one layer changes, what else has to

| You changed | Also run | Or this breaks |
| --- | --- | --- |
| a contract's ABI (any external fn or event) | `forge build` then `web/ pnpm abis` | the frontend decodes the stale shape and fails at runtime, not at build |
| deployed new contracts | `web/ pnpm deployments <chainId>` | the app reads the old addresses and looks empty |
| a `constant` in `Campaign` (e.g. `CLAIM_GRACE`) | full `DeployBoney` **and** `pnpm deployments` | constants are compiled in; there is no setter |
| a reputation schema name | check it against the chain first | see `base-sepolia-schema-names` in memory — the chain won |
| an event name the relayer scans | `web/src/lib/eventNames.ts` + `relayCore.ts` | the relayer observes nothing and gated KPI ceilings stay 0 |

---

## 5. Traps

**`grep` is a shell function.** A Copilot shim shadows it. Every Bash call uses `command grep`. This
also applies inside scripts you write — `dev-up.sh` already does it.

**Don't invent route names to test.** The route table is exactly `web/src/app/*/page.tsx` plus `/r`
and `/b/[wallet]`. There is no `/campaigns` — a 404 there is correct. List `web/src/app` instead of
guessing.

**Judge a running server by HTTP status, not HTML.** A stale `web/.next` returns a full-looking page
for a route that 404s. `curl -s -o /dev/null -w '%{http_code}'` with `--max-time 90` (Turbopack
compiles per route on first hit).

**`next dev` detaches a daemon.** Killing `pnpm dev` leaves `next-server` holding port 3000, often
bound-but-hung. Never blanket-`pkill next-server` — this machine runs other projects' servers. Filter
by `readlink /proc/<pid>/cwd` and kill only `/home/ebby/boney/web`.

**Next 16 allows one dev server per directory.** A parallel Claude window holding the lock makes
`dev:up` fail as a health-check timeout, not as a clear error.

**Base RPC.** Use `base-sepolia-rpc.publicnode.com`. `sepolia.base.org` 502s about one call in three,
so a scan rarely finishes. `web/.env.local` already points at publicnode.

**Anvil on 8545** is a separate long-lived process. The fixture targets Base Sepolia. Leave anvil be.

**Playwright is unusable.** Headless chromium won't launch (missing `libnspr4.so`), so
`web/scripts/drive-*.mjs` and `screenshot*.mjs` cannot run. Verify by HTTP + the `__check-*.ts`
probes in `web/scripts/`, or ask the user to look.

**Follower sources throttle.** `fxtwitter`/`vxtwitter` rate-limit back-to-back runs; a live follower
failure is almost always that, not an outage.

---

## 6. Writing code that matches

**Comments are descriptions only, as of 2026-08-28.** What a thing is and the rule it enforces —
never why, never the alternative that was rejected, never a measurement.

The target register:

- **Solidity** — one-line `@notice`; `@dev` only where behaviour needs stating, two or three lines at
  most; then `@param` / `@return` for every parameter and return value, **including on `private`
  helpers**. `@inheritdoc` covers the interface's own text, so don't repeat it.
- **TypeScript** — a one-or-two-line summary, then `@param` / `@returns`.
- **Inline `//`** — one short clause. `// Debit before transferring, for tokens with transfer hooks.`

`src/**` (all 26 `.sol` files) is fully converted. `web/src/**` is not — those files still carry long
rationale comments, and the register above is what they are being converted *to*.

Background rationale for four files lives in `.claude/docs/decisions.md`. It is a standalone
reference with **no back-pointers from the code**; don't add any. For everything else, the stripped
prose is in `git log -p` on that path.

Two things stay in the source:

- **`[bscoretest]` markers**, phrased descriptively (`/// @dev [bscoretest] Protocol value is 7
  days.`). They name the protocol value of a shortened constant; without them the branch cannot be
  restored before merging.
- **`web/node_modules/next/dist/docs/…` citations.** Per `web/AGENTS.md` that path is how anyone
  finds the Next 16 API that differs from training data.

Verifying a comment-only change: `forge build && forge test` for Solidity, `pnpm test` +
`pnpm lint <paths>` for TypeScript, and confirm no executable line moved:

```bash
git diff -U0 -- src | command grep -E '^[+-]' | command grep -vE '^(\+\+\+|---)' \
  | command grep -vE '^[+-]\s*(///|//|\*|/\*|\*/)' | command grep -vE '^[+-]\s*$'
```

Empty output means comments only. Nothing else catches a mangled comment inside a template literal
or JSX expression except `pnpm lint`, and nothing at all catches one inside a `.css` block — check
`/*` and `*/` counts match there.

Rules for either form:

- Describe, don't justify. `// increment i` is still worse than no comment — say what the line is
  *for*, in one clause.
- Document every parameter and return, even on helpers nobody outside the file calls.
- State a constraint as a constraint: "Never reordered, cycled, or assigned by rank" belongs in the
  source; the ΔE measurement behind it does not.
- Don't leave a truncated sentence behind. Several files carried half-edited fragments before this
  sweep; a comment that stops mid-thought is worse than none.

Style: named exports, `type` over `interface`, no default exports outside `app/**/page.tsx`,
`@/` imports, no `any`, no new dependencies without asking.

---

## 7. Commits

Short. Title in the imperative, then one or two tight paragraphs. **No `Co-Authored-By` trailer**
and no "Verification" section. Recent history is the model:

```
Seed the promoter history the card's stage 2 needs

Two projects, five campaigns, three promoters, with outcomes chosen rather than
discovered: every KPI has no verifier and empty params, so progress is whatever is
reported and the running relay leaves these alone.
```

Don't imitate the longer prose commits further back. Commit or push only when asked; if on `main`,
branch first.

Note `broadcast/**` churns on every deploy or seed — a dirty `broadcast/` in `git status` is normal,
and those files are records, so don't clean them up unasked.

---

## 8. Cold-start checklist for a new task

1. Read the one doc from `CLAUDE.md`'s table that matches. Not all four.
2. Locate the layer: is this Solidity, pure `lib/`, a hook, markup, or a seam? The layer decides
   both where the code goes and how it's verified.
3. Grep for the concept, not the filename (`command grep -rn "promoterProgress" web/src src`). Names
   diverge across the seam.
4. Read the block comment above whatever you're about to change before changing it.
5. Make the change; run only the verify step for that layer (§3).
6. If a seam moved, run the regeneration (§4).
7. If you learned something durable, write it into the matching `.claude/docs/` file in the same
   change.
