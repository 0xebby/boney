"use client";

import {useCallback, useState} from "react";
import {useAccount, usePublicClient, useWalletClient} from "wagmi";
import type {PublicClient} from "viem";
import {ReputationRegistryAbi} from "@/lib/abis";
import {getDeployment} from "@/lib/chains";

/**
 * Fetch signed attestations for the connected wallet and submit them on chain.
 *
 * The split of duties is deliberate: the server holds the attestor key and only ever *signs*,
 * while the KOL's own wallet sends the transaction. `ReputationRegistry.submitAttestation` is
 * permissionless for exactly this reason — authority comes from the signature, not the caller — so
 * the key never needs gas, never needs to be a hot wallet on chain, and a leaked response is
 * useless for any wallet other than the subject it was signed for.
 *
 * Submissions are sequential and order-sensitive: the verifier consumes one nonce per signature,
 * so sending them concurrently would revert all but the first.
 */

type SignedAttestation = {
  schema: string;
  attestation: {
    attestor: `0x${string}`;
    subject: `0x${string}`;
    schemaId: `0x${string}`;
    value: string;
    nonce: string;
    expiresAt: string;
    data: `0x${string}`;
  };
  signature: `0x${string}`;
};

type AttestResponse = {
  wallet: `0x${string}`;
  ethos: number;
  followers: number;
  reach: number;
  handle: string | null;
  signed: SignedAttestation[];
};

export type AttestState =
  | {status: "idle"}
  | {status: "fetching"}
  | {status: "submitting"; done: number; total: number}
  | {status: "success"; ethos: number; reach: number; followers: number}
  | {status: "error"; message: string};

export function useEthosAttestation() {
  const {address} = useAccount();
  const publicClient = usePublicClient();
  const {data: walletClient} = useWalletClient();
  const [state, setState] = useState<AttestState>({status: "idle"});

  const reset = useCallback(() => setState({status: "idle"}), []);

  const attest = useCallback(async (): Promise<boolean> => {
    if (!address || !publicClient || !walletClient) {
      setState({status: "error", message: "Connect a wallet first."});
      return false;
    }
    const chainId = publicClient.chain?.id;
    const deployment = getDeployment(chainId);
    if (!deployment) {
      setState({status: "error", message: "No Boney deployment on this chain."});
      return false;
    }

    setState({status: "fetching"});

    let payload: AttestResponse;
    try {
      const response = await fetch("/api/attest", {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({wallet: address, chainId}),
      });
      const json = await response.json();
      if (!response.ok) {
        // The route's messages are written for humans — surface them verbatim rather than
        // flattening every failure into "something went wrong".
        setState({status: "error", message: json?.message ?? "Could not verify your score."});
        return false;
      }
      payload = json as AttestResponse;
    } catch (error) {
      setState({status: "error", message: (error as Error).message});
      return false;
    }

    const total = payload.signed.length;
    for (let i = 0; i < total; i++) {
      const {attestation, signature} = payload.signed[i];
      setState({status: "submitting", done: i, total});

      const struct = {
        attestor: attestation.attestor,
        subject: attestation.subject,
        schemaId: attestation.schemaId,
        value: BigInt(attestation.value),
        nonce: BigInt(attestation.nonce),
        expiresAt: BigInt(attestation.expiresAt),
        data: attestation.data,
      };

      try {
        const {request} = await (publicClient as PublicClient).simulateContract({
          account: walletClient.account,
          address: deployment.reputationRegistry,
          abi: ReputationRegistryAbi,
          functionName: "submitAttestation",
          args: [struct.subject, struct.schemaId, struct.value, [struct], [signature]],
        });
        const hash = await walletClient.writeContract(request);
        await (publicClient as PublicClient).waitForTransactionReceipt({hash});
      } catch (error) {
        setState({
          status: "error",
          message: `Submitting ${payload.signed[i].schema} failed: ${(error as Error).message}`,
        });
        return false;
      }
    }

    setState({
      status: "success",
      ethos: payload.ethos,
      reach: payload.reach,
      followers: payload.followers,
    });
    return true;
  }, [address, publicClient, walletClient]);

  return {state, attest, reset};
}
