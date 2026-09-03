"use client";

import Link from "next/link";
import {Card, CardHeader} from "@/components/ui/Card";
import {Meter} from "@/components/ui/Meter";
import {RankBadge} from "@/components/ui/RankBadge";
import {BoneLevel, BoneWatermark} from "@/components/ui/Bone";
import {ErrorState, SkeletonRows} from "@/components/ui/States";
import {BoneyCardHistory} from "@/components/BoneyCardHistory";
import {
  type CardHistory,
  type CardScore,
  type Qualification,
  type ScoreScale,
} from "@/lib/boneycard";
import type {GraphUnavailable} from "@/lib/graph";
import type {TokenMeta} from "@/lib/token";
import {compactNumber, shortAddress} from "@/lib/format";

/**
 * The BoneyCard — a promoter's card.
 *
 * ## Two halves, and they fail independently
 *
 * **Stage 1 is onboarding.** A wallet that has never promoted anything still has an Ethos profile and
 * an audience, so it still has a card. Every number in the head comes from `/api/score` and costs no
 * gas.
 *
 * **Stage 2 is the history**, folded from the subgraph in `BoneyCardHistory`. It is the only thing that
 * moves the bone's level, which is why the level is passed in rather than derived from the score — and
 * why it is allowed to be `undefined`. An unreachable indexer means the level is *unknown*; rendering 1
 * there would take a level-5 promoter's card down to a beginner's over an outage.
 *
 * **Differentiation at stage 1 is the rank, not the level.** Every new promoter is level 1, so if the
 * bone carried the visual weight the launch card would look identical for everybody. The rank ladder
 * in `ranks.ts` already spans Netrunner to Legend off exactly the inputs stage 1 has, so it does the
 * distinguishing and the level is left with something to earn.
 *
 * ## Design-system notes
 *
 * Reuses `ui/Meter` and `ui/RankBadge` rather than restyling: the
 * form decisions are already made there (a lone current value is a stat tile, a ratio against a limit
 * is a meter, an ordinal rank takes the sequential ramp rather than a categorical hue). The bone
 * outline is decorative framing and encodes nothing — every value inside it is text, so the shape can
 * be ignored entirely without losing information.
 *
 * State is never carried by colour alone: `unclaimed`, `unavailable` and `reachUnconfirmed` each
 * render words.
 */
export function BoneyCard({
  wallet,
  score,
  scoreLoading,
  onChainExpired,
  scale,
  qualification,
  headline,
  qualificationReady,
  history,
  historyUnavailable,
  historyLoading,
  earnedToken,
  onVerify,
  onRetryScore,
  onRetryHistory,
}: {
  wallet: `0x${string}` | undefined;
  score: CardScore | undefined;
  scoreLoading: boolean;
  onChainExpired: boolean;
  scale: ScoreScale;
  qualification: Qualification;
  headline: string;
  qualificationReady: boolean;
  history: CardHistory | undefined;
  historyUnavailable: GraphUnavailable | undefined;
  historyLoading: boolean;
  earnedToken: TokenMeta | null;
  onVerify?: () => void;
  onRetryScore?: () => void;
  onRetryHistory?: () => void;
}) {
  // No wallet is a real viewing state, not a wall. The campaigns that set no reputation floor are
  // joinable by anyone, and they are the strongest thing this page has to say to a stranger — so the
  // list renders before a connection and only the score half waits.
  const anonymous = !wallet;

  /**
   * Where the history section sits, which depends on whether there is any.
   *
   * With campaigns behind it, the history is what the promoter opened the card for and it goes
   * directly under the score. Empty, it is an invitation to promote a first campaign — and the
   * qualification list immediately above says the same thing with actual campaign names in it, so
   * leading with the weaker version of that message would just be repeating it.
   */
  const historyFirst = (history?.campaignsJoined ?? 0) > 0;

  const historySection = wallet ? (
    <BoneyCardHistory
      card={history}
      unavailable={historyUnavailable}
      isLoading={historyLoading}
      earnedToken={earnedToken}
      onRetry={onRetryHistory}
    />
  ) : null;

  return (
    <div className="flex flex-col gap-4">
      <Bone
        wallet={wallet}
        score={score}
        scoreLoading={scoreLoading}
        scale={scale}
        level={history?.level}
        onRetryScore={onRetryScore}
      />

      {/*
        The one state notice the breakdown carried that is not an explanation: expired attestations
        drop the score campaigns read back to zero.
      */}
      {onChainExpired ? (
        <p className="text-xs text-brand">
          Your on-chain attestations have expired. Re-verify to restore the score campaigns read.
        </p>
      ) : null}

      {historyFirst ? historySection : null}

      <Qualifies
        headline={headline}
        qualification={qualification}
        ready={qualificationReady}
        // The verify affordance needs a wallet to sign with *and* a registry that can record the
        // result. Withholding it on a ceiling of 0 is the point: attesting there costs one
        // transaction per schema and cannot raise `scoreOf` by anything.
        onVerify={anonymous || !scale.verifiable ? undefined : onVerify}
        verifiable={scale.verifiable}
        verifyNote={scale.note}
        anonymous={anonymous}
      />

      {historyFirst ? null : historySection}
    </div>
  );
}

