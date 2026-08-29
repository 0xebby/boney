import Link from "next/link";
import {Card, CardHeader} from "@/components/ui/Card";
import {StatTile, StatRow} from "@/components/ui/StatTile";
import {StatusPill} from "@/components/ui/StatusPill";
import {BoneGlyph} from "@/components/ui/Bone";
import {ErrorState, SkeletonRows} from "@/components/ui/States";
import {
  nextMilestone,
  orderedMilestones,
  type CardHistory,
  type Milestone,
} from "@/lib/boneycard";
import type {CampaignHistoryRow} from "@/lib/boneycard";
import type {GraphUnavailable} from "@/lib/graph";
import {formatDate, formatTokenAmount} from "@/lib/format";
import type {TokenMeta} from "@/lib/token";
import {KPI_KIND_LABEL} from "@/lib/types";

/**
 * The BoneyCard's history half — stage 2.
 *
 * Its own component rather than a section of `BoneyCard` because the public card at `/b/<wallet>`
 * renders exactly this for a wallet that is not the viewer's, and the only difference is the voice.
 *
 * **Deliberately not `"use client"`.** It holds no state and no effects, so leaving the directive off
 * makes it a shared component: `/card` pulls it into its own client bundle by importing it, and
 * `/b/<wallet>` renders it on the server with no client JavaScript and no props crossing a
 * serialization boundary. The only client-only prop is `onRetry`, which the server-rendered page simply
 * does not pass — there a reload *is* the retry.
 *
 * ## Every number here is a cumulative count, and that is a design decision
 *
 * No percentages, no ratios, no "delivered 25 of 27". A percentage exists to be compared, and the
 * moment the card shows one it is a ranking whether or not anything sorts on it — so the card carries
 * milestones and totals that only ever go up. That is also why there is **no chart on this card**: per
 * the form heuristic, a lone current value is a stat tile, and these four values are four different
 * units (campaigns, tiers, wallets, money) with no shared scale to plot them against. A grouped bar of
 * them would be the dual-axis mistake wearing a different hat.
 *
 * The specialization badges are the one place identity could have become colour. They are words in
 * text tokens inside hairline pills instead: there is no magnitude to encode, so a categorical hue
 * would be decoration that a colourblind reader has to decode for no information.
 *
 * ## Three states before any number renders
 *
 * `unavailable` — the subgraph could not be believed. Renders as words, never as zeros: "0 campaigns,
 * 0 tiers, 0 referrals" is a claim about a person, and a fetch that did not complete has not earned
 * the right to make one. Two of the six reasons are not failures at all (no endpoint configured, a
 * chain with no deployment) and say so without offering a retry that cannot help.
 *
 * `campaignsJoined === 0` — the empty card, and the state most promoters see first. It gets the
 * milestone list with the next step named as an instruction rather than a grid of zeroes, because this
 * is the render that decides whether the card reads as an invitation or a void.
 *
 * `partial` — the rows are real but incomplete, either because a page cap was hit or because a
 * subgraph handler threw. The counts are floors, and the footer says so rather than presenting them
 * as totals.
 */

/**
 * Who the card is being read by.
 *
 * `self` is the connected wallet at `/card`; `other` is the public card at `/b/<wallet>`, where the
 * subject is somebody the reader may not know. Every sentence that addresses a person switches, and one
 * behaviour switches with it: unearned milestones stop being instructions. "Join your first campaign"
 * is advice, and advice aimed at a stranger's card is aimed at the wrong reader.
 */
export type HistoryVoice = {kind: "self"} | {kind: "other"; subject: string};

const SELF: HistoryVoice = {kind: "self"};

type HistoryCopy = {
  title: string;
  subtitle: string;
  emptyTitle: string;
  emptyBody: string;
  notIndexedNote: string;
  orphanNote: (n: number) => string;
  /** Unearned milestones read as instructions, and the next one is marked. `self` only. */
  instruct: boolean;
};

/**
 * All of the card's prose, in one block.
 *
 * Gathered here rather than inlined at each use so the two voices can be read against each other — the
 * failure mode of a per-site conditional is one sentence that keeps saying "you" on somebody else's
 * card, and that is not visible until it is in front of a reader.
 */
