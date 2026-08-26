/**
 * Throwaway probe: run the real read path *and* the real fold against the deployed subgraph.
 *
 * The read path and the fold were both written without ever hitting the endpoint, so this is what
 * catches schema drift and numbers that only look right against hand-written fixtures.
 */
process.env.NEXT_PUBLIC_SUBGRAPH_URL =
  process.env.NEXT_PUBLIC_SUBGRAPH_URL ??
  "https://api.studio.thegraph.com/query/1757958/boney-indexer/v0.3.0";

import {fetchPromoterHistory} from "../src/lib/boneyHistory";
import {foldHistory} from "../src/lib/boneycard";

const WALLETS = [
  "0x98405c5776a63547e7cb16000ba04ca53d9fb2f8", // dev wallet, all 9 campaigns
  "0x0198fa30b0458b4775b8ba98a9a97dc243eaad22", // second promoter, lynx only
  "0x000000000000000000000000000000000000dEaD", // never joined anything
];

async function main() {
  for (const wallet of WALLETS) {
    const result = await fetchPromoterHistory({chainId: 84532, wallet});
    console.log(`\n=== ${wallet} ===`);
    if (result.kind !== "ok") {
      console.log(`UNAVAILABLE  reason=${result.reason}  ${result.message}`);
      continue;
    }

    const card = foldHistory(result.data, {now: Math.floor(Date.now() / 1000)});
    console.log({
      level: card.level,
      campaignsJoined: card.campaignsJoined,
      campaignsDelivered: card.campaignsDelivered,
      projects: card.projects,
      tiers: card.tiers,
      actions: card.actions,
      referrals: card.referrals,
      partial: card.partial,
      orphanPayouts: card.orphanPayouts,
      promotingSinceBlock: card.promotingSinceBlock?.toString(),
    });
    console.log("specializations:", card.specializations.join(" · ") || "(none)");
    console.log(
      "earned:",
      card.earned.map((e) => `${e.paid / BigInt(10) ** BigInt(18)} @ ${e.token} (${e.campaigns} campaigns)`),
    );
    console.log("milestones:");
    for (const m of card.milestones) {
      const when = m.at
        ? new Date(m.at * 1000).toISOString().slice(0, 10)
        : m.atBlock
          ? `block ${m.atBlock}`
          : "—";
      console.log(`  ${m.earned ? "✓" : "○"} ${m.label.padEnd(28)} ${when}`);
    }
    console.log("rows:");
    for (const r of card.rows) {
      const flags = [
        r.delivered ? `${r.actions} acts` : "no credit",
        r.aggregateOnly ? "NOT CREDITABLE (aggregate)" : "",
        r.endedEarly === true ? "ENDED EARLY" : "",
        r.tiers ? `${r.tiers} tiers` : "",
      ].filter(Boolean);
      console.log(`  ${r.campaign.name.padEnd(28)} [${r.campaign.status}] ${flags.join(" · ")}`);
    }
  }

  // Unsupported chain and unconfigured URL must be distinguishable, not both "network error".
  const anvil = await fetchPromoterHistory({chainId: 31337, wallet: WALLETS[0]});
  console.log(
    "\nanvil:",
    anvil.kind === "unavailable" ? `${anvil.reason} — ${anvil.message}` : "unexpectedly ok",
  );
}

void main();
