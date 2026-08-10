# 🦴 The Boneyard — you're already qualified

**Your reputation already exists. Boneyard just pays you for it.**

Two promoters, scored against every campaign live on Boneyard today.

---

## 1. Scorecard

| Metric | @leaf_swan 🍃 | @xeverade ⛌ |
| :--- | ---: | ---: |
| Display name | Leafswan | ⛌ev |
| **BoneyScore** | **16,004** | **14,937** |
| Share of max (28,000) | 57.2% | 53.3% |
| Progress | `███████████░░░░░░░░░` | `██████████░░░░░░░░░░` |
| Ethos score | 1,463 | 1,356 |
| Ethos band | *known* | *neutral* |
| X followers | 63,654 | 34,484 |
| Normalised reach | 1,921 | 1,815 |
| Trust / reach mix | 64% / 36% | 64% / 36% |

## 2. How the score is built

`BoneyScore = 7 × Ethos + 3 × Reach` — trust is weighted higher because followers are purchasable and Ethos vouches are not.

| Component | Weight | @leaf_swan | @xeverade |
| :--- | :---: | ---: | ---: |
| Ethos score | × 7 | 1,463 → **10,241** | 1,356 → **9,492** |
| Reach (`400 · log₁₀(1+followers)`, cap 2,800) | × 3 | 1,921 → **5,763** | 1,815 → **5,445** |
| **Total** | | **16,004** | **14,937** |

## 3. Live campaigns

| # | Gate | Prize pool | @leaf_swan | @xeverade |
| :---: | ---: | ---: | :--- | :--- |
| 0 | 12,000 | 50,000 bUSD | ✅ Eligible | ✅ Eligible |
| 1 | open | 12,000 bUSD | ✅ Eligible | ✅ Eligible |
| 2 | 16,000 | 8,000 bUSD | ✅ Eligible *(by 4 pts)* | 🔒 short 1,063 |
| 4 | open | 30,000 bUSD | ✅ Eligible | ✅ Eligible |
| 5 | 20,000 | 5,000 bUSD | 🔒 short 3,996 | 🔒 short 5,063 |
| 6 | 24,000 | 5,000 bUSD | 🔒 short 7,996 | 🔒 short 9,063 |
| 7 | 26,000 | 5,000 bUSD | 🔒 short 9,996 | 🔒 short 11,063 |
| 10 | 15,000 | 100,000 bUSD | ✅ Eligible | 🔒 **short 63** |

## 4. Unlocked totals

| | @leaf_swan | @xeverade |
| :--- | ---: | ---: |
| Campaigns open to you | **5 of 8** | **3 of 8** |
| Rewards unlocked | **200,000 bUSD** | **92,000 bUSD** |
| Share of the 215,000 bUSD live pool | **93%** | **43%** |

## 5. What the next gate costs

Two routes to any gate: raise Ethos, or grow the audience. Reach is capped at 2,800, so above a point the audience route closes and only Ethos moves the number.

| Promoter | Gate | Short by | Ethos route | Followers route |
| :--- | ---: | ---: | :--- | :--- |
| @xeverade | 15,000 (#10) | 63 | **+9 Ethos** → 1,365 | 38,904 followers |
| @xeverade | 16,000 (#2) | 1,063 | +152 Ethos → 1,508 | 266,072 followers |
| @xeverade | 20,000 (#5) | 5,063 | +724 Ethos → 2,080 | — not reachable |
| @xeverade | 24,000 (#6) | 9,063 | +1,295 Ethos → 2,651 | — not reachable |
| @xeverade | 26,000 (#7) | 11,063 | — not reachable | — not reachable |
| @leaf_swan | 20,000 (#5) | 3,996 | +571 Ethos → 2,034 | — not reachable |
| @leaf_swan | 24,000 (#6) | 7,996 | +1,143 Ethos → 2,606 | — not reachable |
| @leaf_swan | 26,000 (#7) | 9,996 | — not reachable | — not reachable |

Ceiling at today's follower count: **25,363** for @leaf_swan, **25,045** for @xeverade, against an absolute max of 28,000.

## 6. The 63-point story

**@leaf_swan** — you clear campaign #2 by **4 points**. Four. The 100,000 bUSD pool at #10 is already yours to join. Five of eight live campaigns, no waiting.

**@xeverade** — you are **63 points** short of the single biggest live pool on Boneyard (#10, 100,000 bUSD). That is **+9 Ethos points**. One vouch. Campaign #2 needs +152 Ethos or 266k followers — the vouch is the cheap door.

Campaigns #5–#7 are Ethos-gated by design for both of you: at your current audiences, followers alone mathematically cannot clear them.

> **Verify Ethos → attest on chain → join → get attributed → get paid.**
> Your score is portable. Your followers are already counted.

## 7. Ended campaigns

Closed to new promoters, listed for completeness.

| # | Gate | Prize pool |
| :---: | ---: | ---: |
| 3 | open | 5,000 bUSD |
| 8 | 10,000 | 100,000 bUSD |
| 9 | 15,000 | 100,000 bUSD |
| 11 | 9,000 | 50,000 bUSD |

---

## Notes on the numbers

- **Scores are projected, not on chain.** Neither wallet is attested yet — `scoreOf` returns 0 for all five of their linked addresses on the Base Sepolia `ReputationRegistry`. These are computed from live Ethos scores and live X follower counts through `web/src/lib/boneyscore.ts`, so they are what each would land at the moment they verify.
- **Gates** are the on-chain `minReputation` on each `Campaign`. A gate of 0 ("open") disables the check entirely.
- **Eligibility** is computed through the real `canJoin` gate (`web/src/lib/promoter.ts`): status must be Active *or* Pending, and score ≥ gate.
- **Campaign set** is all 12 live on Base Sepolia via `CampaignRegistry.campaignAt`. Campaigns carry no on-chain names, hence the ids.

Snapshot taken 2026-08-10.
