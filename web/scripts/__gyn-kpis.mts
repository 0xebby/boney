/**
 * Runs the app's own event-source probe over the Gyndore Base Sepolia contracts, so each proposed
 * KPI is judged by the same code the create form uses.
 */
import {createPublicClient, http, getAddress} from "viem";
import {baseSepolia} from "viem/chains";
import {probeEventSource, encodeEventSource, eventTopic, AMOUNT_MODE, ZERO_TOPIC, normalizeTopicValue, type EventSource} from "../src/lib/kpiSource";

const client = createPublicClient({
  chain: baseSepolia,
  transport: http(process.env.BASE_SEPOLIA_RPC ?? "https://base-sepolia-rpc.publicnode.com"),
});

const A = {
  bonding: getAddress("0x903ADC267e9DDe7bF7be8C442e779A2b9e70F78E"),
  staking: getAddress("0x5c0E023Ce4A353e5Cd9a43E28D2879Cb9e876865"),
  faucet: getAddress("0x14b3248f2e1bd1190C9b3b5F7D2eFc68700533d6"),
  nfpm: getAddress("0x76998e42B789d81004f006402b6c62a8BDCAfD5b"),
  router: getAddress("0xC7dbf300B6aEA3CFE1730f1C692C606b17B514a6"),
  GYND: getAddress("0x0d442EC7BdDB06b531DCA3Dd39ABaFf554170776"),
  bGYND: getAddress("0x235521110E4761fE2734d5c5F6c1b54ac897D9bF"),
  poolCbbtcUsdc: getAddress("0xc44eE87cF25c36be9a5577620067C8Aa63Dd578F"),
  poolGyndCbbtc: getAddress("0x7B47daC59075aF44046795BA347EC872D5409263"),
};

type Proposal = {name: string; signature: string; src: EventSource; note: string};