function copyFor(voice: HistoryVoice): HistoryCopy {
  if (voice.kind === "self") {
    return {
      title: "Your history",
      subtitle: "Everything you have done on Boneyard, counted. These only ever go up.",
      emptyTitle: "Your history starts with one campaign",
      emptyBody:
        "Join a campaign from the list above, share your tracking link, and the actions it earns " +
        "fill in here. Nothing on this half of the card can go down.",
      notIndexedNote:
        "Your score and the campaigns above need no indexer — only the history half does.",
      orphanNote: (n) =>
        `${n} reward ${n === 1 ? "payout" : "payouts"} could not be matched to a campaign you ` +
        "joined. They are counted in your tiers but left out of what you earned.",
      instruct: true,
    };
  }

  return {
    title: "History",
    subtitle: `Everything ${voice.subject} has done on Boneyard, counted. These only ever go up.`,
    emptyTitle: "No campaigns yet",
    emptyBody: `${voice.subject} has not joined a campaign on Boneyard yet. The campaigns, referrals and reward tiers they earn will fill in here.`,
    notIndexedNote: "The score above needs no indexer — only the history half does.",
    orphanNote: (n) =>
      `${n} reward ${n === 1 ? "payout" : "payouts"} could not be matched to a campaign this ` +
      "wallet joined. They are counted in the tier total but left out of what it earned.",
    instruct: false,
  };
}

export function BoneyCardHistory({
  card,
  unavailable,
  isLoading,
  indexedBlock,
  lag,
  earnedToken,
  voice = SELF,
  onRetry,
}: {
  /** The fold. Present only on a successful read. */
  card: CardHistory | undefined;
  /** Present only on a failed one. Mutually exclusive with `card` by construction. */
  unavailable: GraphUnavailable | undefined;
  isLoading: boolean;
  indexedBlock: bigint | undefined;
  /** Blocks behind the chain head. Undefined until both numbers are in. */
  lag: bigint | undefined;
  /** Metadata for the dominant earned token. Null when the read has not landed or failed. */
  earnedToken: TokenMeta | null;
  /** Defaults to the connected wallet reading its own card. */
  voice?: HistoryVoice;
  onRetry?: () => void;
}) {
  const copy = copyFor(voice);

  return (
    <Card>
      <CardHeader title={copy.title} subtitle={copy.subtitle} />

      {isLoading ? (
        <SkeletonRows rows={3} cols={4} />
      ) : unavailable ? (
        <Unavailable unavailable={unavailable} copy={copy} onRetry={onRetry} />
      ) : !card ? (
        // Defensive. With a wallet the read is always loading, ok, or unavailable, and `BoneyCard`
        // renders nothing at all without one — so this is reachable only from a host that mounts the
        // section before starting a query.
        <p className="text-xs text-ink-muted">No history has been read for this wallet.</p>
      ) : card.campaignsJoined === 0 ? (
        <EmptyHistory milestones={card.milestones} copy={copy} />
      ) : (
        <Filled card={card} earnedToken={earnedToken} copy={copy} />
      )}

      {card ? <Footer card={card} indexedBlock={indexedBlock} lag={lag} copy={copy} /> : null}
    </Card>
  );
}

/**
 * The subgraph could not be believed.
 *
 * Split on reason because two of them are not errors and the copy should not apologise for them: an
 * unset endpoint and a chain with no deployment are both "this build does not index history here",
 * which a retry cannot change. The rest get `ErrorState` and a retry.
 */
function Unavailable({
  unavailable,
  copy,
  onRetry,
}: {
  unavailable: GraphUnavailable;
  copy: HistoryCopy;
  onRetry?: () => void;
}) {
  const expected =
    unavailable.reason === "not-configured" || unavailable.reason === "unsupported-chain";

  if (expected) {
    return (
      <div className="flex flex-col gap-1.5 rounded border border-hairline bg-surface-2 p-3">
        <p className="text-sm font-semibold text-ink">History not indexed here</p>
        <p className="text-xs text-ink-secondary">{unavailable.message}</p>
        <p className="text-xs text-ink-muted">{copy.notIndexedNote}</p>
      </div>
    );
  }

  return (
    <ErrorState
      message="History unavailable"
      detail={`${unavailable.message} (${unavailable.reason})`}
      onRetry={onRetry}
    />
  );
}

/**
 * Nothing joined yet.
 *
 * Deliberately not a grid of zeros. The counts would all be 0 and all be true, and they would still be
 * the wrong thing to show — a new promoter needs the next step, which is the first milestone. Every
 * milestone renders, so the ladder is visible from the first screen rather than revealed one rung at a
 * time.
 */
function EmptyHistory({
  milestones,
  copy,
}: {
  milestones: readonly Milestone[];
  copy: HistoryCopy;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5 rounded border border-hairline bg-surface-2 p-3">
        <p className="text-sm font-semibold text-ink">{copy.emptyTitle}</p>
        <p className="text-xs text-ink-secondary">{copy.emptyBody}</p>
      </div>
      <Milestones milestones={milestones} copy={copy} />
    </div>
  );
}

