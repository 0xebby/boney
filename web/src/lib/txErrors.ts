import {
  BaseError,
  ContractFunctionRevertedError,
  decodeErrorResult,
  type Abi,
  type Hex,
} from "viem";
import {
  AttestationVerifierAbi,
  AttributionRegistryAbi,
  BoneyAbi,
  CampaignAbi,
  CampaignRegistryAbi,
  EscrowVaultAbi,
  IERC20Abi,
  OracleCoordinatorAbi,
  ReputationRegistryAbi,
} from "@/lib/abis";
import {compactNumber, formatDateTime, shortAddress} from "@/lib/format";
import {CAMPAIGN_STATUS} from "@/lib/types";

/**
 * Turns a chain revert into a sentence a user can act on.
 *
 * Every write in this app simulates before it signs, so a failed action arrives as a named custom
 * error with its arguments — `WrongStatus(3)`, `InsufficientReputation(24620, 50000)`,
 * `TouchNotNewer(1786133189, 1786133200)`. Those names are precise and completely opaque: they say
 * nothing about what the user should do differently. This module is the one place that translates
 * them, so the copy lives next to the argument formatting instead of being re-invented at each
 * call site.
 *
 * Two strings come back, not one. `message` is the sentence; `detail` keeps the raw
 * `Name(args)` so a user reporting a problem can paste something exact. Never drop `detail` —
 * a humanised message that turns out to be the wrong guess is unreportable without it.
 */

export type TxErrorCopy = {
  /** Plain-language sentence, safe to show as the only thing on screen. */
  message: string;
  /** `ErrorName(arg, arg)` as the chain returned it. Absent for non-revert failures. */
  detail?: string;
};

/**
 * Error entries from every contract in the protocol, not just the one being called.
 *
 * A revert can originate below the contract the UI addressed: `Campaign.activate` reads escrow, so
 * an `EscrowVault` error surfaces from a call simulated against `CampaignAbi`. viem can only name
 * an error whose selector is in the ABI it was handed, so it returns raw hex for those. Decoding
 * against the union recovers the name instead of showing the user four bytes.
 */
const ERROR_ABI: Abi = dedupeErrors(
  (
    [
      BoneyAbi,
      CampaignAbi,
      CampaignRegistryAbi,
      EscrowVaultAbi,
      AttributionRegistryAbi,
      ReputationRegistryAbi,
      AttestationVerifierAbi,
      OracleCoordinatorAbi,
      IERC20Abi,
    ] as unknown as readonly Abi[]
  ).flatMap((abi) => abi.filter((entry) => entry.type === "error")),
);

