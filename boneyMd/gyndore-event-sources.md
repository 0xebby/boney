# Gyndore as a Boneyard event source

Gyndore (`https://testnet.gyndore.com/`) is a Uniswap V3 fork with its own staking and bonding
contracts, deployed to **Base Sepolia (84532)** — the same chain as the Boneyard demo fixture. Its
events can therefore back an event-source KPI directly, with no bridge and no second RPC.

Addresses came from the app's own JS bundles and were confirmed against Blockscout's verified
sources. Every proposal below was then run through **the app's own `probeEventSource`**
(`web/src/lib/kpiSource.ts`), so each is judged by the same code the create form uses. Probe figures
are from a run on **2026-08-29**; they move as the chain does, because the probe reads the last
~1,900 blocks rather than all history.

## Contracts

| Role | Address | Notes |
| --- | --- | --- |
| Bonding | `0x903ADC267e9DDe7bF7be8C442e779A2b9e70F78E` | `Bonding`, verified |
| Staking | `0x5c0E023Ce4A353e5Cd9a43E28D2879Cb9e876865` | `GyndStaking`, verified |
| Faucet | `0x14b3248f2e1bd1190C9b3b5F7D2eFc68700533d6` | `TestnetFaucetV4` |
| SwapRouter | `0xC7dbf300B6aEA3CFE1730f1C692C606b17B514a6` | Emits nothing itself — swaps surface on the pool |
| NonfungiblePositionManager | `0x76998e42B789d81004f006402b6c62a8BDCAfD5b` | `UNI-V3-POS` |
| Factory | `0x056F97bF0D734EDB887ee322dD461de09BBFC20e` | |
| QuoterV2 | `0xf71d40Cb00677c7478c038700a7C11F34e33eA1e` | View-only, no events |

### Tokens

| Token | Address | Decimals | Stakeable |
| --- | --- | --- | --- |
| GYND | `0x0d442EC7BdDB06b531DCA3Dd39ABaFf554170776` | 18 | yes |
| bGYND | `0x235521110E4761fE2734d5c5F6c1b54ac897D9bF` | 18 | yes |
| cbBTC (mock) | `0xD385d2Da758027a7a7D9a06139c6c53B2a8c284C` | 8 | no |
| USDC (mock) | `0xc367d3465Fd8785bD2CdE1e295d15c5B63C61cFa` | 6 | no — the staking reward token |

### Pools

| Pair | Fee | Address |
| --- | --- | --- |
| GYND / USDC | 3000 | `0xA13896Ac7A64180087616BB7168d5040f4D5dad2` |
| GYND / cbBTC | 10000 | `0x7B47daC59075aF44046795BA347EC872D5409263` |
| cbBTC / USDC | 500 | `0xc44eE87cF25c36be9a5577620067C8Aa63Dd578F` |
| WETH / USDC | 500 | `0xDfD78fe126273CF2fd56A24e6e2a714806037c97` |
| cbBTC / WETH | 3000 | `0x0d1644D467A966BCc82D3eEC7Cdf73eC61CCE1FB` |

A swap is credited from the **pool** that carries it, so one KPI covers one pair. Pinning the
router in `filterTopic` 1 is what makes it "a swap on Gyndore" rather than "a swap by anyone using
this pool".

## Usable KPIs

`actor` is the topic index the crediting address is read from; `amount` is `count` (one unit per
matching log) or `dataWord0` (the first non-indexed word, divided by `scale`).

