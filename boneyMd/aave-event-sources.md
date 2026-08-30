# Aave V3 as a Boneyard event source

Aave V3 has a full testnet market on **Base Sepolia (84532)** — the same chain as the Boneyard demo
fixture — so its events can back an event-source KPI directly, with no bridge and no second RPC.
Unlike the Gyndore and Uniswap deployments, this one is a *lending* market: the interesting verbs are
supply, withdraw, borrow and repay rather than swap and provide-liquidity.

Addresses came from `PoolAddressesProvider` and `PoolDataProvider` on chain, not from a deployment
list. Every proposal below was then run through **the app's own `probeEventSource`**
(`web/src/lib/kpiSource.ts`), so each is judged by the same code the create form uses. Probe figures
are from a run on **2026-08-30**; they move as the chain does, because the probe reads the last
~1,900 blocks rather than all history.

## Contracts

| Role | Address | Notes |
| --- | --- | --- |
| Pool | `0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27` | Every usable KPI reads from here |
| PoolAddressesProvider | `0xE4C23309117Aa30342BFaae6c95c6478e0A4Ad00` | Resolves the rest |
| PoolDataProvider | `0xBc9f5b7E248451CdD7cA54e717a2BFe1F32b566b` | Reserve list, token triples |
| PoolConfigurator | `0x0Bf6bdFF4da24C272BC524d521Ab0db20601D384` | Admin only, no user events |
| PriceOracle | `0x943b0dE18d4abf4eF02A85912F8fc07684C141dF` | |
| ACLManager | `0x9f09F541Adf314341d8d45E5B18961147b9050E9` | |
| Faucet | `0xD9145b5F45Ad4519c7ACcD6E0A4A82e83bB8A6Dc` | `isPermissioned() == false` — anyone can mint test reserves |

### Reserves

Six reserves, all with `stableDebtToken == address(0)` (Aave 3.2 removed stable-rate borrowing).

| Token | Decimals | Underlying | aToken | Variable debt |
| --- | --- | --- | --- | --- |
| USDC | 6 | `0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f` | `0x10F1A9D11CDf50041f3f8cB7191CBE2f31750ACC` | `0xFB3e85601b7fEb3691bbb8779Ef0E1069E347204` |
| USDT | 6 | `0x0a215D8ba66387DCA84B284D18c3B4ec3de6E54a` | `0xcE3CAae5Ed17A7AafCEEbc897DE843fA6CC0c018` | `0xE3C742c88EE6A610157C16b60bBDD62351daeE39` |
| WBTC | 8 | `0x54114591963CF60EF3aA63bEfD6eC263D98145a4` | `0x47Db195BAf46898302C06c31bCF46c01C64ACcF9` | `0x638291B5Ccb9fEd339FdD351Eb086e607fCA9561` |
| WETH | 18 | `0x4200000000000000000000000000000000000006` | `0x73a5bB60b0B0fc35710DDc0ea9c407031E31Bdbb` | `0x562abf6562d6A2b165aDa02b5946bc3E7b4dD653` |
| cbETH | 18 | `0xD171b9694f7A2597Ed006D41f7509aaD4B485c4B` | `0x9Fd6d1DBAd7c052e0c43f46df36eEc6a68814B63` | `0xa1a483652b157FF006292CDb0e9EB7FFad2a5142` |
| LINK | 18 | `0x810D46F9a9027E28F9B01F75E2bdde839dA61115` | `0x0aD46dE765522399d7b25B438b230A894d72272B` | `0xBA42C6752F347e3c22DD0A4e5578dCB0137C1325` |

The WETH reserve on this market sits at its supply cap on a fork (`SupplyCapExceeded()`), so USDC is
the reserve to reach for when seeding a fixture.

Every Pool event carries the reserve in `topics[1]`, so one KPI covers one asset and dropping the
filter covers all six. That is the whole reason `filterTopic` exists here.

## Usable KPIs

`actor` is the topic index the crediting address is read from; `amount` is `count` (one unit per
matching log) or `dataWord0` (the first non-indexed word, divided by `scale`). Every KPI below reads
the Pool.

| KPI | Event | actor | amount | scale | filter | Probe (2026-08-30) |
| --- | --- | --- | --- | --- | --- | --- |
| Withdraw USDC | `Withdraw(address,address,address,uint256)` | T2 | `dataWord0` | 1e6 | T1 = USDC | ok — 2/2 match, last log reads 1,843 |
| Withdraw WETH | `Withdraw(address,address,address,uint256)` | T2 | `dataWord0` | 1e18 | T1 = WETH | warn — valid but none of the recent withdrawals were WETH |
| Repay USDC debt | `Repay(address,address,address,uint256,bool)` | T2 | `dataWord0` | 1e6 | T1 = USDC | ok — 3/3 match, last log reads 30,605 |
| Repay anything | `Repay(address,address,address,uint256,bool)` | T2 | `count` | 1 | — | ok |
| Supply USDC | `Supply(address,address,address,uint256,uint16)` | T2 | `count` | 1 | T1 = USDC | warn — idle, none in the last 1,900 blocks |
| Supply any reserve | `Supply(address,address,address,uint256,uint16)` | T2 | `count` | 1 | — | warn — idle |
| Borrow USDC | `Borrow(address,address,address,uint256,uint8,uint256,uint16)` | T2 | `count` | 1 | T1 = USDC | warn — idle |
| Enable USDC as collateral | `ReserveUsedAsCollateralEnabled(address,address)` | T2 | `count` | 1 | T1 = USDC | warn — idle |
| Set an eMode category | `UserEModeSet(address,uint8)` | T1 | `count` | 1 | — | warn — idle |