const PROPOSALS: Proposal[] = [
  {
    name: "Stake GYND",
    signature: "Staked(address,address,uint256)",
    note: "actor = user (T1); filter pins the staked token to GYND (T2); amount = GYND staked / 1e18",
    src: {source: A.staking, topic0: eventTopic("Staked(address,address,uint256)"), actorTopic: 1,
          amountMode: AMOUNT_MODE.dataWord0, scale: BigInt(1e18),
          filterTopic: 2, filterValue: normalizeTopicValue(A.GYND)!},
  },
  {
    name: "Stake bGYND",
    signature: "Staked(address,address,uint256)",
    note: "same event, filter pins bGYND — the only other token isStakeToken() accepts",
    src: {source: A.staking, topic0: eventTopic("Staked(address,address,uint256)"), actorTopic: 1,
          amountMode: AMOUNT_MODE.dataWord0, scale: BigInt(1e18),
          filterTopic: 2, filterValue: normalizeTopicValue(A.bGYND)!},
  },
  {
    name: "Stake anything (count)",
    signature: "Staked(address,address,uint256)",
    note: "no filter, 1 per stake",
    src: {source: A.staking, topic0: eventTopic("Staked(address,address,uint256)"), actorTopic: 1,
          amountMode: AMOUNT_MODE.count, scale: BigInt(1)},
  },
  {
    name: "Claim staking rewards (USDC)",
    signature: "RewardPaid(address,uint256)",
    note: "actor = user (T1); reward is USDC, 6dp",
    src: {source: A.staking, topic0: eventTopic("RewardPaid(address,uint256)"), actorTopic: 1,
          amountMode: AMOUNT_MODE.dataWord0, scale: BigInt(1e6)},
  },
  {
    name: "Bond GYND",
    signature: "Bonded(address,uint256,uint256,uint256,uint256)",
    note: "actor = user (T1); dataWord0 = amount bonded, 18dp. T2 is bondId — not filterable usefully",
    src: {source: A.bonding, topic0: eventTopic("Bonded(address,uint256,uint256,uint256,uint256)"),
          actorTopic: 1, amountMode: AMOUNT_MODE.dataWord0, scale: BigInt(1e18)},
  },
  {
    name: "Claim a matured bond",
    signature: "Claimed(address,uint256)",
    note: "actor = user (T1); proves the user came back after the cooldown",
    src: {source: A.bonding, topic0: eventTopic("Claimed(address,uint256)"), actorTopic: 1,
          amountMode: AMOUNT_MODE.dataWord0, scale: BigInt(1e18)},
  },
  {
    name: "Provide liquidity (LP NFT minted)",
    signature: "Transfer(address,address,uint256)",
    note: "NFPM ERC-721; actor = to (T2), filter from = address(0) so only mints count. dataWords=0, so count only",
    src: {source: A.nfpm, topic0: eventTopic("Transfer(address,address,uint256)"), actorTopic: 2,
          amountMode: AMOUNT_MODE.count, scale: BigInt(1), filterTopic: 1, filterValue: ZERO_TOPIC},
  },
  {
    name: "Swap through the Gyndore router (cbBTC/USDC)",
    signature: "Swap(address,address,int256,int256,uint160,uint128,int24)",
    note: "actor = recipient (T2); filter sender = swapRouter (T1). count, because dataWord0 is a signed int256",
    src: {source: A.poolCbbtcUsdc, topic0: eventTopic("Swap(address,address,int256,int256,uint160,uint128,int24)"),
          actorTopic: 2, amountMode: AMOUNT_MODE.count, scale: BigInt(1),
          filterTopic: 1, filterValue: normalizeTopicValue(A.router)!},
  },
  {
    name: "Swap through the Gyndore router (GYND/cbBTC)",
    signature: "Swap(address,address,int256,int256,uint160,uint128,int24)",
    note: "same, on the GYND/cbBTC pool",
    src: {source: A.poolGyndCbbtc, topic0: eventTopic("Swap(address,address,int256,int256,uint160,uint128,int24)"),
          actorTopic: 2, amountMode: AMOUNT_MODE.count, scale: BigInt(1),
          filterTopic: 1, filterValue: normalizeTopicValue(A.router)!},
  },
  {
    name: "Claim from the testnet faucet",
    signature: "AssetsMinted(address,address,uint256)",
    note: "actor = to (T1). Onboarding only — free to farm",
    src: {source: A.faucet, topic0: eventTopic("AssetsMinted(address,address,uint256)"), actorTopic: 1,
          amountMode: AMOUNT_MODE.count, scale: BigInt(1)},
  },
  // Rejected shapes, probed to show why.
  {
    name: "REJECTED: NFPM IncreaseLiquidity",
    signature: "IncreaseLiquidity(uint256,uint128,uint256,uint256)",
    note: "T1 is a tokenId, not an address",
    src: {source: A.nfpm, topic0: eventTopic("IncreaseLiquidity(uint256,uint128,uint256,uint256)"),
          actorTopic: 1, amountMode: AMOUNT_MODE.dataWord0, scale: BigInt(1e18)},
  },
  {
    name: "REJECTED: pool Mint",
    signature: "Mint(address,address,int24,int24,uint128,uint256,uint256)",
    note: "T1 is the position manager, T2/T3 are ticks",
    src: {source: A.poolGyndCbbtc, topic0: eventTopic("Mint(address,address,int24,int24,uint128,uint256,uint256)"),
          actorTopic: 1, amountMode: AMOUNT_MODE.count, scale: BigInt(1)},
  },
];

for (const p of PROPOSALS) {
  const findings = await probeEventSource(
    client,
    {
      source: p.src.source, signature: p.signature, amountMode: p.src.amountMode,
      scale: p.src.scale.toString(), actorTopic: p.src.actorTopic,
      filterTopic: p.src.filterTopic, filterValue: p.src.filterValue,
    },
    {chainId: baseSepolia.id},
  );
  const worst = findings.some((f) => f.severity === "error") ? "ERROR"
    : findings.some((f) => f.severity === "warn") ? "warn" : "ok";
  const params = encodeEventSource(p.src);
  console.log(`\n### ${p.name}  →  ${worst}`);
  console.log(`    ${p.signature} on ${p.src.source}`);
  console.log(`    actorTopic=${p.src.actorTopic} amountMode=${p.src.amountMode === 1 ? "dataWord0" : "count"} scale=${p.src.scale}` +
    (p.src.filterTopic ? ` filterTopic=${p.src.filterTopic} filterValue=${p.src.filterValue}` : " (no filter)"));
  console.log(`    ${p.note}`);
  console.log(`    params=${params.length - 2} hex chars / ${(params.length - 2) / 2} bytes`);
  for (const f of findings) console.log(`      [${f.severity}] ${f.message}`);
  await new Promise((r) => setTimeout(r, 400));
}
