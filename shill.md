# 🦴 THE BONEYARD — YOU'RE ALREADY QUALIFIED

```
╔══════════════════════════════════════════════════════════════════════════╗
║   Your reputation already exists. Boneyard just pays you for it.         ║
╚══════════════════════════════════════════════════════════════════════════╝
```

### BoneyScore, head to head

| | **@leaf_swan** 🍃 | **@xeverade** ⛌ |
|---|---:|---:|
| | *Leafswan* | *⛌ev* |
| **BoneyScore** | **16,004** | **14,937** |
| of 28,000 possible | ▓▓▓▓▓▓▓▓▓▓▓░░░░ 57.2% | ▓▓▓▓▓▓▓▓▓▓░░░░░ 53.3% |
| | | |
| Ethos score | 1,463 · *known* | 1,356 · *neutral* |
| → trust points `×7` | **10,241** | **9,492** |
| X followers | 63,654 | 34,484 |
| → reach `400·log₁₀` | 1,921 | 1,815 |
| → reach points `×3` | **5,763** | **5,445** |
| | | |
| Trust / Reach mix | 64% / 36% | 64% / 36% |

> `BoneyScore = 7 × Ethos + 3 × Reach` — trust weighted higher, because followers are purchasable and Ethos vouches are not.

### What's open to you right now

| # | Status | Gate | Prize pool | @leaf_swan | @xeverade |
|---|:---:|---:|---:|:---:|:---:|
| 0 | 🟢 Active | 12,000 | 50,000 bUSD | ✅ **IN** | ✅ **IN** |
| 1 | 🟢 Active | open | 12,000 bUSD | ✅ **IN** | ✅ **IN** |
| 2 | 🟢 Active | 16,000 | 8,000 bUSD | ✅ **IN** *by 4 pts* | 🔒 −1,063 |
| 4 | 🟢 Active | open | 30,000 bUSD | ✅ **IN** | ✅ **IN** |
| 5 | 🟢 Active | 20,000 | 5,000 bUSD | 🔒 −3,996 | 🔒 −5,063 |
| 6 | 🟢 Active | 24,000 | 5,000 bUSD | 🔒 −7,996 | 🔒 −9,063 |
| 7 | 🟢 Active | 26,000 | 5,000 bUSD | 🔒 −9,996 | 🔒 −11,063 |
| 10 | 🟢 Active | 15,000 | 100,000 bUSD | ✅ **IN** | 🔒 **−63** |
| 3 | ⚫ Ended | open | 5,000 bUSD | — | — |
| 8 | ⚫ Ended | 10,000 | 100,000 bUSD | — | — |
| 9 | ⚫ Ended | 15,000 | 100,000 bUSD | — | — |
| 11 | ⚫ Ended | 9,000 | 50,000 bUSD | — | — |
| | | | | | |
| **UNLOCKED** | | | **215,000 live** | **5 / 8 · 200,000 bUSD** | **3 / 8 · 92,000 bUSD** |
| | | | | *93% of live rewards* | *43% of live rewards* |

### The 63-point story

**@leaf_swan** — you clear campaign #2 by **4 points**. Four. The 100,000 bUSD pool at #10 is already yours to join. Five of eight live campaigns, no waiting.

**@xeverade** — you are **63 points** short of the single biggest live pool on Boneyard (#10, 100,000 bUSD). That's **+9 Ethos points**. One vouch. Campaign #2 needs +152 Ethos, or 266k followers — the vouch is the cheap door.

Campaigns #5–#7 (gates 20k–26k) are Ethos-gated by design for both of you: with your current audiences, followers alone mathematically cannot reach them (reach caps at 2,800, so #7 needs both higher Ethos *and* more reach).

```
   Verify Ethos → attest on chain → join → get attributed → get paid.
   Your score is portable. Your followers are already counted.
```

---

## Notes on the numbers

- **Scores are projected, not on chain.** Neither wallet is attested yet — `scoreOf` returns 0 for all
  five of their linked addresses on the Base Sepolia `ReputationRegistry`. These are computed from
  live Ethos scores and live X follower counts through `web/src/lib/boneyscore.ts`, so they are what
  each would land at the moment they verify.
- **Gates** are the on-chain `minReputation` on each `Campaign`.
- **Joinability** is computed through the real `canJoin` gate (`web/src/lib/promoter.ts`): status must
  be Active *or* Pending, and score ≥ gate (a gate of 0 disables the check entirely).
- **Campaign set** is all 12 live on Base Sepolia via `CampaignRegistry.campaignAt`. Campaigns carry
  no on-chain names, hence the ids.
- Campaign #3 has a 5,000 bUSD pool but has ended, so it is dark for everyone.

Snapshot taken 2026-08-10.
