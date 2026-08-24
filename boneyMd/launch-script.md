# Boneyard — Launch Video Script

**Product:** Boneyard (the marketplace) · **Protocol:** Boney (the accountability layer underneath)
**Primary cut:** 2:40 · **Also included:** 45s teaser, 90s demo walkthrough, cold-open alternates

Everything factual in this script is drawn from the contracts and the app. Nothing is aspirational
unless the line explicitly says "next." Status disclosure (testnet, unaudited) is in the primary
cut and is not optional.

---

## Voice and rules

- **Tone:** dry, technical, confident. No hype adjectives, no "revolutionary," no "imagine a world."
  The product's own copy is lowercase and terse — the voiceover should match.
- **Person:** second person for the viewer ("you fund the escrow"), third for the protocol.
- **Never say:** "influencer" (say *promoter*), "guaranteed," "trustless" without qualification.
- **Say KOL only once**, in the "who this is for" beat. The app's vocabulary is *promoter* and
  *referral*; the contracts still say KOL internally.
- **Pace:** ~140 words/min. The line counts below are timed to that.

---

## PRIMARY CUT — 2:40

| # | Time | Visual | Voiceover | On-screen text |
|---|---|---|---|---|
| 1 | 0:00–0:12 | Cold open. Screen recording of a DM thread: a promoter sending an analytics screenshot. Slow zoom on the screenshot. Desaturated. | "This is how most Web3 growth deals get settled. A screenshot. A number nobody can check. And a payment that already went out before any of it was true." | — |
| 2 | 0:12–0:24 | Cut to black. Text builds line by line, one per beat. | "Projects pay upfront for promises. Promoters wait on goodwill for approval. And to qualify for anything, you hand over your social accounts to a stranger." | `pay for promises` / `wait on goodwill` / `hand over your identity` |
| 3 | 0:24–0:32 | Hard cut. `boneyard` hero on the landing page, full bleed, brand yellow on dark. Hold. | "Boneyard is a marketplace for verifiable growth. Underneath it is Boney — an accountability layer where funds only move after the work is provably done." | `boneyard` / *The marketplace for verifiable Web3 growth* |
| 4 | 0:32–0:52 | `/create` — scroll the campaign builder. Land on the KPI section, then the tier ladder, then the escrow amount field. | "A project sets the terms up front. What counts as a result — a mint, a swap, a deposit, a bridge, a signup, or a custom metric you define. What each tier of results pays. And how much is in the pot. Then it escrows the whole reward pool. The campaign will not activate while it's underfunded." | `Set your KPIs.` / `Fund the escrow.` / `Pay for verified results.` |
| 5 | 0:52–1:06 | Slow pan across a deployed campaign's config panel on `/campaign/[id]`. Overlay a lock icon on the config block. | "And then those terms are frozen. KPIs, tiers, the window, the reputation gate — all immutable at deployment. A project cannot move the goalposts after promoters have already done the work." | `Immutable at deployment` |
| 6 | 1:06–1:28 | `/promoters` directory. Rows of wallet addresses with rank badges and scores. Cursor hovers a badge; the score breakdown expands. | "Promoters qualify by wallet, not by handle. Your BoneyScore is seventy percent Ethos credibility, thirty percent audience reach — and reach is logarithmic, so ten million followers can't drown out a thousand people who actually vouch for you. Your social accounts never touch the chain. An attestor sees them off-chain and signs a number." | `BoneyScore = 7 × Ethos + 3 × Reach` |
| 7 | 1:28–1:42 | The rank ladder from `/docs`, animating bottom-up: Drifter → Scavenger → Runner → **Netrunner** → Fixer → Ronin → Samurai → Ghost → Oracle → Legend. Freeze on the Netrunner row; the rows below it dim. | "Every rank below Netrunner can be cleared on follower count alone. Netrunner is the first one that can't. A campaign that gates there is filtering for credibility, not audience — and the number it gates on is public before anyone joins." | `8,400 — the pure-reach ceiling` |
| 8 | 1:42–2:04 | Split screen. Left: a phone, someone taps a tracking link and taps *Sign* in a wallet. Right: the touch landing on the campaign detail page, attribution flipping to their promoter. | "Attribution is consented, not asserted. A promoter shares a tracking link. The person who arrives signs a message — an explicit, wallet-signed statement that they were referred by that promoter. The promoter pays the gas; the referral never sends a transaction. If a promoter could just claim wallets, they'd claim all of them. The signature is the part an attacker can't forge. And it expires." | `User-signed. Expiring. Forward-only.` |
| 9 | 2:04–2:22 | The money shot. Screen recording, unedited, single take: progress gets reported → the tier row flips from *Locked* to *Paid* → the promoter's wallet balance increments. Real timestamps visible. | "When progress is reported, settlement happens in the same transaction. The tier clears and the escrow releases to the promoter's wallet — right there. There is no claim button in this app, because there is nothing to claim. The money already moved." | `No approval. No claim. Same transaction.` |
| 10 | 2:22–2:32 | Quick montage, ~1s each: the escrow vault balance, the dispute-window countdown on an oracle report, the `PoolExhausted` handling note, the grace timer on an ended campaign. | "The rest is the boring part that matters. Escrow is custody-only and isolated per campaign. Oracle reporters are staked and slashable. A pool that runs dry pays out what's left instead of freezing everyone. And after a campaign ends, a grace window settles final progress before a project can reclaim a cent." | — |
| 11 | 2:32–2:40 | Back to the `boneyard` hero. Wide. Beta tag visible in the top bar. | "Three hundred tests across thirteen suites. Live on Base Sepolia. In beta, and not yet audited — so bring testnet funds and break it. The first application is KOL campaigns. The machinery underneath doesn't care: a grant program is a campaign whose KPIs are deliverables. A bug bounty is a campaign whose verifier is a triage attestation." | `Beta · testnet · unaudited` / `boneyard` / *[your URL]* |