function dedupeErrors(entries: Abi): Abi {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key =
      entry.type === "error"
        ? `${entry.name}(${entry.inputs.map((i) => i.type).join(",")})`
        : "";
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── argument formatting ──────────────────────────────────────────

/** A `Types.CampaignStatus` index as its name. Out-of-range stays numeric rather than lying. */
function statusName(value: unknown): string {
  const index = Number(value);
  return CAMPAIGN_STATUS[index] ?? `status ${String(value)}`;
}

/** A unix seconds argument as a readable local timestamp. */
function at(value: unknown): string {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? formatDateTime(seconds) : "an unknown time";
}

/**
 * The offending byte from `InvalidNameChar`, shown only when it is printable.
 *
 * The rejected byte is frequently a control character or one piece of a multi-byte sequence, and
 * rendering that raw produces a mojibake glyph the user cannot match to anything they typed. Better
 * to say nothing than to point at the wrong character.
 */
function nameChar(value: unknown): string {
  if (typeof value !== "string") return "";
  const byte = Number.parseInt(value.replace(/^0x/, ""), 16);
  if (!Number.isFinite(byte) || byte < 0x21 || byte > 0x7e) return "";
  return ` ("${String.fromCharCode(byte)}")`;
}

/** A count-like uint. Reputation scores and KPI totals are counts, not token amounts. */
function count(value: unknown): string {
  const n = Number(value);
  return Number.isFinite(n) ? compactNumber(n) : String(value);
}

/**
 * A BoneyScore, always exact.
 *
 * Deliberately not `count`: "your score is 24.6K, this needs 50K" rounds away the thing the user
 * is trying to judge — how far off they are. A score is a target to close, so it gets every digit.
 */
function score(value: unknown): string {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString("en-US") : String(value);
}

function addr(value: unknown): string {
  const s = String(value);
  return s.startsWith("0x") ? shortAddress(s) : s;
}

/** A bytes32 id — long enough to be unique in a support thread, short enough to read. */
function id(value: unknown): string {
  const s = String(value);
  return s.startsWith("0x") ? `${s.slice(0, 10)}…` : s;
}

/** `index` args are zero-based on chain; KPIs are presented one-based in the UI. */
function kpiLabel(value: unknown): string {
  const n = Number(value);
  return Number.isFinite(n) ? `KPI #${n + 1}` : "that KPI";
}

// ── the copy ─────────────────────────────────────────────────────

/**
 * One entry per custom error the protocol can revert with.
 *
 * Each returns a sentence that names the cause *and* the way out, because "AlreadyJoined" tells a
 * user nothing they can do. Token amounts are deliberately never printed: these arguments are base
 * units and this module has no decimals to scale them by, so a raw `1000000000000000000` would be
 * worse than the qualitative statement. The exact values stay in `detail`.
 *
 * Overloaded names (`NotProject`, `InvalidSignature`, `UnknownCampaign` exist with two shapes)
 * branch on `args.length` rather than getting two entries, since the map is keyed by name alone.
 */
const MESSAGES: Record<string, (args: readonly unknown[]) => string> = {
  // ── Campaign: lifecycle ──
  WrongStatus: ([actual]) =>
    `This campaign is ${statusName(actual)}, which doesn't allow that action. Reload — someone may have changed its status.`,
  NotProject: (args) =>
    args.length === 2
      ? `Only the project that created this campaign can do that. Connected as ${addr(args[1])}, expected ${addr(args[0])}.`
      : "Only the project that created this campaign can do that. Switch to the wallet that created it.",
  NotReporter: () => "Only the project or the oracle can report progress on this campaign.",
  NotOracle: () => "Only the oracle coordinator can submit that report.",
  NotFunded: () =>
    "Escrow doesn't hold the full reward pool yet. Fund the campaign before activating it.",
  OutsideWindow: ([start, end]) =>
    `Outside the campaign window (${at(start)} → ${at(end)}). Wait for it to open, or it has already closed.`,
  InvalidWindow: () =>
    "The start and end times don't work: the end must come after the start and be in the future.",
  ClaimWindowOpen: ([until]) =>
    `Promoters can still claim until ${at(until)}. Unspent funds can only be reclaimed after that.`,
  NothingToReclaim: () => "There's nothing left in escrow to reclaim.",

  // ── Campaign: joining ──
  AlreadyJoined: () => "This wallet is already promoting the campaign.",
  NotJoined: () => "This wallet isn't promoting the campaign yet.",
  InsufficientReputation: ([current, required]) =>
    `Your BoneyScore is ${score(current)}, and this campaign requires ${score(required)}. Build reputation or pick a campaign with a lower bar.`,
  UnreachableReputation: ([required, max]) =>
    `The minimum BoneyScore of ${score(required)} is above the highest score anyone can reach (${score(max)}). Lower the requirement.`,

  // ── Campaign: reporting ──
  UnknownKpi: (a) => `${kpiLabel(a[0])} doesn't exist on this campaign.`,
  AggregateKpi: (a) =>
    `${kpiLabel(a[0])} is a campaign-wide KPI, so it can't be reported for a single user.`,
  NotAggregateKpi: (a) =>
    `${kpiLabel(a[0])} is a per-user KPI, so it can't be reported as a campaign-wide total.`,
  NoAttribution: ([user]) =>
    `No promoter is attributed to ${addr(user)}, so this action can't be credited. The referral needs a stored touch first.`,
  AmbiguousAttribution: ([user, kpiIndex]) =>
    `${addr(user)} switched promoter since the last ${kpiLabel(kpiIndex)} report, so a report with no per-action evidence can't say whose work this is. Report from observed actions instead.`,
  NonMonotonic: () =>
    "That report moves a total backwards. Progress can only go up — the chain already has a higher figure.",
  VerifierOvercredit: () =>
    "The verifier tried to credit more than the reported amount. Nothing was recorded.",
  TooManyActions: ([provided, max]) =>
    `That report carries ${count(provided)} actions as evidence, and the limit is ${count(max)}. Report a narrower range, or merge the actions.`,
  UnorderedEvidence: ([index]) =>
    `The evidence goes backwards at action ${Number(index) + 1}. Actions have to be ordered oldest first.`,

  // ── Campaign: creation ──
  NoKpis: () => "Add at least one KPI before creating the campaign.",
  TooManyKpis: ([, max]) => `Too many KPIs — this campaign type allows at most ${count(max)}.`,
  TierLengthMismatch: () => "Every KPI needs its own list of reward tiers.",
  EmptyTiers: (a) => `${kpiLabel(a[0])} has no reward tiers. Add at least one.`,
  TooManyTiers: (a) => `${kpiLabel(a[0])} has too many tiers — the limit is ${count(a[2])}.`,
  TiersNotAscending: (a) =>
    `On ${kpiLabel(a[0])}, tier ${Number(a[1]) + 1} doesn't have a higher threshold than the one before it. Thresholds must increase.`,
  ZeroTierReward: (a) =>
    `On ${kpiLabel(a[0])}, tier ${Number(a[1]) + 1} pays nothing. Every tier needs a reward above zero.`,
  ZeroRewardPool: () => "The reward pool can't be zero.",
  CustomKpiNeedsVerifier: (a) =>
    `${kpiLabel(a[0])} is a custom KPI, so it needs a verifier contract address.`,
  CampaignMismatch: ([expected, provided]) =>
    `That campaign address doesn't match the id — expected ${addr(expected)}, got ${addr(provided)}. Reload the page.`,
  UnknownCampaign: ([which]) =>
    `Campaign ${typeof which === "bigint" || typeof which === "number" ? `#${String(which)}` : addr(which)} isn't registered on this network. Check you're on the right chain.`,

  // ── Campaign: naming ──
  NameTooLong: ([got, max]) =>
    `That campaign name is ${count(got)} bytes — the limit is ${count(max)}. Note that accented and emoji characters cost more than one byte each.`,
  InvalidNameChar: ([index, char]) =>
    `The campaign name has a character it can't use at position ${Number(index) + 1}${nameChar(char)}. Letters, digits, spaces and basic punctuation only.`,
  NameTaken: ([takenName, existing]) =>
    `"${String(takenName)}" is already used by a campaign at ${addr(existing)}. Pick a different name.`,

  // ── Attribution ──
  TouchExpired: ([expiresAt]) =>
    `That referral link expired at ${at(expiresAt)}. Ask the promoter for a fresh one.`,
  TouchTooLong: () =>
    "That referral link is valid for longer than the registry allows. Ask the promoter for a fresh one.",
  TouchNotYetValid: () =>
    "That referral link is dated in the future — usually a clock that's running fast. Try again in a moment.",
  TouchNotNewer: () =>
    "A more recent attribution is already stored for this wallet, so this one can't replace it.",
  TouchAlreadyActive: ([, expiresAt]) =>
    `You're already attributed to this promoter until ${at(expiresAt)}. The window can't be extended, but you can switch to a different promoter.`,
  PromoterNotRegistered: () =>
    "That promoter isn't promoting this campaign, so the referral can't be attributed.",
  CampaignOver: ([endTime]) =>
    `This campaign closed at ${at(endTime)}, so referrals can no longer be attributed to it.`,
  CampaignTerminal: ([status]) =>
    `This campaign is ${statusName(status).toLowerCase()}, so referrals can no longer be attributed to it.`,
  ZeroPromoterId: () => "The referral link is missing its promoter id. Ask for a fresh one.",
  ZeroWindow: () => "The attribution window can't be zero.",
  InvalidSignature: (args) =>
    args.length === 1
      ? `Attestation ${Number(args[0]) + 1} has an invalid signature.`
      : "The signature doesn't match the wallet that was supposed to sign. Sign again with the correct account.",

  // ── Escrow ──
  InsufficientBalance: () =>
    "Escrow doesn't hold enough for that withdrawal. Someone may have reclaimed or paid out since this page loaded.",
  CampaignNotRegistered: () => "This campaign has no escrow account yet.",
  AlreadyRegistered: () => "This campaign already has an escrow account.",
  ZeroAmount: () => "Enter an amount above zero.",
  NotRegistrar: () => "Only the campaign registrar can move escrow.",
  NotAdmin: () => "Only the escrow admin can do that.",
  RegistrarAlreadySet: () => "The escrow registrar is already set and can't be changed.",
  RegistrarNotSet: () => "Escrow isn't wired up yet — no registrar has been set.",
  TransferFailed: () => "The token transfer failed. Check the token contract and your balance.",

  // ── Reputation ──
  UnknownSchema: ([schema]) => `Reputation schema ${id(schema)} isn't registered on this network.`,
  SchemaDisabled: ([schema]) => `Reputation schema ${id(schema)} is disabled.`,
  SchemaAlreadyRegistered: ([schema]) => `Reputation schema ${id(schema)} is already registered.`,
  AttestationAlreadyUsed: () =>
    "That attestation has already been submitted. Each one can only be used once.",
  StaleValue: ([storedAt]) =>
    `A newer reputation value is already stored (from ${at(storedAt)}), so this older one was rejected.`,
  ValueExceedsMax: ([schema, , max]) =>
    `That value is above the ceiling for schema ${id(schema)} (max ${count(max)}).`,
  EmptyName: () => "The name can't be empty.",
  TooManySchemas: ([max]) => `The registry is full — at most ${count(max)} schemas.`,

  // ── Attestation verification ──
  LengthMismatch: () => "The attestations and signatures don't line up. Re-request the attestation.",
  BelowThreshold: ([provided, required]) =>
    `Only ${count(provided)} of the ${count(required)} required attestations were provided.`,
  TooManyAttestations: () => "Too many attestations in one submission.",
  AttestationMismatch: ([index]) =>
    `Attestation ${Number(index) + 1} doesn't match what was requested.`,
  AttestationExpired: ([index]) => `Attestation ${Number(index) + 1} has expired. Request a fresh one.`,
  NotAnAttestor: ([who]) => `${addr(who)} isn't a recognised attestor.`,
  DuplicateAttestor: ([who]) => `${addr(who)} signed twice — each attestor can only sign once.`,
  InvalidNonce: () => "This attestation was already used or arrived out of order. Request a fresh one.",
  InvalidThreshold: ([threshold, attestors]) =>
    `A threshold of ${count(threshold)} is impossible with ${count(attestors)} attestors.`,

  // ── Oracle ──
  NotAReporter: ([who]) => `${addr(who)} isn't a registered oracle reporter.`,
  NothingStaked: () => "Stake is required first, and the amount must be above zero.",
  StakeLocked: ([until]) => `Stake is locked until ${at(until)}.`,
  UnknownReport: ([report]) => `Report ${id(report)} doesn't exist.`,
  ReportAlreadyExists: ([report]) => `Report ${id(report)} has already been filed.`,
  DisputeWindowOpen: ([until]) =>
    `The dispute window is open until ${at(until)}. This report can't be applied before then.`,
  DisputeWindowClosed: ([until]) => `The dispute window closed at ${at(until)}.`,
  ReportIsDisputed: () => "This report is under dispute and can't be applied.",
  ReportAlreadyApplied: () => "This report has already been applied.",
  NotUserReport: () => "That report is campaign-wide, not per-user.",
  NotAggregateReport: () => "That report is per-user, not campaign-wide.",
  RegistryAlreadySet: () => "The campaign registry is already set and can't be changed.",
  RegistryNotSet: () => "The oracle isn't wired to a campaign registry yet.",

  // ── Shared / OpenZeppelin ──
  ZeroAddress: () => "An address is missing or set to zero. Check the form and try again.",
  OwnableUnauthorizedAccount: ([who]) =>
    `${addr(who)} doesn't own this contract, so it can't make that change.`,
  OwnableInvalidOwner: () => "That owner address isn't valid.",
  ReentrancyGuardReentrantCall: () => "The contract blocked a re-entrant call. Try again.",
  SafeERC20FailedOperation: ([token]) =>
    `The token at ${addr(token)} rejected the transfer. Check your balance and allowance.`,
  ECDSAInvalidSignature: () => "The signature is malformed. Sign again.",
  ECDSAInvalidSignatureLength: () => "The signature is the wrong length. Sign again.",
  ECDSAInvalidSignatureS: () => "The signature is malformed. Sign again.",
  InvalidShortString: () => "That text is too long to store on chain.",
  StringTooLong: () => "That text is too long to store on chain.",
};

// ── node-level failures ──────────────────────────────────────────

/**
 * Failures that never reach the contract — the wallet, the node, or the network refused first.
 *
 * Matched against viem's `shortMessage` and `message` because these arrive as prose, not as typed
 * errors. Order matters: the first match wins, so the specific patterns come before the broad ones.
 */
const NODE_FAILURES: {test: RegExp; message: string}[] = [
  {
    test: /user rejected|user denied|denied transaction|rejected the request|\b4001\b/i,
    message: "You rejected the request in your wallet.",
  },
  {
    test: /insufficient funds/i,
    message: "This wallet doesn't have enough ETH to cover gas for that transaction.",
  },
  {
    test: /transfer amount exceeds balance|exceeds balance/i,
    message: "Your token balance is too low for that amount.",
  },
  {
    test: /insufficient allowance/i,
    message: "The token allowance is too low. Approve the spend and try again.",
  },
  {
    test: /nonce too low|already known|replacement transaction underpriced/i,
    message: "A transaction from this wallet is already in flight. Wait for it to confirm, then retry.",
  },
  {
    test: /gas required exceeds|out of gas|intrinsic gas too low/i,
    message: "The transaction needs more gas than the limit allows.",
  },
  {
    test: /max fee per gas less than|fee cap|underpriced/i,
    message: "The gas price offered is below what the network is accepting right now. Try again.",
  },
  {
    test: /chain (id )?mismatch|does not match the target chain|wrong network|unsupported chain/i,
    message: "Your wallet is on a different network. Switch it to the campaign's chain and retry.",
  },
  {
    test: /timed out|timeout|took too long/i,
    message: "The network didn't respond in time. Check your connection and try again.",
  },
  {
    test: /rate limit|too many requests|429/i,
    message: "The RPC endpoint is rate limiting this app. Wait a moment and try again.",
  },
  {
    test: /http request failed|fetch failed|network error|failed to fetch/i,
    message: "Couldn't reach the network. Check your connection and try again.",
  },
  {
    test: /reverted|execution reverted/i,
    message: "The transaction was rejected by the contract.",
  },
];

// ── entry points ─────────────────────────────────────────────────

/**
 * The sentence for a decoded custom error.
 *
 * Exported so the same copy can be reused anywhere an error name is already known — a read-side
 * decode, a test, a static explanation — without going through a viem error object.
 */
export function humanizeContractError(name: string, args: readonly unknown[] = []): TxErrorCopy {
  const detail = args.length > 0 ? `${name}(${args.map(formatArg).join(", ")})` : `${name}()`;
  const render = MESSAGES[name];
  return {
    // An unmapped name is still better shown than swallowed: it names the contract's own reason,
    // which is what a user would have to quote to get help anyway.
    message: render ? render(args) : `The contract rejected this action (${name}).`,
    detail,
  };
}

function formatArg(value: unknown): string {
  return typeof value === "bigint" ? value.toString() : String(value);
}

/**
 * Turns any thrown value from a write path into user-facing copy.
 *
 * Tries three things in order: the custom error viem already named, the raw revert bytes decoded
 * against every protocol ABI (which catches reverts from contracts the call didn't address), and
 * finally the prose patterns for wallet- and node-level failures.
 */
export function describeTxError(err: unknown): TxErrorCopy {
  if (err instanceof BaseError) {
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);

    if (reverted instanceof ContractFunctionRevertedError) {
      const name = reverted.data?.errorName;
      if (name) return humanizeContractError(name, reverted.data?.args ?? []);

      // A `require` string rather than a custom error.
      if (reverted.reason && reverted.reason !== "execution reverted") {
        return {message: reverted.reason, detail: reverted.reason};
      }

      const decoded = decodeUnknownRevert(reverted.raw);
      if (decoded) return decoded;
    }

    const decoded = decodeUnknownRevert(rawDataOf(err));
    if (decoded) return decoded;

    const prose = `${err.shortMessage ?? ""} ${err.message}`;
    const match = NODE_FAILURES.find((f) => f.test.test(prose));
    if (match) return {message: match.message};

    return {message: err.shortMessage || err.message};
  }

  const message = err instanceof Error ? err.message : String(err);
  const match = NODE_FAILURES.find((f) => f.test.test(message));
  return {message: match ? match.message : message};
}

/** Revert bytes hanging off an arbitrary viem error, wherever the version of the day puts them. */
function rawDataOf(err: BaseError): Hex | undefined {
  // `walk(fn)` returns `Error | null`, so this is a nullable cast, not an optional one.
  const walked = err.walk((e) => typeof (e as {data?: unknown}).data === "string") as
    | {data?: unknown}
    | null;
  const data = walked?.data;
  return typeof data === "string" && data.startsWith("0x") ? (data as Hex) : undefined;
}

/**
 * Decodes revert bytes against the union of protocol errors.
 *
 * Returns undefined rather than throwing on an unrecognised selector: an error from a token or a
 * verifier this app doesn't ship an ABI for should fall through to the prose matching, not crash
 * the handler that was trying to explain a failure.
 */
function decodeUnknownRevert(data: Hex | undefined): TxErrorCopy | undefined {
  if (!data || data === "0x" || data.length < 10) return undefined;
  try {
    const {errorName, args} = decodeErrorResult({abi: ERROR_ABI, data});
    return humanizeContractError(errorName, (args ?? []) as readonly unknown[]);
  } catch {
    return undefined;
  }
}