| KPI | Event | On | actor | amount | scale | filter | Probe (2026-08-29) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Stake GYND | `Staked(address,address,uint256)` | staking | T1 | `dataWord0` | 1e18 | T2 = GYND | ok — 4/4 match, last log reads 23 GYND |
| Stake bGYND | `Staked(address,address,uint256)` | staking | T1 | `dataWord0` | 1e18 | T2 = bGYND | warn — valid but 0 of 4 recent stakes were bGYND |
| Stake anything | `Staked(address,address,uint256)` | staking | T1 | `count` | 1 | — | ok |
| Claim staking rewards | `RewardPaid(address,uint256)` | staking | T1 | `dataWord0` | 1e6 | — | ok — last log reads 6.673231 USDC |
| Bond GYND | `Bonded(address,uint256,uint256,uint256,uint256)` | bonding | T1 | `dataWord0` | 1e18 | — | ok — last log reads 50 GYND |
| Claim a matured bond | `Claimed(address,uint256)` | bonding | T1 | `dataWord0` | 1e18 | — | warn — idle, none in the last 1,900 blocks |
| Provide liquidity | `Transfer(address,address,uint256)` | position manager | T2 | `count` | 1 | T1 = `0x0` | ok — 1906/1906 match |
| Swap on cbBTC/USDC | `Swap(address,address,int256,int256,uint160,uint128,int24)` | pool `0xc44eE87c…578F` | T2 | `count` | 1 | T1 = router | ok — 402/402 match |
| Swap on GYND/cbBTC | `Swap(address,address,int256,int256,uint160,uint128,int24)` | pool `0x7B47daC5…9263` | T2 | `count` | 1 | T1 = router | ok — 46/46 match |
| Faucet claim | `AssetsMinted(address,address,uint256)` | faucet | T1 | `count` | 1 | — | ok, but free to farm — onboarding only |

A `warn` is not a rejection: the shape is valid and the source is simply idle over the probe's
window. `Claim a matured bond` in particular only fires after the bond cooldown, so an idle reading
is the expected state on a young testnet.

### Rejected shapes, and why

| Event | Why it cannot back a per-user KPI |
| --- | --- |
| NFPM `IncreaseLiquidity` / `DecreaseLiquidity` / `Collect` | Topic 1 is a `tokenId`, not an address. Crediting it would credit a number cast to an address. |
| Pool `Mint` / `Collect` | The owner is the position manager, not the user; topics 2 and 3 are `int24` ticks. |
| `SwapRouter` itself | Emits no events — everything observable happens on the pool. |
| `QuoterV2` | View-only. |

## Two traps

**Pool `Swap.dataWord0` is a signed `int256`.** `amount0` is negative on one side of every swap, so
`dataWord0` mode would read the two's-complement word and credit roughly `1.157e77` units. Use
`count` for swaps, or add a signed mode before using volume.

**The probe reported `IncreaseLiquidity` as `ok`.** It passes `actorShapeFindings`' address test only
because the sampled `tokenId` (`0x21A85`) is small enough to have zero high bytes, so it looks like a
20-byte address. A large `tokenId` would fail the same test. The probe's `ok` is evidence, not proof —
read the event's own parameter types before trusting an actor topic.

## Encoded `KpiSpec.params`

The create form builds these from the KPI editor — this appendix exists so a value can be checked or
pasted directly. Word order is `(address source, bytes32 topic0, uint8 actorTopic, uint8 amountMode,
uint256 scale)` for 160 bytes, plus `(uint8 filterTopic, bytes32 filterValue)` for 224. Length is
what distinguishes the layouts: 32 B is a `TouchWindowVerifier` lookback, not an event source.

`topic0` for every signature used above:

| Signature | topic0 |
| --- | --- |
| `Staked(address,address,uint256)` | `0x5dac0c1b1112564a045ba943c9d50270893e8e826c49be8e7073adc713ab7bd7` |
| `RewardPaid(address,uint256)` | `0xe2403640ba68fed3a2f88b7557551d1993f84b99bb10ff833f0cf8db0c5e0486` |
| `Bonded(address,uint256,uint256,uint256,uint256)` | `0x2fa887dbaa2b6b55971fc4d2686b753756c04fd71bbd0534954807d55a1f5ada` |
| `Claimed(address,uint256)` | `0xd8138f8a3f377c5259ca548e70e4c2de94f129f5a11036a15b69513cba2b426a` |
| `Transfer(address,address,uint256)` | `0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef` |
| `Swap(address,address,int256,int256,uint160,uint128,int24)` | `0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67` |
| `AssetsMinted(address,address,uint256)` | `0xd361b0ed3071fc5924cc1a7e8bb3795cebeceeed58cf0ce2c1763489ecff5aaf` |

Each block below is one 32-byte word per line; concatenate without whitespace to get the value.

**Stake GYND** — 224 bytes

