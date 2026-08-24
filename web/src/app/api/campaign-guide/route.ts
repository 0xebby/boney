import {createPublicClient, http} from "viem";
import type {NextRequest} from "next/server";
import {CampaignAbi} from "@/lib/abis";
import {anvil, sepolia, baseSepolia, mainnet} from "@/lib/chains";
import {canonicalGuideMessage, isEmptyGuide, sanitizeGuide} from "@/lib/campaignGuide";
import {readGuide, writeGuide} from "@/lib/guideStore";

/**
 * Campaign guides — the off-chain "what am I supposed to do here" a campaign page renders.
 *
 * `GET` answers with the *stored* guide only. The committed catalog (`lib/campaignGuide.CATALOG`) is
 * already in the client bundle, so shipping it back over HTTP would send the same bytes twice and put
 * the precedence rule in two places; `resolveCampaignGuide` applies it on the client instead.
 *
 * `POST` requires a signature from the campaign's own `project` wallet. That is the whole security
 * story of the feature and it is not optional: a guide is a set of outbound links shown to a referral
 * on the page that has just told them they are attributed to a promoter. An unauthenticated write
 * would let anyone point the Aave campaign's "do this here" at a drainer. So the route reads
 * `Campaign.project()` from the chain the guide claims to be for and checks the signature against it —
 * authority comes from the key, exactly as it does for `/api/attest`, and for the same reason.
 *
 * What it deliberately does not do:
 *
 *  - **Trust the client's bytes.** The message is rebuilt from the server's own `sanitizeGuide` output,
 *    so a client that signs one guide and sends another fails verification rather than storing the
 *    second.
 *  - **Check that the caller is still the project.** `CampaignConfig.project` is immutable, so there is
 *    nothing to re-check later.
 *  - **Rate-limit.** The signature already binds each write to one campaign's owner, and a project
 *    overwriting its own guide is not abuse.
 */

/** Node runtime: `node:fs` in `guideStore`, and viem's verification path wants Node crypto. */
export const runtime = "nodejs";
/** The store changes under a running server, and a stale guide is a wrong instruction. Never cache. */
export const dynamic = "force-dynamic";

/** viem chain objects by id, for the RPC transport the project read needs. Mirrors `/api/attest`. */
const CHAINS = [anvil, sepolia, baseSepolia, mainnet];
const chainFor = (id: number) => CHAINS.find((c) => c.id === id);

/**
 * The endpoint the rest of the app already reads through, per chain — `undefined` to take viem's
 * default for chains that have no override.
 *
 * `http()` with no URL uses the chain's built-in RPC, which for Base Sepolia is `sepolia.base.org`:
 * the endpoint `wagmi.ts` and `.env.local` both deliberately moved off, because it 502s roughly one
 * call in three. A flake on the `project()` read below is indistinguishable from a bad address, so it
 * comes back as `unknown_campaign` — telling a project there is no campaign at an address they just
 * created one at. Same URL as the client, so the one server-side read cannot be the flaky one.
 */
function rpcFor(chainId: number): string | undefined {
  if (chainId === baseSepolia.id) {
    return process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC ?? "https://base-sepolia-rpc.publicnode.com";
  }
  if (chainId === anvil.id) return process.env.NEXT_PUBLIC_ANVIL_RPC ?? "http://127.0.0.1:8545";
  if (chainId === sepolia.id) return process.env.NEXT_PUBLIC_SEPOLIA_RPC;
  return process.env.NEXT_PUBLIC_MAINNET_RPC;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const SIGNATURE_RE = /^0x[0-9a-fA-F]+$/;

function fail(code: string, message: string, status: number, extra: object = {}) {
  return Response.json({error: code, message, ...extra}, {status});
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const chainId = Number(params.get("chainId"));
  const campaign = params.get("campaign");

  if (!Number.isInteger(chainId) || chainId <= 0) {
    return fail("bad_request", "Pass a numeric `chainId`.", 400);
  }
  if (!campaign || !ADDRESS_RE.test(campaign)) {
    return fail("bad_request", "Pass a campaign address as `campaign`.", 400);
  }

  // `null` rather than a 404: "this campaign has no stored guide" is the ordinary answer for almost
  // every campaign, and a 404 would make the client treat the normal case as a failed request.
  return Response.json({guide: readGuide(chainId, campaign)});
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("bad_request", "Expected a JSON body.", 400);
  }

  const {campaign, chainId, guide, signature} = (body ?? {}) as Record<string, unknown>;

  if (typeof campaign !== "string" || !ADDRESS_RE.test(campaign)) {
    return fail("bad_request", "`campaign` must be a campaign address.", 400);
  }
  if (typeof signature !== "string" || !SIGNATURE_RE.test(signature)) {
    return fail("bad_request", "`signature` must be a hex signature.", 400);
  }

  const chain = chainFor(Number(chainId));
  if (!chain) {
    return fail("unknown_chain", `No known chain with id ${String(chainId)}.`, 400);
  }

  // Sanitized before it is signed against, so the project signs what will actually be stored and a
  // dropped field cannot arrive as something they never agreed to.
  const clean = sanitizeGuide(guide);
  const client = createPublicClient({chain, transport: http(rpcFor(chain.id))});

  let project: `0x${string}`;
  try {
    project = await client.readContract({
      abi: CampaignAbi,
      address: campaign as `0x${string}`,
      functionName: "project",
    });
  } catch {
    // No `project()` at that address on this chain: not a campaign, wrong chain, or an RPC outage.
    // All three are indistinguishable from here and all three mean the write cannot be authorized.
    return fail(
      "unknown_campaign",
      `No Boney campaign readable at ${campaign} on ${chain.name}.`,
      400,
    );
  }

  let valid: boolean;
  try {
    // The client-side form of this call, so a smart-account project (ERC-1271/6492) verifies too
    // rather than only an EOA.
    valid = await client.verifyMessage({
      address: project,
      message: canonicalGuideMessage({campaign, chainId: chain.id, guide: clean}),
      signature: signature as `0x${string}`,
    });
  } catch {
    valid = false;
  }

  if (!valid) {
    return fail(
      "not_project",
      "That signature is not from this campaign's project wallet. Only the project can publish a " +
        "guide, because these links are shown to referrals.",
      403,
    );
  }

  if (!writeGuide(chain.id, campaign, clean)) {
    // Expected on Netlify, whose function filesystem is ephemeral and read-only. Say so and hand back
    // the entry to commit, rather than reporting a success the next request would contradict.
    return fail(
      "store_unwritable",
      "This deployment cannot store guides — its filesystem is read-only. Add the entry below to " +
        "`CATALOG` in web/src/lib/campaignGuide.ts instead.",
      501,
      {entry: {[campaign.toLowerCase()]: clean}},
    );
  }

  // `cleared` when every field was empty or dropped: `writeGuide` treats that as a withdrawal, and a
  // project that just deleted its guide should be told that is what happened.
  return Response.json({cleared: isEmptyGuide(clean), guide: clean});
}
