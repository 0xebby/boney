import {createPublicClient, http, type PublicClient} from "viem";
import {IERC20MetadataAbi} from "@/lib/abis";
import {DEFAULT_CHAIN_ID} from "@/lib/chains";
import {chainFor, rpcFor} from "@/lib/serverChain";
import {scoreResponse} from "@/lib/score";
import {fetchPromoterHistory} from "@/lib/boneyHistory";
import {graphLag, type GraphUnavailable} from "@/lib/graph";
import {
  cardScoreFrom,
  foldHistory,
  milestoneBlocks,
  withResolvedDates,
  type CardHistory,
  type CardScore,
} from "@/lib/boneycard";
import type {TokenMeta} from "@/lib/token";

/**
 * Server-side assembly of a public BoneyCard.
 *
 * `/b/<wallet>` is rendered on the server with no wallet, no wagmi and no client-side fetching, which
 * is what makes it shareable: a link has to render for a crawler, an embed and a phone with no
 * extension installed. That rules out every hook the connected card uses, so this module is the
 * server's equivalent of `useBoneyCard`.
 *
 * ## Four reads, none of which may take the page down
 *
 * | Read | Source | Missing means |
 * |---|---|---|
 * | Prospective score | `lib/score.scoreResponse` (Ethos + X) | no score shown — never a zero |
 * | Campaign history | `boney-indexer` | "history unavailable" — never zeroed counts |
 * | Milestone dates | one `eth_getBlockByNumber` per join block | milestones show block numbers |
 * | Earned token symbol | `symbol`/`decimals` on the dominant token | the earned figure shows a dash |
 *
 * The first two run concurrently because neither needs the other. The last two are best-effort RPC and
 * are wrapped in `allSettled`: a public page must not 500 because a rate-limited node dropped one call
 * for a date format. Every failure has a rendering, and none of them is a zero — a zero is a claim
 * about a person, and a read that did not complete has not earned the right to make one.
 *
 * ## What it deliberately does not read
 *
 * **The campaign list, and so the qualification groups.** "What you can join" is a question about the
 * *viewer*, and the viewer of a public card is not its subject. Leaving it out also removes N on-chain
 * reads from the page's critical path.
 *
 * A consequence worth naming: `foldHistory` gets no `views`, so it has no `endTime` to compare against
 * and the per-campaign rows do not claim a campaign was "ended early". That is the degradation it was
 * designed for — the row says Ended and claims nothing more.
 */

export type PublicCard = {
  wallet: `0x${string}`;
  chainId: number;
  score: CardScore;
  /** The handle Ethos knows, for prose and the page title. Null when there is no claimed profile. */
  handle: string | null;
  /** Present only on a successful subgraph read. */
  history: CardHistory | undefined;
  /** Present only on a failed one. */
  historyUnavailable: GraphUnavailable | undefined;
  indexedBlock: bigint | undefined;
  /** Blocks behind the chain head. Undefined when the head could not be read. */
  lag: bigint | undefined;
  /** Metadata for the dominant earned token. Null when unread. */
  earnedToken: TokenMeta | null;
};

/**
 * A client for the default chain, or null when there is nothing to talk to.
 *
 * `DEFAULT_CHAIN_ID` rather than a connected wallet's chain, because there is no wallet — this is the
 * deployment the public actually shares, which is exactly what `DEFAULT_CHAIN_ID` documents itself as.
 *
 * The four-second timeout is the important argument. Every RPC read here is a nicety (a date format, a
 * token symbol) on a page whose whole job is to render fast for a crawler, and viem's default would let
 * one stalled connection hold the response for ten seconds to improve a label.
 */
function serverClient(chainId: number): PublicClient | null {
  const chain = chainFor(chainId);
  if (!chain) return null;
  return createPublicClient({
    chain,
    transport: http(rpcFor(chainId), {timeout: 4_000, retryCount: 0}),
  }) as PublicClient;
}

