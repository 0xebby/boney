/**
 * Names a topic hash by hashing every event declared anywhere in the Solidity sources, so an
 * unrecognised topic in a scan can be resolved without guessing.
 */
import {readdirSync, readFileSync, statSync} from "node:fs";
import {join} from "node:path";
import {eventTopic} from "../src/lib/kpiSource";

const ROOT = "/home/ebby/boney/src";
const files: string[] = [];
const walk = (dir: string) => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path);
    else if (path.endsWith(".sol")) files.push(path);
  }
};
walk(ROOT);

/** Declared events, as `name(type,type)` with names, indexed markers and whitespace stripped. */
const byTopic = new Map<string, string>();
for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(/event\s+(\w+)\s*\(([^;]*?)\)\s*;/gs)) {
    const name = match[1]!;
    const args = match[2]!
      .split(",")
      .map((a) => a.trim().replace(/\s+/g, " "))
      .filter(Boolean)
      .map((a) => a.split(" ")[0]!)
      .map((t) => (t === "uint" ? "uint256" : t));
    if (args.some((a) => !/^[a-z]/.test(a))) continue;
    const signature = `${name}(${args.join(",")})`;
    try {
      byTopic.set(eventTopic(signature).toLowerCase(), signature);
    } catch { /* not a resolvable signature */ }
  }
}

// Third-party and OpenZeppelin events the scans also turn up.
for (const extra of [
  "OwnershipTransferred(address,address)",
  "Transfer(address,address,uint256)",
  "Approval(address,address,uint256)",
  "RoleGranted(bytes32,address,address)",
]) byTopic.set(eventTopic(extra).toLowerCase(), extra);

const WANTED = process.argv.slice(2);
for (const topic of WANTED) {
  console.log(`${topic}  ${byTopic.get(topic.toLowerCase()) ?? "UNKNOWN"}`);
}
if (WANTED.length === 0) {
  for (const [topic, signature] of [...byTopic].sort((a, b) => a[1].localeCompare(b[1]))) {
    console.log(`${topic}  ${signature}`);
  }
}
