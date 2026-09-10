# Feature 1 Anvil E2E Completion Report

Date: 2026-09-07

## Scope

This report records the isolated Anvil playground test for the updated Boney contracts and the
surrounding deployment, seed, relayer, indexer, frontend, and subgraph tooling.

The hosted Base Sepolia deployment was not touched.

| Item | Value |
| --- | --- |
| RPC | `http://127.0.0.1:8546` |
| Chain ID | `31338` |
| Anvil mode | `--disable-code-size-limit` |
| Frontend target | port `3002` |
| Local GraphQL | `http://localhost:8000/subgraphs/name/boney-local` |

The Anvil code-size override is diagnostic only. It does not demonstrate that the contracts are
currently deployable on a production EVM.

## Final Result

The local subgraph path is now operational end to end:

- Anvil deployment completed with the diagnostic code-size override.
- `SeedLocal.s.sol` completed with explicit playground module addresses.
- Local manifest compilation completed.
- IPFS upload completed through the local Kubo container.
- Graph Node accepted and deployed `boney-local`.
- Graph Node reported `healthy` and `synced: true` through block 48.
- GraphQL returned the five seeded campaigns.

The complete Feature 1 behavior test is not complete. The current seed does not create the intended
nearly-exhausted pool and owed shortfall transition, and the relayer test campaign is not configured
with an EventMetric verifier KPI.

## Summary

| Area | Result | Notes |
| --- | --- | --- |
| Anvil startup | PASS | Isolated chain `31338` on port `8546`. |
| Standard deployment | BLOCKED | `CampaignRegistry` bytecode is above EIP-170. |
| Diagnostic deployment | PASS | Used `--disable-code-size-limit` and Forge `--code-size-limit 30000`. |
| Existing Solidity seed | PASS | Ran with explicit playground addresses and deterministic Anvil keys. |
| Generic TypeScript seed harness | FAIL | Assumed chain `31337`, then used the repository deployer and failed funding. |
| Deployment artifact generation | PASS | Generated chain `31338` deployment data. |
| ABI generation | PASS | Generated updated contract ABIs. |
| Indexer dry run | PASS | Accepted the Anvil RPC and returned zero reports for the unchanged fixture. |
| Relayer dry run | EXPECTED FAIL | Seeded KPI had no EventMetric verifier configuration. |
| Frontend process | STARTED | Ran directly on port `3002`. |
| Frontend routes | FAIL | Chain `31338` is not fully registered in wagmi/app chain configuration. |
| Local manifest build | PASS | `subgraph.local.yaml` compiles. |
| Local Graph Node | PASS | Docker stack starts after locale and port fixes. |
| Local IPFS upload | PASS | Host port `5001` is exposed. |
| Local subgraph deployment | PASS | `boney-local` deployed successfully. |
| Feature 1 shortfall behavior | NOT TESTED | Requires a dedicated seed and configured gated KPI. |

## Deployment

### Production-size deployment failure

The standard deployment was blocked by EIP-170:

```text
Unknown5 is above the contract size limit (26014 > 24576)
```

The reported contract bytecode is 26,014 bytes against the 24,576-byte EVM limit. The Anvil
playground was therefore run with the code-size limit disabled. This remains a production blocker
and must be resolved before a normal redeployment to Base Sepolia.

### Diagnostic deployment

The diagnostic deployment succeeded on chain `31338`.

| Contract | Address |
| --- | --- |
| Boney | `0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6` |
| CampaignRegistry | `0x5FC8d32690cc91D4c39d9d3abcBD16989F875707` |
| EscrowVault | `0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9` |
| AttributionRegistry | `0x5FbDB2315678afecb367f032d93F642f64180aa3` |
| ReputationRegistry | `0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0` |
| OracleCoordinator | `0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9` |
| EventMetricVerifier | `0x8A791620dd6260079BF849Dc5567aDC3F2FdC318` |
| GuardedVerifier | `0x610178dA211FEF7D417bC0e6FeD39F05609AD788` |

## Seed State

The direct `SeedLocal.s.sol` run created the following fixture:

```text
Token                 0xA51c1fc2f0D1a1b8494Ed1FE312d7C3a78Ed91C0
Active with progress  0x61c36a8d610163660E21a8b7359e1Cac0C9133e1
Active empty          0x23dB4a08f2272df049a4932a4Cc3A6Dc1002B33E
Ended                 0x6743E5c6E1B453372507E8dfD6CA53508721425B
Multi-KPI             0xA14d9C7a916Db01cCA55ec21Be1F7665C326928F
```

The generic TypeScript harness failed with:

```text
Insufficient funds for gas * price + value
```