A `warn` is not a rejection: the shape is valid and the source is simply idle over the probe's
window. This market is quiet — over 49,000 blocks it carried 76 repayments, 10 withdrawals, 7
supplies and 6 borrows, and zero flash loans, liquidations, eMode changes or collateral-disables. A
`count` KPI on a rarer verb is honest but slow.

`Withdraw` and `Repay` are the only two verbs whose amount is directly readable, which is why they
are the only two proposed as volume. `Supply` and `Borrow` are `count`-only — see the second trap.

`Repay`'s `topics[2]` is the borrower whose debt shrank and `topics[3]` is whoever paid. Crediting
T2 means a promoter's referral is credited when their debt is repaid even if a third party paid it;
crediting T3 would credit the payer instead. T2 is the right choice for a "get your users out of
debt" campaign, T3 for "get your users repaying".

### Rejected shapes, and why

| Event | Why it cannot back a per-user KPI |
| --- | --- |
| `Supply` / `Borrow` as volume | `topics` hold reserve, `onBehalfOf` and the referral code; the first *non-indexed* word is the `user` **address**, and the amount is the second. `dataWord0` would credit an address cast to a number — roughly 8.7e47 units. |
| aToken `Mint` / `Burn` | The first data word is the residual after interest netting, not the deposit. See the first trap. |
| aToken `Transfer` | Same netting problem, and it also fires on plain aToken transfers between wallets, which move a receipt rather than doing anything on Aave. The probe passes this shape — it is rejected on what the number *means*, not on its layout. |
| aToken `BalanceTransfer` | Never fires on this market (0 logs in 49,000 blocks) and carries the scaled balance, not an amount. |
| `FlashLoan` | Never fires here, and `topics[1]` is the receiver contract — an integrator, not a user. |
| `LiquidationCall` | Never fires here, and crediting a liquidation would pay a promoter for their referral being liquidated. |
| `ReserveUsedAsCollateralDisabled` | Valid shape, but rewards turning collateral *off*. |
| PoolConfigurator events | Admin-only. |

## Three traps

**aToken amounts are netted against accrued interest.** At block 46139879 the Pool's `Withdraw`
reads `0x733` (1,843 units) while the matching aUSDC `Burn` reads `1` in its first data word and
`0x733` in its second, and the aUSDC `Transfer` to `address(0)` reads `1`. At block 46132680 an
aUSDC `Mint` fires with first word `1` and **no `Supply` in that block at all** — an interest-only
mint. Yet aWETH `Mint` at block 46096534 reads `0x71afd80f0b842` (~0.002 WETH), which does
approximate a deposit. That inconsistency is what makes the shape dangerous: it looks right in a
sample and is wrong in general. The Pool's own events carry the real figure.

**`Supply` and `Borrow` put an address where the amount should be.** Both are
`(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, …)`. Only three
of those are indexed, so `dataWord0` lands on `user` — a 20-byte address, read as a `uint256`. This
is the exact unit disagreement the verifier's own guard exists to catch, and it is why the
`SeedRealKpi` fixture uses `COUNT` for Aave.

**Amounts on this market are dust, and scale is unforgiving.** The largest recent repayment was
30,605 units — 0.030605 USDC. At the natural scale of `1e6` (one unit of progress per USDC) the
probe reports "0 units of progress", and a campaign would sit at zero forever while transactions
land. A testnet KPI wants `scale = 1e3` or `1` and a cap set to match; the appendix below keeps
`1e6` because that is the mainnet-honest figure, and it is the one thing to change before seeding.

## Encoded `KpiSpec.params`

The create form builds these from the KPI editor — this appendix exists so a value can be checked or
pasted directly. Word order is `(address source, bytes32 topic0, uint8 actorTopic, uint8 amountMode,
uint256 scale)` for 160 bytes, plus `(uint8 filterTopic, bytes32 filterValue)` for 224. Length is
what distinguishes the layouts: 32 B is a `TouchWindowVerifier` lookback, not an event source.

`topic0` for every signature used above:

