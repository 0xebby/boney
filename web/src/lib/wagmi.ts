import {http, createConfig} from "wagmi";
import {injected} from "wagmi/connectors";
import {anvil, sepolia, baseSepolia, mainnet} from "./chains";

/**
 * wagmi configuration.
 *
 * Injected connector only (decision F2): WalletConnect needs a project id and a relay, and
 * RainbowKit pulls in a large dependency tree. An injected wallet covers local development and
 * every browser-extension wallet, with no configuration to get wrong.
 *
 * The anvil RPC is env-configurable because `127.0.0.1` is not a fixed point — it means whatever
 * host the *browser* runs on. A chain served from WSL2, a container, or another machine is not on
 * the browser's loopback, and the resulting failure is confusing: pages render fine (they are
 * server-rendered) and only wallet and contract reads break. Set `NEXT_PUBLIC_ANVIL_RPC` to an
 * address the browser can actually resolve, and start anvil with `--host 0.0.0.0` so it listens
 * there.
 */
export const wagmiConfig = createConfig({
  chains: [anvil, baseSepolia, sepolia, mainnet],
  connectors: [injected()],
  transports: {
    [anvil.id]: http(process.env.NEXT_PUBLIC_ANVIL_RPC ?? "http://127.0.0.1:8545"),
    // Base's public endpoint is rate-limited; set the env var to a provider URL for real use.
    [baseSepolia.id]: http(process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC ?? "https://sepolia.base.org"),
    [sepolia.id]: http(process.env.NEXT_PUBLIC_SEPOLIA_RPC),
    [mainnet.id]: http(process.env.NEXT_PUBLIC_MAINNET_RPC),
  },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