**Total VO word count:** ~390 words ≈ 2:47 at 140 wpm. Trim scene 10 first if you need to hit 2:30.

---

## 45-SECOND TEASER

For the timeline. Silent-autoplay-safe — every line must land as on-screen text too.

| # | Time | Visual | Voiceover / Text |
|---|---|---|---|
| 1 | 0:00–0:06 | DM screenshot, desaturated, zoom. | "Web3 growth runs on screenshots and trust." |
| 2 | 0:06–0:12 | Hard cut to `boneyard` hero. | "Boneyard replaces both." |
| 3 | 0:12–0:22 | `/create` KPI + tier ladder + escrow field, fast scroll. | "Set your KPIs. Fund the escrow. The terms freeze on deployment." |
| 4 | 0:22–0:30 | Phone: tap link → sign. | "Referrals sign their own attribution. Promoters pay the gas." |
| 5 | 0:30–0:40 | The settlement shot: *Locked* → *Paid*, balance increments. | "Progress reported. Tier cleared. Paid — same transaction, no approval." |
| 6 | 0:40–0:45 | Hero + URL. | `Beta on Base Sepolia. Unaudited.` `boneyard — the marketplace for verifiable Web3 growth` |

---

## 90-SECOND DEMO WALKTHROUGH (screen-only, no b-roll)

Use your own voice, unscripted, hitting these beats. This is the one that converts developers.

