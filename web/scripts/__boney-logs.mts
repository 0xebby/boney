/**
 * Wide historical scan of the Boney protocol's own event logs on Base Sepolia.
 *
 * The app's probe only looks back `PROBE_BLOCK_RANGE`, which is the right question for a create
 * form and the wrong one for deciding whether a shape has ever fired. This walks from the
 * subgraph's `startBlock` to head and reports, per candidate, how many logs exist, whether the
 * proposed actor topic really holds an address, and what the first non-indexed word looks like.
 */
import {createPublicClient, http, getAddress, type Hex} from "viem";
import {baseSepolia} from "viem/chains";
import {eventTopic} from "../src/lib/kpiSource";

const client = createPublicClient({
  chain: baseSepolia,
  transport: http(process.env.BASE_SEPOLIA_RPC ?? "https://base-sepolia-rpc.publicnode.com"),
});

const A = {
  campaignRegistry: getAddress("0x3e0a2fc423dE77bEE9147879308BFfFC6129c4EE"),
  attributionRegistry: getAddress("0xe04C5185eDd4C9b1c91e31c790843c335766258e"),
  escrowVault: getAddress("0x880fd3271f83b8B68E2E2Ff9888706fEF1b70D7b"),
  reputationRegistry: getAddress("0x8B601B46C9Bd74F991F5A17d4bF674A837Ebed52"),
  oracleCoordinator: getAddress("0x94EaBe8FBB05AbaEB2fC28Edc41A5533Ea0d4c3B"),
  attestationVerifier: getAddress("0xA73fA728aF15da26998BD855985F85615224E576"),
  eventMetric: getAddress("0xFF69E2B4A1Cb96a59dbDD138fb7215dCa58aEBd6"),
  nft: getAddress("0x3bdd104560ae0f0cc4360e691cdcd972f4cd1193"),
};

const START = 46110182n;
const CHUNK = 9000n;

type Cand = {name: string; source: `0x${string}`; sig: string};

const CANDS: Cand[] = [
  {name: "CampaignCreated", source: A.campaignRegistry, sig: "CampaignCreated(uint256,address,address,address,string)"},
  {name: "TouchStored", source: A.attributionRegistry, sig: "TouchStored(address,address,bytes32,uint64,uint64,address)"},
  {name: "PromoterRegistered", source: A.attributionRegistry, sig: "PromoterRegistered(address,bytes32)"},
  {name: "Deposited", source: A.escrowVault, sig: "Deposited(address,address,uint256)"},
  {name: "Released", source: A.escrowVault, sig: "Released(address,address,uint256)"},
  {name: "Reclaimed", source: A.escrowVault, sig: "Reclaimed(address,address,uint256)"},
  {name: "CampaignRegistered", source: A.escrowVault, sig: "CampaignRegistered(address,address)"},
  {name: "AttestationStored", source: A.reputationRegistry, sig: "AttestationStored(address,bytes32,uint256,bytes32)"},
  {name: "AttestationVerified", source: A.attestationVerifier, sig: "AttestationVerified(bytes32)"},
  {name: "ReporterStaked", source: A.oracleCoordinator, sig: "ReporterStaked(address,uint256)"},
  {name: "ReportSubmitted", source: A.oracleCoordinator, sig: "ReportSubmitted(bytes32,address,address,uint256)"},
  {name: "VerifiedTotalReported", source: A.eventMetric, sig: "VerifiedTotalReported(address,uint256,address,uint256)"},
  {name: "NFT Minted", source: A.nft, sig: "Minted(address,uint256,uint256)"},
  {name: "NFT Transfer", source: A.nft, sig: "Transfer(address,address,uint256)"},
];

const head = await client.getBlockNumber();
console.log(`head=${head} start=${START} span=${head - START} chunk=${CHUNK}`);

const isAddrWord = (w: Hex) => w.length === 66 && /^0x0{24}[0-9a-f]{40}$/i.test(w);

for (const c of CANDS) {
  const topic0 = eventTopic(c.sig);
  const logs: {topics: readonly Hex[]; data: Hex; blockNumber: bigint | null}[] = [];
  let from = START;
  let calls = 0;
  let failed = 0;
  while (from <= head) {
    const to = from + CHUNK - 1n > head ? head : from + CHUNK - 1n;
    try {
      const got = await client.getLogs({address: c.source, event: undefined, fromBlock: from, toBlock: to, args: undefined} as never);
      calls++;
      for (const l of got as never as typeof logs) {
        if (l.topics[0]?.toLowerCase() === topic0.toLowerCase()) logs.push(l);
      }
    } catch (e) {
      failed++;
      if (failed <= 1) console.log(`  ! ${c.name} ${from}-${to}: ${(e as Error).message.split("\n")[0].slice(0, 90)}`);
    }
    from = to + 1n;
  }

  console.log(`\n### ${c.name}  ${c.sig}`);
  console.log(`    source=${c.source} topic0=${topic0}`);
  console.log(`    logs=${logs.length} chunks=${calls} failed=${failed}`);
  if (logs.length === 0) continue;

  const topicCount = logs[0].topics.length - 1;
  console.log(`    indexed topics=${topicCount} dataWords=${(logs[0].data.length - 2) / 64}`);
  for (let t = 1; t <= topicCount; t++) {
    const vals = logs.map((l) => l.topics[t]!).filter(Boolean);
    const addrLike = vals.filter(isAddrWord).length;
    const distinct = new Set(vals.map((v) => v.toLowerCase())).size;
    console.log(`      T${t}: address-shaped ${addrLike}/${vals.length}  distinct=${distinct}  e.g. ${vals[0]}`);
  }
  if (logs[0].data.length > 2) {
    const w0 = logs.map((l) => BigInt(l.data.slice(0, 66)));
    const min = w0.reduce((m, v) => (v < m ? v : m));
    const max = w0.reduce((m, v) => (v > m ? v : m));
    const signedHigh = w0.some((v) => v >= 1n << 255n);
    console.log(`      dataWord0: min=${min} max=${max} negative-if-signed=${signedHigh}`);
  }
  console.log(`    blocks: first=${logs[0].blockNumber} last=${logs[logs.length - 1].blockNumber}`);
}
