"use client";

import {LeaderboardPage} from "@/components/LeaderboardPage";

/**
 * `/leaderboard` — points for verified actions on Boneyard.
 *
 * Public and walletless: the board is the argument for joining, so it has to be readable before a
 * wallet is connected. A connected wallet additionally sees its own standing.
 *
 * A client component because the whole board is one subgraph read, and `useBoneyChainId` needs the
 * connected chain to know which subgraph to ask.
 */
export default function Page() {
  return <LeaderboardPage />;
}
