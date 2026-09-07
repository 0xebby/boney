# Feature 1: Fair campaign extensions

## Status

First contract iteration implemented on 2026-09-07.

## Shipped

- `Campaign.extend(newEndTime)` is project-only and works while Active or Paused.
- An extension must move the deadline forward and cannot move it beyond half of the initial campaign duration.
- `rewardPool` and `endTime` remain available through their existing public getter names, while `config()` returns current values.
- `Campaign.topUp(amount)` is project-only and works while Active or Paused.
- Top-ups require at least 90% of the current pool to have been paid out and must be at least 20% of the initial pool.
- The pool increases by the amount actually credited by the escrow vault, including fee-on-transfer behavior.
- Pool exhaustion records unpaid tier rewards as promoter/KPI shortfalls instead of losing them.
- Promoters can call `claimShortfall(kpiIndex)` after funds are available.
- Reclamation is blocked while any shortfall remains outstanding.
- Events, custom errors, getters, and focused Foundry tests were added.
- Project controls for extension and top-up are wired into the campaign detail page.
- The detail read exposes the initial pool and fixed maximum deadline needed by the controls.

## Decisions in motion

- Shortfalls are paid from newly added pool funds and are claimed by the promoter who earned them.
- A top-up must cover all currently recorded shortfalls; excess remains available for future tiers.
- The extension ceiling is cumulative, not reset by each successive call.
- Existing KPI definitions and tier ladders remain unchanged by extension and top-up.

## Deferred next slice

- Synchronize `EventMetricKpiVerifier.windowEndBlock` when a campaign extends. The preferred design is a registered-campaign `extendWindow` entrypoint and a campaign call across gated KPIs.
- Add shortfall claim UI and improve project-panel guidance after live campaign feedback.
- Update subgraph handlers for `Extended`, `PoolIncreased`, and shortfall-related state.
- Regenerate ABIs and deployment artifacts after the contract shape is finalized, then redeploy and reseed once with the other contract features.
- Add tests for non-project callers, paused top-ups/extensions, partial shortfall claims, and verifier-window continuity.

## Verification

`forge fmt src/interfaces/ICampaign.sol src/campaign/Campaign.sol test/Campaign.t.sol`

`forge test --match-contract CampaignTest` -> 74 passed.
