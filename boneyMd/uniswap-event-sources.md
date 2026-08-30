# Uniswap as a Boneyard event source

Uniswap has both **V3** and **V4** deployed to **Base Sepolia (84532)** — the same chain as the
Boneyard demo fixture — so its events can back an event-source KPI directly, with no bridge and no
second RPC. The short version: **V3 works and V4 does not**, for a reason that is structural rather
than incidental.

Addresses came from Uniswap's published Base Sepolia deployment and were each confirmed by reading
code size and identity calls on chain. Every proposal below was then run through **the app's own
`probeEventSource`** (`web/src/lib/kpiSource.ts`), so each is judged by the same code the create form
uses. Probe figures are from a run on **2026-08-30**; they move as the chain does, because the probe
reads the last ~1,900 blocks rather than all history.

The repo already ships one Uniswap KPI fixture — `script/SeedSwapKpi.s.sol` and
`script/GateUniswapKpi.s.sol` — so parts of this were verified earlier. Where this doc and those
scripts differ, it is noted.

## Contracts

| Role | Address | Notes |
| --- | --- | --- |
| V3 Factory | `0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24` | 24,535 B; owner `0xA9ed4bb8…318C` |
| V3 SwapRouter02 | `0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4` | Emits nothing itself — swaps surface on the pool |
| V3 NonfungiblePositionManager | `0x27F971cb582BF9E50F397e4d29a5C7A34f11faA2` | `UNI-V3-POS` |
| V3 QuoterV2 | `0xC5290058841028F1614F3A6F0F5816cAd0df5E27` | View-only, no events |
| V3 TickLens | `0xEDF6066A2b290c185783862c7f4869A2cD41E2Cd` | **No code at this address** — not deployed on Base Sepolia despite being listed |
| UniversalRouter (V3 era) | `0x050E797f3625EC8785265e1d9BDd4799b97528A1` | 17,958 B |
| UniversalRouter (V4 era) | `0x492E6456D9528771018DeB9E87ef7750EF184104` | 19,540 B; also appears as a swap sender on V3 pools |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | |
| V4 PoolManager | `0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408` | 24,009 B; owner `0x5b73C549…0519` |
| V4 PositionManager | `0x4B2C77d209D3405F41a037Ec6c77F7F5b8e2ca80` | `UNI-V4-POSM` |
| V4 StateView | `0x571291b572ed32ce6751a2Cb2486EbEe8DEfB9B4` | View-only |
| V4 Quoter | `0x4A6513c898fe1B2d0E78d3b0e0A4a151589B1cBa` | View-only |

### Tokens

| Token | Address | Decimals |
| --- | --- | --- |
| WETH | `0x4200000000000000000000000000000000000006` | 18 |
| USDC (Circle test) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | 6 |

### V3 pools

All four WETH/USDC fee tiers exist, from `factory.getPool(WETH, USDC, fee)`. `token0` is USDC in
every one, so `amount0` in a `Swap` is the USDC leg.

| Fee | Address | Liquidity |
| --- | --- | --- |
| 100 | `0x57183717A087d2fe3Ad890873877244c3B96156c` | 728,500,562,969 |
| 500 | `0x94bfc0574FF48E92cE43d495376C477B1d0EEeC0` | 448,098,251,397 |
| 3000 | `0x46880b404CD35c165EDdefF7421019F8dD25F4Ad` | 489,704,413,976,689 |
| 10000 | `0x4664755562152EDDa3a3073850FB62835451926a` | 57,734,017,049 |

The 0.3% pool holds three orders of magnitude more liquidity than the others and carries nearly all
the traffic, so it is the one to point a KPI at.

A swap is credited from the **pool** that carries it, so one KPI covers one pair and one fee tier.

## Usable KPIs

`actor` is the topic index the crediting address is read from; `amount` is `count` (one unit per
matching log) or `dataWord0` (the first non-indexed word, divided by `scale`).

| KPI | Event | On | actor | amount | scale | filter | Probe (2026-08-30) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Swap on WETH/USDC 0.3% | `Swap(address,address,int256,int256,uint160,uint128,int24)` | pool `0x46880b40…F4Ad` | T2 | `count` | 1 | T1 = SwapRouter02 | ok — 4/4 match |
| Swap on 0.3%, any route | same | same pool | T2 | `count` | 1 | — | ok |
| Swap on WETH/USDC 0.05% | same | pool `0x94bfc057…EeC0` | T2 | `count` | 1 | T1 = SwapRouter02 | ok — 1 of the last 3 match |
| USDC out of the 0.3% pool | `Transfer(address,address,uint256)` | USDC | T2 | `dataWord0` | 1e3 | T1 = the pool | ok — 8 of the last 4,889 match, last reads 500,000 |
| Provide liquidity, V3 | `Transfer(address,address,uint256)` | NFPM | T2 | `count` | 1 | T1 = `0x0` | ok — 2/2 match |
| Provide liquidity, V4 | `Transfer(address,address,uint256)` | V4 PositionManager | T2 | `count` | 1 | T1 = `0x0` | warn — idle, none in the last 1,900 blocks |
| Wrap ETH *(adjacent)* | `Deposit(address,uint256)` | WETH | T1 | `dataWord0` | 1e18 | — | ok — last log reads 0.00004 WETH |

