"use client";

import {useCallback, useState} from "react";
import {usePublicClient, useWalletClient} from "wagmi";
import {
  parseEventLogs,
  BaseError,
  ContractFunctionRevertedError,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import {BoneyAbi, CampaignAbi, CampaignRegistryAbi, IERC20Abi, AttributionRegistryAbi} from "@/lib/abis";
import {getDeployment} from "@/lib/chains";
import {buildCreateCampaignArgs, toWireKpis} from "@/lib/campaignArgs";
import {
  buildTouch,
  fetchMaxTouchDuration,
  attributionDomain,
  TOUCH_EIP712_TYPES,
} from "@/lib/attribution";
import type {Touch} from "@/lib/attribution";
import type {LifecycleAction} from "@/lib/lifecycle";
import type {CampaignDraft} from "@/lib/validation";

/**
 * Write hooks for the project-side campaign lifecycle.
 *
 * Every write runs the same four steps — simulate, send, wait, decode — so they share one runner
 * (`useTx`) rather than repeating the state machine six times. Simulation is not optional: it is
 * the only step that surfaces a named custom error (`NotFunded`, `WrongStatus`, `ClaimWindowOpen`)
 * *before* the user signs. Sending without simulating turns every one of those into an opaque
 * "transaction failed" after gas is spent.
 *
 * State machine: idle → preparing → submitted → confirmed, with error reachable from any step.
 */

export type TxStatus = "idle" | "preparing" | "submitted" | "confirmed" | "error";

export type TxState =
  | {status: "idle"}
  /** Simulating and awaiting the wallet prompt. */
  | {status: "preparing"}
  /** In the mempool. */
  | {status: "submitted"; hash: Hex}
  | {status: "confirmed"; hash: Hex}
  | {status: "error"; message: string};

const IDLE: TxState = {status: "idle"};

/** True while the action is in flight — used to disable the button that triggered it. */
export function isPending(state: TxState): boolean {
  return state.status === "preparing" || state.status === "submitted";
}

/**
 * Turns a viem error into something a user can act on.
 *
 * A reverted simulation carries the contract's own custom error (and its args) inside a nested
 * `ContractFunctionRevertedError`. Surfacing that name beats the default multi-paragraph dump,
 * which buries it under the full calldata. A wallet rejection is not an error worth alarming
 * about, so it gets its own plain message.
 */
export function describeTxError(err: unknown): string {
  if (err instanceof BaseError) {
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      const name = reverted.data?.errorName;
      if (name) {
        const args = reverted.data?.args;
        return args && args.length > 0 ? `${name}(${args.map(String).join(", ")})` : name;
      }
      if (reverted.reason) return reverted.reason;
    }
    // 4001 is the EIP-1193 user-rejected-request code.
    if (/User rejected|denied transaction|4001/i.test(err.message)) {
      return "Transaction rejected in wallet.";
    }
    return err.shortMessage || err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Shared runner for a single write.
 *
 * `send` simulates and submits, returning the hash; `run` drives the state machine around it and
 * waits for the receipt. `onConfirmed` receives the mined receipt, letting a caller decode logs —
 * that's how create recovers its new campaign id.
 */
function useTx() {
  const [state, setState] = useState<TxState>(IDLE);
  const reset = useCallback(() => setState(IDLE), []);

  const run = useCallback(
    async (
      send: () => Promise<Hex>,
      onConfirmed: ((receipt: TransactionReceipt) => void) | undefined,
      client: PublicClient,
    ) => {
      try {
        setState({status: "preparing"});
        const hash = await send();
        setState({status: "submitted", hash});

        const receipt = await client.waitForTransactionReceipt({hash});
        if (receipt.status !== "success") {
          setState({status: "error", message: "Transaction reverted on chain."});
          return;
        }

        onConfirmed?.(receipt);
        setState({status: "confirmed", hash});
      } catch (err) {
        setState({status: "error", message: describeTxError(err)});
      }
    },
    [],
  );

  return {state, setState, reset, run};
}

/** Clients plus the resolved deployment, or an error message explaining what's missing. */
function useWriteContext() {
  const publicClient = usePublicClient();
  const {data: walletClient} = useWalletClient();
  const deployment = getDeployment(publicClient?.chain?.id);

  return {publicClient, walletClient, deployment};
}

// ── create ───────────────────────────────────────────────────────

export function useCreateCampaign() {
  const {publicClient, walletClient, deployment} = useWriteContext();
  const {state, setState, reset, run} = useTx();
  const [campaignId, setCampaignId] = useState<bigint | undefined>();

  const create = useCallback(
    async (draft: CampaignDraft, tokenDecimals: number) => {
      if (!publicClient || !walletClient) {
        setState({status: "error", message: "Connect a wallet to create a campaign."});
        return;
      }
      if (!deployment) {
        setState({status: "error", message: "Boney is not deployed on this network."});
        return;
      }

      const account = walletClient.account;
      setCampaignId(undefined);

      await run(
        async () => {
          // `cfg.project` must equal msg.sender or the facade reverts with NotProject.
          const [cfg, kpis, tiers] = buildCreateCampaignArgs(draft, {
            project: account.address,
            tokenDecimals,
          });

          // Note: createCampaign moves no tokens — escrow arrives via fundCampaign — so there
          // is deliberately no approval step here.
          const {request} = await publicClient.simulateContract({
            account,
            address: deployment.boney,
            abi: BoneyAbi,
            functionName: "createCampaign",
            args: [cfg, toWireKpis(kpis), tiers],
          });

          return walletClient.writeContract(request);
        },
        (receipt) => {
          // Decode with the generated registry ABI rather than a hand-written topic hash: a
          // literal keccak constant is exactly the kind of hand-copied value F4 exists to avoid.
          const events = parseEventLogs({
            abi: CampaignRegistryAbi,
            eventName: "CampaignCreated",
            logs: receipt.logs as never,
          });
          const created = events[0];
          if (created) setCampaignId(created.args.campaignId);
        },
        publicClient,
      );
    },
    [publicClient, walletClient, deployment, run, setState],
  );

  return {state, create, reset, campaignId};
}

// ── fund ─────────────────────────────────────────────────────────

/**
 * Funds a campaign's escrow through the facade.
 *
 * Two transactions, not one: ERC-20 needs an allowance before `fundCampaign` can pull. The
 * allowance is read first and the approval skipped when it already covers the amount, so a
 * repeat funder signs once instead of twice.
 */
export function useFundCampaign() {
  const {publicClient, walletClient, deployment} = useWriteContext();
  const {state, setState, reset, run} = useTx();
  const [needsApproval, setNeedsApproval] = useState(false);

  const fund = useCallback(
    async (campaignId: bigint, amount: bigint, token: `0x${string}`) => {
      if (!publicClient || !walletClient) {
        setState({status: "error", message: "Connect a wallet to fund this campaign."});
        return;
      }
      if (!deployment) {
        setState({status: "error", message: "Boney is not deployed on this network."});
        return;
      }

      const account = walletClient.account;

      await run(
        async () => {
          const allowance = await publicClient.readContract({
            address: token,
            abi: IERC20Abi,
            functionName: "allowance",
            args: [account.address, deployment.boney],
          });

          if (allowance < amount) {
            setNeedsApproval(true);
            const {request: approveRequest} = await publicClient.simulateContract({
              account,
              address: token,
              abi: IERC20Abi,
              functionName: "approve",
              args: [deployment.boney, amount],
            });
            const approveHash = await walletClient.writeContract(approveRequest);
            await publicClient.waitForTransactionReceipt({hash: approveHash});
          }
          setNeedsApproval(false);

          const {request} = await publicClient.simulateContract({
            account,
            address: deployment.boney,
            abi: BoneyAbi,
            functionName: "fundCampaign",
            args: [campaignId, amount],
          });

          return walletClient.writeContract(request);
        },
        undefined,
        publicClient,
      );
    },
    [publicClient, walletClient, deployment, run, setState],
  );

  return {state, fund, reset, needsApproval};
}

// ── lifecycle ────────────────────────────────────────────────────

/**
 * The no-argument lifecycle calls on a `Campaign`.
 *
 * These target the campaign contract directly. The facade deliberately does not proxy them: it
 * holds no privileged role, so a relayed `activate()` would arrive with the wrong `msg.sender`
 * and revert on `onlyProject`.
 *
 * `LifecycleAction` is re-exported from `lib/lifecycle` rather than declared here — one list of
 * action names, so a rename cannot leave the guards and the writer disagreeing.
 */
export type {LifecycleAction} from "@/lib/lifecycle";

export function useCampaignLifecycle() {
  const {publicClient, walletClient} = useWriteContext();
  const {state, setState, reset, run} = useTx();
  const [action, setAction] = useState<LifecycleAction | null>(null);

  const execute = useCallback(
    async (campaign: `0x${string}`, fn: LifecycleAction) => {
      if (!publicClient || !walletClient) {
        setState({status: "error", message: "Connect a wallet to manage this campaign."});
        return;
      }

      const account = walletClient.account;
      setAction(fn);

      await run(
        async () => {
          const {request} = await publicClient.simulateContract({
            account,
            address: campaign,
            abi: CampaignAbi,
            functionName: fn,
          });
          return walletClient.writeContract(request);
        },
        undefined,
        publicClient,
      );
    },
    [publicClient, walletClient, run, setState],
  );

  return {
    state,
    execute,
    reset: useCallback(() => {
      setAction(null);
      reset();
    }, [reset]),
    /** Which action is in flight, so only that button shows a spinner. */
    action,
  };
}

// ── promoter (KOL) ───────────────────────────────────────────────

/**
 * `Campaign.join()` — called on the campaign directly, never through the facade.
 *
 * The campaign records `msg.sender` as the promoter, so a facade-relayed join would register the
 * facade instead of the KOL. `Boney` documents this and deliberately exposes only
 * `campaignJoinTarget` to resolve the address.
 *
 * The new promoter id is decoded from the receipt rather than recomputed, so what the UI shows
 * is what the chain actually stored.
 */
export function useJoinCampaign() {
  const {publicClient, walletClient} = useWriteContext();
  const {state, setState, reset, run} = useTx();
  const [promoterId, setPromoterId] = useState<Hex | undefined>();

  const join = useCallback(
    async (campaign: `0x${string}`) => {
      if (!publicClient || !walletClient) {
        setState({status: "error", message: "Connect a wallet to join this campaign."});
        return;
      }

      const account = walletClient.account;
      setPromoterId(undefined);

      await run(
        async () => {
          const {request} = await publicClient.simulateContract({
            account,
            address: campaign,
            abi: CampaignAbi,
            functionName: "join",
          });
          return walletClient.writeContract(request);
        },
        (receipt) => {
          const events = parseEventLogs({
            abi: CampaignAbi,
            eventName: "PromoterJoined",
            logs: receipt.logs as never,
          });
          const joined = events[0];
          if (joined) setPromoterId(joined.args.promoterId);
        },
        publicClient,
      );
    },
    [publicClient, walletClient, run, setState],
  );

  return {state, join, reset, promoterId};
}

/**
 * `Campaign.settle(promoter, kpiIndex)` — pays out crossed-but-unsettled tiers for one KPI.
 *
 * Settlement is per KPI, not per campaign: the contract has no "settle everything" entry point,
 * so claiming across several KPIs means several transactions. They are issued in sequence rather
 * than in parallel — each one moves the same escrow balance, so a later call's simulation must
 * see the earlier one's effect or it can be built against a pool that is already spent.
 */
export function useSettleRewards() {
  const {publicClient, walletClient} = useWriteContext();
  const {state, setState, reset, run} = useTx();
  const [settling, setSettling] = useState<number | null>(null);

  const settle = useCallback(
    async (campaign: `0x${string}`, promoter: `0x${string}`, kpiIndex: number) => {
      if (!publicClient || !walletClient) {
        setState({status: "error", message: "Connect a wallet to claim rewards."});
        return;
      }

      const account = walletClient.account;
      setSettling(kpiIndex);

      await run(
        async () => {
          const {request} = await publicClient.simulateContract({
            account,
            address: campaign,
            abi: CampaignAbi,
            functionName: "settle",
            args: [promoter, BigInt(kpiIndex)],
          });
          return walletClient.writeContract(request);
        },
        undefined,
        publicClient,
      );

      setSettling(null);
    },
    [publicClient, walletClient, run, setState],
  );

  return {state, settle, reset, settling};
}

// ── attribution ──────────────────────────────────────────────────

/**
 * `AttributionRegistry.storeTouch` — the user signs a Touch, anyone relays it.
 *
 * Two transactions' worth of work in one call, but only one of them costs gas: the *user* signs
 * an EIP-712 Touch off-chain, and whoever is connected relays it. That split is the whole point
 * of the design — a KOL can pay the gas to attribute a user who never transacts, and a promoter
 * cannot attribute a wallet it has no signature from.
 *
 * `signedAt` comes from the connected chain's latest block, not `Date.now()`. A browser clock
 * running fast produces a touch the contract rejects outright (`TouchNotYetValid`), and one
 * running slow silently loses ordering races against other promoters. The chain's own clock is
 * the only one both sides agree on.
 */
export function useStoreTouch() {
  const {publicClient, walletClient, deployment} = useWriteContext();
  const {state, setState, reset, run} = useTx();
  const [touch, setTouch] = useState<Touch | undefined>();

  const storeTouch = useCallback(
    async (campaign: `0x${string}`, promoterId: Hex) => {
      if (!publicClient || !walletClient) {
        setState({status: "error", message: "Connect a wallet to confirm attribution."});
        return;
      }
      if (!deployment) {
        setState({status: "error", message: "Boney is not deployed on this network."});
        return;
      }

      const account = walletClient.account;
      const registry = deployment.attributionRegistry;
      setTouch(undefined);

      await run(
        async () => {
          const [attributionWindow, maxTouchDuration, block] = await Promise.all([
            publicClient.readContract({
              address: campaign,
              abi: CampaignAbi,
              functionName: "attributionWindow",
            }),
            fetchMaxTouchDuration(publicClient, registry),
            publicClient.getBlock(),
          ]);

          const built = buildTouch(
            campaign,
            promoterId,
            attributionWindow,
            maxTouchDuration,
            Number(block.timestamp),
          );

          // The user signs; the connected wallet relays. They are usually the same account here,
          // but the contract does not require it and neither does this.
          const signature = await walletClient.signTypedData({
            account,
            domain: attributionDomain(publicClient.chain.id, registry),
            types: TOUCH_EIP712_TYPES,
            primaryType: "Touch",
            message: built,
          });

          const {request} = await publicClient.simulateContract({
            account,
            address: registry,
            abi: AttributionRegistryAbi,
            functionName: "storeTouch",
            args: [account.address, built, signature, account.address],
          });

          setTouch(built);
          return walletClient.writeContract(request);
        },
        undefined,
        publicClient,
      );
    },
    [publicClient, walletClient, deployment, run, setState],
  );

  return {state, storeTouch, reset, touch};
}
