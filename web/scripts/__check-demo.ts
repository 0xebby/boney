/**
 * Throwaway check for the SeedDemo fixture: does the app's own read path see exactly six Active
 * campaigns expiring at 24h and 3/5/7/10/14 days, with the names the marketplace column renders?
 *
 * Run: pnpm tsx scripts/__check-demo.ts
 */
import {createPublicClient, http, type PublicClient} from "viem";
import {baseSepolia} from "viem/chains";
import {fetchBrowseCampaigns} from "../src/lib/contracts";
import {summarize, filterCampaigns, EMPTY_FILTERS} from "../src/lib/filters";
import {projectName, hasProjectName} from "../src/lib/projects";
import {utilization} from "../src/lib/campaign";
import {formatTokenAmount} from "../src/lib/format";

const RPC = process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC ?? "https://base-sepolia-rpc.publicnode.com";

const client = createPublicClient({chain: baseSepolia, transport: http(RPC)}) as PublicClient;

async function main() {
  const views = await fetchBrowseCampaigns(client, BigInt(0), BigInt(50));
  const now = Math.floor(Date.now() / 1000);

  console.log(`browse returned ${views.length} campaigns via ${RPC}\n`);
  for (const v of views) {
    const days = (Number(v.endTime) - now) / 86_400;
    console.log(
      `  id ${v.campaignId}  ${projectName(v).padEnd(10)} named=${hasProjectName(v)}  ` +
        `${v.status.padEnd(7)} expires in ${days.toFixed(2)}d  ` +
        `pool ${formatTokenAmount(v.rewardPool, 18, {maxFractionDigits: 0}).padStart(6)}  ` +
        `util ${utilization(v.rewardPool, v.paidOut)}%`,
    );
  }

  const summary = summarize(views);
  console.log(
    `\nsummary: count=${summary.count} active=${summary.activeCount} ` +
      `totalPool=${formatTokenAmount(summary.totalPool, 18, {maxFractionDigits: 0})} ` +
      `paidOut=${formatTokenAmount(summary.totalPaidOut, 18, {maxFractionDigits: 0})}`,
  );

  const expiryOrder = [...views].sort((a, b) => Number(a.endTime - b.endTime)).map((v) => v.campaignId);
  console.log(`expiry order by id: ${expiryOrder.join(", ")}`);
  console.log(`default filter keeps: ${filterCampaigns(views, EMPTY_FILTERS).length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
