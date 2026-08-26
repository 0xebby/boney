import type {NextRequest} from "next/server";
import {isAddress} from "@/lib/ethos";
import {scoreResponse} from "@/lib/score";

/**
 * Score endpoint — a wallet's BoneyScore inputs, with nothing signed.
 *
 * This is the onboarding half of reputation. `/api/attest` reads the same upstreams and then signs
 * an EIP-712 attestation per schema for the promoter to submit on chain; this route stops before the
 * signing, so a wallet that has never sent a transaction can still be shown a score, a rank, and the
 * campaigns it qualifies for. No key is touched here and no nonce is consumed.
 *
 * **The number this returns is not the number `Campaign.join()` reads.** `join()` gates on
 * `ReputationRegistry.scoreOf`, which is 0 until attestations are submitted and gas is paid. The two
 * are kept apart in `lib/boneycard.qualify`, which runs the join guard against both and reports
 * "verify to join" for the gap. Anything rendering this value as though it were the on-chain score
 * will produce a Join button that reverts `InsufficientReputation`.
 *
 * The score itself, its cache and its failure mapping live in `lib/score.ts`, because the public card
 * at `/b/<wallet>` is server-rendered and calls the same function directly rather than fetching this
 * route. This file is now only the HTTP edge: parse an address, serialise a result.
 */

/** Node runtime, matching `/api/attest`: both call the same upstream helpers. */
export const runtime = "nodejs";

/**
 * Never served from Next's route cache.
 *
 * `lib/score.ts`'s TTL is the caching story, deliberately, because it is the one that can distinguish
 * a success from a failure and give them different lifetimes. Layering Next's cache on top would make
 * the effective freshness of a score two numbers instead of one.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const wallet = request.nextUrl.searchParams.get("wallet");
  // Narrows to `0x${string}`, so nothing below needs a cast.
  if (!isAddress(wallet)) {
    return Response.json(
      {error: "invalid_address", message: "Provide a wallet address as `wallet`."},
      {status: 400},
    );
  }

  const {status, body} = await scoreResponse(wallet);
  return Response.json(body, {status});
}
