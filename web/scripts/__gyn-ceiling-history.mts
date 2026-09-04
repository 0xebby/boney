/**
 * Throwaway: the write history of Boney's ceiling for one campaign — every `VerifiedTotalReported`
 * and `CheckpointAdvanced`, in block order, so an inflated total can be traced to the pass that wrote it.
 *
 * Run: pnpm tsx scripts/__gyn-ceiling-history.mts <campaign>
 */
import {createPublicClient, http, getAddress, toHex, type Hex, type PublicClient} from "viem";
import {GENERATED_DEPLOYMENTS} from "../src/lib/deployments";
import {blockChunks} from "../src/lib/indexerCore";

const RPC = "https://base-sepolia-rpc.publicnode.com";
const D = GENERATED_DEPLOYMENTS[84532]!;
const campaign = getAddress(process.argv[2]!);
const FROM = 46215147n;
const RANGE = 1900n;

const REPORTED = "0x" + "" as Hex; // filled below
const client = createPublicClient({transport: http(RPC, {retryCount: 6})}) as PublicClient;

type Raw = {topics: readonly Hex[]; data: Hex; blockNumber: Hex; transactionHash: Hex};

async function main() {
  const head = await client.getBlockNumber();
  const campaignWord = ("0x" + campaign.slice(2).toLowerCase().padStart(64, "0")) as Hex;

  const rows: {block: bigint; kind: string; kpi: number; user?: string; value: bigint; tx: Hex}[] = [];

  for (const c of blockChunks(FROM, head, RANGE)) {
    const raw = (await client.request({
      method: "eth_getLogs",
      params: [
        {
          address: D.eventMetricKpiVerifier,
          topics: [null, campaignWord] as never,
          fromBlock: toHex(c.from),
          toBlock: toHex(c.to),
        },
      ],
    })) as Raw[];

    for (const l of raw) {
      const t0 = l.topics[0]!.toLowerCase();
      const kpi = Number(BigInt(l.topics[2]!));
      // VerifiedTotalReported has 4 topics (3 indexed + sig); CheckpointAdvanced has 3.
      if (l.topics.length === 4) {
        rows.push({
          block: BigInt(l.blockNumber),
          kind: "reported",
          kpi,
          user: `0x${l.topics[3]!.slice(26)}`,
          value: BigInt(l.data),
          tx: l.transactionHash,
        });
      } else {
        rows.push({
          block: BigInt(l.blockNumber),
          kind: t0.startsWith("0x") && l.data !== "0x" ? "checkpoint" : "other",
          kpi,
          value: BigInt(l.data),
          tx: l.transactionHash,
        });
      }
    }
  }

  rows.sort((a, b) => Number(a.block - b.block));
  for (const r of rows) {
    if (r.kind === "reported") {
      console.log(
        `${r.block} kpi${r.kpi} reported ${r.user} -> ${r.value}   ${r.tx.slice(0, 12)}`,
      );
    } else {
      console.log(`${r.block} kpi${r.kpi} checkpoint -> ${r.value}   ${r.tx.slice(0, 12)}`);
    }
  }
  console.log(`\n${rows.length} row(s), head ${head}`);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
