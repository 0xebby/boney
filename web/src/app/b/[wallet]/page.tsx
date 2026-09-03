import {cache} from "react";
import {notFound} from "next/navigation";
import type {Metadata} from "next";
import {PublicBoneyCard} from "@/components/PublicBoneyCard";
import {loadPublicCard} from "@/lib/cardServer";
import {
  cardDescription,
  cardPath,
  cardTitle,
  parseCardWallet,
  subjectLabel,
} from "@/lib/publicCard";

/**
 * `/b/<wallet>` — a promoter's public BoneyCard.
 *
 * The share surface, and the only page in the app rendered entirely on the server: no wallet, no wagmi,
 * no client fetching. A shared link has to work for a crawler building a preview card, for an embed in a
 * chat client, and for someone on a phone with no wallet extension — none of which will run the app's
 * client hooks.
 *
 * ## The address is the URL
 *
 * `/b/0x98405c…`, never `/b/alice`. `ReputationRegistry` stores no social handles by design, so there is
 * no on-chain map to read, and an X handle is re-assignable — a handle URL would let a link shared today
 * point at a different person's card next month. The handle is *displayed* when Ethos knows one. See
 * `lib/publicCard.ts`.
 *
 * A malformed path 404s. A well-formed address with no profile and no campaigns does **not**: that is a
 * real card showing level 1 and an empty milestone ladder, and 404ing it would tell a new promoter their
 * card does not exist.
 */

/**
 * Five minutes.
 *
 * The page reads Ethos and the subgraph, and neither answer changes meaningfully in less time: history
 * is cumulative, and the score is already rendered with the date it was computed on. Without this, a
 * link that circulates would hit both upstreams once per view — and the follower sources throttle
 * back-to-back requests, so popularity would present as an outage.
 */
export const revalidate = 300;

/**
 * One load per request, shared with `generateMetadata`.
 *
 * Next calls `generateMetadata` and the page body separately, and the subgraph read is a POST, which
 * nothing in Next's fetch cache deduplicates. Without `cache()` every render would query the indexer
 * twice to produce one card. The wrapper takes a single string so the memo key actually matches — an
 * options object would be a fresh reference on each call and miss every time.
 */
const load = cache(async (wallet: string) => loadPublicCard(wallet as `0x${string}`));

type Params = {params: Promise<{wallet: string}>};

export async function generateMetadata({params}: Params): Promise<Metadata> {
  const wallet = parseCardWallet((await params).wallet);
  if (!wallet) return {title: "No such BoneyCard"};

  const card = await load(wallet);
  const subject = subjectLabel(wallet, card.handle);
  const scored = card.score.kind === "scored" ? card.score : undefined;

  const title = cardTitle({
    subject,
    rank: scored?.rank,
    score: scored?.score.total,
  });
  const description = cardDescription({
    subject,
    level: card.history?.level,
    campaigns: card.history?.campaignsJoined,
    tiers: card.history?.tiers,
  });

  return {
    title,
    description,
    // `opengraph-image.tsx` in this segment supplies `og:image` on its own; what it cannot supply is
    // the title, description and canonical URL, which is all this adds.
    openGraph: {title, description, url: cardPath(wallet), type: "profile"},
    twitter: {card: "summary_large_image", title, description},
  };
}

export default async function Page({params}: Params) {
  const wallet = parseCardWallet((await params).wallet);
  // Not an address at all. The 404 is honest: there is no card at this path, as opposed to a card with
  // nothing in it, which renders normally.
  if (!wallet) notFound();

  const card = await load(wallet);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
      <PublicBoneyCard card={card} />
    </div>
  );
}
