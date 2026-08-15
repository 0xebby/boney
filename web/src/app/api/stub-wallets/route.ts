import {NextRequest} from "next/server";
import {addStubWallet, listStubWallets, normalizeStubWallet, removeStubWallet} from "@/lib/stubWallets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(status: number, body: unknown) {
  return Response.json(body, {status});
}

export async function GET() {
  return json(200, {wallets: listStubWallets()});
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(400, {error: "Expected a JSON body."});
  }

  const wallet = (body as {wallet?: unknown})?.wallet;
  const action = (body as {action?: unknown})?.action;

  if (typeof wallet !== "string") {
    return json(400, {error: "A wallet address is required."});
  }

  const normalized = normalizeStubWallet(wallet);
  if (!normalized) {
    return json(400, {error: "Invalid wallet address."});
  }

  if (action === "add") {
    try {
      addStubWallet(normalized);
    } catch (cause) {
      return json(400, {error: cause instanceof Error ? cause.message : "Invalid address."});
    }
    return json(200, {wallets: listStubWallets()});
  }

  if (action === "remove") {
    removeStubWallet(normalized);
    return json(200, {wallets: listStubWallets()});
  }

  return json(400, {error: "Action must be 'add' or 'remove'."});
}
