import {createPublicClient, http} from "viem";
import {anvil} from "viem/chains";
import {fetchBrowseCampaigns} from "../src/lib/contracts.ts";
import {fetchCampaignDetail, fetchPromoterState} from "../src/lib/campaignDetail.ts";
import {settlementPayout} from "../src/lib/campaign.ts";

const client = createPublicClient({chain: anvil, transport: http("http://127.0.0.1:8545")});
const KOLS = {
  "KOL1 (acct2)": "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  "KOL2 (acct3)": "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
};

const views = await fetchBrowseCampaigns(client, 0n, 100n);
for (const v of views) {
  const detail = await fetchCampaignDetail(client, v.campaign);
  console.log(`\ncampaign ${v.campaignId} ${v.campaign} status=${detail.status} pool=${detail.rewardPool} paidOut=${detail.paidOut} remaining=${detail.remainingPool}`);
  for (const [name, who] of Object.entries(KOLS)) {
    const p = await fetchPromoterState(client, v.campaign, who, detail.kpis.length);
    if (!p?.joined) { console.log(`   ${name}: not joined`); continue; }
    for (const kpi of detail.kpis) {
      const s = p.perKpi.find((x) => x.kpiIndex === kpi.index);
      const {payout, shortfall} = settlementPayout(s?.progress ?? 0n, kpi.tiers, s?.settledTiers ?? 0, detail.remainingPool);
      console.log(`   ${name} kpi${kpi.index}: progress=${s?.progress} settledTiers=${s?.settledTiers}/${kpi.tiers.length} CLAIMABLE=${payout} shortfall=${shortfall}`);
    }
  }
}