/**
 * The bone.
 *
 * The watermark is one SVG so it scales to an OG image without re-layout, and `aria-hidden` because it
 * is ornament: the card's content is the HTML on top of it.
 */
function Bone({
  wallet,
  score,
  scoreLoading,
  scale,
  level,
  onRetryScore,
}: {
  wallet: `0x${string}` | undefined;
  score: CardScore | undefined;
  scoreLoading: boolean;
  scale: ScoreScale;
  level?: number;
  onRetryScore?: () => void;
}) {
  return (
    <Card className="relative overflow-hidden">
      <BoneWatermark />

      <div className="relative flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-bold text-brand">BONEYCARD</p>
            <p className="mt-0.5 font-mono text-xs text-ink-muted">
              {wallet ? shortAddress(wallet) : "no wallet connected"}
            </p>
          </div>
          <BoneLevel level={level} />
        </div>

        {/*
          Four states, and the order matters. A missing wallet is checked first because the score
          query is disabled without one — so `score` is undefined and `scoreLoading` is false, which
          would otherwise fall through to "could not reach the score service" and blame an outage
          for a wallet that was simply never connected.
        */}
        {!wallet ? (
          <DisconnectedHead />
        ) : scoreLoading ? (
          <SkeletonRows rows={2} />
        ) : score?.kind === "scored" ? (
          <ScoredHead score={score} scale={scale} />
        ) : score?.kind === "unclaimed" ? (
          <UnclaimedHead message={score.message} />
        ) : (
          <UnavailableHead message={score?.message} onRetry={onRetryScore} />
        )}
      </div>
    </Card>
  );
}

