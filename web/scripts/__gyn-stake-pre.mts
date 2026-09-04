/** Throwaway: balances, attribution and a simulated 1-GYND stake for every KOL ref wallet. */
import {readFileSync} from "node:fs";
import {createPublicClient, http, getAddress, formatEther, parseAbiItem, parseUnits, type Hex, type PublicClient} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {baseSepolia} from "viem/chains";
import {CampaignAbi, AttributionRegistryAbi} from "../src/lib/abis";
import {GENERATED_DEPLOYMENTS} from "../src/lib/deployments";

const RPC = process.env.BASE_SEPOLIA_RPC ?? "https://base-sepolia-rpc.publicnode.com";
const client = createPublicClient({chain: baseSepolia, transport: http(RPC, {retryCount: 5})}) as PublicClient;
const CAMPAIGN = getAddress("0x86B7b22aEd09452232Ca1A072db5BE7a837F06fc");
const STAKING = getAddress("0x5c0E023Ce4A353e5Cd9a43E28D2879Cb9e876865");
const GYND = getAddress("0x0d442EC7BdDB06b531DCA3Dd39ABaFf554170776");
const registry = GENERATED_DEPLOYMENTS[baseSepolia.id]!.attributionRegistry;

const ERC20 = [parseAbiItem("function balanceOf(address) view returns (uint256)"),
               parseAbiItem("function allowance(address,address) view returns (uint256)")];
const STAKE_ABI = [parseAbiItem("function stake(address token, uint256 amount)"),
                   parseAbiItem("function isStakeToken(address) view returns (bool)")];

console.log("isStakeToken(GYND)", await client.readContract({address: STAKING, abi: STAKE_ABI, functionName: "isStakeToken", args: [GYND]}));

const rows: {name: string; addr: Hex}[] = [];
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^\s*(KOL[\w]*)\s*=\s*(.+)$/);
  if (!m) continue;
  const raw = m[2].trim().replace(/^["']|["']$/g, "");
  const hex = (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) continue;
  rows.push({name: m[1], addr: privateKeyToAccount(hex).address});
}

for (const {name, addr} of rows) {
  const [eth, gynd, allowSt, touch] = await Promise.all([
    client.getBalance({address: addr}),
    client.readContract({address: GYND, abi: ERC20, functionName: "balanceOf", args: [addr]}) as Promise<bigint>,
    client.readContract({address: GYND, abi: ERC20, functionName: "allowance", args: [addr, STAKING]}) as Promise<bigint>,
    client.readContract({address: registry, abi: AttributionRegistryAbi, functionName: "touchOf", args: [CAMPAIGN, addr]}) as Promise<any>,
  ]);
  let prom = "none";
  if (touch.promoterId !== `0x${"00".repeat(32)}`) {
    const w = await client.readContract({address: CAMPAIGN, abi: CampaignAbi, functionName: "promoterOf", args: [touch.promoterId]});
    const live = Number(touch.expiresAt) > Date.now() / 1000;
    prom = `${w} ${live ? "live" : "EXPIRED"}`;
  }
  let sim = "ok";
  try {
    await client.simulateContract({address: STAKING, abi: STAKE_ABI, functionName: "stake", args: [GYND, parseUnits("1", 18)], account: addr});
  } catch (e) { sim = `REVERT: ${(e as Error).message.split("\n")[0]}`; }
  console.log(`${name.padEnd(10)} ${addr}  eth ${Number(formatEther(eth)).toFixed(5).padStart(9)}  gynd ${Number(formatEther(gynd)).toFixed(2).padStart(10)}  stakeAllow ${allowSt === 0n ? "0" : formatEther(allowSt)}  prom ${prom}  sim1GYND ${sim}`);
}