1. **`/` (0:00–0:10)** — "This is every campaign on the network, read straight from the chain. No backend, no database. Search, filter by status, filter by what you can actually join."
2. **`/create` (0:10–0:35)** — Build one live. Name a KPI, add two tiers, set `minReputation` to Netrunner using the rank picker. Say out loud: *"this is immutable after deployment, so I'm choosing carefully."* Fund it. Activate it. Point out that activation reverts while underfunded.
3. **`/campaign/[id]` (0:35–0:55)** — Join as a promoter from a second wallet. Show the reputation gate accepting it. Copy the tracking link and show the promoter id encoded in it.
4. **`/r` (0:55–1:10)** — Open the tracking link as a third wallet. Sign the touch. Show the attribution flipping on the campaign page, and point out the expiry.
5. **Report + settle (1:10–1:30)** — Report progress as the project. Let the tier row flip to *Paid* on camera and show the balance. Do not cut. The single unbroken take is the entire argument.

**Recording notes:** run against local anvil, not Base Sepolia — public RPC rate-limits and one stalled
read ruins a take. Two funded wallets pre-loaded in the browser profile. Wallet popups are part of
the story; don't edit them out.

---

## COLD-OPEN ALTERNATES

Pick one. A is safest, C is the most memorable.

- **A — The screenshot.** As scripted above. Universally understood, zero setup.
- **B — The invoice.** Static shot of a growth invoice: *"KOL package — 25,000 USDC — deliverables: 3 posts, 1 thread."* VO: "Three posts and a thread. That's the deliverable. Not a single user, not a single mint — three posts and a thread, paid in advance." Cut to the tier ladder: "This is the same deal, priced on results."
- **C — The empty rank.** Open on the Legend rank row in an empty directory. VO: "Nobody is this. That's the point — the top of the ladder isn't for sale, and neither is anything above Netrunner." Cut to hero. Riskier, only works for an audience that already knows what reputation gating is.

---

## LINES THAT DO THE HEAVY LIFTING

Reusable for thumbnails, tweets, and captions. Every one is literally true of the code.

- "There's no claim button, because there's nothing to claim. The money already moved."
- "Attribution is consented, not asserted."
- "The terms freeze at deployment. Nobody moves the goalposts."
- "Your handles never touch the chain."
- "Netrunner is the first rank you can't fake with followers."
- "A verifier can discount a claim. It can never inflate one."
- "A grant program is a campaign whose KPIs are deliverables."
- "Escrow that releases itself."

---

## ACCURACY GUARDRAILS

Things that are easy to overclaim on camera. Hold the line on all of them.

| Don't say | Say instead | Why |
|---|---|---|
| "Trustless" | "Escrow you don't have to trust anyone with" | For KPIs without a verifier adapter, the project or oracle *is* the reporter. Custody is trustless; progress isn't yet. |
| "Fraud-proof attribution" | "Attribution requires the referral's signature" | A referral can knowingly sell their signature. Documented, accepted. |
| "Sybil-proof" | "Reputation-gated" | The tier ladder is per-promoter, so bottom rungs are farmable across wallets. `minReputation` raises the cost; it doesn't eliminate it. `RejoinAttack.t.sol` tests exactly this. |
| "Audited" | "Not yet audited" | Say it out loud in scene 11. Don't bury it in a lower third. |
| "Live" / "mainnet" | "Beta on Base Sepolia" | Testnet only. |
| "Decentralized oracle" | "Staked reporters with a dispute window" | Disputes are governor-only in the MVP. |

---

## SHOT LIST

Routes in the running app, in the order the primary cut needs them:

| Route | What it gives you |
|---|---|
| `/` | `boneyard` hero, campaign table, search — scenes 3 and 11 |
| `/create` | KPI builder, tier ladder, escrow field — scene 4 |
| `/campaign/[id]` | Frozen config panel, promoter list, ladder rows, settlement — scenes 5 and 9 |
| `/promoters` | Rank badges and score breakdown — scene 6 |
| `/docs` | The generated rank table — scene 7 |
| `/r` | The referral signing flow — scene 8 |
| `/my` | Project-side campaign management — b-roll |
| `/discover` | Promoter-side campaign discovery — b-roll |

**Capture settings:** 1440×900 browser window at 2× DPI, dark theme, wallet extension pinned.
Hide bookmarks bar. Use a cursor-highlight tool — the brand yellow on dark hides a default cursor.