/** The counts, the badges, the milestones and the per-campaign rows. */
function Filled({
  card,
  earnedToken,
  copy,
}: {
  card: CardHistory;
  earnedToken: TokenMeta | null;
  copy: HistoryCopy;
}) {
  return (
    <div className="flex flex-col gap-4">
      <Counts card={card} earnedToken={earnedToken} />
      <Specializations card={card} />
      <Milestones milestones={card.milestones} copy={copy} />
      <CampaignRows rows={card.rows} />
    </div>
  );
}

/**
 * The four headline counts.
 *
 * Numbers only — each tile is a label and a figure, with no descriptive line under it. Four tiles
 * rather than seven: "19 projects" would take the same visual weight as "25 tiers crossed" while
 * saying much less, since one project address is behind every campaign on this deployment.
 */
function Counts({
  card,
  earnedToken,
}: {
  card: CardHistory;
  earnedToken: TokenMeta | null;
}) {
  const dominant = card.earned[0];
  const others = card.earned.length - 1;

  return (
    <StatRow>
      <StatTile label="CAMPAIGNS JOINED" value={card.campaignsJoined.toLocaleString()} />
      <StatTile label="TIERS CROSSED" value={card.tiers.toLocaleString()} />
      <StatTile label="REFERRALS BROUGHT" value={card.referrals.toLocaleString()} />
      <EarnedTile dominant={dominant} others={others} meta={earnedToken} />
    </StatRow>
  );
}

/**
 * Earnings in the dominant token, never a total across tokens.
 *
 * Base Sepolia alone carries two mock bUSD deployments at different addresses, so adding them would
 * assert a 1:1 rate nobody set. The other tokens are counted, not converted.
 *
 * Unresolved metadata renders a dash rather than a number. Decimals are the *scale* an amount is read
 * at, so falling back to 18 for an unread 6-decimal token would overstate a payout by a factor of a
 * trillion — the same silent-corruption risk `useTokenMeta` was written to remove from the create form.
 */
function EarnedTile({
  dominant,
  others,
  meta,
}: {
  dominant: CardHistory["earned"][number] | undefined;
  others: number;
  meta: TokenMeta | null;
}) {
  if (!dominant) return <StatTile label="EARNED" value="0" />;
  if (!meta) return <StatTile label="EARNED" value="—" />;

  return (
    <StatTile
      label="EARNED"
      value={formatTokenAmount(dominant.paid, meta.decimals, {compact: true})}
      unit={meta.symbol}
      // Earnings in other tokens are counted, never converted — the count qualifies the figure it
      // sits on rather than describing it.
      qualifier={others > 0 ? `+ ${others} other ${others === 1 ? "token" : "tokens"}` : undefined}
    />
  );
}

/**
 * What this promoter has actually delivered on, named in protocol terms.
 *
 * Earned by holding credit on a KPI of that kind — so these are claims the chain backs, not
 * self-description. Words in a hairline pill rather than coloured chips: there is no magnitude here to
 * encode, and a categorical hue would be something to decode for no added information.
 */
