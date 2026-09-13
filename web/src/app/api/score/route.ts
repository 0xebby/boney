import type {NextRequest} from "next/server";
import {isAddress} from "@/lib/ethos";
import {scoreResponse} from "@/lib/score";

/**
 * Score endpoint — a wallet's BoneyScore inputs, with nothing signed.
 * **The number this returns is not the number `Campaign.join()` reads.** `join()` gates on
 * `ReputationRegistry.scoreOf`, which is 0 until attestations are submitted and gas is paid.
 */

/** Node runtime, matching `/api/attest`: both call the same upstream helpers. */
export const runtime = "nodejs";

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
