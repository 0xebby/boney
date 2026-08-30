import {formatTokenAmount, shortAddress} from "./format";

/**
 * The description of a wallet prompt, shown for confirmation before the wallet opens.
 *
 * Built by the hook that owns the write, rendered by `ui/ConfirmSignDialog`, and gated on by
 * `components/SignatureGate`. Pure data with no React and no viem types, so the copy for every
 * signing path is unit-testable.
 */

/** Whether a prompt costs gas (`transaction`) or is an off-chain signature. */
export type SignKind = "transaction" | "signature";

/** One label→value fact about the pending prompt. */
export type IntentRow = {
  label: string;
  value: string;
  /** Sentence revealed from the row's info control. */
  hint?: string;
  /** Renders the value in mono — addresses, ids, hashes. */
  mono?: boolean;
};

/** Tone of the consequence callout. */
export type IntentTone = "info" | "warning" | "critical";

/** Everything the confirmation dialog renders for one pending prompt. */
export type SignIntent = {
  /** Imperative action name, used as the dialog title. */
  title: string;
  /** One sentence stating what signing does. */
  summary: string;
  /** The facts of the prompt, in reading order. */
  rows: readonly IntentRow[];
  /** The consequence the signer must read, shown in the callout. */
  important?: string;
  /** Callout tone. Defaults to `info`. */
  tone?: IntentTone;
  /** Label on the confirm control. */
  confirmLabel: string;
  /** The wallet prompts this action opens, in order. */
  prompts: readonly SignKind[];
};

const KIND_LABEL: Record<SignKind, {one: string; many: string}> = {
  transaction: {one: "transaction", many: "transactions"},
  signature: {one: "signature", many: "signatures"},
};

/**
 * Plain-language count of the wallet prompts an action opens.
 *
 * Runs of the same kind collapse ("2 transactions"); mixed runs are joined in order
 * ("1 signature, then 1 transaction").
 *
 * @param prompts Prompts in the order the wallet will show them.
 * @returns The summary sentence fragment, or "no prompts" when the list is empty.
 */
export function promptSummary(prompts: readonly SignKind[]): string {
  if (prompts.length === 0) return "no prompts";

  const runs: {kind: SignKind; count: number}[] = [];
  for (const kind of prompts) {
    const last = runs[runs.length - 1];
    if (last && last.kind === kind) last.count += 1;
    else runs.push({kind, count: 1});
  }

  const parts = runs.map(({kind, count}) => {
    const label = KIND_LABEL[kind];
    return `${count} ${count === 1 ? label.one : label.many}`;
  });

  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")}, then ${parts[parts.length - 1]}`;
}

/**
 * A row naming an address, abbreviated for reading and rendered in mono.
 *
 * @param label Row label.
 * @param address The address, shown abbreviated.
 * @param hint Optional explanation for the row's info control.
 * @returns The row.
 */
export function addressRow(label: string, address: string, hint?: string): IntentRow {
  return {label, value: shortAddress(address), hint, mono: true};
}

/**
 * A row naming a token amount in display units.
 *
 * @param label Row label.
 * @param raw Amount in base units.
 * @param decimals Token decimals.
 * @param symbol Token symbol, or undefined to omit it.
 * @param hint Optional explanation for the row's info control.
 * @returns The row.
 */
export function amountRow(
  label: string,
  raw: bigint,
  decimals: number,
  symbol?: string,
  hint?: string,
): IntentRow {
  const amount = formatTokenAmount(raw, decimals, {maxFractionDigits: decimals >= 6 ? 4 : 2});
  return {label, value: symbol ? `${amount} ${symbol}` : amount, hint};
}

/**
 * The description used when a caller supplies none.
 *
 * Says only what is certain — that a wallet prompt is about to open — rather than guessing at the
 * action, so an unlabelled write still gets a confirmation step.
 *
 * @param prompts Prompts the action opens.
 * @returns A minimal intent.
 */
export function fallbackIntent(prompts: readonly SignKind[] = ["transaction"]): SignIntent {
  return {
    title: "Confirm in your wallet",
    summary: "Your wallet will open next. Review the request there before approving it.",
    rows: [],
    confirmLabel: "Continue",
    prompts,
  };
}
