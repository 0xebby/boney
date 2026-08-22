import {decodeEventSource} from "./kpiSource";
import {resolveTrackedEvent, shortTopic} from "./eventNames";
import {KPI_KIND_LABEL, type KpiSpec} from "./types";
import type {CampaignView} from "./types";

/**
 * What a campaign measures, condensed to one table cell.
 *
 * The marketplace used to print `kpiCount` — a number that answers "how many milestones" and not the
 * question a visitor scanning the list actually has, which is "is this a deposits campaign or a
 * bridge campaign". `kind` is the one part of a KPI that reads without decoding anything (`Types.sol`
 * calls it "a hint for indexers and UIs"), so it belongs in the column that the count occupied.
 *
 * Pure, and deliberately read-only about the chain: the hover text names the tracked event from the
 * local catalog and the escrow-token metadata the list already loaded, never a fresh read. A table of
 * a hundred rows cannot afford a per-row round trip to sharpen a tooltip, and the campaign's own page
 * resolves the authoritative name anyway (`useTrackedEvent`).
 */

export type KindSummary = {
  /** The first distinct kind label, e.g. `Deposits`. */
  label: string;
  /**
   * How many *other* distinct kinds the campaign carries.
   *
   * Distinct, not "count minus one": two KPIs of the same kind are one answer to "what does this
   * measure", and rendering `Token purchases +1` for them would promise a second thing that is not
   * there. The hover text still lists every KPI.
   */
  extra: number;
  /** Multi-line hover text, one line per KPI. */
  title: string;
  /** Sorts the column the way it reads. */
  sortValue: string;
};

/** Everything the summary can learn without a chain read. */
export type SummaryContext = {
  chainId?: number;
  /** The campaign's escrow token, lowercased, and what it calls itself. See `tokenSymbol`. */
  escrowToken?: string;
  /**
   * Symbol of that token, from the metadata `useCampaigns` already fetched.
   *
   * Most seeded campaigns watch `Transfer` on the very token they escrow, so this names the watched
   * contract for free — the same answer `useTrackedEvent` would get from a `symbol()` call.
   */
  tokenSymbol?: string;
  /** The campaign's name, the last-resort label for a watched contract. */
  campaignName?: string;
};

export function summarizeKinds(
  specs: readonly KpiSpec[],
  context: SummaryContext = {},
): KindSummary | null {
  if (specs.length === 0) return null;

  const labels: string[] = [];
  for (const spec of specs) {
    const label = KPI_KIND_LABEL[spec.kind];
    if (!labels.includes(label)) labels.push(label);
  }

  return {
    label: labels[0],
    extra: labels.length - 1,
    title: specs.map((spec) => describeKpi(spec, context)).join("\n"),
    sortValue: labels[0],
  };
}

/**
 * One hover line: the kind, then how it is measured.
 *
 * A KPI with no event source says so rather than going quiet — "reported by the project" and
 * "credited from this contract's logs" are the two trust models on offer here, and which one a
 * campaign uses is the more interesting half of the line.
 */
function describeKpi(spec: KpiSpec, context: SummaryContext): string {
  const kind = KPI_KIND_LABEL[spec.kind];
  const source = decodeEventSource(spec.params);
  if (!source) return `${kind} — reported by the project`;

  const watchesEscrowToken =
    context.escrowToken !== undefined &&
    source.source.toLowerCase() === context.escrowToken.toLowerCase();

  const tracked = resolveTrackedEvent({
    source,
    kind: spec.kind,
    chainId: context.chainId,
    scanned: watchesEscrowToken ? {symbol: context.tokenSymbol} : undefined,
    campaignName: context.campaignName,
  });

  // With no signature to show, the name resolved from `kind` — which this line already opened with.
  // Repeating it ("Deposits — Deposits on …") would spend the informative half of the line on an echo.
  const event =
    tracked.eventFrom === "kind" ? `unrecognised event ${shortTopic(tracked.topic0)}` : tracked.event;

  return `${kind} — ${event} on ${tracked.protocol}`;
}

/**
 * Which campaigns to read specs for, and how many reads that is.
 *
 * `kpiCount` comes free on every summary row, so the exact cost is known before a single call goes
 * out: one `kpi(i)` per KPI. The cap is a floor under a pathological page — a hundred campaigns with
 * thirty-two KPIs each is 3,200 reads against a rate-limited public endpoint — and it truncates by
 * *campaign* so a row either gets its full kind list or keeps the count fallback, never a partial
 * list that silently understates what a campaign measures.
 *
 * Truncation is reported (`dropped`) rather than absorbed: a column that quietly stopped describing
 * the tail of the list would read as "these campaigns have no KPIs".
 */
export const MAX_SPEC_READS = 256;

export type SpecReadPlan = {
  targets: {campaign: `0x${string}`; count: number}[];
  /** Campaigns left out by the cap. */
  dropped: number;
};

export function planSpecReads(
  campaigns: readonly Pick<CampaignView, "campaign" | "kpiCount">[],
  budget: number = MAX_SPEC_READS,
): SpecReadPlan {
  const targets: SpecReadPlan["targets"] = [];
  let spent = 0;
  let dropped = 0;

  for (const view of campaigns) {
    const count = Number(view.kpiCount);
    // A campaign with no KPIs has nothing to read and nothing to say; it keeps the count fallback,
    // which renders "0". Not a drop — no cap was hit reaching that answer.
    if (count <= 0) continue;

    if (spent + count > budget) {
      dropped += 1;
      continue;
    }

    targets.push({campaign: view.campaign, count});
    spent += count;
  }

  return {targets, dropped};
}
