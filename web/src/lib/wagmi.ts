import {http, createConfig} from "wagmi";
import {injected} from "wagmi/connectors";
import {anvil, sepolia, baseSepolia, mainnet, rpcUrlFor} from "./chains";

/**
 * wagmi configuration.
 *
 * Injected connector only (decision F2): WalletConnect needs a project id and a relay, and
 * RainbowKit pulls in a large dependency tree. An injected wallet covers local development and
 * every browser-extension wallet, with no configuration to get wrong.
 *
 * The endpoints come from `rpcUrlFor` rather than being written out here, so the browser and the
 * server-rendered public card read the same chain from the same URL. See that function for why the
 * Base Sepolia default is publicnode and why the anvil one has to be configurable.
 */
export const wagmiConfig = createConfig({
  chains: [anvil, baseSepolia, sepolia, mainnet],
  connectors: [injected()],
  transports: {
    [anvil.id]: http(rpcUrlFor(anvil.id)),
    [baseSepolia.id]: http(rpcUrlFor(baseSepolia.id)),
    [sepolia.id]: http(rpcUrlFor(sepolia.id)),
    [mainnet.id]: http(rpcUrlFor(mainnet.id)),
  },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