| Signature | topic0 |
| --- | --- |
| `Supply(address,address,address,uint256,uint16)` | `0x2b627736bca15cd5381dcf80b0bf11fd197d01a037c52b927a881a10fb73ba61` |
| `Withdraw(address,address,address,uint256)` | `0x3115d1449a7b732c986cba18244e897a450f61e1bb8d589cd2e69e6c8924f9f7` |
| `Borrow(address,address,address,uint256,uint8,uint256,uint16)` | `0xb3d084820fb1a9decffb176436bd02558d15fac9b0ddfed8c465bc7359d7dce0` |
| `Repay(address,address,address,uint256,bool)` | `0xa534c8dbe71f871f9f3530e97a74601fea17b426cae02e1c5aee42c96c784051` |
| `ReserveUsedAsCollateralEnabled(address,address)` | `0x00058a56ea94653cdf4f152d227ace22d4c00ad99e2a43f58cb7d9e3feb295f2` |
| `UserEModeSet(address,uint8)` | `0xd728da875fc88944cbf17638bcbe4af0eedaef63becd1d1c57cc097eb4608d84` |
| `FlashLoan(address,address,address,uint256,uint8,uint256,uint16)` | `0xefefaba5e921573100900a3ad9cf29f222d995fb3b6045797eaea7521bd8d6f0` |
| `LiquidationCall(address,address,address,uint256,uint256,address,bool)` | `0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286` |
| `ReserveUsedAsCollateralDisabled(address,address)` | `0x44c58d81365b66dd4b1a7f36c25aa97b8c71c361ee4937adc1a00000227db5dd` |

Each block below is one 32-byte word per line; concatenate without whitespace to get the value.

**Withdraw USDC** — 224 bytes

```
0x0000000000000000000000008bab6d1b75f19e9ed9fce8b9bd338844ff79ae27
  3115d1449a7b732c986cba18244e897a450f61e1bb8d589cd2e69e6c8924f9f7
  0000000000000000000000000000000000000000000000000000000000000002
  0000000000000000000000000000000000000000000000000000000000000001
  00000000000000000000000000000000000000000000000000000000000f4240
  0000000000000000000000000000000000000000000000000000000000000001
  000000000000000000000000ba50cd2a20f6da35d788639e581bca8d0b5d4d5f
```

**Withdraw WETH** — 224 bytes, the same but with scale `0de0b6b3a7640000` (1e18) and filter value
`0000000000000000000000004200000000000000000000000000000000000006`

**Repay USDC debt** — 224 bytes

```
0x0000000000000000000000008bab6d1b75f19e9ed9fce8b9bd338844ff79ae27
  a534c8dbe71f871f9f3530e97a74601fea17b426cae02e1c5aee42c96c784051
  0000000000000000000000000000000000000000000000000000000000000002
  0000000000000000000000000000000000000000000000000000000000000001
  00000000000000000000000000000000000000000000000000000000000f4240
  0000000000000000000000000000000000000000000000000000000000000001
  000000000000000000000000ba50cd2a20f6da35d788639e581bca8d0b5d4d5f
```

**Repay anything (count)** — 160 bytes

```
0x0000000000000000000000008bab6d1b75f19e9ed9fce8b9bd338844ff79ae27
  a534c8dbe71f871f9f3530e97a74601fea17b426cae02e1c5aee42c96c784051
  0000000000000000000000000000000000000000000000000000000000000002
  0000000000000000000000000000000000000000000000000000000000000000
  0000000000000000000000000000000000000000000000000000000000000001
```

**Supply USDC (count)** — 224 bytes

```
0x0000000000000000000000008bab6d1b75f19e9ed9fce8b9bd338844ff79ae27
  2b627736bca15cd5381dcf80b0bf11fd197d01a037c52b927a881a10fb73ba61
  0000000000000000000000000000000000000000000000000000000000000002
  0000000000000000000000000000000000000000000000000000000000000000
  0000000000000000000000000000000000000000000000000000000000000001
  0000000000000000000000000000000000000000000000000000000000000001
  000000000000000000000000ba50cd2a20f6da35d788639e581bca8d0b5d4d5f
```

**Supply any reserve (count)** — 160 bytes, the first five words above.

**Borrow USDC (count)** — 224 bytes, the `Supply USDC` block with topic0
`b3d084820fb1a9decffb176436bd02558d15fac9b0ddfed8c465bc7359d7dce0`

**Enable USDC as collateral** — 224 bytes, the `Supply USDC` block with topic0
`00058a56ea94653cdf4f152d227ace22d4c00ad99e2a43f58cb7d9e3feb295f2`

**Set an eMode category** — 160 bytes

```
0x0000000000000000000000008bab6d1b75f19e9ed9fce8b9bd338844ff79ae27
  d728da875fc88944cbf17638bcbe4af0eedaef63becd1d1c57cc097eb4608d84
  0000000000000000000000000000000000000000000000000000000000000001
  0000000000000000000000000000000000000000000000000000000000000000
  0000000000000000000000000000000000000000000000000000000000000001
```

## Reproducing this

`web/scripts/__aave-kpis.mts` runs each proposal above through `probeEventSource` and prints the
encoded params word by word alongside the findings. It takes `BASE_SEPOLIA_RPC` and defaults to
`https://base-sepolia-rpc.publicnode.com`, because `sepolia.base.org` returns 502 on roughly one
call in three.

```
cd web && pnpm tsx scripts/__aave-kpis.mts
```

Publicnode caps `eth_getLogs` at 50,000 blocks and also caps response size, so a scan of a busy
token needs a window nearer 2,000 blocks. The probe itself reads 1,900 and is unaffected.
