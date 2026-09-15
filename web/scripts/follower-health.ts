/** CLI for the follower-source health check. */

import {checkFollowerSources} from "../src/lib/follower-health";

type SourceResult = {
  name: string;
  ok: boolean;
  count: number | null;
  detail: string;
};

/**
 * Formats one follower-source result.
 *
 * @param source Source result to format.
 * @returns One printable status line.
 */
function formatSource(source: SourceResult): string {
  const status = source.ok ? "PASS" : "FAIL";
  const count = String(source.count ?? "-").padStart(12);
  return `  ${status}  ${source.name.padEnd(12)} ${count}  ${source.detail}`;
}

/**
 * Checks follower sources and exits nonzero when all are unusable.
 *
 * @returns Nothing.
 */
async function main(): Promise<void> {
  const report = await checkFollowerSources();

  console.log("Follower sources — reference handle (must clear the floor):");
  report.reference.forEach((source) => console.log(formatSource(source)));
  console.log("\nFollower sources — small handle (must resolve at all):");
  report.small.forEach((source) => console.log(formatSource(source)));
  console.log(
    `\nKaito smart followers: ${report.smartFollowers.count} (${report.smartFollowers.detail})`,
  );

  if (!report.healthy) {
    console.error(
      "\nNo follower source is returning usable data. Reach is degraded to 0 for every promoter.",
    );
    process.exit(1);
  }

  const degraded = report.reference.filter((source) => !source.ok);
  console.log(
    degraded.length > 0
      ? `\nHealthy, but ${degraded.map((source) => source.name).join(", ")} needs attention.`
      : "\nAll follower sources healthy.",
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
