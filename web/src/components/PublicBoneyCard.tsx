import Link from "next/link";
import {Card} from "@/components/ui/Card";
import {RankBadge} from "@/components/ui/RankBadge";
import {TrustReachBar} from "@/components/ui/TrustReachBar";
import {BoneLevel, BoneWatermark} from "@/components/ui/Bone";
import {BoneyCardHistory} from "@/components/BoneyCardHistory";
import {ETHOS_WEIGHT, REACH_WEIGHT} from "@/lib/boneyscore";
import {subjectLabel} from "@/lib/publicCard";
import type {PublicCard} from "@/lib/cardServer";
import {compactNumber, formatDate} from "@/lib/format";
import {explorerAddressUrl} from "@/lib/chains";

/**
 * The public BoneyCard at `/b/<wallet>`.
 *
 * A **server component**: no wallet, no wagmi, no client JavaScript. That is what makes it shareable —
 * a link has to render for a crawler building a preview, for an embed, and for a phone with no
 * extension installed. Every number arrives already resolved from `lib/cardServer.loadPublicCard`.
 *
 * ## What it says that the connected card does not
 *
 * The score is labelled as **off-chain**. On `/card` that distinction drives a Verify button, so it is
 * explained in terms of what to do about it; here the reader cannot act on it and might reasonably take
 * a five-figure number in a share card as something the chain attests. So the card states where the
 * figure comes from and when it was computed, and leaves it there.
 *
 * ## What it deliberately leaves out
 *
 * **The qualification list.** "What you can join" is a question about the viewer, and the viewer of a
 * public card is not its subject.
 *
 * **The score meter.** A meter is a ratio against a limit and the limit is `ReputationRegistry.maxScore()`,
 * which is a chain read this page does not make. Drawing the bar against `MAX_BONEY_SCORE` instead would
 * be inventing the denominator, which is the one thing the form must not do — so the score renders as a
 * figure with its rank, and no bar.
 *
 * **A retry.** There is nothing to re-run on the client; a reload is the retry.
 */
export function PublicBoneyCard({card}: {card: PublicCard}) {
  const {wallet, score, handle, history} = card;
  const subject = subjectLabel(wallet, handle);
  const explorer = explorerAddressUrl(card.chainId, wallet);

  return (
    <div className="flex flex-col gap-4">
      <Card className="relative overflow-hidden">
        <BoneWatermark />

        <div className="relative flex flex-col gap-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-bold text-brand">BONEYCARD</p>
              {handle ? (
                <p className="text-sm font-semibold text-ink">@{handle}</p>
              ) : null}
              {/*
                The full address, not the shortened one. This is the canonical identity of the card and
                the thing a reader may want to check on an explorer or paste somewhere — `subjectLabel`
                shortens it for prose, but the card itself should carry the real value.
              */}
              {explorer ? (
                <a
                  className="break-all font-mono text-xs text-ink-muted underline decoration-hairline"
                  href={explorer}
                  rel="noreferrer noopener"
                  target="_blank"
                >
                  {wallet}
                </a>
              ) : (
                <p className="break-all font-mono text-xs text-ink-muted">{wallet}</p>
              )}
            </div>
            <BoneLevel level={history?.level} />
          </div>

          {score.kind === "scored" ? (
            <ScoredHead score={score} />
          ) : (
            <NoScoreHead
              subject={subject}
              unclaimed={score.kind === "unclaimed"}
              message={score.message}
            />
          )}
        </div>
      </Card>

      <BoneyCardHistory
        card={history}
        unavailable={card.historyUnavailable}
        isLoading={false}
        indexedBlock={card.indexedBlock}
        lag={card.lag}
        earnedToken={card.earnedToken}
        voice={{kind: "other", subject}}
      />

      <Footer />
    </div>
  );
}

