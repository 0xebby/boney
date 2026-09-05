/**
 * Recounts every candidate event at the current head, one scan per address, so the figures quoted in
 * the write-up can be restated against one block rather than several.
 */
import {createPublicClient, http, getAddress, type Hex} from "viem";
import {baseSepolia} from "viem/chains";

const client = createPublicClient({
  chain: baseSepolia,
  transport: http(process.env.BASE_SEPOLIA_RPC ?? "https://base-sepolia-rpc.publicnode.com"),
});

const START = 46110182n;
const CHUNK = 9000n;
const head = await client.getBlockNumber();

const GROUPS: Array<[string, `0x${string}` | `0x${string}`[]]> = [
  ["registry", getAddress("0x3e0a2fc423dE77bEE9147879308BFfFC6129c4EE")],
  ["attribution", getAddress("0xe04C5185eDd4C9b1c91e31c790843c335766258e")],
  ["vault", getAddress("0x880fd3271f83b8B68E2E2Ff9888706fEF1b70D7b")],
  ["reputation", getAddress("0x8B601B46C9Bd74F991F5A17d4bF674A837Ebed52")],
  ["attestVerifier", getAddress("0xA73fA728aF15da26998BD855985F85615224E576")],
  ["eventMetric", getAddress("0xFF69E2B4A1Cb96a59dbDD138fb7215dCa58aEBd6")],
  ["oracle", getAddress("0x94EaBe8FBB05AbaEB2fC28Edc41A5533Ea0d4c3B")],
  ["nft", getAddress("0x3bdD104560Ae0F0cC4360E691Cdcd972F4CD1193")],
  ["clones", [
    getAddress("0x16FE7197F7Df62D86CD7606FA6F72dBF30A23491"),
    getAddress("0xF6f786589391410B41dEfBd02a4B6303Ca372542"),
    getAddress("0x0a01B03EBaCBb553AD5b269297921F32D261C45F"),
    getAddress("0x86B7b22aEd09452232Ca1A072db5BE7a837F06fc"),
  ]],
];

console.log(`head=${head}  start=${START}`);
for (const [label, address] of GROUPS) {
  const counts = new Map<string, number>();
  let from = START;
  while (from <= head) {
    const to = from + CHUNK - 1n > head ? head : from + CHUNK - 1n;
    try {
      const got = (await client.getLogs({address, fromBlock: from, toBlock: to} as never)) as unknown as
        {topics: readonly Hex[]}[];
      for (const l of got) {
        const t = l.topics[0] ?? "0x";
        counts.set(t, (counts.get(t) ?? 0) + 1);
      }
    } catch { /* chunk skipped */ }
    from = to + 1n;
  }
  const rows = [...counts].sort((a, b) => b[1] - a[1]);
  console.log(`\n### ${label}`);
  for (const [topic, n] of rows) console.log(`  ${topic}  ${n}`);
}
