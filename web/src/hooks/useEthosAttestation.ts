"use client";

import {useCallback, useState} from "react";
import {useAccount, usePublicClient, useWalletClient} from "wagmi";
import type {PublicClient} from "viem";
import {ReputationRegistryAbi, AttestationVerifierAbi} from "@/lib/abis";
import {getDeployment} from "@/lib/chains";
import {useBoneyChainId} from "@/hooks/useBoneyChain";

/**
 * Fetch signed attestations for the connected wallet and submit them on chain.
 *
 * The split of duties is deliberate: the server holds the attestor key and only ever *signs*,
 * while the promoter's own wallet sends the transaction. `ReputationRegistry.submitAttestation` is
 * permissionless for exactly this reason — authority comes from the signature, not the caller — so
 * the key never needs gas, never needs to be a hot wallet on chain, and a leaked response is
 * useless for any wallet other than the subject it was signed for.
 *
 * Submissions are sequential and order-sensitive: the verifier consumes one nonce per signature,
 * so sending them concurrently would revert all but the first.
 *
 * Sequential is necessary but not sufficient. `waitForTransactionReceipt` proves *one* node saw the
 * previous submission; the next `simulateContract` may be routed to a replica that has not caught
 * up, which reads the pre-submission nonce and reverts the whole batch with `InvalidNonce` even
 * though every signature was correct. Base's public endpoint is load-balanced and rate-limited, so
 * this is routine rather than exotic. `waitForNonce` closes the window by polling the verifier until
 * the attestor's nonce actually reflects the previous submission.
 */

/**
 * Registry ABI plus the verifier's, purely so reverts decode into names.
 *
 * `submitAttestation` lives on the registry but delegates to `AttestationVerifier`, and most of the
 * ways it fails — `InvalidNonce`, `NotAnAttestor`, `AttestationExpired`, `InvalidSignature` — are
 * declared there. viem decodes a revert against the ABI it was handed, so with the registry ABI
 * alone those surface as a raw selector ("Unable to decode signature 0x1d8af046") and the user is
 * told to go look it up on a fourbyte directory. Concatenating the two costs nothing at runtime and
 * turns every one of them into a readable error.
 */
const SUBMIT_ABI = [...ReputationRegistryAbi, ...AttestationVerifierAbi] as const;

/** How long to wait for a lagging RPC replica to catch up before giving up on a submission. */
const NONCE_SYNC_TIMEOUT_MS = 30_000;
const NONCE_POLL_INTERVAL_MS = 1_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Block until the verifier reports `expected` as the attestor's next nonce.
 *
 * Returns rather than throwing on timeout: the nonce read is an optimisation, and a node that
 * cannot answer it in time should not be the reason a valid signature never gets submitted. The
 * submission is attempted anyway and the contract remains the authority on whether it is valid.
 *
 * A nonce *above* `expected` also ends the wait — that means this signature has already been
 * consumed, and no amount of further polling will bring it back. The submission then fails with
 * the contract's own error, which is the accurate thing to show.
 */
async function waitForNonce(
  client: PublicClient,
  verifier: `0x${string}`,
  attestor: `0x${string}`,
  expected: bigint,
): Promise<void> {
  const deadline = Date.now() + NONCE_SYNC_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      const onChain = (await client.readContract({
        address: verifier,
        abi: AttestationVerifierAbi,
        functionName: "nonces",
        args: [attestor],
      })) as bigint;
      if (onChain >= expected) return;
    } catch {
      // A failed read is itself a symptom of the rate limiting this loop exists to ride out.
      // Keep polling until the deadline rather than failing the submission on one bad response.
    }
    await sleep(NONCE_POLL_INTERVAL_MS);
  }
}

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
  /** Kaito's smart-follower count. Display only — not attested, not scored. */
  smartFollowers: number;
  reach: number;
  handle: string | null;
  signed: SignedAttestation[];
};

export type AttestState =
  | {status: "idle"}
  | {status: "fetching"}
  | {status: "submitting"; done: number; total: number}
  | {status: "success"; ethos: number; reach: number; followers: number; smartFollowers: number}
  | {status: "error"; message: string};

export function useEthosAttestation() {
  const {address} = useAccount();
  const publicClient = usePublicClient({chainId: useBoneyChainId()});
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
        // Make sure the node about to simulate this call has observed the previous submission.
        // Skipped for the first attestation, which depends on nothing before it.
        if (i > 0) {
          await waitForNonce(
            publicClient as PublicClient,
            deployment.attestationVerifier,
            struct.attestor,
            struct.nonce,
          );
        }

        const {request} = await (publicClient as PublicClient).simulateContract({
          account: walletClient.account,
          address: deployment.reputationRegistry,
          abi: SUBMIT_ABI,
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
      smartFollowers: payload.smartFollowers,
    });
    return true;
  }, [address, publicClient, walletClient]);

  return {state, attest, reset};
}
