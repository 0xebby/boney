"use client";

import {useCallback, useState} from "react";
import {usePublicClient, useWalletClient} from "wagmi";
import {
  parseEventLogs,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import {BoneyAbi, CampaignAbi, CampaignRegistryAbi, IERC20Abi, AttributionRegistryAbi} from "@/lib/abis";
import {getDeployment} from "@/lib/chains";
import {useBoneyChainId} from "@/hooks/useBoneyChain";
import {buildCreateCampaignArgs, toWireKpis} from "@/lib/campaignArgs";
import {describeTxError} from "@/lib/txErrors";
import {encodeActions} from "@/lib/indexerCore";
import {
  buildTouch,
  fetchEffectiveMaxDuration,
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
  /** `message` is plain language; `detail` is the raw `ErrorName(args)` for a bug report. */
  | {status: "error"; message: string; detail?: string};

const IDLE: TxState = {status: "idle"};

/** True while the action is in flight — used to disable the button that triggered it. */
export function isPending(state: TxState): boolean {
  return state.status === "preparing" || state.status === "submitted";
}

/**
 * Error copy lives in `lib/txErrors`, not here.
 *
 * A revert reaches this hook as a custom error name and its arguments — `WrongStatus(3)`,
 * `InsufficientReputation(24620, 50000)` — which is exact and unreadable. Translating it is pure
 * string work over the contract ABIs, so it belongs in a unit-tested module rather than inside a
 * React hook. Re-exported so existing call sites keep importing it from here.
 */
export {describeTxError} from "@/lib/txErrors";
export type {TxErrorCopy} from "@/lib/txErrors";

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
          // Simulation passed but execution didn't, so state moved between the two. There is no
          // error name to decode from a receipt — the reason lives in the trace — so this says
          // what the user can actually do rather than inventing a cause.
          setState({
            status: "error",
            message:
              "The transaction reverted on chain — the campaign's state changed after this page loaded. Reload and try again.",
            detail: `receipt status: ${receipt.status}`,
          });
          return;
        }

        onConfirmed?.(receipt);
        setState({status: "confirmed", hash});
      } catch (err) {
        setState({status: "error", ...describeTxError(err)});
      }
    },
    [],
  );

  return {state, setState, reset, run};
}

/**
 * Clients plus the resolved deployment, or an error message explaining what's missing.
 *
 * Pinning the public client to `useBoneyChainId` is safe for a *write* path specifically because
 * every writer below bails with "Connect a wallet…" when `walletClient` is missing, and with a
 * wallet connected that hook returns the wallet's own chain. So this never simulates against the
 * disconnected default — it only removes the window where wagmi's store still reports `chains[0]`
 * for a render after mount, which would otherwise resolve the deployment for the wrong chain.
 */
