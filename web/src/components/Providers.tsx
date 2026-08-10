"use client";

import {useState, type ReactNode} from "react";
import {WagmiProvider} from "wagmi";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {wagmiConfig} from "@/lib/wagmi";

/**
 * Client providers.
 *
 * The QueryClient is created inside `useState` so each browser session gets one instance and
 * it is never shared across requests during SSR.
 */
export function Providers({children}: {children: ReactNode}) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 10_000,
            retry: 1,
            // Chain state can move while a tab sits in the background — a campaign ended from
            // another tab, another wallet, or anyone at all once its window closes. Refetching on
            // focus is the cheapest way to notice: it costs nothing while away and resolves the
            // "came back to a stale page" case without polling. `staleTime` above still collapses
            // the rapid focus/blur bursts that made this look like noise.
            refetchOnWindowFocus: true,
          },
        },
      }),
  );

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
