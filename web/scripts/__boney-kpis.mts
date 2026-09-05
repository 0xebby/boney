/**
 * Runs the app's own event-source probe over the Boney protocol's own Base Sepolia deployment, so
 * each proposed self-hosted KPI is judged by the same code the create form uses.
 */
import {createPublicClient, http, getAddress, keccak256, toHex} from "viem";
import {baseSepolia} from "viem/chains";
import {
  probeEventSource, encodeEventSource, eventTopic, AMOUNT_MODE, ZERO_TOPIC,
  normalizeTopicValue, type EventSource,
} from "../src/lib/kpiSource";

const client = createPublicClient({
  chain: baseSepolia,
  transport: http(process.env.BASE_SEPOLIA_RPC ?? "https://base-sepolia-rpc.publicnode.com"),
});

const A = {
  campaignRegistry: getAddress("0x3e0a2fc423dE77bEE9147879308BFfFC6129c4EE"),
  attributionRegistry: getAddress("0xe04C5185eDd4C9b1c91e31c790843c335766258e"),
  escrowVault: getAddress("0x880fd3271f83b8B68E2E2Ff9888706fEF1b70D7b"),
  reputationRegistry: getAddress("0x8B601B46C9Bd74F991F5A17d4bF674A837Ebed52"),
  attestationVerifier: getAddress("0xA73fA728aF15da26998BD855985F85615224E576"),
  oracleCoordinator: getAddress("0x94EaBe8FBB05AbaEB2fC28Edc41A5533Ea0d4c3B"),
  eventMetric: getAddress("0xFF69E2B4A1Cb96a59dbDD138fb7215dCa58aEBd6"),
  boney: getAddress("0x8DDAfd60a9Dc9F8dec0Fb483954f03282C3d642f"),
  nft: getAddress("0x3bdd104560ae0f0cc4360e691cdcd972f4cd1193"),
  gyndoreCampaign: getAddress("0x86B7b22aEd09452232Ca1A072db5BE7a837F06fc"),
  bUSD: getAddress("0x2755562471B5f6239722ab164d126260F4D8dCc2"),
};

const SCHEMA = {
  followers: keccak256(toHex("X_FOLLOWERS")),
  reach: keccak256(toHex("X_REACH")),
  ethos: keccak256(toHex("ETHOS_SCORE")),
};
console.log("schemaIds:", SCHEMA);

const E18 = BigInt("1000000000000000000");
const MILLI = BigInt(1000000000000000);

type Proposal = {name: string; signature: string; src: EventSource; note: string};

