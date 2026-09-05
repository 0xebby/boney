/**
 * Runs a `PromoterJoined` proposal against every campaign clone through the app's own probe, so each
 * clone's verdict is the one the create form would show.
 */
import {createPublicClient, http, getAddress} from "viem";
import {baseSepolia} from "viem/chains";
import {probeEventSource} from "../src/lib/kpiSource";

const client = createPublicClient({
  chain: baseSepolia,
  transport: http(process.env.BASE_SEPOLIA_RPC ?? "https://base-sepolia-rpc.publicnode.com"),
});

const CLONES: Array<[string, `0x${string}`]> = [
  ["Venus", getAddress("0x16FE7197F7Df62D86CD7606FA6F72dBF30A23491")],
  ["Sdy Labs", getAddress("0xF6f786589391410B41dEfBd02a4B6303Ca372542")],
  ["SuperBridge", getAddress("0x0a01B03EBaCBb553AD5b269297921F32D261C45F")],
  ["Gyndore Testnet", getAddress("0x86B7b22aEd09452232Ca1A072db5BE7a837F06fc")],
];

for (const [name, address] of CLONES) {
  const out = await probeEventSource(
    client as never,
    {
      source: address,
      signature: "PromoterJoined(address,bytes32,uint256)",
      actorTopic: 1,
      amountMode: "count",
      scale: "1",
    },
    {chainId: 84532},
  );
  console.log(`\n### ${name} ${address}`);
  for (const f of out) console.log(`  [${f.severity}] ${f.message}`);
}
