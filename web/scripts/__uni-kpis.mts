/**
 * Runs the app's own event-source probe over the Uniswap V3 and V4 deployments on Base Sepolia, so
 * each proposed KPI is judged by the same code the create form uses.
 */
import {createPublicClient, http, getAddress} from "viem";
import {baseSepolia} from "viem/chains";
import {
  probeEventSource,
  encodeEventSource,
  eventTopic,
  AMOUNT_MODE,
  ZERO_TOPIC,
  normalizeTopicValue,
  type EventSource,
} from "../src/lib/kpiSource";

const client = createPublicClient({
  chain: baseSepolia,
  transport: http(process.env.BASE_SEPOLIA_RPC ?? "https://base-sepolia-rpc.publicnode.com"),
});

const A = {
  factory: getAddress("0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24"),
  router02: getAddress("0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4"),
  universalRouter: getAddress("0x050E797f3625EC8785265e1d9BDd4799b97528A1"),
  nfpm: getAddress("0x27F971cb582BF9E50F397e4d29a5C7A34f11faA2"),
  permit2: getAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3"),
  poolManagerV4: getAddress("0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408"),
  positionManagerV4: getAddress("0x4B2C77d209D3405F41a037Ec6c77F7F5b8e2ca80"),
  pool3000: getAddress("0x46880b404CD35c165EDdefF7421019F8dD25F4Ad"),
  pool500: getAddress("0x94bfc0574FF48E92cE43d495376C477B1d0EEeC0"),
  WETH: getAddress("0x4200000000000000000000000000000000000006"),
  USDC: getAddress("0x036CbD53842c5426634e7929541eC2318f3dCF7e"),
};

const SIG = {
  swapV3: "Swap(address,address,int256,int256,uint160,uint128,int24)",
  swapV4: "Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)",
  transfer: "Transfer(address,address,uint256)",
  deposit: "Deposit(address,uint256)",
  increase: "IncreaseLiquidity(uint256,uint128,uint256,uint256)",
  collectNfpm: "Collect(uint256,address,uint256,uint256)",
  mintPool: "Mint(address,address,int24,int24,uint128,uint256,uint256)",
  approvalPermit2: "Approval(address,address,address,uint160,uint48)",
} as const;

const ROUTER_TOPIC = normalizeTopicValue(A.router02)!;
const POOL_TOPIC = normalizeTopicValue(A.pool3000)!;

type Proposal = {name: string; signature: string; src: EventSource; note: string};

