# Feature 1 Anvil End-to-End Report

Date: 2026-09-07

## Scope

Tested the updated contract, deployment, seed, generated artifacts, relayer, indexer, frontend, and
subgraph path against an isolated Anvil chain:

- RPC: `http://127.0.0.1:8546`
- Chain ID: `31338`
- Anvil mode: `--disable-code-size-limit` for diagnostic integration testing only
- Frontend target: port `3002`

The hosted Base Sepolia registry was not touched.

## Summary

| Area                                          | Result                                                                |
| --------------------------------------------- | --------------------------------------------------------------------- |
| Anvil startup                                 | PASS                                                                  |
| Standard deployment with EIP-170 limit        | BLOCKED                                                               |
| Diagnostic deployment with size override      | PASS                                                                  |
| Existing`SeedLocal` Solidity script         | PASS with explicit addresses                                          |
| `pnpm seed --rpc ... --skip-deploy` harness | FAIL: wrong deployer/funding assumptions                              |
| Deployment artifact generation                | PASS                                                                  |
| ABI generation                                | PASS                                                                  |
| Indexer dry-run                               | PASS: 0 reports                                                       |
| Relayer dry-run                               | FAIL: seeded KPI is not verifier-configured                           |
| Frontend process on`3002`                   | STARTED                                                               |
| Frontend routes on chain`31338`             | FAIL: only`/` returned `200`; dynamic/app routes returned `404` |
| Existing subgraph build                       | PASS                                                                  |
| Local Graph Node                              | NOT RUN: Docker is unavailable                                        |
| Feature 1 end-to-end behavior                 | NOT COMPLETED                                                         |

## Deployment

### Standard deployment

Command:

```bash
PRIVATE_KEY=... BONEY_INITIAL_ATTESTOR=... forge script \
  script/DeployBoney.s.sol:DeployBoney \
  --rpc-url http://127.0.0.1:8546 --broadcast
```

Result: blocked by EIP-170:

```text
`Unknown5` is above the contract size limit (26014 > 24576).
```

The deployment script then prompted for confirmation. `n` was supplied, so no invalid deployment was
accepted. This is a real production blocker: the updated facade bytecode is 26,014 bytes, above the
24,576-byte EVM contract size limit.

### Diagnostic deployment

Anvil was restarted with `--disable-code-size-limit`, and Forge was run with
`--code-size-limit 30000`. Deployment succeeded on chain `31338`.

Key addresses:

```text
Boney                  0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6
CampaignRegistry       0x5FC8d32690cc91D4c39d9d3abcBD16989F875707
EscrowVault            0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9
AttributionRegistry    0x5FbDB2315678afecb367f032d93F642f64180aa3
ReputationRegistry     0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0
OracleCoordinator      0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9
EventMetricVerifier    0x8A791620dd6260079BF849Dc5567aDC3F2FdC318
GuardedVerifier        0x610178dA211FEF7D417bC0e6FeD39F05609AD788
```

The size override is suitable for diagnosis only. It does not prove the contracts are deployable on
Base Sepolia or another production EVM.

## Seeding

The existing `SeedLocal.s.sol` script succeeded when run directly with explicit playground module
addresses and deterministic Anvil keys. It created four campaigns and a seed token:

```text
Token                 0xA51c1fc2f0D1a1b8494Ed1FE312d7C3a78Ed91C0
Active with progress  0x61c36a8d610163660E21a8b7359e1Cac0C9133e1
Active empty          0x23dB4a08f2272df049a4932a4Cc3A6Dc1002B33E
Ended                 0x6743E5c6E1B453372507E8dfD6CA53508721425B
Multi-KPI             0xA14d9C7a916Db01cCA55ec21Be1F7665C326928F
```

The existing one-command TypeScript harness did not work:

```bash
pnpm seed --rpc http://127.0.0.1:8546 --skip-deploy
```

It detected chain `31338` but treated it as a non-Anvil chain, derived the deployer from the repo
`.env`, and tried to fund a promoter from an unfunded account. It failed with:

```text
Insufficient funds for gas * price + value
```

`seed-local.ts` currently recognises only chain `31337` as Anvil. Playground mode must recognise
`31338` or accept an explicit `--local` flag and use the deterministic Anvil keys.

The generic `SeedLocal` fixture does not create the intended Feature 1 state of a nearly exhausted
pool with an owed shortfall. A dedicated Feature 1 playground seed is still required.

## Generated artifacts

Both pipelines succeeded:

```bash
pnpm deployments 31338
pnpm abis
```

