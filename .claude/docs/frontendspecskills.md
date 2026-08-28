# frontendspecskills — the anti-slop spec for Boneyard UI

Read this **before** invoking any visual skill, and before writing a line of markup or CSS.

The VibeCurb skills in `~/.claude/skills/` are excellent and they are also **not written for this
app**. They assume a marketing site: viewport-scale type, extreme whitespace, a single focal point,
hero architectures. Boneyard is a **data terminal** — dense tables, tabular figures, a 40px row
height, a palette whose contrast and colour-vision-deficiency ratios were measured rather than
chosen. Applying hero doctrine to `/campaign/[id]` would wreck it.

This doc is the adapter. It decides **which skill applies to which surface**, and lists the Boneyard
constraints that **override every skill, always**.

---

## 1. Surface classification — do this first

Every visual task in this repo lands on one of three surface types. Identify it before picking a
skill.

### Terminal surfaces — the product

`/` (Campaigns) · `/my` · `/campaign/[id]` · `/create` · `/promoters` · `/discover` · every panel
(`KpiPanel`, `ReportPanel`, `ProjectPromotersPanel`, `PromoterDashboard`, `CampaignGuidePanel`).

These are for someone reading numbers they may act money on. **Density, legibility and honesty beat
drama.** Never apply hero doctrine here.

- Applicable: `visual-redesign` (its Sacred/Slop discipline is exactly right), `dataviz` (for any
  meter, stat tile, chart or sparkline).
- Applicable **in miniature only**: `awwwards-motion-design` — take its easing, staggering and
  reduced-motion rigour; reject its scroll choreography, parallax and page transitions.
- **Not** applicable: `awwwards-hero-section`, `awwwards-sections`.

### Pitch surfaces — the argument

`/docs` · the `boneyard` hero at the top of the campaign list · any future landing page.

- Applicable: `awwwards-hero-section`, `awwwards-sections`, `awwwards-motion-design`, all at full
  strength — **inside the token system in §2**.

### Share surfaces — seen by strangers, once

`/b/[wallet]` (`PublicBoneyCard`) · `app/b/[wallet]/opengraph-image.tsx` · `BoneyCard` itself.

Read walletless and server-rendered, often as a 1200×630 image in a feed. Composition matters more
than interaction; there *is* no interaction in an OG image.

- Applicable: `awwwards-hero-section` for composition and type scale, `pixel-perfect-replication`
  when the user supplies a reference.
- **No motion** — an OG image is a single frame.

---

## 2. Boneyard's non-negotiables — these override every skill

`web/src/app/globals.css` is the contract, and it states the rules. The measurements behind them —
contrast ratios, the OKLCH lightness band, the CVD ΔE figures — are in `.claude/docs/decisions.md`
under the `#globals-css-*` anchors. A skill that tells you to do otherwise is wrong *here*, and the
numbers are there so you can check that claim rather than take it on faith.

### Colour

- **Every colour comes from a token.** `text-ink`, `text-ink-muted`, `bg-surface-1`, `bg-surface-2`,
  `border-hairline`, `text-brand`. A hex literal in a component is a regression, full stop.
- **Brand yellow `#ffc800` is ink and chrome only** — never a categorical series colour. Measured: the
  dark-palette lightness band is OKLCH L 0.48–0.67; vivid yellows sit at 0.74–0.86 and fail it
  outright. The series yellow slot is the darker `#c98500`.
- **The series slot ORDER is the CVD-safety mechanism.** `--series-1` … `--series-8` in that order.
  Leading with brand yellow was tried and collapsed magenta↔aqua to ΔE 1.6 under deuteranopia. Never
  reorder, never cycle, never assign a series colour by rank.
- **Status colours are reserved and always paired with a label.** `--status-good/-warning/-serious/
  -critical`. Never reused as a series colour. `--status-warning` is orange, not yellow, because a
  yellow "Pending" pill on a yellow-branded page reads as chrome rather than as state.
- **Magnitude uses the amber `--seq-*` ramp**, not a categorical slot. Single hue, monotone lightness.

### Type

- Two faces, both wired through `--font-*` in `globals.css`. Never hard-code a family at a call site.
- `Space_Grotesk` — body and all table/data text. Its figures are even-width.
- `Bagel_Fat_One` via `.font-display` — brand mark, page titles, hero figures. **It has exactly one
  weight (400).** `.font-display` pins it with `!important`; anything wearing that class must **not**
  also carry a Tailwind weight utility, or the browser synthesises a fake bold and smears an already
  very fat face.
- `.tnum` (tabular figures) on table cells and axis ticks. **Deliberately not** on large standalone
  figures — tabular makes `121` look loose at display size.
- No new webfont without asking.

### Chrome and a11y