Cause: `seed-local.ts` only recognized chain `31337` as Anvil. On chain `31338` it treated the
playground as a normal network, derived the deployer from the repository environment, and attempted
to fund a promoter from an unfunded account.

The generic fixture also does not create a nearly exhausted pool with a repayment shortfall, so it
cannot prove the Feature 1 extension behavior.

## Indexer and Relayer

Indexer command:

```bash
cd web
pnpm index --rpc http://127.0.0.1:8546 \
  --campaign 0x61c36a8d610163660E21a8b7359e1Cac0C9133e1 --dry-run
```

Result:

```text
Chain 31338 at http://127.0.0.1:8546
0 report(s) sent, 0 skipped.
```

This validates Anvil RPC and campaign override wiring. It does not validate a new report or payout
transition because the selected fixture had no new creditable activity.

Relayer command:

```bash
cd web
pnpm relay --campaign 0x61c36a8d610163660E21a8b7359e1Cac0C9133e1 \
  --kpi 0 --rpc http://127.0.0.1:8546 --dry-run
```

Result:

```text
KPI 0 ... is not configured on EventMetricKpiVerifier.
Run setKpiConfig first.
```

This is an expected fixture failure, not an RPC failure. A gated playground KPI needs an explicit
`setKpiConfig` setup step before the relayer can observe it.

## Frontend

The frontend was started directly because the existing `dev-up.sh` orchestration is Base Sepolia
specific:

```bash
cd web
NEXT_PUBLIC_DEFAULT_CHAIN_ID=31338 PORT=3002 pnpm dev
```

The process started, but the app did not fully support chain `31338`:

```text
/          200
/campaign/0 404
/my        404
/create    404
```

The deployment map contains chain `31338`, but the wagmi supported-chain configuration and chain
helpers do not yet register a named local playground chain. Setting only
`NEXT_PUBLIC_DEFAULT_CHAIN_ID` is insufficient.

## Local Graph Node

### Initial failures

The first compose attempt could not be inspected because the Docker socket was inaccessible:

```text
permission denied while trying to connect to the Docker daemon socket
```

The session user was not in the `docker` group and non-interactive `sudo` could not provide a
password. Running the compose commands with `sudo` resolved the host permission issue.

Graph Node then failed against the persisted Postgres volume because its database used the wrong
locale/collation. The disposable local database was recreated with:

```yaml
POSTGRES_INITDB_ARGS: --locale=C --encoding=UTF8
```

The IPFS upload then failed from the host because Kubo's API was not published. The compose file now
exposes:

```yaml
ports:
  - "5001:5001"
```

### Successful stack

The local stack is defined in `subgraph/docker-compose.local.yml` and contains:

- Postgres 14
- IPFS Kubo `v0.17.0`
- Graph Node `v0.35.1`
- Anvil RPC mapped through `host.docker.internal:8546`

The local manifest is `subgraph/subgraph.local.yaml`, using `network: localhost`, playground
addresses, and `startBlock: 1`.

The local deployment command is now:

```bash
cd subgraph
pnpm deploy:local
```

The script explicitly deploys `subgraph.local.yaml` and writes compiled files to `build-local/`:

```text
graph deploy boney-local subgraph.local.yaml \
  --node http://localhost:8020/ \
  --ipfs http://localhost:5001 \
  --output-dir build-local
```

An earlier version omitted the manifest argument. Graph CLI then compiled the production
`subgraph.yaml`, which caused:

```text
network not supported by registrar: no network base-sepolia found on chain ethereum
```

An attempt to deploy the generated `build-local/subgraph.yaml` directly caused a separate path
error because generated WASM paths are relative to the build directory:

```text
ERROR TS6054: File 'CampaignRegistry/CampaignRegistry.wasm.ts' not found.
```

Deploying from the source local manifest with `--output-dir build-local` is the correct workflow.

### Final Graph Node verification

Deployment completed with IPFS manifest hash:

```text
QmS9yv8xFB1DGDViRDTB7uc7JvUNpKt1PiZ6rkDoh5Aut7
```

Indexing status:

```json
{
  "synced": true,
  "health": "healthy",
  "network": "localhost",
  "latestBlock": "48",
  "chainHeadBlock": "48",
  "fatalError": null
}
```

GraphQL query:

```graphql
{ campaigns(first: 10) { id name status } }
```

Returned five campaigns:

```text
Seed Campaign 1   status 1
Seed Campaign 0   status 1
Seed Campaign 3   status 3
Seed Campaign 2   status null
Multi-KPI Demo    status 1
```

A first query requested `Campaign.address`, which is not in the schema. The campaign contract address
is the entity `id`, so the valid query uses `id`, `name`, and `status`.

## Findings