const PROPOSALS: Proposal[] = [
  {
    name: "Sign an attribution anywhere on Boneyard",
    signature: "TouchStored(address,address,bytes32,uint64,uint64,address)",
    note: "actor = user (T2); count, because dataWord0 is signedAt (a unix timestamp)",
    src: {source: A.attributionRegistry, topic0: eventTopic("TouchStored(address,address,bytes32,uint64,uint64,address)"),
          actorTopic: 2, amountMode: AMOUNT_MODE.count, scale: BigInt(1)},
  },
  {
    name: "Sign an attribution on one named campaign",
    signature: "TouchStored(address,address,bytes32,uint64,uint64,address)",
    note: "same, with T1 pinned to the Gyndore Testnet campaign",
    src: {source: A.attributionRegistry, topic0: eventTopic("TouchStored(address,address,bytes32,uint64,uint64,address)"),
          actorTopic: 2, amountMode: AMOUNT_MODE.count, scale: BigInt(1),
          filterTopic: 1, filterValue: normalizeTopicValue(A.gyndoreCampaign)!},
  },
  {
    name: "Launch a campaign",
    signature: "CampaignCreated(uint256,address,address,address,string)",
    note: "actor = project (T3); count, because dataWord0 is the payout token address",
    src: {source: A.campaignRegistry, topic0: eventTopic("CampaignCreated(uint256,address,address,address,string)"),
          actorTopic: 3, amountMode: AMOUNT_MODE.count, scale: BigInt(1)},
  },
  {
    name: "Escrow a reward pool (bUSD)",
    signature: "Deposited(address,address,uint256)",
    note: "actor = depositor (T2); dataWord0 = amount escrowed / 1e18",
    src: {source: A.escrowVault, topic0: eventTopic("Deposited(address,address,uint256)"),
          actorTopic: 2, amountMode: AMOUNT_MODE.dataWord0, scale: E18},
  },
  {
    name: "Escrow a reward pool (count)",
    signature: "Deposited(address,address,uint256)",
    note: "same event, 1 per funded campaign — token-agnostic, so mixed-decimal pools stay comparable",
    src: {source: A.escrowVault, topic0: eventTopic("Deposited(address,address,uint256)"),
          actorTopic: 2, amountMode: AMOUNT_MODE.count, scale: BigInt(1)},
  },
  {
    name: "Get an X_FOLLOWERS attestation stored",
    signature: "AttestationStored(address,bytes32,uint256,bytes32)",
    note: "actor = subject (T1); filter pins the schema; count, so one whale is one onboarding",
    src: {source: A.reputationRegistry, topic0: eventTopic("AttestationStored(address,bytes32,uint256,bytes32)"),
          actorTopic: 1, amountMode: AMOUNT_MODE.count, scale: BigInt(1),
          filterTopic: 2, filterValue: SCHEMA.followers},
  },
  {
    name: "Get an ETHOS_SCORE attestation stored",
    signature: "AttestationStored(address,bytes32,uint256,bytes32)",
    note: "same, pinned to the Ethos schema — the one the reputation gate actually weighs",
    src: {source: A.reputationRegistry, topic0: eventTopic("AttestationStored(address,bytes32,uint256,bytes32)"),
          actorTopic: 1, amountMode: AMOUNT_MODE.count, scale: BigInt(1),
          filterTopic: 2, filterValue: SCHEMA.ethos},
  },
  {
    name: "Join one named campaign as a promoter",
    signature: "PromoterJoined(address,bytes32,uint256)",
    note: "actor = promoter (T1) on a single campaign clone; count",
    src: {source: A.gyndoreCampaign, topic0: eventTopic("PromoterJoined(address,bytes32,uint256)"),
          actorTopic: 1, amountMode: AMOUNT_MODE.count, scale: BigInt(1)},
  },
  {
    name: "Mint the open Boney NFT (spend)",
    signature: "Minted(address,uint256,uint256)",
    note: "live on Sdy Labs KPI 1: actor = minter (T1); dataWord0 = wei paid / 1e15",
    src: {source: A.nft, topic0: eventTopic("Minted(address,uint256,uint256)"),
          actorTopic: 1, amountMode: AMOUNT_MODE.dataWord0, scale: MILLI},
  },
  {
    name: "Mint the open Boney NFT (tokens)",
    signature: "Transfer(address,address,uint256)",
    note: "live on Sdy Labs KPI 0: actor = to (T2), filter from = address(0); 1 per token",
    src: {source: A.nft, topic0: eventTopic("Transfer(address,address,uint256)"),
          actorTopic: 2, amountMode: AMOUNT_MODE.count, scale: BigInt(1),
          filterTopic: 1, filterValue: ZERO_TOPIC},
  },
  // Rejected shapes, probed to show what the probe does and does not catch.
  {
    name: "REJECTED: Released (promoter payout)",
    signature: "Released(address,address,uint256)",
    note: "shape is valid; paying for payouts makes reward -> progress -> reward",
    src: {source: A.escrowVault, topic0: eventTopic("Released(address,address,uint256)"),
          actorTopic: 2, amountMode: AMOUNT_MODE.dataWord0, scale: E18},
  },
  {
    name: "REJECTED: CampaignCreated actorTopic=1",
    signature: "CampaignCreated(uint256,address,address,address,string)",
    note: "T1 is a campaignId (0..3); small enough to pass the address-shape test",
    src: {source: A.campaignRegistry, topic0: eventTopic("CampaignCreated(uint256,address,address,address,string)"),
          actorTopic: 1, amountMode: AMOUNT_MODE.count, scale: BigInt(1)},
  },
  {
    name: "REJECTED: PromoterRegistered",
    signature: "PromoterRegistered(address,bytes32)",
    note: "T1 is the campaign, T2 a promoterId; the promoter's wallet is nowhere in the log",
    src: {source: A.attributionRegistry, topic0: eventTopic("PromoterRegistered(address,bytes32)"),
          actorTopic: 2, amountMode: AMOUNT_MODE.count, scale: BigInt(1)},
  },
  {
    name: "REJECTED: VerifiedTotalReported",
    signature: "VerifiedTotalReported(address,uint256,address,uint256)",
    note: "the relayer's own output; T2 is a kpiIndex that passes the address-shape test",
    src: {source: A.eventMetric, topic0: eventTopic("VerifiedTotalReported(address,uint256,address,uint256)"),
          actorTopic: 3, amountMode: AMOUNT_MODE.dataWord0, scale: BigInt(1)},
  },
  {
    name: "REJECTED: AttestationVerified",
    signature: "AttestationVerified(bytes32)",
    note: "one topic, and it is an attestationId",
    src: {source: A.attestationVerifier, topic0: eventTopic("AttestationVerified(bytes32)"),
          actorTopic: 1, amountMode: AMOUNT_MODE.count, scale: BigInt(1)},
  },
  {
    name: "REJECTED: ReporterStaked",
    signature: "ReporterStaked(address,uint256)",
    note: "clean shape, but the oracle staking path has never been exercised",
    src: {source: A.oracleCoordinator, topic0: eventTopic("ReporterStaked(address,uint256)"),
          actorTopic: 1, amountMode: AMOUNT_MODE.dataWord0, scale: E18},
  },
  {
    name: "REJECTED: the Boney facade",
    signature: "CampaignCreated(uint256,address,address,address,string)",
    note: "the facade is stateless and declares no events at all",
    src: {source: A.boney, topic0: eventTopic("CampaignCreated(uint256,address,address,address,string)"),
          actorTopic: 3, amountMode: AMOUNT_MODE.count, scale: BigInt(1)},
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
  console.log(`\n### ${p.name}  ->  ${worst}`);
  console.log(`    ${p.signature} on ${p.src.source}`);
  console.log(`    actorTopic=${p.src.actorTopic} amountMode=${p.src.amountMode === 1 ? "dataWord0" : "count"} scale=${p.src.scale}` +
    (p.src.filterTopic ? ` filterTopic=${p.src.filterTopic} filterValue=${p.src.filterValue}` : " (no filter)"));
  console.log(`    ${p.note}`);
  console.log(`    params=${(params.length - 2) / 2} bytes`);
  for (const f of findings) console.log(`      [${f.severity}] ${f.message}`);
  await new Promise((r) => setTimeout(r, 400));
}
