"use client";

import {createContext, useCallback, useContext, useRef, useState, type ReactNode} from "react";
import {ConfirmSignDialog} from "./ui/ConfirmSignDialog";
import {fallbackIntent, type SignIntent} from "@/lib/signIntent";

/**
 * The confirmation step every wallet prompt in the app passes through.
 *
 * Mounted once by `components/Providers`. Hooks that are about to open a wallet call
 * `useConfirmSignature()` with a description of what they are about to ask for; the returned promise
 * resolves true when the signer accepts and false when they dismiss, so declining is a plain "not
 * signed" rather than an error to recover from.
 *
 * One prompt is shown at a time. A second request supersedes the first, which resolves false.
 */

/** Asks the signer to confirm, resolving true when they accept. */
export type ConfirmSignature = (intent?: SignIntent) => Promise<boolean>;

type Pending = {intent: SignIntent; settle: (accepted: boolean) => void};

const SignatureGateContext = createContext<ConfirmSignature | null>(null);

/**
 * Provides the confirmation dialog to every hook beneath it.
 *
 * @param children The app.
 * @returns The children, plus the dialog while a prompt is awaiting confirmation.
 */
export function SignatureGate({children}: {children: ReactNode}) {
  const [pending, setPending] = useState<Pending | null>(null);
  // The outstanding request is tracked in a ref as well as state so `confirm` can settle a
  // superseded promise without reading it from inside a state updater.
  const pendingRef = useRef<Pending | null>(null);

  const confirm = useCallback<ConfirmSignature>(
    (intent) =>
      new Promise<boolean>((resolve) => {
        pendingRef.current?.settle(false);

        const next: Pending = {
          intent: intent ?? fallbackIntent(),
          settle: (accepted) => {
            if (pendingRef.current === next) pendingRef.current = null;
            setPending((current) => (current === next ? null : current));
            resolve(accepted);
          },
        };

        pendingRef.current = next;
        setPending(next);
      }),
    [],
  );

  return (
    <SignatureGateContext value={confirm}>
      {children}
      {pending ? (
        <ConfirmSignDialog
          intent={pending.intent}
          onConfirm={() => pending.settle(true)}
          onCancel={() => pending.settle(false)}
        />
      ) : null}
    </SignatureGateContext>
  );
}

/**
 * The confirmation function for the surrounding gate.
 *
 * Falls back to accepting without a dialog when no gate is mounted, so a hook stays usable when it
 * is rendered outside the app shell.
 *
 * @returns A function that resolves true when the signer accepts.
 */
export function useConfirmSignature(): ConfirmSignature {
  const confirm = useContext(SignatureGateContext);
  return confirm ?? acceptWithoutDialog;
}

const acceptWithoutDialog: ConfirmSignature = () => Promise.resolve(true);
