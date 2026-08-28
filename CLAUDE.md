# Boneyard — read this first

Escrowed, performance-based campaigns between projects and promoters. Solidity (Foundry) at the
repo root, a Next 16 app in `web/`, and three off-chain processes that stitch them together.

This file is loaded automatically every session. It is a **router**, not a manual — it stays short
so the four docs below can be long. Read the one that matches the task before touching code.

## Which doc to read

| Doing this | Read |
| --- | --- |
| Anything at all — commands, verify loop, commit style, repo etiquette | `.claude/docs/Generalskills.md` |
| Touching `web/src/**` — routes, components, hooks, lib | `.claude/docs/BoneyFrontend.md` |
| Changing how anything *looks* | `.claude/docs/frontendspecskills.md` **then** the named VibeCurb skill |
| Anything crossing the Solidity ↔ web seam, or you don't know where a number comes from | `.claude/docs/BoneyGeneral.md` |
| You hit a `decision: see …#anchor` back-pointer, or need the *why* behind a line | `.claude/docs/decisions.md` |
| Starting the app | the `start-servers` skill (`.claude/skills/start-servers/`) |

Read one doc, not all four. `Generalskills.md` is the cheapest and most often sufficient;
`decisions.md` is a lookup, read by anchor rather than end to end.

Deeper background, only when the four docs don't answer it: `README.md` (protocol + deploy order),
`boneyMd/spec/` (11-part spec), `boneyMd/KPI_VERIFICATION.md` (+ `_WALKTHROUGH`), `flow/*.svg`.

## Rules that survive every task

1. **`grep` is shadowed** by a Copilot shell function. Write `command grep` in every Bash call.
2. **Never run `pnpm typecheck` in `web/`** — full or scoped. It OOMs and burns minutes for
   nothing. Verify with `pnpm test` (vitest) + `pnpm lint <paths>`.
3. **Generated files are generated.** `web/src/lib/abis/*` comes from `pnpm abis`;
   `web/src/lib/deployments.ts` from `pnpm deployments <chainId>`. Never hand-edit either.
4. **Solidity says `kol`, the UI says "promoter".** Both are correct in their own layer. Do not
   find-and-replace across the seam — see `promoter-vocabulary` in memory.
5. **Design tokens are validated, not decorative.** `web/src/app/globals.css` states the rules; the
   measured contrast, lightness-band and CVD figures behind them are in `decisions.md`. Adding a hex
   literal to a component is a regression.
6. **Comments are descriptions only.** Solidity: a one-line `@notice`, at most two or three `@dev`
   lines, then `@param`/`@return` for every parameter and return — including on `private` helpers.
   TypeScript: a short summary, then `@param`/`@returns`. **No rationale, no rejected alternatives,
   no measurements, no decision ids, no pointers to other docs.** `src/**` is fully converted; most
   of `web/src/**` is not yet.
7. **Keep `[bscoretest]` markers**, stated descriptively (`Protocol value is 7 days.`). They name the
   protocol value of a shortened constant, and without them the branch cannot be safely restored.
   Keep the `web/node_modules/next/dist/docs/…` citations too — that path is the finding aid for a
   Next 16 API that differs from training data.
8. **Commits:** title + 1–2 tight paragraphs, no trailer, no verification section. Don't imitate
   the long prose commits further back in the history.

## Keeping these docs current

They exist so a cold session doesn't re-derive the codebase. When you learn something that would
have saved you a detour, add it to the matching doc in the same change — that is cheaper than the
next session rediscovering it. One-off facts belong in memory
(`~/.claude/projects/-home-ebby-boney/memory/`); durable structure belongs in these four.