function useWriteContext() {
  const publicClient = usePublicClient({chainId: useBoneyChainId()});
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

// ── promoter ─────────────────────────────────────────────────────

/**
 * `Campaign.join()` — called on the campaign directly, never through the facade.
 *
 * The campaign records `msg.sender` as the promoter, so a facade-relayed join would register the
 * facade instead of the promoter. `Boney` documents this and deliberately exposes only
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
 * `Campaign.settle(promoter, kpiIndex)` — the recovery path for a tier that was crossed but never
 * paid.
 *
 * Not the normal payment path, and the UI must not present it as one: `_settle` runs inline at the
 * end of `reportUserAction`, releasing escrow in the same transaction that credits progress, so on
 * the happy path there is nothing left to settle. `canSettle` in `lib/promoter` gates the button on
 * a non-zero payout for exactly that reason — see the note there.
 *
 * `promoter` is a parameter rather than the connected account because the contract pays the address
 * it is handed, not `msg.sender`. Anyone can push a promoter's earned tiers through, which is what
 * keeps a promoter from depending on the project to get paid after a campaign ends.
 *
 * Per-KPI by necessity: the tier ladder is keyed by `(promoter, kpiIndex)` and `settle` walks one
 * ladder, so a promoter owed on two KPIs signs twice. `pendingKpi` tracks which one is in flight so
 * only that row shows a spinner — same reason `useCampaignLifecycle` tracks `action`.
 */
export function useSettleRewards() {
  const {publicClient, walletClient} = useWriteContext();
  const {state, setState, reset, run} = useTx();
  const [pendingKpi, setPendingKpi] = useState<number | null>(null);

  const settle = useCallback(
    async (campaign: `0x${string}`, promoter: `0x${string}`, kpiIndex: number) => {
      if (!publicClient || !walletClient) {
        setState({status: "error", message: "Connect a wallet to settle these rewards."});
        return;
      }

      const account = walletClient.account;
      setPendingKpi(kpiIndex);

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
    },
    [publicClient, walletClient, run, setState],
  );

  return {
    state,
    settle,
    reset: useCallback(() => {
      setPendingKpi(null);
      reset();
    }, [reset]),
    /** Which KPI's settle is in flight, so only that button shows a spinner. */
    pendingKpi,
  };
}

// ── attribution ──────────────────────────────────────────────────

/**
 * `AttributionRegistry.storeTouch` — the referral signs a Touch, anyone relays it.
 *
 * Two transactions' worth of work in one call, but only one of them costs gas: the *referral* signs
 * an EIP-712 Touch off-chain, and whoever is connected relays it. That split is the whole point
 * of the design — a promoter can pay the gas to attribute a referral who never transacts, and a
 * promoter cannot attribute a wallet it has no signature from.
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
          // One read, not two: the registry resolves `min(attributionWindow, maxTouchDuration)`
          // itself and enforces exactly that in `storeTouch`, so asking it removes the chance of
          // this client computing a different minimum and producing a touch that reverts
          // `TouchTooLong` after the referral has already signed.
          const [horizon, block] = await Promise.all([
            fetchEffectiveMaxDuration(publicClient, registry, campaign),
            publicClient.getBlock(),
          ]);

          const built = buildTouch(campaign, promoterId, horizon, horizon, Number(block.timestamp));

          // The referral signs; the connected wallet relays. They are usually the same account here,
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

// ── reporting (dev tool) ─────────────────────────────────────────

/**
 * `Campaign.reportUserAction` — the project crediting a referral's activity.
 *
 * Normally the indexer's job (`scripts/indexer.ts` watches KPI event sources and reports what it
 * finds). This hook exists so a project wallet can push the same reports by hand while testing —
 * which is why it lives behind `isProject` in `ReportPanel` rather than being part of the
 * promoter-facing flow. What it reports is decided by `planObservedReport`, from the same logs the
 * indexer reads; this hook only sends what it is handed.
 *
 * **Sequential, not batched.** One KOL can have several attributed referrals, and the contract
 * takes one referral per call, so crediting a KOL is N transactions. They run in series and the
 * loop stops at the first failure: `_settle` runs inline at the end of each call, so a partial
 * sequence has already moved real money, and firing the rest after a revert would pile more state
 * changes on top of a condition the caller has not seen yet. `sent` reports how many landed, so
 * the panel can say "2 of 3 confirmed" rather than implying all-or-nothing.
 *
 * Each call is simulated first, for the same reason as every other write here: `NoAttribution`,
 * `NonMonotonic` and `AggregateKpi` are named errors before signing and opaque failures after.
 */
export function useReportUserAction() {
  const {publicClient, walletClient} = useWriteContext();
  const [state, setState] = useState<TxState>(IDLE);
  const [sent, setSent] = useState(0);
  const [total, setTotal] = useState(0);

  const reset = useCallback(() => {
    setState(IDLE);
    setSent(0);
    setTotal(0);
  }, []);

  const report = useCallback(
    async (
      campaign: `0x${string}`,
      kpiIndex: number,
      calls: readonly {
        referral: `0x${string}`;
        newTotal: bigint;
        actions?: readonly {timestamp: bigint; amount: bigint}[];
      }[],
    ) => {
      if (!publicClient || !walletClient) {
        setState({status: "error", message: "Connect a wallet to report progress."});
        return;
      }
      if (calls.length === 0) return;

      const account = walletClient.account;
      setSent(0);
      setTotal(calls.length);

      for (const call of calls) {
        try {
          setState({status: "preparing"});

          // Evidence is the observed actions when the plan carries them, `"0x"` otherwise. A KPI
          // with `verifier == address(0)` ignores the argument either way (`Campaign.sol:325`); a
          // verifier-gated one decodes it as `TouchWindowVerifier.Action[]`, so sending the empty
          // blob there would fail the decode rather than credit a discounted amount.
          const evidence = call.actions?.length ? encodeActions(call.actions) : "0x";

          const {request} = await publicClient.simulateContract({
            account,
            address: campaign,
            abi: CampaignAbi,
            functionName: "reportUserAction",
            args: [BigInt(kpiIndex), call.referral, call.newTotal, evidence],
          });

          const hash = await walletClient.writeContract(request);
          setState({status: "submitted", hash});

          const receipt = await publicClient.waitForTransactionReceipt({hash});
          if (receipt.status !== "success") {
            setState({
              status: "error",
              message:
                "The report reverted on chain — the campaign's state changed after this page loaded. Reload and try again.",
              detail: `receipt status: ${receipt.status} · referral ${call.referral}`,
            });
            return;
          }

          setSent((n) => n + 1);
          setState({status: "confirmed", hash});
        } catch (err) {
          const {message, detail} = describeTxError(err);
          setState({
            status: "error",
            message,
            detail: [detail, `referral ${call.referral}`].filter(Boolean).join(" · "),
          });
          return;
        }
      }
    },
    [publicClient, walletClient],
  );

  return {
    state,
    report,
    reset,
    /** Reports confirmed so far, and how many the plan asked for. */
    sent,
    total,
  };
}
