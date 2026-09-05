/** Throwaway: which tiers settled, and what each promoter has actually been paid. */
import {createPublicClient, http, getAddress, formatUnits} from "viem";
import {baseSepolia} from "viem/chains";
import {CampaignAbi} from "../src/lib/abis/Campaign";
import {IERC20MetadataAbi} from "../src/lib/abis/IERC20Metadata";

const CAMPAIGN = getAddress("0x86B7b22aEd09452232Ca1A072db5BE7a837F06fc");
const GYND = getAddress("0x0d442EC7BdDB06b531DCA3Dd39ABaFf554170776");
const PROMOTERS = [
  "0xc27a65590409a88e4722ba53895d111ea3b3cd44", "0x64d15744acdba91559b27d03a18f3b2b697cc6d9",
  "0x27781bd062b4e7efda001ed97786e1ebdc2fd433", "0xc7df188878c319c46294b6c655865ca999375c5f",
  "0x0198fa30b0458b4775b8ba98a9a97dc243eaad22", "0x98405c5776a63547e7cb16000ba04ca53d9fb2f8",
].map((a) => getAddress(a));

const client = createPublicClient({
  chain: baseSepolia,
  transport: http("https://base-sepolia-rpc.publicnode.com", {retryCount: 6, retryDelay: 800}),
});
const read = <T,>(functionName: string, args: unknown[] = []) =>
  client.readContract({address: CAMPAIGN, abi: CampaignAbi, functionName, args}) as Promise<T>;

const [sym, dec] = await Promise.all([
  client.readContract({address: GYND, abi: IERC20MetadataAbi, functionName: "symbol"}) as Promise<string>,
  client.readContract({address: GYND, abi: IERC20MetadataAbi, functionName: "decimals"}) as Promise<number>,
]);
console.log(`escrow token: ${sym} (${dec} decimals)  ${GYND}`);

const LADDER = [
  [[5n, 100n], [25n, 200n], [100n, 400n]],
  [[3n, 100n], [15n, 200n], [50n, 400n]],
  [[1n, 100n], [5n, 200n], [20n, 400n]],
];

let grand = 0n;
for (const p of PROMOTERS) {
  const lines: string[] = [];
  let earned = 0n;
  for (let k = 0; k < 3; k++) {
    const prog = await read<bigint>("progressOf", [p, BigInt(k)]);
    const settled = await read<bigint>("settledTiersOf", [p, BigInt(k)]);
    if (prog === 0n && settled === 0n) continue;
    let due = 0n;
    for (let t = 0; t < Number(settled); t++) due += LADDER[k]![t]![1]!;
    earned += due;
    lines.push(`    kpi#${k}: progress ${prog}  tiers settled ${settled}/3  paid ${due} ${sym}`);
  }
  grand += earned;
  console.log(`\n${p}  earned ${earned} ${sym}`);
  for (const l of lines) console.log(l);
}
const [pool, remaining, paid] = await Promise.all([
  read<any>("config").then((c) => c.rewardPool as bigint),
  read<bigint>("remainingPool"), read<bigint>("paidOut"),
]);
console.log(`\npool ${formatUnits(pool, dec)} ${sym}  paidOut ${formatUnits(paid, dec)}  remaining ${formatUnits(remaining, dec)}`);
console.log(`sum of settled tiers: ${grand} ${sym}  (matches paidOut: ${grand === paid / 10n ** BigInt(dec)})`);