1. **Production blocker:** `CampaignRegistry` bytecode exceeds EIP-170 by 1,438 bytes.
2. **Playground isolation works:** Anvil chain `31338`, local deployment artifacts, local IPFS, and
   local Graph Node are isolated from Base Sepolia.
3. **Deployment script fix completed:** `deploy:local` now uses `subgraph.local.yaml`, preventing
   accidental compilation of the Base Sepolia manifest.
4. **Local Graph Node stack fix completed:** Postgres locale initialization and host IPFS API port
   exposure are configured in the local compose file.
5. **Seed harness gap:** chain `31338` needs explicit playground recognition or a `--local` mode.
6. **Feature 1 seed gap:** a dedicated shortfall fixture is still needed.
7. **Relayer setup gap:** a gated KPI must receive `setKpiConfig` before relay verification.
8. **Frontend gap:** chain `31338` needs named wagmi and app-chain registration.
9. **Subgraph coverage gap:** the local manifest currently mirrors the existing event coverage; Feature
   1 assertions should also index `Extended` and `PoolIncreased` when those events are part of the
   finalized contract surface.
10. **Generated artifact hygiene:** `web/src/lib/deployments.ts` now includes the diagnostic `31338`
    entry and should remain clearly separated from production deployment selection.

## Conclusion

The isolated infrastructure path is proven: Anvil -> local Graph Node -> local IPFS -> local
subgraph -> GraphQL all works, and the seeded campaigns are queryable.

The Feature 1 business behavior is not yet proven. The next test should add a dedicated playground
seed that configures a gated KPI, nearly exhausts the campaign pool, triggers the extension/top-up
path, and then runs relay, indexer, contract assertions, and GraphQL checks against that fresh local
state.

## Gyndore Local Mock Run

The local mock seed was added at `script/SeedGyndoreLocal.s.sol` and run against the existing
isolated Anvil chain:

```bash
REGISTRY_ADDRESS=0x5FC8d32690cc91D4c39d9d3abcBD16989F875707 \
VAULT_ADDRESS=0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9 \
TOKEN_ADDRESS=0xA51c1fc2f0D1a1b8494Ed1FE312d7C3a78Ed91C0 \
forge script script/SeedGyndoreLocal.s.sol:SeedGyndoreLocal \
  --rpc-url http://127.0.0.1:8546 --broadcast
```

Result: PASS on chain `31338`.

```text
campaign:  0x1c8d7d133c0c4AC780Fc1a4f71913FB6625F7De5
initial pool: 6000 ether
planned top-up: 2000 ether
extended deadline: 1792691140
```

This was an append-only seed. It did not delete or replace the existing campaigns. The registry
count changed from five to six, and GraphQL returned the original five campaigns plus:

```text
Gyndore Feature 1 Local
0x1c8d7d133c0c4ac780fc1a4f71913fb6625f7de5
status 1
createdAtBlock 49
```

The mock has a 6,000-token pool and two tiers totaling 8,000 tokens. It extends the campaign during
seeding to the maximum allowed deadline and joins the deterministic local promoter. It does not
fabricate a direct `reportUserAction` call: production reports must pass through the deployed
`OracleCoordinator` and its four-minute dispute window. A report/apply step is still required to
create the on-chain shortfall in this live fixture.

Focused contract verification completed separately:

```text
5 passed, 0 failed
```

The passing tests cover successful extension, extension ceiling rejection, ended-campaign rejection,
top-up-before-depletion rejection, and top-up repayment of a recorded shortfall.

The seed was then expanded to run the same sequence against live Anvil state, using the project as
the authorized campaign reporter:

```text
Campaign: 0x7fc1375aA5d360Ca90cc443B5c3d3919aA8B9208
Report before extension: cumulative user total 10
Extension: successful
Report after extension: cumulative user total 20
Pool before top-up: 6000 ether
Top-up: 2000 ether
Final promoter progress: 20
Final paidOut: 8000 ether
Final rewardPool: 8000 ether
Final shortfall: 0
```

Graph Node remained healthy through block 66 and indexed the live campaign as
`Gyndore Feature 1 Live`. This verifies user-action reporting on both sides of extension and the
post-exhaustion top-up/shortfall claim on the isolated Anvil chain. The project-authorized report path
was used intentionally; a separate relayer/coordinator run would additionally exercise the
four-minute optimistic report dispute window.

The insufficient-funding case is covered by
`test_TopUp_rejectsAmountBelowRecordedShortfall`: with a recorded shortfall of `2,000 ether`, a
`1,500 ether` top-up reverts with `ShortfallUnfunded(1500 ether, 2000 ether)`. The attempted amount
also satisfies the 20% minimum top-up rule, so this proves the shortfall-coverage guard rather than
the earlier minimum-amount guard.