/** Block timestamps, best-effort. A block that did not resolve is absent, never zero. */
async function blockTimes(
  client: PublicClient | null,
  blocks: readonly bigint[],
): Promise<ReadonlyMap<bigint, number>> {
  const times = new Map<bigint, number>();
  if (!client || blocks.length === 0) return times;

  const settled = await Promise.allSettled(
    blocks.map(async (blockNumber) => {
      const block = await client.getBlock({blockNumber});
      return [blockNumber, Number(block.timestamp)] as const;
    }),
  );

  for (const result of settled) {
    // A zero timestamp is not a date; dropping it leaves the milestone on its block number rather than
    // dating a promoter's first campaign to 1 January 1970.
    if (result.status === "fulfilled" && result.value[1] > 0) {
      times.set(result.value[0], result.value[1]);
    }
  }
  return times;
}

/**
 * `symbol` and `decimals` for one token, or null.
 *
 * Null rather than an 18-decimal fallback, and the card renders a dash for it. Decimals are the *scale*
 * an amount is read at, so guessing 18 for an unread 6-decimal token overstates a payout by a factor of
 * a trillion — on the one page built to be screenshotted and shared.
 */
async function tokenMeta(
  client: PublicClient | null,
  token: `0x${string}` | undefined,
): Promise<TokenMeta | null> {
  if (!client || !token) return null;
  try {
    const [symbol, decimals] = await Promise.all([
      client.readContract({address: token, abi: IERC20MetadataAbi, functionName: "symbol"}),
      client.readContract({address: token, abi: IERC20MetadataAbi, functionName: "decimals"}),
    ]);
    return {symbol: symbol as string, decimals: Number(decimals)};
  } catch {
    return null;
  }
}

/** The chain head, for the lag figure. Undefined on any failure — the footer then omits it. */
async function chainHead(client: PublicClient | null): Promise<bigint | undefined> {
  if (!client) return undefined;
  try {
    return await client.getBlockNumber();
  } catch {
    return undefined;
  }
}

/**
 * Load everything `/b/<wallet>` renders.
 *
 * Never throws. Every branch of every failure has a value in the returned shape, because the caller is
 * a server component and a thrown error there is a 500 on a page somebody shared.
 */
export async function loadPublicCard(
  wallet: `0x${string}`,
  opts: {chainId?: number; now?: number} = {},
): Promise<PublicCard> {
  const chainId = opts.chainId ?? DEFAULT_CHAIN_ID;
  const now = opts.now ?? Math.floor(Date.now() / 1000);

  // Independent upstreams — Ethos and the subgraph — so they run together. The score is the slower of
  // the two on a cache miss and there is no reason for the history to wait behind it.
  const [scored, historyResult] = await Promise.all([
    scoreResponse(wallet),
    fetchPromoterHistory({chainId, wallet}),
  ]);

  const score = cardScoreFrom(scored.status, scored.body);
  const handle = score.kind === "scored" ? score.score.handle : null;

  if (historyResult.kind !== "ok") {
    return {
      wallet,
      chainId,
      score,
      handle,
      history: undefined,
      historyUnavailable: historyResult,
      indexedBlock: undefined,
      lag: undefined,
      earnedToken: null,
    };
  }

  const folded = foldHistory(historyResult.data, {now});
  const client = serverClient(chainId);

  // All three are optional decorations on a card that already has its numbers, so they go out together
  // and none of them can fail the page.
  const [times, earnedToken, head] = await Promise.all([
    blockTimes(client, milestoneBlocks(folded)),
    tokenMeta(client, folded.earned[0]?.token),
    chainHead(client),
  ]);

  return {
    wallet,
    chainId,
    score,
    handle,
    history: withResolvedDates(folded, times),
    historyUnavailable: undefined,
    indexedBlock: historyResult.data.indexedBlock,
    lag: graphLag(historyResult.data.indexedBlock, head),
    earnedToken,
  };
}
