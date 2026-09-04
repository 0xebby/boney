/** Throwaway: per-referral Swap log block numbers, to line up against the ceiling write history. */
import {createPublicClient, http, pad, toHex, type Hex, type PublicClient} from "viem";
import {blockChunks} from "../src/lib/indexerCore";
const c = createPublicClient({transport: http("https://base-sepolia-rpc.publicnode.com",{retryCount:6})}) as PublicClient;
const POOL="0x7B47daC59075aF44046795BA347EC872D5409263";
const SWAP="0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const users=["0x030e293a83fa089ee00d3e5f70bd78d9ab8d2189","0x5a597273ee3312116abcc6b4824d6be89448055c","0x98bef22956549f6ab41db8828db539c185ea3f1b","0xc7df188878c319c46294b6c655865ca999375c5f"] as Hex[];
const words=users.map(u=>pad(u,{size:32}).toLowerCase() as Hex);
const head=await c.getBlockNumber();
const out=new Map<string,bigint[]>();
for (const ch of blockChunks(46215147n, head, 1900n)) {
  try {
    const raw=await c.request({method:"eth_getLogs",params:[{address:POOL,topics:[SWAP,null,words] as never,fromBlock:toHex(ch.from),toBlock:toHex(ch.to)}]}) as {topics:Hex[];blockNumber:Hex}[];
    for (const l of raw){const u=`0x${l.topics[2]!.slice(26)}`;out.set(u,[...(out.get(u)??[]),BigInt(l.blockNumber)]);}
  } catch {}
}
console.log("head", head);
for (const [u,bs] of out) console.log(u, bs.length, "blocks:", bs.join(", "));