```
0x0000000000000000000000005c0e023ce4a353e5cd9a43e28d2879cb9e876865
  5dac0c1b1112564a045ba943c9d50270893e8e826c49be8e7073adc713ab7bd7
  0000000000000000000000000000000000000000000000000000000000000001
  0000000000000000000000000000000000000000000000000000000000000001
  0000000000000000000000000000000000000000000000000de0b6b3a7640000
  0000000000000000000000000000000000000000000000000000000000000002
  0000000000000000000000000d442ec7bddb06b531dca3dd39abaff554170776
```

**Stake bGYND** — 224 bytes, identical but for the final word:
`000000000000000000000000235521110e4761fe2734d5c5f6c1b54ac897d9bf`

**Stake anything (count)** — 160 bytes

```
0x0000000000000000000000005c0e023ce4a353e5cd9a43e28d2879cb9e876865
  5dac0c1b1112564a045ba943c9d50270893e8e826c49be8e7073adc713ab7bd7
  0000000000000000000000000000000000000000000000000000000000000001
  0000000000000000000000000000000000000000000000000000000000000000
  0000000000000000000000000000000000000000000000000000000000000001
```

**Claim staking rewards** — 160 bytes

```
0x0000000000000000000000005c0e023ce4a353e5cd9a43e28d2879cb9e876865
  e2403640ba68fed3a2f88b7557551d1993f84b99bb10ff833f0cf8db0c5e0486
  0000000000000000000000000000000000000000000000000000000000000001
  0000000000000000000000000000000000000000000000000000000000000001
  00000000000000000000000000000000000000000000000000000000000f4240
```

**Bond GYND** — 160 bytes

```
0x000000000000000000000000903adc267e9dde7bf7be8c442e779a2b9e70f78e
  2fa887dbaa2b6b55971fc4d2686b753756c04fd71bbd0534954807d55a1f5ada
  0000000000000000000000000000000000000000000000000000000000000001
  0000000000000000000000000000000000000000000000000000000000000001
  0000000000000000000000000000000000000000000000000de0b6b3a7640000
```

**Claim a matured bond** — 160 bytes, the same but with topic0
`d8138f8a3f377c5259ca548e70e4c2de94f129f5a11036a15b69513cba2b426a`

**Provide liquidity (LP NFT minted)** — 224 bytes

```
0x00000000000000000000000076998e42b789d81004f006402b6c62a8bdcafd5b
  ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef
  0000000000000000000000000000000000000000000000000000000000000002
  0000000000000000000000000000000000000000000000000000000000000000
  0000000000000000000000000000000000000000000000000000000000000001
  0000000000000000000000000000000000000000000000000000000000000001
  0000000000000000000000000000000000000000000000000000000000000000
```

**Swap on cbBTC/USDC** — 224 bytes

```
0x000000000000000000000000c44ee87cf25c36be9a5577620067c8aa63dd578f
  c42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67
  0000000000000000000000000000000000000000000000000000000000000002
  0000000000000000000000000000000000000000000000000000000000000000
  0000000000000000000000000000000000000000000000000000000000000001
  0000000000000000000000000000000000000000000000000000000000000001
  000000000000000000000000c7dbf300b6aea3cfe1730f1c692c606b17b514a6
```

**Swap on GYND/cbBTC** — 224 bytes, the same but with source
`0000000000000000000000007b47dac59075af44046795ba347ec872d5409263`

**Faucet claim** — 160 bytes

```
0x00000000000000000000000014b3248f2e1bd1190c9b3b5f7d2efc68700533d6
  d361b0ed3071fc5924cc1a7e8bb3795cebeceeed58cf0ce2c1763489ecff5aaf
  0000000000000000000000000000000000000000000000000000000000000001
  0000000000000000000000000000000000000000000000000000000000000000
  0000000000000000000000000000000000000000000000000000000000000001
```

## Reproducing this

`web/scripts/__gyn-probe.mjs` resolves the event catalogue from the deployment; `web/scripts/__gyn-kpis.mts`
runs each proposal above through `probeEventSource` and prints the encoded params alongside the findings.
Both take `BASE_SEPOLIA_RPC` and default to `https://base-sepolia-rpc.publicnode.com`, because
`sepolia.base.org` 502s about one call in three.