A `warn` is not a rejection: the shape is valid and the source is simply idle over the probe's
window. V4 liquidity on this testnet is minted rarely; over 49,000 blocks the V4 PositionManager
minted 32 positions against the NFPM's 21, so both are live, just sparse.

**`Swap` is `count`, never volume.** `amount0` is a signed `int256` and is negative on one side of
every swap — see the first trap. Volume has to come from the token leg instead.

**Which swap KPI to pick.** Over 49,000 blocks the 0.3% pool carried 26 swaps: 21 sent by
SwapRouter02, 2 by the V4-era UniversalRouter, and 3 by `0x09AD820a…4Afa` (an unidentified 7,570 B
contract). Pinning `filterTopic 1 = SwapRouter02` makes the KPI "a swap through the canonical V3
router" and silently excludes the other five. Dropping the filter makes it "a swap on this pool
however you got there", which is closer to what a project usually means. `SeedSwapKpi.s.sol` takes
the unfiltered form.

**The volume KPI's honest cost.** `SeedSwapKpi` reads USDC `Transfer` with **no** filter, so *any*
USDC a referral receives counts — including a transfer from a friend. Pinning `filterTopic 1` to the
pool tightens that to "USDC this pool paid out", which over the same window is 43 logs against 26
swaps: the excess is fee collections and position burns, which also pay USDC out of the pool. That
is a real tightening and still not exactly "swap volume". The WETH leg cannot substitute — see the
third trap.

### Rejected shapes, and why

| Event | Why it cannot back a per-user KPI |
| --- | --- |
| V3 `Swap` with `dataWord0` | `amount0` is a signed `int256`. The probe reads `1.157e77` from the last log. |
| **V4 `Swap` on the PoolManager** | `topics[1]` is a `bytes32` PoolId and `topics[2]` is the calling router. No end-user address appears in the log at all. Over 2,000 blocks it carried 261 swaps from **3 distinct senders**, one of them the UniversalRouter. |
| V4 `ModifyLiquidity` | Same shape problem: `topics[1]` is a PoolId, `topics[2]` was one contract for all 2,255 logs. |
| NFPM `IncreaseLiquidity` / `DecreaseLiquidity` / `Collect` | `topics[1]` is a `tokenId`, not an address. The real recipient of `Collect` sits in data word 0, where only an amount can be read. |
| V3 pool `Mint` / `Burn` / `Collect` | The owner is the position manager, not the user; topics 2 and 3 are `int24` ticks. |
| V3 pool `Flash` | Zero logs in 49,000 blocks, and the actor is an integrator contract. |
| `SwapRouter02` itself | Emits no events — everything observable happens on the pool. |
| Factory `PoolCreated` | Creating a pool is not a user action worth paying for, and both token topics are assets. |
| Permit2 `Approval` / `Permit` | `topics[1]` is the owner, so the shape works — but an approval costs nothing and moves no value, so it is free to farm. |
| `QuoterV2` / `StateView` / V4 `Quoter` | View-only. |

## Three traps

**Pool `Swap.dataWord0` is a signed `int256`.** `amount0` is negative on one side of every swap, so
`dataWord0` mode reads the two's-complement word and credits roughly `1.157e77` units. Use `count`
for swaps, or read the token's own `Transfer` for volume.

**V4 is unattributable per user, and it is not a bug.** V4 collapses every pool into one singleton
`PoolManager`, so its `Swap` identifies the *pool* by hash and the *caller* by address, and the
caller is always a router. The end user's address is never in the log — it exists only in the
router's calldata. An event-source KPI reads topics, so there is nothing for it to read. V4 activity
can only be credited through the V4 PositionManager's ERC-721 `Transfer`, which does name the owner.

**A routed swap does not wrap the user's ETH.** `PeripheryPayments.pay` spends the router's own
stranded ETH balance before touching the caller's, so a swap that looks like "ETH in" often produces
a WETH `Deposit` crediting the *router*, not the user — verified on tx
`0x3a406382d9811276cfe6cd5132da8cf4f7d7d2b45d7a004bde12da9720e43f91`. The `Wrap ETH` KPI above is
therefore listed as adjacent, not as a Uniswap KPI: it credits a user only when they wrap ETH
themselves.

One more thing worth knowing rather than a trap: of the 13 distinct swap recipients on the 0.3% pool,
the sampled ones are all **contracts** — `0x398B2F3B…4677` and `0x15Fd0484…9630` are 45-byte minimal
proxies, i.e. smart accounts. The KPI credits whatever address sits in the topic, which is the smart
account, not any EOA behind it. A promoter's referral must therefore be the smart account address for
the credit to land.

