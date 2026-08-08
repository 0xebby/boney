/**
 * CLI wrapper for the follower-source health check — `pnpm followers:health`.
 *
 * Exits non-zero when no source can still produce a real count, so CI can schedule it and find out
 * that reach has gone dark from a red build rather than from a promoter asking why their score
 * dropped.
 */

import {checkFollowerSources} from "../src/lib/follower-health";

async function main(): Promise<void> {
  const report = await checkFollowerSources();

  const line = (s: {name: string; ok: boolean; count: number | null; detail: string}) =>
    `  ${s.ok ? "PASS" : "FAIL"}  ${s.name.padEnd(12)} ${String(s.count ?? "-").padStart(12)}  ${s.detail}`;

  console.log("Follower sources — reference handle (must clear the floor):");
  report.reference.forEach((s) => console.log(line(s)));
  console.log("\nFollower sources — small handle (must resolve at all):");
  report.small.forEach((s) => console.log(line(s)));
  console.log(
    `\nKaito smart followers: ${report.smartFollowers.count} (${report.smartFollowers.detail})`,
  );

  if (!report.healthy) {
    console.error(
      "\nNo follower source is returning usable data. Reach is degraded to 0 for every promoter.",
    );
    process.exit(1);
  }

  const degraded = report.reference.filter((s) => !s.ok);
  if (degraded.length > 0) {
    console.log(`\nHealthy, but ${degraded.map((s) => s.name).join(", ")} needs attention.`);
  } else {
    console.log("\nAll follower sources healthy.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
