/**
 * Throwaway probe: run the real leaderboard read *and* the real fold against the deployed subgraph.
 *
 * `POINTS_QUERY` and `foldPoints` were both written against hand-written fixtures, and a field the
 * deployment does not have fails GraphQL *validation* — taking the whole document with it. This is
 * what catches that, and the point totals that only look right against a fixture.
 */
import {readFileSync} from "node:fs";

import {fetchPointsFromGraph} from "../src/lib/pointsGraph";
import {actionsOf, foldPoints} from "../src/lib/points";

/** The endpoint from `.env.local`, so the probe cannot drift from what the app reads. */
function subgraphFromEnvFile(): string | undefined {
  const path = new URL("../.env.local", import.meta.url);
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = line.match(/^\s*NEXT_PUBLIC_SUBGRAPH_URL\s*=\s*(.+)$/);
    if (match) return match[1]!.trim().replace(/^["']|["']$/g, "");
  }
  return undefined;
}

async function main() {
  process.env.NEXT_PUBLIC_SUBGRAPH_URL =
    process.env.NEXT_PUBLIC_SUBGRAPH_URL ?? subgraphFromEnvFile();

  const result = await fetchPointsFromGraph({chainId: 84532});
  if (result.kind !== "ok") {
    console.log(`UNAVAILABLE  reason=${result.reason}  ${result.message}`);
    return;
  }

  const {input, truncated, indexedBlock, hasIndexingErrors} = result.data;
  console.log(
    `read: joins=${input.joins.length} touches=${input.touches.length} ` +
      `credits=${input.credits.length} kpis=${input.kpis.length}`,
  );
  console.log(
    `truncated=${truncated} indexedBlock=${indexedBlock} indexingErrors=${hasIndexingErrors}`,
  );

  const rows = foldPoints(input);
  console.log(`\n${rows.length} wallet(s) ranked`);
  for (const row of rows) {
    console.log(
      `  #${String(row.rank).padStart(2)}  ${row.wallet}  ${String(row.total).padStart(7)} pts  ` +
        `${row.counts.joins} joined · ${row.counts.touches} signed · ${actionsOf(row)} actions`,
    );
  }

  // Unsupported chain and unconfigured URL must be distinguishable, not both "network error".
  const anvil = await fetchPointsFromGraph({chainId: 31337});
  console.log(
    `\nanvil: ${anvil.kind === "unavailable" ? `${anvil.reason} — ${anvil.message}` : "unexpectedly ok"}`,
  );

  process.env.NEXT_PUBLIC_SUBGRAPH_URL = "";
  const unset = await fetchPointsFromGraph({chainId: 84532});
  console.log(
    `unset: ${unset.kind === "unavailable" ? `${unset.reason} — ${unset.message}` : "unexpectedly ok"}`,
  );
}

void main();
