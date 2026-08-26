import {createPublicClient, http} from "viem";
import type {NextRequest} from "next/server";
import {
  canonicalStubAllowlistMessage,
  normalizeStubWallet,
  STUB_SIGNATURE_TTL_SECONDS,
} from "@/lib/stubWallets";
import {
  addStubWallet,
  isStubListPersisted,
  listStubWallets,
  removeStubWallet,
  stubAdminWallet,
} from "@/lib/stubWalletStore";
import {chainFor, rpcFor} from "@/lib/serverChain";

/**
 * The stub allowlist — which wallets get a fabricated BoneyScore instead of a real Ethos lookup.
 *
 * `POST` requires a signature from the admin wallet, and that is the whole security story. An
 * allowlisted wallet is scored by `lib/stubProfile` rather than by Ethos, and `/api/attest` will then
 * sign those numbers with the attestor key — so an unauthenticated write here is a mint button for
 * reputation. The dev-wallet check in `AppShell` decides whether the *panel* renders; it is a
 * convenience, not a boundary, and cannot be one because it runs in the browser.
 *
 * `GET` is open. The list is not a secret — every address on it is one whose score is fabricated, and
 * saying so is the honest thing for a demo deployment to do.
 *
 * What it deliberately does not do:
 *
 *  - **Trust the client's message.** The signed text is rebuilt here from the server's own normalised
 *    action and address, so a client that signs `remove` and sends `add` fails verification.
 *  - **Keep a nonce.** Both actions are idempotent, so the worst a replay inside the TTL achieves is
 *    re-applying a change the admin already authorised. A nonce would need state that survives a
 *    read-only deploy, which the store deliberately does not assume.
 *  - **Refuse when the filesystem is read-only.** Unlike `/api/campaign-guide`, a failed write still
 *    takes effect for the running instance, so this reports `persisted: false` and a 200 rather than a
 *    501. The change is real; it just will not outlive the instance.
 */

/** Node runtime: `node:fs` in `stubWalletStore`, and viem's verification path wants Node crypto. */
export const runtime = "nodejs";
/** The list changes under a running server, and a stale answer is a wrong score. Never cache. */
export const dynamic = "force-dynamic";

const SIGNATURE_RE = /^0x[0-9a-fA-F]+$/;

function json(status: number, body: unknown) {
  return Response.json(body, {status});
}

export async function GET() {
  return json(200, {
    wallets: listStubWallets(),
    admin: stubAdminWallet(),
    persisted: isStubListPersisted(),
  });
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(400, {error: "Expected a JSON body."});
  }

  const {wallet, action, chainId, issuedAt, signature} = (body ?? {}) as Record<string, unknown>;

  if (typeof wallet !== "string") {
    return json(400, {error: "A wallet address is required."});
  }
  const normalized = normalizeStubWallet(wallet);
  if (!normalized) {
    return json(400, {error: "Invalid wallet address."});
  }
  if (action !== "add" && action !== "remove") {
    return json(400, {error: "Action must be 'add' or 'remove'."});
  }
  if (typeof signature !== "string" || !SIGNATURE_RE.test(signature)) {
    return json(400, {error: "A signature from the admin wallet is required."});
  }

  const chain = chainFor(Number(chainId));
  if (!chain) {
    return json(400, {error: `No known chain with id ${String(chainId)}.`});
  }

  const issued = Number(issuedAt);
  if (!Number.isFinite(issued)) {
    return json(400, {error: "`issuedAt` must be a unix timestamp in seconds."});
  }

  // Both directions: a stale signature cannot be replayed later, and one timestamped in the future
  // cannot be minted now to be replayed then. The window is symmetric because clock skew is too.
  const skew = Math.abs(Math.floor(Date.now() / 1000) - issued);
  if (skew > STUB_SIGNATURE_TTL_SECONDS) {
    return json(400, {
      error: `That signature is outside its ${STUB_SIGNATURE_TTL_SECONDS}s window. Sign again.`,
    });
  }

  const admin = stubAdminWallet();
  const client = createPublicClient({chain, transport: http(rpcFor(chain.id))});

  let valid: boolean;
  try {
    // The client-side form, so an ERC-1271/6492 smart account holding the admin role verifies too
    // rather than only an EOA. Mirrors `/api/campaign-guide`.
    valid = await client.verifyMessage({
      address: admin as `0x${string}`,
      message: canonicalStubAllowlistMessage({
        action,
        wallet: normalized,
        chainId: chain.id,
        issuedAt: issued,
      }),
      signature: signature as `0x${string}`,
    });
  } catch {
    valid = false;
  }

  if (!valid) {
    return json(403, {
      error:
        "That signature is not from the stub admin wallet. Only it can change the allowlist, " +
        "because an allowlisted address is scored by the stub rather than by Ethos.",
    });
  }

  try {
    const result = action === "add" ? addStubWallet(normalized) : removeStubWallet(normalized);
    return json(200, {...result, admin});
  } catch (cause) {
    return json(400, {error: cause instanceof Error ? cause.message : "Invalid address."});
  }
}