/** The score, its composition, and where it came from. */
function ScoredHead({score}: {score: Extract<PublicCard["score"], {kind: "scored"}>}) {
  const {total, ethos, reach, followers, smartFollowers, reachUnconfirmed, computedAt} = score.score;
  const ethosPoints = ETHOS_WEIGHT * ethos;
  const trustPct = total > 0 ? Math.round((ethosPoints / total) * 100) : 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-bold text-brand">BONEYSCORE</p>
          <p className="font-display text-4xl leading-tight text-ink">{total.toLocaleString()}</p>
          <p className="mt-0.5 text-xs text-ink-muted">credibility &amp; reach — not delivery</p>
        </div>
        {/*
          `tone="default"` here, unlike the header badge on `/card`. A `reachOnly` rank — one reachable
          on follower count with no Ethos credibility behind it — is exactly the caution a reader vetting
          somebody else's card should see, which is the audience `RankBadge`'s warning outline was
          written for.
        */}
        <div className="flex items-center gap-3">
          <TrustReachBar trustPct={trustPct} reachPct={100 - trustPct} />
          <RankBadge rank={score.rank} />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-muted">
        <span>
          {ETHOS_WEIGHT}× Ethos {ethos.toLocaleString()} + {REACH_WEIGHT}× reach{" "}
          {reach.toLocaleString()}
        </span>
        {reachUnconfirmed ? (
          // Words, not colour. `fetchFollowers` returns 0 for a throttled source and for an empty
          // account alike, so this is a suspicion and has to read as one.
          <span className="text-warning">reach unconfirmed — follower count unavailable</span>
        ) : (
          <span>{compactNumber(followers)} followers</span>
        )}
        {smartFollowers > 0 ? <span>{compactNumber(smartFollowers)} smart</span> : null}
      </div>

      {/*
        Two facts the connected card gets to explain interactively and this one has to state. The date
        matters because this number can *fall* with nothing happening — Ethos scores move and follower
        counts move — so a share card that presented it as timeless would be the same lie
        `discovery.ts` refused when it named its field `scoreAtJoin`.
      */}
      <p className="text-xs text-ink-muted">
        Computed from this wallet&apos;s Ethos profile and audience, not read from the chain
        {computedAt > 0 ? ` — as of ${formatDate(computedAt)}` : ""}.
      </p>
    </div>
  );
}

/**
 * No score, and the two reasons are not the same.
 *
 * `unclaimed` is the ordinary state for most wallets and is not a failing: there is no Ethos profile, so
 * there is no credibility figure and no X handle to derive reach from either. `unavailable` is an
 * upstream problem and says so. Neither renders a zero — a zero would be a claim about someone that a
 * missing profile and a broken fetch have equally not earned.
 */
function NoScoreHead({
  subject,
  unclaimed,
  message,
}: {
  subject: string;
  unclaimed: boolean;
  message: string;
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded border border-hairline bg-surface-2 p-3">
      <p className="text-sm font-semibold text-ink">
        {unclaimed ? "No BoneyScore yet" : "Score unavailable"}
      </p>
      <p className="text-xs text-ink-secondary">{message}</p>
      <p className="text-xs text-ink-muted">
        {unclaimed
          ? `A BoneyScore comes from a claimed Ethos profile and the audience on it. ${subject} has neither yet — the history below is the part the chain records either way.`
          : "This is an upstream failure, not a judgement about this wallet. Reload to try again."}
      </p>
    </div>
  );
}

/** What a reader can do next. The only growth loop on the card. */
function Footer() {
  return (
    <Card>
      <p className="text-sm text-ink">This is a Boneyard promoter card.</p>
      <p className="mt-1 text-xs text-ink-secondary">
        Every count on it is earned on chain — campaigns joined, actions credited to a referral, reward
        tiers settled. Nothing here is self-reported.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Link
          className="rounded border border-brand/60 px-2.5 py-1.5 text-xs font-semibold text-brand"
          href="/card"
        >
          Get your own BoneyCard
        </Link>
        <Link
          className="rounded border border-hairline px-2.5 py-1.5 text-xs font-semibold text-ink"
          href="/discover"
        >
          Find campaigns to promote
        </Link>
      </div>
    </Card>
  );
}
