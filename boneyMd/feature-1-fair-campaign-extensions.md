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

## Isolated playground

The hosted registry is append-only, so Feature 1 redeployment and reseeding must not happen on the
existing Base Sepolia registry. Use a fresh local deployment instead:

- Anvil on RPC port `8546` with chain id `31338`.
- `DeployBoney` followed by `SeedLocal` against the fresh registry.
- A separate generated deployment output and frontend process on port `3002`.
- A playground seed containing an active campaign with a nearly exhausted pool, an owed shortfall,
	and an extendable reporting window.
- A reset command that clears only playground Anvil and Graph Node/Postgres state.

The current `seed-local.ts` treats only chain id `31337` as Anvil, so playground mode needs an
explicit local flag or local-RPC detection before using the deterministic Anvil keys on `31338`.

### Off-chain processes

- Ethos stub is chain-independent and can be reused.
- The relayer CLI and indexer accept an explicit playground RPC and campaign address.
- `relay-loop.sh` currently contains hardcoded Base Sepolia targets; playground mode needs a target
	file or environment-provided `campaign:kpi` list.
- `dev-up.sh` currently assumes Base Sepolia and needs a playground mode before it can orchestrate
	the local RPC, relayer, indexer, and frontend together.

### Local Graph Node

Graph Node can index the playground through a separate local manifest:

- Configure an Ethereum network named `localhost` with Anvil's RPC URL.
- Use playground contract addresses and the deployment block in `subgraph.yaml`.
- Keep the Base Sepolia manifest and Studio deployment unchanged.
- Start from the deployment block so `CampaignCreated` events spawn all dynamic campaign templates.
- Add `Extended` and `PoolIncreased` handlers when the subgraph exposes Feature 1 state.
- Run Postgres and IPFS with Graph Node; after resetting Anvil, recreate their data so stale entities
	from old contract addresses cannot survive.

The local Graph Node is for indexing and GraphQL integration checks. Direct RPC remains the primary
contract behavior check, and the hosted subgraph is never repointed at the playground.

The first isolated end-to-end run is documented in
`boneyMd/feature-1-anvil-e2e-report.md`. It found an EIP-170 deployment-size blocker, missing
31338 frontend chain registration, a seed harness assumption limited to 31337, and the need for
explicit verifier configuration before relaying.

## Deferred next slice

- Synchronize `EventMetricKpiVerifier.windowEndBlock` when a campaign extends. The preferred design is a registered-campaign `extendWindow` entrypoint and a campaign call across gated KPIs.
- Add shortfall claim UI and improve project-panel guidance after live campaign feedback.
- Update subgraph handlers for `Extended`, `PoolIncreased`, and shortfall-related state.
- Regenerate ABIs and deployment artifacts after the contract shape is finalized, then redeploy and reseed once with the other contract features.
- Add tests for non-project callers, paused top-ups/extensions, partial shortfall claims, and verifier-window continuity.

## Verification

`forge fmt src/interfaces/ICampaign.sol src/campaign/Campaign.sol test/Campaign.t.sol`

`forge test --match-contract CampaignTest` -> 77 passed, including Feature 1 fuzz coverage.