- `:focus-visible` is a 2px brand outline. **Never removed, only restyled** — and never restyled to a
  series colour: focus is chrome and chrome must not borrow an identity hue.
- Hairlines are `--border` / `--border-strong`, warm-tinted so they belong to the palette instead of
  reading grey.
- The `@media (prefers-reduced-motion: reduce)` block in `globals.css` is global and already covers
  every transition. Any animation you add must still be *comprehensible* when it's flattened — see the
  blink chip, which pins to a single iteration at full opacity rather than disappearing.
- Density scale: `--row-h: 40px`, `--row-h-compact: 32px`. A terminal is tighter than a marketing
  page. Don't inflate padding to "let it breathe."

### Structure

- Reuse `components/ui/` before inventing: `Card`/`CardHeader`, `DataTable`, `StatTile`, `Meter`,
  `TrustReachBar`, `StatusPill`, `RankBadge`, `JoinedBadge`, `Bone`, `NavDrawer`, `States`
  (`EmptyState`/`ErrorState`), `TxErrorMessage`. A second, slightly different card is the most common
  slop in this repo.
- Nav shape lives in `lib/nav.ts`, not in JSX. Two components render the same nav; adding a link in
  markup makes them drift.
- Layout is `AppShell` — sticky `header`, `main.max-w-6xl`, `footer`. Pages don't re-implement chrome.
- Tailwind v4, tokens exposed via `@theme inline`. No `tailwind.config.js`.

---

## 3. The Boneyard slop catalog

Things that look like improvements and are not. Each has been considered.

| Slop | Why it's wrong here | Instead |
| --- | --- | --- |
| Whitespace inflation on a data table | halves the rows on screen for a reader comparing campaigns | keep `--row-h`; earn space by cutting columns |
| A hero on a terminal route | the page's job is the table below it | one line of `.font-display` title + a muted subtitle, as `/card` does |
| Brand yellow as a chart series | fails the lightness band; measured, not taste | `--series-4` (`#c98500`) |
| Reordering series slots for aesthetics | breaks CVD separation | never |
| A yellow warning pill | reads as chrome on a yellow-branded page | `--status-warning` orange |
| `font-extrabold` on `.font-display` | synthesises fake bold on a 400-only face | nothing — `.font-display` pins it |
| Gradient text / glassmorphism / AI-purple | not in the palette; not this brand | flat token colours |
| `.tnum` on a big hero figure | makes it look loose | proportional figures at display size |
| A skeleton where an `EmptyState` belongs | a dead-end tab costs a navigation to discover | `States.tsx`; or hide the entry, as `lib/nav.ts` does for personal tabs |
| Scroll-linked parallax anywhere in the product | motion sickness on a page you're reading numbers off | hover/focus feedback only |
| A raw revert string surfaced to the user | unreadable | extend `lib/txErrors.ts` |
| A new hex, a new radius, a new shadow | drifts from the validated system | a token, or ask |

---

## 4. Working procedure

1. **Classify the surface** (§1). Say which type it is out loud before you start.
2. **Invoke the matching skill** via the Skill tool with its real name: `visual-redesign`,
   `awwwards-hero-section`, `awwwards-sections`, `awwwards-motion-design`,
   `pixel-perfect-replication`, `dataviz`, `imagegen-frontend-web`, `brandkit-gen`.
3. **Run its pipeline, subject to §2.** Where the skill and §2 disagree, §2 wins and you note the
   deviation in a comment.
4. **Respect the Sacred/Slop line** from `visual-redesign`, on every visual task and not just that
   one. In this repo the line is unusually clean and worth stating explicitly:
   - **Sacred** — `hooks/*`, `lib/*` (all of it: `boneycard.ts`, `validation.ts`, `nav.ts`,
     `kpiSource.ts`, …), every `useQuery`/`useWriteContract`, every prop *contract*, every rationale
     comment.
   - **Slop, fair game** — `className` strings, wrapper elements, ordering within a section, spacing,
     which `ui/` primitive renders a value.
   - A visual change that edits a file in `hooks/` or `lib/` has gone out of bounds. Stop and
     reconsider.
5. **Verify.** `pnpm lint <paths>` and `pnpm test` if any `lib/` fixture is implicated. **Never
   `pnpm typecheck`.** Playwright can't launch here, so there are no screenshots — verify routes by
   HTTP status and ask the user to look at anything genuinely visual.

---

## 5. When the user supplies a reference image

`pixel-perfect-replication` is the right pipeline, with one amendment: build its Extraction Sheet in
full, then **map every extracted colour onto the nearest Boneyard token before writing code**, and say
which mapping you made. The reference is the spec for *layout, proportion, hierarchy and type scale*.
It is **not** the spec for palette — this app's palette is validated and the reference's isn't.

If the reference's structure genuinely can't survive that mapping, say so and ask, rather than
shipping an off-palette page.