---

## MUSIC AND EDIT NOTES

- One track, no drop. Something sparse and mechanical. The tone is *audit*, not *launch party*.
- **The single most important edit decision:** scene 9 is one unbroken take. Every cut you make
  there costs credibility, because the whole claim is "this happens in one transaction." Show it
  happening in one transaction.
- Let scenes 5 and 7 breathe — a beat of silence after "cannot move the goalposts" and after
  "the first one that can't."
- Captions burned in. Most of this will be watched muted.

---

## PRODUCTION STACK (all free)

**The honest verdict first: an AI video generator is the wrong primary tool for this video.**
Roughly 85% of the runtime is screen recording of a real app — Veo, Kling, Sora and friends
generate *invented* footage, and an invented dashboard is exactly the screenshot-you-can't-verify
that scene 1 is attacking. Using generated UI here would undercut the entire argument. AI video
earns about 15 seconds of screen time: the cold open and a couple of abstract transitions.

### The stack

| Job | Tool | Cost | Notes |
|---|---|---|---|
| Screen capture | **OBS Studio** | Free, open source, no watermark | Set canvas 2560×1440, capture the browser window, 60fps. The only real requirement is that scene 9 records in one take. |
| Editing | **DaVinci Resolve** (free) | Free tier exports 4K, no watermark | Steeper than CapCut but the free tier is genuinely unrestricted. **CapCut** free is the faster path if you've used it — free plan is watermark-free on desktop at 1080p. |
| Cold-open b-roll (scene 1–2) | **Veo 3 via Gemini / Google AI Studio** | Free, daily rate-limited quota | Best free output quality, native audio, no on-frame watermark. This is your first choice for the DM/screenshot shot. |
| Backup / more volume | **Kling AI** | 66 credits/day free | Most generous free tier, but **watermarks free exports** — so use it only for shots you can crop, or as a storyboard pass before regenerating the keeper in Veo. |
| Voiceover | Record it yourself | Free | Genuinely the right call — a slightly imperfect human read outperforms clean TTS for a technical launch. If you must synthesize, free TTS tiers change constantly and most restrict commercial use; check the license the day you use it. |
| Music | **Free Music Archive** / **Uppbeat** free tier | Free w/ attribution | Sparse and mechanical. Verify the license allows commercial use before publishing. |

**Free-tier reality check:** free tiers on every one of these move month to month, and several
forbid commercial use in the fine print even when output is watermark-free. Confirm the current
terms on the day you render — don't trust this table's specifics six months from now.

### Veo / Kling prompts for the cold open

Only three shots need generating. Keep them abstract — no readable UI, no legible text, since
that's where generators fail most visibly.

1. **Scene 1** — `Extreme close-up of a phone screen showing a chat conversation, shallow depth of field, screen glare, a hand holding the phone in a dim room, slow push in, desaturated cool color grade, cinematic, no readable text`
2. **Scene 2 transition** — `Abstract dark background, warm amber particles drifting slowly upward against near-black, very low contrast, shallow depth, cinematic grain, no subject`
3. **Scene 10 texture** — `Macro shot of an amber indicator light pulsing slowly in darkness, out-of-focus bokeh, warm yellow on black, extremely minimal`

Generate at 16:9. If a clip arrives with a watermark in the corner, scale 105% and reframe rather
than regenerating — these are all backgrounds under text.

---

## BRAND ASSETS

### Palette — from `web/src/app/globals.css`

Use these exact values for titles, lower thirds, and motion graphics so the edit matches the app.

