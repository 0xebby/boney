import {createPublicClient, http, pad, toHex, type Hex, type PublicClient} from "viem";
import {EVENT_PRESETS, WETH_BASE} from "../src/lib/kpiSource";
const client = createPublicClient({
  transport: http("https://base-sepolia-rpc.publicnode.com"),
}) as PublicClient;
const d = EVENT_PRESETS[0].source;
const ACTIVE = "0x5f9215dff5c01671e6e77469389d694ac4af2e97";
const IDLE = "0x98405c5776a63547e7cb16000ba04ca53d9fb2f8"; // dev wallet, a campaign 9 referral
async function q(addrs: string[], from: bigint, to: bigint) {
  const r = (await client.request({method: "eth_getLogs", params: [{address: WETH_BASE,
    topics: [d.topic0, addrs.map((a) => pad(a as Hex, {size: 32}))],
    fromBlock: toHex(from), toBlock: toHex(to)}]})) as unknown[];
  return r.length;
}
async function main() {
  const head = await client.getBlockNumber();
  const from = 45369010n, to = 45370909n;
  console.log(`window ${from}..${to} (head ${head})`);
  console.log(`[active]         -> ${await q([ACTIVE], from, to)}`);
  console.log(`[idle]           -> ${await q([IDLE], from, to)}`);
  console.log(`[idle, active]   -> ${await q([IDLE, ACTIVE], from, to)}`);
}
void main().catch((e) => {console.error(e); process.exit(1);});