The deployment generator added a `31338` entry to `web/src/lib/deployments.ts`, using the fresh
broadcast receipt. The ABI generator produced the updated Campaign ABI.

This generated-file change is a test side effect and should be handled deliberately before merging;
the production deployment map must not accidentally select the diagnostic chain.

## Indexer

Command:

```bash
pnpm index --rpc http://127.0.0.1:8546 \
  --campaign 0x61c36a8d610163660E21a8b7359e1Cac0C9133e1 --dry-run
```

Result: PASS.

```text
Chain 31338 at http://127.0.0.1:8546
0 report(s) sent, 0 skipped.
```

The indexer accepts the playground RPC and campaign override. The seeded campaign had no new
creditable activity for this dry run, so this validates wiring, not a payout/report transition.

## Relayer

Command:

```bash
pnpm relay --campaign 0x61c36a8d610163660E21a8b7359e1Cac0C9133e1 \
  --kpi 0 --rpc http://127.0.0.1:8546 --dry-run
```

Result: FAIL as expected for the current seed.

```text
KPI 0 ... is not configured on EventMetricKpiVerifier.
Run setKpiConfig first.
```

The relayer resolved chain `31338` and the correct playground verifier address. It needs an explicit
KPI configuration step before it can observe a gated playground campaign. A playground seed should
configure at least one KPI with `setKpiConfig`, or the test should use an ungated KPI and document
that the relayer is intentionally not involved.

## Frontend

Started directly, bypassing the Base Sepolia-specific `dev-up.sh` orchestration:

```bash
NEXT_PUBLIC_DEFAULT_CHAIN_ID=31338 PORT=3002 pnpm dev
```

The Next server started successfully on port `3002`.

HTTP results:

```text
/          200
/campaign/0 404
/my        404
/create    404
```

The deployment mapping contains chain `31338`, but the app's supported wagmi chain configuration does
not yet register a 31338 chain. The default-chain environment variable alone is insufficient. Add a
named local/playground chain to the wagmi configuration and chain helpers before the frontend can use
this deployment.

## Subgraph

The existing Base Sepolia subgraph build passed:

```bash
cd subgraph && pnpm build
```

That does not validate the playground. The manifest is still hardcoded to:

- `network: base-sepolia`
- Base Sepolia module addresses
- Base Sepolia deployment start blocks

A local manifest using `network: localhost`, playground addresses, and the playground deployment block
is required. It should also index `Extended` and `PoolIncreased` before Feature 1 subgraph assertions
are meaningful.

Local Graph Node was not started because Docker is not installed in the environment:

```text
Command 'docker' not found
```

A setup retry was attempted. No container runtime (`docker`, `podman`, or `nerdctl`) is installed,
and non-interactive `sudo` is unavailable in this session, so installation could not be performed
without user-provided elevated access. The Graph Node result remains **not run**.

## Findings and required fixes

1. **Production blocker: Boney exceeds EIP-170 by 1,438 bytes.** Reduce the facade bytecode or split/remove facade functionality before a real redeploy.
2. **Playground harness does not recognise chain 31338.** Add explicit playground/local mode to `seed-local.ts`.
3. **Generic seed does not produce Feature 1 shortfall state.** Add a dedicated Feature 1 seed script.
4. **Relayer requires KPI configuration.** Configure the EventMetric verifier in the playground seed or provide a dedicated setup script.
5. **Frontend lacks a 31338 wagmi chain.** Add a named local playground chain and wire it into `SUPPORTED_CHAINS`, wagmi, RPC resolution, and deployment selection.
6. **`dev-up.sh` is Base Sepolia-specific.** Add playground orchestration or use a documented direct `pnpm dev` command.
7. **Subgraph manifest is Base Sepolia-specific.** Add a separate local manifest and local Graph Node stack.
8. **No local Graph Node test was possible.** Install Docker or provide an existing Postgres/IPFS/Graph Node stack.
9. **Generated deployment state now includes diagnostic chain 31338.** Decide whether to keep it as an explicit playground entry or remove it through the generator after isolating playground artifacts.
10. **Container setup remains an environment prerequisite.** Install Docker or provide a rootless Graph Node stack before retrying the subgraph integration.

## Conclusion

The relayer CLI, indexer CLI, deployment generator, ABI generator, and Solidity seed logic can operate
against Anvil with explicit overrides. The complete end-to-end playground does not yet work as one
command. The first fix should be the EIP-170 contract-size failure; the second should be a dedicated
playground mode that owns chain configuration, seeding, verifier setup, frontend chain registration,
and a local subgraph manifest.