function Specializations({card}: {card: CardHistory}) {
  if (card.specializations.length === 0) return null;

  return (
    <div>
      <p className="mb-1.5 text-xs font-bold text-brand">VERIFIED ON</p>
      <ul className="flex flex-wrap gap-1.5">
        {card.specializations.map((kind) => (
          <li
            key={kind}
            className="rounded-full border border-hairline bg-surface-2 px-2.5 py-1 text-xs text-ink-secondary"
          >
            {KPI_KIND_LABEL[kind]}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The dated list of firsts.
 *
 * Earned rungs carry a filled bone and a date; the rest are faint. State is not colour alone — an
 * earned rung has a date where an unearned one does not, so the two read differently in greyscale and
 * to a screen reader.
 *
 * On the reader's own card the next rung is marked and worded as an instruction. On somebody else's it
 * is not: "Join your first campaign" is advice, and a stranger's card is the wrong place to give it —
 * there the unearned rungs simply sit undated, which is the fact.
 *
 * A milestone with `atBlock` and no `at` is one whose block lookup did not resolve. It renders the
 * block number, because a promoter's first join is a fact and an RPC failure should cost the *format*
 * of that fact, not the fact.
 */
function Milestones({
  milestones,
  copy,
}: {
  milestones: readonly Milestone[];
  copy: HistoryCopy;
}) {
  const next = copy.instruct ? nextMilestone(milestones) : undefined;
  const ordered = orderedMilestones(milestones);

  return (
    <div>
      <p className="mb-1.5 text-xs font-bold text-brand">MILESTONES</p>
      <ul className="flex flex-col">
        {ordered.map((milestone) => {
          const isNext = milestone.key === next?.key;
          return (
            <li
              key={milestone.key}
              className="flex items-baseline gap-2.5 border-b border-hairline py-1.5 last:border-b-0"
            >
              <span aria-hidden className="flex w-4 shrink-0 justify-center self-center">
                {milestone.earned ? (
                  <BoneGlyph className="h-2.5 w-4 text-brand" />
                ) : (
                  <span
                    className={`size-2 rounded-full border ${
                      isNext ? "border-brand" : "border-hairline-strong"
                    }`}
                  />
                )}
              </span>

              <span
                className={`flex-1 text-xs ${
                  milestone.earned
                    ? "text-ink"
                    : isNext
                      ? "text-ink-secondary"
                      : "text-ink-muted"
                }`}
              >
                {milestone.earned || !copy.instruct ? milestone.label : milestone.todo}
              </span>

              <span className="tnum shrink-0 text-xs text-ink-muted">
                {milestone.at !== undefined
                  ? formatDate(milestone.at)
                  : milestone.atBlock !== undefined
                    ? `block ${milestone.atBlock.toLocaleString()}`
                    : isNext
                      ? "next"
                      : ""}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Per campaign, most recently joined first.
 *
 * This is the only place `Credit` amounts could have been shown, and they are not: one campaign's
 * amount is a swap count, another's is raw wei, another's a token total awaiting `Kpi.scale`. The row
 * counts actions instead, which is comparable across campaigns because it counts events rather than
 * their units.
 *
 * A row is its counts and its status pill — no explanatory sentence underneath.
 */
function CampaignRows({rows}: {rows: readonly CampaignHistoryRow[]}) {
  if (rows.length === 0) return null;

  return (
    <div>
      <p className="mb-1.5 text-xs font-bold text-brand">CAMPAIGN BY CAMPAIGN</p>
      <ul className="divide-y divide-hairline rounded border border-hairline">
        {rows.map((row) => (
          <li key={row.campaign.address} className="flex flex-col gap-1 px-3 py-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Link
                className="text-sm text-ink underline decoration-hairline"
                href={`/campaign/${row.campaign.campaignId}`}
              >
                {row.campaign.name || "unnamed campaign"}
              </Link>
              <StatusPill status={row.campaign.status} />
            </div>

            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-ink-muted">
              <span className="tnum">
                {row.actions.toLocaleString()} {row.actions === 1 ? "action" : "actions"}
              </span>
              <span className="tnum">
                {row.referrals.toLocaleString()}{" "}
                {row.referrals === 1 ? "referral" : "referrals"}
              </span>
              <span className="tnum">
                {row.tiers.toLocaleString()} {row.tiers === 1 ? "tier" : "tiers"}
              </span>
              {row.kinds.length > 0 ? (
                <span>{row.kinds.map((kind) => KPI_KIND_LABEL[kind]).join(" · ")}</span>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Where the numbers came from and how far they can be trusted.
 *
 * The indexed block is stated rather than hidden: a promoter who just crossed a tier and cannot see it
 * needs "indexed to 4 blocks ago", not a card that looks wrong. Same reasoning as `partial` — a count
 * that might be a floor has to say so, because the alternative is a total that is quietly too low.
 */
function Footer({
  card,
  indexedBlock,
  lag,
  copy,
}: {
  card: CardHistory;
  indexedBlock: bigint | undefined;
  lag: bigint | undefined;
  copy: HistoryCopy;
}) {
  return (
    <div className="mt-3 flex flex-col gap-1 border-t border-hairline pt-2">
      {card.partial ? (
        <p className="text-xs text-warning">
          Some history could not be read in full, so every count above is a floor rather than a total.
        </p>
      ) : null}

      {card.orphanPayouts > 0 ? (
        <p className="text-xs text-warning">{copy.orphanNote(card.orphanPayouts)}</p>
      ) : null}

      {indexedBlock !== undefined && indexedBlock > BigInt(0) ? (
        <p className="tnum text-xs text-ink-muted">
          Indexed to block {indexedBlock.toLocaleString()}
          {lag !== undefined ? ` · ${lag.toLocaleString()} behind the chain` : ""}
        </p>
      ) : null}
    </div>
  );
}
