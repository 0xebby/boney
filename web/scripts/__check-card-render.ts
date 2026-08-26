/**
 * Throwaway probe: render the card's history half against the **live** subgraph.
 *
 * There is no component-test tooling in this repo and no way to drive a browser here (headless
 * chromium will not launch), so this is what proves P5 renders — real rows from `boney-indexer`,
 * through the real fold, into the real component, printed as text.
 *
 * Dates are fabricated rather than looked up: `useBlockTimes` is a React hook, and the thing under
 * test is `withResolvedDates` feeding the component, not the RPC call.
 */
process.env.NEXT_PUBLIC_SUBGRAPH_URL =
  process.env.NEXT_PUBLIC_SUBGRAPH_URL ??
  "https://api.studio.thegraph.com/query/1757958/boney-indexer/v0.3.0";

import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {fetchPromoterHistory} from "../src/lib/boneyHistory";
import {foldHistory, milestoneBlocks, withResolvedDates} from "../src/lib/boneycard";
import {BoneyCardHistory} from "../src/components/BoneyCardHistory";
import {graphUnavailable} from "../src/lib/graph";

const DEV_WALLET = "0x98405c5776a63547e7cb16000ba04ca53d9fb2f8";
const NEVER_JOINED = "0x000000000000000000000000000000000000dEaD";

/** Tags out, one line per text node, so the copy can be read the way a promoter would. */
function text(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, "\n")
    .split("\n")
    .map((line) => line.replace(/&#x27;/g, "'").replace(/&amp;/g, "&").trim())
    .filter(Boolean)
    .join("\n  ");
}

async function render(label: string, wallet: string) {
  const result = await fetchPromoterHistory({chainId: 84532, wallet});
  if (result.kind !== "ok") {
    console.log(`\n### ${label}\nUNAVAILABLE ${result.reason} — ${result.message}`);
    return;
  }

  const folded = foldHistory(result.data, {now: Math.floor(Date.now() / 1000)});
  // One fabricated timestamp per join block, spaced a day apart, so the dated path is exercised.
  const times = new Map(
    milestoneBlocks(folded).map((block, i) => [block, 1_787_000_000 + i * 86_400]),
  );
  const card = withResolvedDates(folded, times);

  const markup = renderToStaticMarkup(
    createElement(BoneyCardHistory, {
      card,
      unavailable: undefined,
      isLoading: false,
      indexedBlock: result.data.indexedBlock,
      lag: BigInt(3),
      earnedToken: {symbol: "bUSD", decimals: 18},
    }),
  );

  console.log(`\n### ${label} (level ${card.level})\n  ${text(markup)}`);
}

async function main() {
  await render("dev wallet — 9 campaigns", DEV_WALLET);
  await render("never joined anything", NEVER_JOINED);

  // The two states that must not render as zeros.
  for (const reason of ["not-configured", "network"] as const) {
    const markup = renderToStaticMarkup(
      createElement(BoneyCardHistory, {
        card: undefined,
        unavailable: graphUnavailable(reason, `test: ${reason}`),
        isLoading: false,
        indexedBlock: undefined,
        lag: undefined,
        earnedToken: null,
      }),
    );
    console.log(`\n### unavailable: ${reason}\n  ${text(markup)}`);
  }
}

void main();