## Encoded `KpiSpec.params`

The create form builds these from the KPI editor — this appendix exists so a value can be checked or
pasted directly. Word order is `(address source, bytes32 topic0, uint8 actorTopic, uint8 amountMode,
uint256 scale)` for 160 bytes, plus `(uint8 filterTopic, bytes32 filterValue)` for 224. Length is
what distinguishes the layouts: 32 B is a `TouchWindowVerifier` lookback, not an event source.

`topic0` for every signature used above:

| Signature | topic0 |
| --- | --- |
| `Swap(address,address,int256,int256,uint160,uint128,int24)` | `0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67` |
| `Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)` | `0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f` |
| `Transfer(address,address,uint256)` | `0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef` |
| `Deposit(address,uint256)` | `0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c` |
| `IncreaseLiquidity(uint256,uint128,uint256,uint256)` | `0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f` |
| `DecreaseLiquidity(uint256,uint128,uint256,uint256)` | `0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4` |
| `Collect(uint256,address,uint256,uint256)` | `0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01` |
| `Mint(address,address,int24,int24,uint128,uint256,uint256)` | `0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde` |
| `ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)` | `0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec` |
| `PoolCreated(address,address,uint24,int24,address)` | `0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118` |
| `Approval(address,address,address,uint160,uint48)` | `0xda9fa7c1b00402c17d0161b249b1ab8bbec047c5a52207b9c112deffd817036b` |

Each block below is one 32-byte word per line; concatenate without whitespace to get the value.

**Swap on WETH/USDC 0.3% through SwapRouter02** — 224 bytes

```
0x00000000000000000000000046880b404cd35c165eddeff7421019f8dd25f4ad
  c42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67
  0000000000000000000000000000000000000000000000000000000000000002
  0000000000000000000000000000000000000000000000000000000000000000
  0000000000000000000000000000000000000000000000000000000000000001
  0000000000000000000000000000000000000000000000000000000000000001
  00000000000000000000000094cc0aac535ccdb3c01d6787d6413c739ae12bc4
```

**Swap on WETH/USDC 0.3%, any route** — 160 bytes, the first five words above. This is the form
`SeedSwapKpi.s.sol` writes.

**Swap on WETH/USDC 0.05% through SwapRouter02** — 224 bytes, the filtered block with source
`00000000000000000000000094bfc0574ff48e92ce43d495376c477b1d0eeec0`

**USDC out of the 0.3% pool** — 224 bytes

```
0x000000000000000000000000036cbd53842c5426634e7929541ec2318f3dcf7e
  ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef
  0000000000000000000000000000000000000000000000000000000000000002
  0000000000000000000000000000000000000000000000000000000000000001
  00000000000000000000000000000000000000000000000000000000000003e8
  0000000000000000000000000000000000000000000000000000000000000001
  00000000000000000000000046880b404cd35c165eddeff7421019f8dd25f4ad
```

`SeedSwapKpi.s.sol` writes the 160-byte unfiltered version of this with scale `1e5`; `1e3` above is
the figure that produces non-zero progress at the volumes this testnet actually sees.

**Provide liquidity, V3 (LP NFT minted)** — 224 bytes

```
0x00000000000000000000000027f971cb582bf9e50f397e4d29a5c7a34f11faa2
  ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef
  0000000000000000000000000000000000000000000000000000000000000002
  0000000000000000000000000000000000000000000000000000000000000000
  0000000000000000000000000000000000000000000000000000000000000001
  0000000000000000000000000000000000000000000000000000000000000001
  0000000000000000000000000000000000000000000000000000000000000000
```

**Provide liquidity, V4 (position minted)** — 224 bytes, the same but with source
`0000000000000000000000004b2c77d209d3405f41a037ec6c77f7f5b8e2ca80`

**Wrap ETH** — 160 bytes

```
0x0000000000000000000000004200000000000000000000000000000000000006
  e1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c
  0000000000000000000000000000000000000000000000000000000000000001
  0000000000000000000000000000000000000000000000000000000000000001
  0000000000000000000000000000000000000000000000000de0b6b3a7640000
```

## Reproducing this

`web/scripts/__uni-kpis.mts` runs each proposal above through `probeEventSource` and prints the
encoded params word by word alongside the findings. It takes `BASE_SEPOLIA_RPC` and defaults to
`https://base-sepolia-rpc.publicnode.com`, because `sepolia.base.org` returns 502 on roughly one call
in three.

```
cd web && pnpm tsx scripts/__uni-kpis.mts
```

The log counts and topic layouts quoted above came from a wider scan over 49,000 blocks
(46092235..46141235). Publicnode caps `eth_getLogs` at 50,000 blocks and also caps response size, so
the two busiest sources — USDC `Transfer` and the V4 PoolManager's `Swap` — need a window nearer
2,000 blocks. The probe itself reads 1,900 and is unaffected.