| Token | Hex | Use in the video |
|---|---|---|
| `--plane` | `#0a0a09` | Background for every title card. Not pure black. |
| `--surface-1` | `#121110` | Card/panel fills behind text |
| `--surface-2` | `#1b1a17` | Raised elements, lower-third backing |
| `--brand` | `#ffc800` | The brand yellow. Headlines, key figures, the logo. |
| `--brand-dim` | `#b38c00` | Secondary accents, underlines |
| `--text-primary` | `#ffe9a3` | Body text — a soft cream, **not white**. Never put white text in this edit. |
| `--text-secondary` | `#d6c489` | Subtitles and captions |
| `--text-muted` | `#9a8f63` | Disclaimers, the beta/unaudited line |
| `--status-good` | `#35c135` | The *Paid* state in scene 9 |
| `--status-warning` | `#f0871a` | *Pending* — note it's orange, deliberately not yellow |

Contrast is already solved: `#ffc800` on `#0a0a09` is 12.75:1, and every ink step clears WCAG AA.
Keep those pairings and your burned-in captions stay legible on a phone.

### Type

- **Display — Bagel Fat One** (Google Fonts, free). The `boneyard` mark, titles, hero figures.
  Ships a **single 400 weight** — never apply bold to it in your editor, synthetic bold smears an
  already-heavy face. Always lowercase for the brand mark.
- **Body — Space Grotesk** (Google Fonts, free). Captions, lower thirds, on-screen labels.

### Screenshots in `web/screenshots/`

⚠️ **These are stale and three of them contradict the script. Read this before cutting anything.**

| File | Shows | Verdict |
|---|---|---|
| `campaigns.png` | Full landing page: `boneyard` hero, stat tiles (5 campaigns, 105K escrowed, 10K paid, 9.5% utilization), campaign table | **Palette/layout reference only** — tagline is outdated (see below) |
| `campaigns-sorted-asc.png` | Same, sorted | Reference |
| `campaigns-fixed.png` | Same, layout fix | Reference |
| `detail-phase6.png` | Campaign #0 detail: 50K pool, 10K paid, tier ladder with *Reached / Reached / Locked* | **Good for scene 5** — frozen-config panel with Starts/Ends/Attribution window/Min. reputation is exactly the shot |
| `kol-joined.png` | Promoter dashboard with tracking link and tier ladder | ❌ **Do not use** — contains a `Claim` button and an "Awaiting claim" figure |
| `event-kpi-page.png` | Campaign #5, event-sourced KPI | Reference |
| `event-kpi-progress.png` | Campaign #5 with a `TRACKING Deposit(address,uint256)` block and tiers *Reached/Reached/Locked* | **Best asset in the folder** — the on-chain event signature is visible proof the KPI is measured, not asserted. Strong scene 4 or 5 insert. |
| `event-probe.png` | Event probe | Reference |
| `write-funded.png` | Post-funding state | Useful for scene 4 |
| `write-activated.png` | Post-activation state | Useful for scene 4 |

**Three conflicts with the script, all real:**

1. **The tagline is outdated.** Screenshots read *"The marketplace for trustless marketing
   campaigns."* The current code (`CampaignsPage.tsx`) reads *"The marketplace for verifiable Web3
   growth."* The old wording uses the exact word the accuracy table says to avoid — recapture the
   hero rather than using `campaigns.png` for scene 3.
2. **`kol-joined.png` has a Claim button.** The current code removed it deliberately —
   `PromoterPanel.tsx` states there is no claim control, and `useWriteCampaign.ts` explains why
   there is no settle hook. Putting that screenshot on screen while the voiceover says "there is
   no claim button" hands a reviewer an immediate contradiction. **Recapture or cut.**
3. **Nav is out of date.** Screenshots show `Campaigns / My Campaigns / KOL / Docs`. The app now
   has `/promoters` and `/discover` routes, and the vocabulary moved from KOL to Promoter. Any
   full-window shot showing the old nav dates the video.

**Recommendation:** treat this folder as a palette, layout, and framing reference — not as
footage. Recapture everything against local anvil at the current build, following the capture
settings in the shot list. The one asset worth keeping as-is is `event-kpi-progress.png`, whose
tracking block is unaffected by all three issues.
