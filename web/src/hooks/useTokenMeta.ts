"use client";

import {useQuery} from "@tanstack/react-query";
import {usePublicClient} from "wagmi";
import type {PublicClient} from "viem";
import {IERC20MetadataAbi} from "@/lib/abis";
import {isAddress} from "@/lib/validation";
import {useBoneyChainId} from "@/hooks/useBoneyChain";

/**
 * Reads an ERC-20's `symbol` and `decimals` straight from the chain.
 *
 * The create form used to take decimals as a typed field, which is a silent-corruption risk of
 * exactly the kind `campaignArgs` guards against: entering 18 for a 6-decimal token scales the
 * whole reward ladder by 10^12 and still deploys successfully. Reading it from the token removes
 * the chance to get it wrong.
 *
 * `status` is reported so the form can block submission until the token is confirmed, rather than
 * quietly encoding against the 18-decimal fallback.
 */

export type TokenMeta = {
  symbol: string;
  decimals: number;
};

export type TokenMetaState = {
  meta: TokenMeta | null;
  /** No address entered yet, or it is not well-formed. */
  isIdle: boolean;
  isLoading: boolean;
  /** The address is well-formed but does not answer as an ERC-20. */
  isUnreadable: boolean;
};

export function useTokenMeta(tokenAddress: string): TokenMetaState {
  const client = usePublicClient({chainId: useBoneyChainId()});
  const chainId = client?.chain?.id;
  const valid = isAddress(tokenAddress) && !/^0x0{40}$/i.test(tokenAddress);

  const query = useQuery({
    queryKey: ["tokenMeta", chainId, tokenAddress.toLowerCase()],
    enabled: Boolean(client) && valid,
    // Token metadata is immutable in practice; no need to refetch it during a form session.
    staleTime: Infinity,
    retry: false,
    queryFn: async (): Promise<TokenMeta> => {
      const c = client as PublicClient;
      const address = tokenAddress as `0x${string}`;

      const [symbol, decimals] = await Promise.all([
        c.readContract({address, abi: IERC20MetadataAbi, functionName: "symbol"}),
        c.readContract({address, abi: IERC20MetadataAbi, functionName: "decimals"}),
      ]);

      return {symbol: symbol as string, decimals: Number(decimals)};
    },
  });

  return {
    meta: query.data ?? null,
    isIdle: !valid,
    isLoading: valid && query.isLoading,
    // Unlike the read-only list, a failure here is NOT smoothed over with an 18-decimal
    // fallback: this value scales money the project is about to escrow.
    isUnreadable: valid && query.isError,
  };
}