const PROPOSALS: Proposal[] = [
  {
    name: "Swap on WETH/USDC 0.3% through SwapRouter02",
    signature: SIG.swapV3,
    note: "actor = recipient (T2); filter sender = SwapRouter02 (T1). count, because dataWord0 is a signed int256",
    src: {source: A.pool3000, topic0: eventTopic(SIG.swapV3), actorTopic: 2,
          amountMode: AMOUNT_MODE.count, scale: BigInt(1),
          filterTopic: 1, filterValue: ROUTER_TOPIC},
  },
  {
    name: "Swap on WETH/USDC 0.3%, any route",
    signature: SIG.swapV3,
    note: "no filter — also credits UniversalRouter and direct pool calls",
    src: {source: A.pool3000, topic0: eventTopic(SIG.swapV3), actorTopic: 2,
          amountMode: AMOUNT_MODE.count, scale: BigInt(1)},
  },
  {
    name: "Swap on WETH/USDC 0.05% through SwapRouter02",
    signature: SIG.swapV3,
    note: "same shape on the shallower fee tier",
    src: {source: A.pool500, topic0: eventTopic(SIG.swapV3), actorTopic: 2,
          amountMode: AMOUNT_MODE.count, scale: BigInt(1),
          filterTopic: 1, filterValue: ROUTER_TOPIC},
  },
  {
    name: "USDC received out of the 0.3% pool",
    signature: SIG.transfer,
    note: "actor = to (T2); filter from = the pool (T1), so only USDC the pool paid out counts. scale 1e3 = 0.001 USDC",
    src: {source: A.USDC, topic0: eventTopic(SIG.transfer), actorTopic: 2,
          amountMode: AMOUNT_MODE.dataWord0, scale: BigInt(1e3),
          filterTopic: 1, filterValue: POOL_TOPIC},
  },
  {
    name: "Provide liquidity, v3 (LP NFT minted)",
    signature: SIG.transfer,
    note: "NFPM ERC-721; actor = to (T2), filter from = address(0) so only mints count",
    src: {source: A.nfpm, topic0: eventTopic(SIG.transfer), actorTopic: 2,
          amountMode: AMOUNT_MODE.count, scale: BigInt(1),
          filterTopic: 1, filterValue: ZERO_TOPIC},
  },
  {
    name: "Provide liquidity, v4 (position minted)",
    signature: SIG.transfer,
    note: "v4 PositionManager ERC-721, same mint-leg shape",
    src: {source: A.positionManagerV4, topic0: eventTopic(SIG.transfer), actorTopic: 2,
          amountMode: AMOUNT_MODE.count, scale: BigInt(1),
          filterTopic: 1, filterValue: ZERO_TOPIC},
  },
  {
    name: "Wrap ETH (adjacent, not Uniswap)",
    signature: SIG.deposit,
    note: "actor = dst (T1), dataWord0 = wad. Credits any wrap, and a routed swap wraps on the router",
    src: {source: A.WETH, topic0: eventTopic(SIG.deposit), actorTopic: 1,
          amountMode: AMOUNT_MODE.dataWord0, scale: BigInt(1e18)},
  },
  // Rejected shapes, probed to show why.
  {
    name: "REJECTED: v3 Swap as volume",
    signature: SIG.swapV3,
    note: "dataWord0 is `amount0`, a signed int256 — negative on one side of every swap",
    src: {source: A.pool3000, topic0: eventTopic(SIG.swapV3), actorTopic: 2,
          amountMode: AMOUNT_MODE.dataWord0, scale: BigInt(1e6)},
  },
  {
    name: "REJECTED: v4 PoolManager Swap",
    signature: SIG.swapV4,
    note: "T1 is a bytes32 PoolId, T2 is the calling router. No recipient appears in the log at all",
    src: {source: A.poolManagerV4, topic0: eventTopic(SIG.swapV4), actorTopic: 2,
          amountMode: AMOUNT_MODE.count, scale: BigInt(1)},
  },
  {
    name: "REJECTED: NFPM IncreaseLiquidity",
    signature: SIG.increase,
    note: "T1 is a tokenId, not an address",
    src: {source: A.nfpm, topic0: eventTopic(SIG.increase), actorTopic: 1,
          amountMode: AMOUNT_MODE.dataWord0, scale: BigInt(1e18)},
  },
  {
    name: "REJECTED: NFPM Collect",
    signature: SIG.collectNfpm,
    note: "T1 is a tokenId; the real recipient sits in data word 0, where only an amount can be read",
    src: {source: A.nfpm, topic0: eventTopic(SIG.collectNfpm), actorTopic: 1,
          amountMode: AMOUNT_MODE.count, scale: BigInt(1)},
  },
  {
    name: "REJECTED: v3 pool Mint",
    signature: SIG.mintPool,
    note: "T1 is the owner, which for every routed position is the NFPM; T2/T3 are int24 ticks",
    src: {source: A.pool3000, topic0: eventTopic(SIG.mintPool), actorTopic: 1,
          amountMode: AMOUNT_MODE.count, scale: BigInt(1)},
  },
  {
    name: "REJECTED: Permit2 Approval",
    signature: SIG.approvalPermit2,
    note: "actor = owner (T1) does work, but an approval is free and moves no value",
    src: {source: A.permit2, topic0: eventTopic(SIG.approvalPermit2), actorTopic: 1,
          amountMode: AMOUNT_MODE.count, scale: BigInt(1)},
  },
  {
    name: "REJECTED: SwapRouter02 itself",
    signature: SIG.swapV3,
    note: "the router emits nothing — every observable swap surfaces on the pool",
    src: {source: A.router02, topic0: eventTopic(SIG.swapV3), actorTopic: 2,
          amountMode: AMOUNT_MODE.count, scale: BigInt(1)},
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
  const words = (params.slice(2).match(/.{64}/g) ?? []);
  console.log(`    params ${words.length * 32} bytes:`);
  for (const [i, w] of words.entries()) console.log(`      ${i === 0 ? "0x" : "  "}${w}`);
  for (const f of findings) console.log(`      [${f.severity}] ${f.message}`);
  await new Promise((r) => setTimeout(r, 400));
}
