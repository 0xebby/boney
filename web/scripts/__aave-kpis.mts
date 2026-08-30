/**
 * Runs the app's own event-source probe over the Aave V3 Base Sepolia market, so each proposed KPI is
 * judged by the same code the create form uses.
 */
import {createPublicClient, http, getAddress} from "viem";
import {baseSepolia} from "viem/chains";
import {
  probeEventSource,
  encodeEventSource,
  eventTopic,
  AMOUNT_MODE,
  normalizeTopicValue,
  type EventSource,
} from "../src/lib/kpiSource";

const client = createPublicClient({
  chain: baseSepolia,
  transport: http(process.env.BASE_SEPOLIA_RPC ?? "https://base-sepolia-rpc.publicnode.com"),
});

const A = {
  pool: getAddress("0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27"),
  USDC: getAddress("0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f"),
  WETH: getAddress("0x4200000000000000000000000000000000000006"),
  aUSDC: getAddress("0x10F1A9D11CDf50041f3f8cB7191CBE2f31750ACC"),
};

const SIG = {
  supply: "Supply(address,address,address,uint256,uint16)",
  withdraw: "Withdraw(address,address,address,uint256)",
  borrow: "Borrow(address,address,address,uint256,uint8,uint256,uint16)",
  repay: "Repay(address,address,address,uint256,bool)",
  flashLoan: "FlashLoan(address,address,address,uint256,uint8,uint256,uint16)",
  collateralOn: "ReserveUsedAsCollateralEnabled(address,address)",
  eMode: "UserEModeSet(address,uint8)",
  liquidation: "LiquidationCall(address,address,address,uint256,uint256,address,bool)",
  aMint: "Mint(address,address,uint256,uint256,uint256)",
  transfer: "Transfer(address,address,uint256)",
} as const;

const USDC_TOPIC = normalizeTopicValue(A.USDC)!;
const WETH_TOPIC = normalizeTopicValue(A.WETH)!;

type Proposal = {name: string; signature: string; src: EventSource; note: string};

const PROPOSALS: Proposal[] = [
  {
    name: "Withdraw USDC",
    signature: SIG.withdraw,
    note: "actor = user (T2); data is the amount alone, 6dp. Filter pins the reserve to USDC (T1)",
    src: {source: A.pool, topic0: eventTopic(SIG.withdraw), actorTopic: 2,
          amountMode: AMOUNT_MODE.dataWord0, scale: BigInt(1e6),
          filterTopic: 1, filterValue: USDC_TOPIC},
  },
  {
    name: "Withdraw WETH",
    signature: SIG.withdraw,
    note: "same event, WETH reserve, 18dp",
    src: {source: A.pool, topic0: eventTopic(SIG.withdraw), actorTopic: 2,
          amountMode: AMOUNT_MODE.dataWord0, scale: BigInt(1e18),
          filterTopic: 1, filterValue: WETH_TOPIC},
  },
  {
    name: "Repay USDC debt",
    signature: SIG.repay,
    note: "actor = user whose debt shrank (T2); T3 is the repayer. dataWord0 = amount, 6dp",
    src: {source: A.pool, topic0: eventTopic(SIG.repay), actorTopic: 2,
          amountMode: AMOUNT_MODE.dataWord0, scale: BigInt(1e6),
          filterTopic: 1, filterValue: USDC_TOPIC},
  },
  {
    name: "Repay anything (count)",
    signature: SIG.repay,
    note: "no filter, 1 per repayment",
    src: {source: A.pool, topic0: eventTopic(SIG.repay), actorTopic: 2,
          amountMode: AMOUNT_MODE.count, scale: BigInt(1)},
  },
  {
    name: "Supply USDC (count)",
    signature: SIG.supply,
    note: "actor = onBehalfOf (T2). Count, not dataWord0 — the first data word is the `user` address",
    src: {source: A.pool, topic0: eventTopic(SIG.supply), actorTopic: 2,
          amountMode: AMOUNT_MODE.count, scale: BigInt(1),
          filterTopic: 1, filterValue: USDC_TOPIC},
  },
  {
    name: "Supply any reserve (count)",
    signature: SIG.supply,
    note: "actor = onBehalfOf (T2), 1 per supply into any of the six reserves",
    src: {source: A.pool, topic0: eventTopic(SIG.supply), actorTopic: 2,
          amountMode: AMOUNT_MODE.count, scale: BigInt(1)},
  },
  {
    name: "Borrow USDC (count)",
    signature: SIG.borrow,
    note: "actor = onBehalfOf (T2); T3 is the uint16 referralCode. dataWord0 is the `user` address, so count",
    src: {source: A.pool, topic0: eventTopic(SIG.borrow), actorTopic: 2,
          amountMode: AMOUNT_MODE.count, scale: BigInt(1),
          filterTopic: 1, filterValue: USDC_TOPIC},
  },
  {
    name: "Enable USDC as collateral",
    signature: SIG.collateralOn,
    note: "actor = user (T2); no data at all, so count is the only mode",
    src: {source: A.pool, topic0: eventTopic(SIG.collateralOn), actorTopic: 2,
          amountMode: AMOUNT_MODE.count, scale: BigInt(1),
          filterTopic: 1, filterValue: USDC_TOPIC},
  },
  {
    name: "Set an eMode category",
    signature: SIG.eMode,
    note: "actor = user (T1). One-off per wallet — onboarding only",
    src: {source: A.pool, topic0: eventTopic(SIG.eMode), actorTopic: 1,
          amountMode: AMOUNT_MODE.count, scale: BigInt(1)},
  },
  // Rejected shapes, probed to show why.
  {
    name: "REJECTED: Supply as a volume KPI",
    signature: SIG.supply,
    note: "dataWord0 is the `user` address, not the amount — it credits ~1e48 units per supply",
    src: {source: A.pool, topic0: eventTopic(SIG.supply), actorTopic: 2,
          amountMode: AMOUNT_MODE.dataWord0, scale: BigInt(1e6)},
  },
  {
    name: "REJECTED: aUSDC Mint as supplied volume",
    signature: SIG.aMint,
    note: "value is netted against accrued interest, and an interest-only Mint fires on withdrawal",
    src: {source: A.aUSDC, topic0: eventTopic(SIG.aMint), actorTopic: 2,
          amountMode: AMOUNT_MODE.dataWord0, scale: BigInt(1e6)},
  },
  {
    name: "REJECTED: aUSDC Transfer as a receipt",
    signature: SIG.transfer,
    note: "the mint and burn legs share the event; the burn leg's `to` is address(0)",
    src: {source: A.aUSDC, topic0: eventTopic(SIG.transfer), actorTopic: 2,
          amountMode: AMOUNT_MODE.dataWord0, scale: BigInt(1e6)},
  },
  {
    name: "REJECTED: FlashLoan",
    signature: SIG.flashLoan,
    note: "T1 is the receiver contract, T2 the asset, T3 the referralCode — no per-user topic exists",
    src: {source: A.pool, topic0: eventTopic(SIG.flashLoan), actorTopic: 1,
          amountMode: AMOUNT_MODE.count, scale: BigInt(1)},
  },
  {
    name: "REJECTED: LiquidationCall",
    signature: SIG.liquidation,
    note: "T3 is the liquidated borrower; the liquidator sits in data",
    src: {source: A.pool, topic0: eventTopic(SIG.liquidation), actorTopic: 3,
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
