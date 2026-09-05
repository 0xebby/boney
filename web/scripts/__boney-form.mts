/**
 * Prints the form-ready values for the self-hosted Boneyard campaign: checksummed addresses, event
 * signatures with their topic0, and the two bytes32 filter words.
 */
import {getAddress, keccak256, pad, toHex, type Hex} from "viem";

const ADDR: Record<string, string> = {
  "CampaignRegistry": "0x3e0a2fc423dE77bEE9147879308BFfFC6129c4EE",
  "AttributionRegistry": "0xe04C5185eDd4C9b1c91e31c790843c335766258e",
  "ReputationRegistry": "0x8B601B46C9Bd74F991F5A17d4bF674A837Ebed52",
  "OpenMintNFT": "0x3bdD104560Ae0F0cC4360E691Cdcd972F4CD1193",
  "GuardedKpiVerifier": "0xa8134d0d4E2a2E092527c3306CeA349292CB8a88",
  "EventMetricKpiVerifier": "0xFF69E2B4A1Cb96a59dbDD138fb7215dCa58aEBd6",
  "bUSD (pool token)": "0x2755562471B5f6239722ab164d126260F4D8dCc2",
  "clone SuperBridge": "0x0a01B03EBaCBb553AD5b269297921F32D261C45F",
  "clone Gyndore Testnet": "0x86B7b22aEd09452232Ca1A072db5BE7a837F06fc",
};
console.log("### addresses (checksummed)");
for (const [k, v] of Object.entries(ADDR)) console.log(`${k.padEnd(24)} ${getAddress(v as Hex)}`);

const SIGS = [
  "CampaignCreated(uint256,address,address,address,string)",
  "TouchStored(address,address,bytes32,uint64,uint64,address)",
  "Transfer(address,address,uint256)",
  "PromoterJoined(address,bytes32,uint256)",
  "AttestationStored(address,bytes32,uint256,bytes32)",
  "Minted(address,uint256,uint256)",
];
console.log("\n### signature -> topic0");
for (const s of SIGS) console.log(`${keccak256(toHex(s))}  ${s}`);

console.log("\n### filter values (bytes32)");
console.log(`T1 = 0x0 (mints only)      ${pad("0x00", {size: 32})}`);
console.log(`T1 = Gyndore clone         ${pad(getAddress(ADDR["clone Gyndore Testnet"] as Hex).toLowerCase() as Hex, {size: 32})}`);