function ScoredHead({
  score,
  scale,
}: {
  score: Extract<CardScore, {kind: "scored"}>;
  scale: ScoreScale;
}) {
  const {total, handle, followers, smartFollowers, reachUnconfirmed, computedAt} = score.score;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-bold text-brand">BONEYSCORE</p>
          <p className="font-display text-4xl leading-tight text-ink">
            {total.toLocaleString()}
          </p>
        </div>
        {/* `muted` tone: this is the viewer's own standing, not a row they are vetting. */}
        <RankBadge rank={score.rank} tone="muted" />
      </div>

      {/*
        The denominator comes from this network's registry, not from `MAX_BONEY_SCORE` — the constant
        is only the arithmetic for the seeded schema configuration. Where there is no ceiling to
        divide by, the bar is dropped rather than drawn against a guess: a meter is a ratio against a
        limit, and inventing the limit would be the one thing it must not do.
      */}
      {scale.max !== undefined ? (
        <Meter
          value={total}
          max={scale.max}
          ariaLabel="Score against the network maximum"
          valueText={`${total.toLocaleString()} / ${scale.max.toLocaleString()}`}
        />
      ) : null}
      {scale.note ? <p className="text-xs text-ink-muted">{scale.note}</p> : null}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-muted">
        {handle ? <span>@{handle}</span> : <span>no X handle on the Ethos profile</span>}
        {reachUnconfirmed ? (
          // Words, not colour. `fetchFollowers` returns 0 for an outage and for an empty account
          // alike, so this is a suspicion and has to read as one.
          <span className="text-brand">reach unconfirmed — follower count unavailable</span>
        ) : (
          <span>{compactNumber(followers)} followers</span>
        )}
        {smartFollowers > 0 ? <span>{compactNumber(smartFollowers)} smart</span> : null}
        {computedAt > 0 ? (
          <span>as of {new Date(computedAt * 1000).toLocaleDateString()}</span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * No wallet connected.
 *
 * Deliberately not an error and not a wall — the campaign list below it is the whole point, and five
 * of the live campaigns need no score at all. This says what a connection would add, nothing more.
 */
function DisconnectedHead() {
  return (
    <div className="flex flex-col gap-1.5 rounded border border-hairline bg-surface-2 p-3">
      <p className="text-sm font-semibold text-ink">Connect a wallet for your BoneyScore</p>
      <p className="text-xs text-ink-secondary">
        Your score comes from your Ethos profile and your audience — no transaction, no gas. The
        campaigns below are already listed either way.
      </p>
    </div>
  );
}

/**
 * No claimed Ethos profile — the ordinary first-run state, not an error.
 *
 * There is no partial score to fall back on: reach is derived from the X handle that lives *on* the
 * Ethos profile, so the missing profile takes both halves. What the card can still do is point at the
 * campaigns that need no score at all, which the section below lists.
 */
function UnclaimedHead({message}: {message: string}) {
  return (
    <div className="flex flex-col gap-2 rounded border border-hairline bg-surface-2 p-3">
      <p className="text-sm font-semibold text-ink">No BoneyScore yet</p>
      <p className="text-xs text-ink-secondary">{message}</p>
      <p className="text-xs text-ink-muted">
        Your score and your audience both come from a claimed Ethos profile. Without one you can still
        promote every campaign that sets no reputation floor.
      </p>
      <a
        className="text-xs font-semibold text-brand underline"
        href="https://app.ethos.network"
        rel="noreferrer noopener"
        target="_blank"
      >
        Claim an Ethos profile →
      </a>
    </div>
  );
}

/** An upstream failure. Never rendered as a score of zero — that would be a claim about someone. */
function UnavailableHead({message, onRetry}: {message?: string; onRetry?: () => void}) {
  return (
    <ErrorState
      message="Score unavailable"
      detail={message ?? "Could not reach the score service."}
      onRetry={onRetry}
    />
  );
}

/**
 * Campaigns this wallet qualifies for, in three groups.
 *
 * Ordered to lead with what needs no gas. `verifyToJoin` is the set the prospective score clears and
 * the chain does not, and it is the only place a verify prompt appears — putting one at the top of
 * the card would ask a stranger to pay for three transactions before they have seen anything work.
 *
 * Every note switches voice on `anonymous`. "Your on-chain score already clears it" is a claim about
 * a specific wallet, and with none connected there is no wallet to make it about — the grouping is
 * still correct (`qualify` never asks about a connection) but the second person is not.
 */
function Qualifies({
  headline,
  qualification,
  ready,
  onVerify,
  verifiable,
  verifyNote,
  anonymous,
}: {
  headline: string;
  qualification: Qualification;
  ready: boolean;
  onVerify?: () => void;
  verifiable: boolean;
  verifyNote?: string;
  anonymous: boolean;
}) {
  const {joinableNow, verifyToJoin, scoreTooLow, joined} = qualification;

  return (
    <Card>
      <CardHeader
        title={anonymous ? "What is open to promote" : "What you can promote"}
        subtitle={ready ? headline : "Checking campaigns against your score…"}
      />

      {!ready ? (
        <SkeletonRows rows={3} />
      ) : (
        <div className="flex flex-col gap-4">
          <Group
            campaigns={joinableNow}
            label={anonymous ? "Open to anyone" : "Open to you now"}
            note={
              anonymous
                ? "These set no reputation floor, so any wallet can promote them without verifying anything."
                : "No reputation floor, or your on-chain score already clears it."
            }
          />

          {verifyToJoin.length > 0 ? (
            <Group
              campaigns={verifyToJoin}
              label={verifiable ? "Verify to promote" : "Score-gated"}
              note={
                !verifiable
                  ? // The prospective score clears these; there is simply nowhere to record it, so
                    // the group is not a to-do list and must not read as one.
                    (verifyNote ??
                      "These are score-gated and this network cannot record a BoneyScore yet.")
                  : "Your Ethos-derived score clears these. Campaigns read the on-chain score, so they need your attestations submitted first."
              }
              action={
                onVerify ? (
                  <button
                    className="rounded border border-brand/60 px-2 py-1 text-xs font-semibold text-brand"
                    onClick={onVerify}
                    type="button"
                  >
                    Verify BoneyScore
                  </button>
                ) : undefined
              }
            />
          ) : null}

          {scoreTooLow.length > 0 ? (
            <Group
              campaigns={scoreTooLow}
              label={anonymous ? "Score-gated" : "Above your score"}
              note={
                anonymous
                  ? "These set a reputation floor. Connect a wallet to see which ones you clear."
                  : "Verification will not reach these — the floor is higher than your Ethos and audience currently support."
              }
              showShortfall={!anonymous}
            />
          ) : null}

          {joined.length > 0 ? (
            <Group
              campaigns={joined}
              label="Already promoting"
              note="These are what will fill in the history half of your card."
            />
          ) : null}
        </div>
      )}
    </Card>
  );
}

function Group({
  campaigns,
  label,
  note,
  action,
  showShortfall = false,
}: {
  campaigns: Qualification["joinableNow"];
  label: string;
  note: string;
  action?: React.ReactNode;
  showShortfall?: boolean;
}) {
  return (
    <div>
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-xs font-bold text-brand">
            {label} <span className="text-ink-muted">({campaigns.length})</span>
          </p>
          <p className="text-xs text-ink-muted">{note}</p>
        </div>
        {action}
      </div>

      {campaigns.length === 0 ? (
        <p className="text-xs text-ink-muted">None.</p>
      ) : (
        <ul className="divide-y divide-hairline rounded border border-hairline">
          {campaigns.map(({view, shortfall}) => (
            <li
              key={view.campaign}
              className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
            >
              <Link
                className="text-sm text-ink underline decoration-hairline"
                href={`/campaign/${view.campaignId}`}
              >
                {view.name}
              </Link>
              <span className="tnum text-xs text-ink-muted">
                {view.minReputation === BigInt(0)
                  ? "no score needed"
                  : `needs ${view.minReputation.toLocaleString()}`}
                {showShortfall && shortfall !== undefined
                  ? ` · ${shortfall.toLocaleString()} short`
                  : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
