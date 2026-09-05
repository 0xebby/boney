/**
 * Prints the encoded `KpiSpec.params` for the recommended self-hosted Boney KPIs, split into
 * 32-byte words, so the appendix can be checked against a deployed campaign's spec.
 */
import {getAddress, keccak256, toHex} from "viem";
import {encodeEventSource, eventTopic, AMOUNT_MODE, ZERO_TOPIC, normalizeTopicValue, type EventSource} from "../src/lib/kpiSource";

const A = {
  campaignRegistry: getAddress("0x3e0a2fc423dE77bEE9147879308BFfFC6129c4EE"),
  attributionRegistry: getAddress("0xe04C5185eDd4C9b1c91e31c790843c335766258e"),
  reputationRegistry: getAddress("0x8B601B46C9Bd74F991F5A17d4bF674A837Ebed52"),
  nft: getAddress("0x3bdd104560ae0f0cc4360e691cdcd972f4cd1193"),
};

const KPIS: {name: string; sig: string; src: EventSource}[] = [
  {
    name: "KPI 0 — Launch a campaign",
    sig: "CampaignCreated(uint256,address,address,address,string)",
    src: {source: A.campaignRegistry, topic0: eventTopic("CampaignCreated(uint256,address,address,address,string)"),
          actorTopic: 3, amountMode: AMOUNT_MODE.count, scale: BigInt(1)},
  },
  {
    name: "KPI 1 — Sign an attribution",
    sig: "TouchStored(address,address,bytes32,uint64,uint64,address)",
    src: {source: A.attributionRegistry, topic0: eventTopic("TouchStored(address,address,bytes32,uint64,uint64,address)"),
          actorTopic: 2, amountMode: AMOUNT_MODE.count, scale: BigInt(1)},
  },
  {
    name: "KPI 2 — Get an ETHOS_SCORE attestation stored",
    sig: "AttestationStored(address,bytes32,uint256,bytes32)",
    src: {source: A.reputationRegistry, topic0: eventTopic("AttestationStored(address,bytes32,uint256,bytes32)"),
          actorTopic: 1, amountMode: AMOUNT_MODE.count, scale: BigInt(1),
          filterTopic: 2, filterValue: keccak256(toHex("ETHOS_SCORE"))},
  },
  {
    name: "KPI 3 — Mint the open Boney NFT",
    sig: "Transfer(address,address,uint256)",
    src: {source: A.nft, topic0: eventTopic("Transfer(address,address,uint256)"),
          actorTopic: 2, amountMode: AMOUNT_MODE.count, scale: BigInt(1),
          filterTopic: 1, filterValue: ZERO_TOPIC},
  },
];

const LABELS = ["source", "topic0", "actorTopic", "amountMode", "scale", "filterTopic", "filterValue"];

for (const k of KPIS) {
  const hex = encodeEventSource(k.src).slice(2);
  const words = hex.match(/.{64}/g) ?? [];
  console.log(`\n${k.name}\n  ${k.sig}\n  ${words.length * 32} bytes`);
  words.forEach((w, i) => console.log(`    [${String(i).padStart(2)}] ${LABELS[i] ?? "?"}`.padEnd(24) + `0x${w}`));
}
console.log("\ntopic0s");
for (const sig of [
  "CampaignCreated(uint256,address,address,address,string)",
  "TouchStored(address,address,bytes32,uint64,uint64,address)",
  "AttestationStored(address,bytes32,uint256,bytes32)",
  "Deposited(address,address,uint256)",
  "Released(address,address,uint256)",
  "PromoterJoined(address,bytes32,uint256)",
  "Minted(address,uint256,uint256)",
  "Transfer(address,address,uint256)",
]) console.log(`  ${eventTopic(sig)}  ${sig}`);
console.log("\nschemaIds");
for (const n of ["X_FOLLOWERS", "X_REACH", "ETHOS_SCORE"]) console.log(`  ${keccak256(toHex(n))}  ${n}`);
