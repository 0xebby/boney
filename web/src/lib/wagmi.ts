import {http, createConfig} from "wagmi";
import {injected} from "wagmi/connectors";
import {anvil, sepolia, mainnet} from "./chains";

/**
 * wagmi configuration.
 *
 * Injected connector only (decision F2): WalletConnect needs a project id and a relay, and
 * RainbowKit pulls in a large dependency tree. An injected wallet covers local development and
 * every browser-extension wallet, with no configuration to get wrong.
 */
export const wagmiConfig = createConfig({
  chains: [anvil, sepolia, mainnet],
  connectors: [injected()],
  transports: {
    [anvil.id]: http("http://127.0.0.1:8545"),
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
