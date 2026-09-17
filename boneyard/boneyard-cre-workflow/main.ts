import {
  CronCapability,
  LAST_FINALIZED_BLOCK_NUMBER,
  Runner,
  TxStatus,
  bytesToHex,
  cre,
  encodeCallMsg,
  getNetwork,
  handler,
  prepareReportRequest,
  type Runtime,
} from "@chainlink/cre-sdk";
import {
  decodeAbiParameters,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  isAddress,
  parseAbi,
  type Abi,
  type Address,
  type Hex,
} from "viem";

export type Config = {
  schedule: string;
  mode: "simulation" | "production";
  isTestnet: boolean;
  evm: {
    chainSelectorName: string;
    receiverAddress: Address;
    campaignAddress: Address;
    verifierAddress: Address;
    kpiIndex: string;
    scanLimit: string;
    gasLimit: string;
    reportLifetimeSeconds: string;
  };
};

export type WorkflowOutcome = {
  status:
    | "submitted"
    | "idle"
    | "config-error"
    | "incompatible-target"
    | "read-failed"
    | "report-failed"
    | "write-failed";
  reason: string;
  user?: Address;
  nextCursor?: string;
  txStatus?: number;
};

const BASE_SEPOLIA = "ethereum-testnet-sepolia-base-1";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_BYTES32 = `0x${"00".repeat(32)}` as Hex;
const REPORT_VERSION = 1;
const MAX_SCAN_LIMIT = 256n;
const UINT64_MAX = (1n << 64n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;
export const RECEIVER_ABI = parseAbi([
  "function campaign() view returns (address)",
  "function kpiIndex() view returns (uint256)",
  "function eventMetricVerifier() view returns (address)",
  "function production() view returns (bool)",
  "function cursor() view returns (uint256)",
  "function nonce() view returns (uint64)",
  "function REPORT_VERSION() view returns (uint8)",
]);

export const CAMPAIGN_ABI = parseAbi([
  "function status() view returns (uint8)",
  "function startTime() view returns (uint64)",
  "function endTime() view returns (uint64)",
  "function endedAt() view returns (uint64)",
  "function CLAIM_GRACE() view returns (uint64)",
  "function kpiCount() view returns (uint256)",
  "function kpi(uint256) view returns ((uint8,address,uint256,bool,bytes))",
  "function attributionRegistry() view returns (address)",
  "function authorizedReporters(address) view returns (bool)",
  "function userCreditedOf(address,uint256) view returns (uint256)",
  "function lastReportBlockOf(address,uint256) view returns (uint64)",
]);

export const GUARD_ABI = parseAbi([
  "function boneyVerifier() view returns (address)",
  "function guardOf(address,uint256) view returns ((address,uint16,uint8,bool))",
]);

export const EVENT_VERIFIER_ABI = parseAbi([
  "function configOf(address,uint256) view returns ((address,string,uint8,uint8,uint8,uint256,uint256,uint256,bool,uint256))",
  "function observedUserCount(address,uint256) view returns (uint256)",
  "function observedUserAt(address,uint256,uint256) view returns (address)",
  "function observedProgressOf(address,uint256,address) view returns (uint256)",
]);

export const ATTRIBUTION_ABI = parseAbi([
  "function activePromoter(address,address) view returns (bytes32)",
  "function soleAttributionSince(address,address,uint64) view returns (bytes32)",
]);

export const MULTICALL3_ABI = parseAbi([
  "function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)",
]);

export const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11" as Address;

export const CRE_REPORT_PARAMETERS = [
  {type: "uint8"},
  {type: "uint64"},
  {type: "uint64"},
  {type: "uint256"},
  {type: "address"},
  {type: "uint256"},
  {type: "bool"},
] as const;

type ValidatedConfig = {
  schedule: string;
  mode: Config["mode"];
  isTestnet: boolean;
  chainSelector: bigint;
  receiverAddress: Address;
  campaignAddress: Address;
  verifierAddress: Address;
  kpiIndex: bigint;
  scanLimit: bigint;
  gasLimit: bigint;
  reportLifetimeSeconds: bigint;
};

type ReadContext = {
  runtime: Runtime<Config>;
  config: ValidatedConfig;
};

const failConfig = (reason: string): never => {
  throw new Error(reason);
};

const parseUnsigned = (
  value: unknown,
  name: string,
  maximum: bigint,
  allowZero = false,
): bigint => {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    return failConfig(`${name} must be a canonical unsigned integer string`);
  }
  const parsed = BigInt(value);
  if ((!allowZero && parsed === 0n) || parsed > maximum) {
    return failConfig(`${name} is outside its supported range`);
  }
  return parsed;
};

const parseAddress = (value: unknown, name: string): Address => {
  if (typeof value !== "string" || !isAddress(value, {strict: true})) {
    return failConfig(`${name} must be a checksummed or lowercase EVM address`);
  }
  if (value.toLowerCase() === ZERO_ADDRESS) {
    return failConfig(`${name} must not be zero`);
  }
  return value as Address;
};

/** Validate workflow configuration before any capability call. */
export const parseConfig = (config: Config): ValidatedConfig => {
  if (!config || typeof config !== "object") return failConfig("config is required");
  if (typeof config.schedule !== "string" || config.schedule.trim() === "") {
    return failConfig("schedule must not be empty");
  }
  const fields = config.schedule.trim().split(/\s+/);
  if (fields.length !== 6) return failConfig("schedule must use six-field CRE cron syntax");
  if (config.mode !== "simulation" && config.mode !== "production") {
    return failConfig("mode must be simulation or production");
  }
  if (typeof config.isTestnet !== "boolean") return failConfig("isTestnet must be a boolean");
  if (!config.evm || typeof config.evm !== "object") return failConfig("evm config is required");
  if (config.evm.chainSelectorName !== BASE_SEPOLIA || !config.isTestnet) {
    return failConfig("this workflow is restricted to Base Sepolia testnet");
  }

  const network = getNetwork({
    chainFamily: "evm",
    chainSelectorName: config.evm.chainSelectorName,
    isTestnet: config.isTestnet,
  });
  if (!network) return failConfig(`unknown EVM network: ${config.evm.chainSelectorName}`);

  return {
    schedule: config.schedule,
    mode: config.mode,
    isTestnet: config.isTestnet,
    chainSelector: network.chainSelector.selector,
    receiverAddress: parseAddress(config.evm.receiverAddress, "receiverAddress"),
    campaignAddress: parseAddress(config.evm.campaignAddress, "campaignAddress"),
    verifierAddress: parseAddress(config.evm.verifierAddress, "verifierAddress"),
    kpiIndex: parseUnsigned(config.evm.kpiIndex, "kpiIndex", UINT256_MAX, true),
    scanLimit: parseUnsigned(config.evm.scanLimit, "scanLimit", MAX_SCAN_LIMIT),
    gasLimit: parseUnsigned(config.evm.gasLimit, "gasLimit", UINT64_MAX),
    reportLifetimeSeconds: parseUnsigned(
      config.evm.reportLifetimeSeconds,
      "reportLifetimeSeconds",
      UINT64_MAX,
    ),
  };
};

const normalizeAddress = (address: Address): string => address.toLowerCase();
const addressesEqual = (a: Address, b: Address): boolean =>
  normalizeAddress(a) === normalizeAddress(b);

type ContractRead = {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
};

const readContracts = (context: ReadContext, reads: readonly ContractRead[]): readonly unknown[] => {
  const calls = reads.map(({address, abi, functionName, args = []}) => ({
    target: address,
    allowFailure: false,
    callData: encodeFunctionData({abi, functionName, args}),
  }));
  const data = encodeFunctionData({abi: MULTICALL3_ABI, functionName: "aggregate3", args: [calls]});
  const response = new cre.capabilities.EVMClient(context.config.chainSelector)
    .callContract(context.runtime, {
      call: encodeCallMsg({from: ZERO_ADDRESS, to: MULTICALL3_ADDRESS, data}),
      blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
    })
    .result();

  const payload = response.data ? bytesToHex(response.data) : "0x";
  if (payload === "0x") {
    throw new Error(`read-empty-response:aggregate3@${MULTICALL3_ADDRESS}`);
  }

  const results = decodeFunctionResult({
    abi: MULTICALL3_ABI,
    functionName: "aggregate3",
    data: payload,
  });
  return results.map((result, index) => {
    const {address, abi, functionName} = reads[index];
    requireCondition(result.success, `multicall-read-failed-${index}`);
    // A codeless target returns success with no data rather than reverting.
    if (result.returnData === "0x") {
      throw new Error(`read-empty-response:${functionName}@${address}`);
    }
    return decodeFunctionResult({abi, functionName, data: result.returnData});
  });
};

type Preflight = {
  blockTimestamp: bigint;
  receiverCursor: bigint;
  receiverNonce: bigint;
  registryAddress: Address;
  observedUserCount: bigint;
};

const requireCondition = (condition: boolean, reason: string): void => {
  if (!condition) throw new Error(reason);
};

/** Verify every on-chain binding required by the evidence-free CRE path. */
export const preflight = (context: ReadContext): Preflight => {
  const {runtime, config} = context;
  const header = new cre.capabilities.EVMClient(config.chainSelector)
    .headerByNumber(runtime, {blockNumber: LAST_FINALIZED_BLOCK_NUMBER})
    .result().header;
  requireCondition(!!header, "finalized-header-unavailable");
  const blockTimestamp = header!.timestamp;
  const reportTimestamp = BigInt(Math.floor(Date.now() / 1_000));
  requireCondition(reportTimestamp >= blockTimestamp, "local-clock-before-finalized-block");

  const receiverReads = readContracts(context, [
    {address: config.receiverAddress, abi: RECEIVER_ABI, functionName: "campaign"},
    {address: config.receiverAddress, abi: RECEIVER_ABI, functionName: "kpiIndex"},
    {address: config.receiverAddress, abi: RECEIVER_ABI, functionName: "eventMetricVerifier"},
    {address: config.receiverAddress, abi: RECEIVER_ABI, functionName: "production"},
    {address: config.receiverAddress, abi: RECEIVER_ABI, functionName: "REPORT_VERSION"},
  ]);
  const receiverCampaign = receiverReads[0] as Address;
  const receiverKpi = receiverReads[1] as bigint;
  const receiverVerifier = receiverReads[2] as Address;
  const receiverProduction = receiverReads[3] as boolean;
  const reportVersion = receiverReads[4] as number;
  requireCondition(addressesEqual(receiverCampaign, config.campaignAddress), "receiver-campaign-mismatch");
  requireCondition(receiverKpi === config.kpiIndex, "receiver-kpi-mismatch");
  requireCondition(addressesEqual(receiverVerifier, config.verifierAddress), "receiver-verifier-mismatch");
  requireCondition(receiverProduction === (config.mode === "production"), "receiver-mode-mismatch");
  requireCondition(reportVersion === REPORT_VERSION, "receiver-report-version-mismatch");

  const campaignReads = readContracts(context, [
    {
      address: config.campaignAddress,
      abi: CAMPAIGN_ABI,
      functionName: "authorizedReporters",
      args: [config.receiverAddress],
    },
    {address: config.campaignAddress, abi: CAMPAIGN_ABI, functionName: "kpiCount"},
    {
      address: config.campaignAddress,
      abi: CAMPAIGN_ABI,
      functionName: "kpi",
      args: [config.kpiIndex],
    },
  ]);
  const authorized = campaignReads[0] as boolean;
  requireCondition(authorized, "receiver-not-authorized");
  const count = campaignReads[1] as bigint;
  requireCondition(config.kpiIndex < count, "unknown-kpi");
  const kpi = campaignReads[2] as readonly [number, Address, bigint, boolean, Hex];
  requireCondition(!kpi[3], "aggregate-kpi");
  requireCondition(normalizeAddress(kpi[1]) !== ZERO_ADDRESS, "ungated-kpi");

  const verifierReads = readContracts(context, [
    {address: kpi[1], abi: GUARD_ABI, functionName: "boneyVerifier"},
    {
      address: kpi[1],
      abi: GUARD_ABI,
      functionName: "guardOf",
      args: [config.campaignAddress, config.kpiIndex],
    },
    {
      address: config.verifierAddress,
      abi: EVENT_VERIFIER_ABI,
      functionName: "configOf",
      args: [config.campaignAddress, config.kpiIndex],
    },
  ]);
  const canonicalVerifier = verifierReads[0] as Address;
  requireCondition(addressesEqual(canonicalVerifier, config.verifierAddress), "guard-verifier-mismatch");
  const guard = verifierReads[1] as readonly [Address, number, number, boolean];
  requireCondition(guard[3], "guard-not-configured");
  requireCondition(normalizeAddress(guard[0]) === ZERO_ADDRESS, "guard-requires-evidence");
  const verifierConfig = verifierReads[2] as readonly [
    Address,
    string,
    number,
    number,
    number,
    bigint,
    bigint,
    bigint,
    boolean,
    bigint,
  ];
  requireCondition(verifierConfig[8], "event-verifier-not-configured");

  const campaignState = readContracts(context, [
    {address: config.campaignAddress, abi: CAMPAIGN_ABI, functionName: "status"},
    {address: config.campaignAddress, abi: CAMPAIGN_ABI, functionName: "startTime"},
    {address: config.campaignAddress, abi: CAMPAIGN_ABI, functionName: "endTime"},
    {address: config.campaignAddress, abi: CAMPAIGN_ABI, functionName: "endedAt"},
    {address: config.campaignAddress, abi: CAMPAIGN_ABI, functionName: "CLAIM_GRACE"},
    {address: config.campaignAddress, abi: CAMPAIGN_ABI, functionName: "attributionRegistry"},
    {address: config.receiverAddress, abi: RECEIVER_ABI, functionName: "cursor"},
    {address: config.receiverAddress, abi: RECEIVER_ABI, functionName: "nonce"},
    {
      address: config.verifierAddress,
      abi: EVENT_VERIFIER_ABI,
      functionName: "observedUserCount",
      args: [config.campaignAddress, config.kpiIndex],
    },
  ]);
  const status = campaignState[0] as number;
  if (status === 1) {
    const start = campaignState[1] as bigint;
    const end = campaignState[2] as bigint;
    requireCondition(blockTimestamp >= start && blockTimestamp <= end, "campaign-outside-window");
  } else if (status === 3) {
    const endedAt = campaignState[3] as bigint;
    const grace = campaignState[4] as bigint;
    requireCondition(blockTimestamp <= endedAt + grace, "campaign-claim-grace-closed");
  } else {
    throw new Error("campaign-not-reportable");
  }

  const registryAddress = campaignState[5] as Address;
  requireCondition(normalizeAddress(registryAddress) !== ZERO_ADDRESS, "missing-attribution-registry");
  const receiverCursor = campaignState[6] as bigint;
  const receiverNonce = campaignState[7] as bigint;
  const observedUserCount = campaignState[8] as bigint;

  return {blockTimestamp: reportTimestamp, receiverCursor, receiverNonce, registryAddress, observedUserCount};
};

type Candidate = {
  user: Address;
  observed: bigint;
  nextCursor: bigint;
};

type Selection = {
  candidate?: Candidate;
  nextCursor: bigint;
  scanned: bigint;
};

/** Select the first eligible user in one bounded circular scan. */
export const selectCandidate = (context: ReadContext, state: Preflight): Selection => {
  const {config} = context;
  const count = state.observedUserCount;
  if (count === 0n) return {nextCursor: 0n, scanned: 0n};

  const limit = count < config.scanLimit ? count : config.scanLimit;
  const start = state.receiverCursor % count;
  for (let offset = 0n; offset < limit; offset++) {
    const index = (start + offset) % count;
    const nextCursor = (index + 1n) % count;
    const candidateReads = readContracts(context, [
      {
        address: config.verifierAddress,
        abi: EVENT_VERIFIER_ABI,
        functionName: "observedUserAt",
        args: [config.campaignAddress, config.kpiIndex, index],
      },
    ]);
    const user = candidateReads[0] as Address;
    const progressReads = readContracts(context, [
      {
        address: config.verifierAddress,
        abi: EVENT_VERIFIER_ABI,
        functionName: "observedProgressOf",
        args: [config.campaignAddress, config.kpiIndex, user],
      },
      {
        address: config.campaignAddress,
        abi: CAMPAIGN_ABI,
        functionName: "userCreditedOf",
        args: [user, config.kpiIndex],
      },
    ]);
    const observed = progressReads[0] as bigint;
    const credited = progressReads[1] as bigint;
    if (observed <= credited) continue;

    const sinceBlockReads = readContracts(context, [
      {
        address: config.campaignAddress,
        abi: CAMPAIGN_ABI,
        functionName: "lastReportBlockOf",
        args: [user, config.kpiIndex],
      },
    ]);
    const sinceBlock = sinceBlockReads[0] as bigint;
    const attributionReads = readContracts(context, [
      {
        address: state.registryAddress,
        abi: ATTRIBUTION_ABI,
        functionName: "activePromoter",
        args: [config.campaignAddress, user],
      },
      {
        address: state.registryAddress,
        abi: ATTRIBUTION_ABI,
        functionName: "soleAttributionSince",
        args: [config.campaignAddress, user, sinceBlock],
      },
    ]);
    const active = attributionReads[0] as Hex;
    const sole = attributionReads[1] as Hex;
    if (active === ZERO_BYTES32 || active.toLowerCase() !== sole.toLowerCase()) continue;

    return {candidate: {user, observed, nextCursor}, nextCursor, scanned: offset + 1n};
  }

  return {nextCursor: (start + limit) % count, scanned: limit};
};

/** ABI-encode the receiver's versioned report envelope. */
export const encodeCreReport = (
  nonce: bigint,
  validUntil: bigint,
  nextCursor: bigint,
  user: Address,
  newTotal: bigint,
  applyProgress: boolean,
): Hex =>
  encodeAbiParameters(
    CRE_REPORT_PARAMETERS,
    [REPORT_VERSION, nonce, validUntil, nextCursor, user, newTotal, applyProgress],
  );

const logOutcome = (runtime: Runtime<Config>, outcome: WorkflowOutcome): WorkflowOutcome => {
  runtime.log(JSON.stringify(outcome));
  return outcome;
};

const outcomeFromError = (
  runtime: Runtime<Config>,
  status: WorkflowOutcome["status"],
  error: unknown,
): WorkflowOutcome =>
  logOutcome(runtime, {status, reason: error instanceof Error ? error.message : String(error)});

const INCOMPATIBLE_REASONS = new Set([
  "receiver-campaign-mismatch",
  "receiver-kpi-mismatch",
  "receiver-verifier-mismatch",
  "receiver-mode-mismatch",
  "receiver-report-version-mismatch",
  "receiver-not-authorized",
  "unknown-kpi",
  "aggregate-kpi",
  "ungated-kpi",
  "guard-verifier-mismatch",
  "guard-not-configured",
  "guard-requires-evidence",
  "event-verifier-not-configured",
  "campaign-outside-window",
  "campaign-claim-grace-closed",
  "campaign-not-reportable",
  "missing-attribution-registry",
]);

const INCOMPATIBLE_SELECTOR_FAILURES = [
  "no handler set for",
  "failed to decode function data",
  "call data too short",
  "function selector",
  "returned no data",
] as const;

const isIncompatible = (error: unknown): boolean =>
  error instanceof Error &&
  (INCOMPATIBLE_REASONS.has(error.message) ||
    INCOMPATIBLE_SELECTOR_FAILURES.some((fragment) => error.message.includes(fragment)));

/** Execute one: preflight, scan, report-generation, and write cycle. */
export const onCronTrigger = (runtime: Runtime<Config>): WorkflowOutcome => {
  let config: ValidatedConfig;
  try {
    config = parseConfig(runtime.config);
  } catch (error) {
    return outcomeFromError(runtime, "config-error", error);
  }

  const context = {runtime, config};
  let state: Preflight;
  let selection: Selection;
  try {
    state = preflight(context);
    selection = selectCandidate(context, state);
  } catch (error) {
    return outcomeFromError(runtime, isIncompatible(error) ? "incompatible-target" : "read-failed", error);
  }

  if (state.observedUserCount === 0n) {
    return logOutcome(runtime, {status: "idle", reason: "no-observed-users", nextCursor: "0"});
  }

  const candidate = selection.candidate;
  if (state.blockTimestamp > UINT64_MAX - config.reportLifetimeSeconds) {
    return logOutcome(runtime, {status: "report-failed", reason: "report-expiry-overflow"});
  }
  const validUntil = state.blockTimestamp + config.reportLifetimeSeconds;
  const payload = encodeCreReport(
    state.receiverNonce,
    validUntil,
    selection.nextCursor,
    candidate?.user ?? ZERO_ADDRESS,
    candidate?.observed ?? 0n,
    !!candidate,
  );

  let report;
  try {
    report = runtime.report(prepareReportRequest(payload)).result();
  } catch (error) {
    return outcomeFromError(runtime, "report-failed", error);
  }

  try {
    const result = new cre.capabilities.EVMClient(config.chainSelector)
      .writeReport(runtime, {
        receiver: config.receiverAddress,
        report,
        gasConfig: {gasLimit: config.gasLimit},
      })
      .result();
    if (result.txStatus !== TxStatus.SUCCESS) {
      return logOutcome(runtime, {
        status: "write-failed",
        reason: result.errorMessage || "non-success-transaction-status",
        user: candidate?.user,
        nextCursor: selection.nextCursor.toString(),
        txStatus: result.txStatus,
      });
    }
    return logOutcome(runtime, {
      status: "submitted",
      reason: candidate ? "progress" : "cursor-only",
      user: candidate?.user,
      nextCursor: selection.nextCursor.toString(),
      txStatus: result.txStatus,
    });
  } catch (error) {
    return outcomeFromError(runtime, "write-failed", error);
  }
};

export const initWorkflow = (config: Config) => {
  const validated = parseConfig(config);
  const cron = new CronCapability();
  return [handler(cron.trigger({schedule: validated.schedule}), onCronTrigger)];
};

export async function main() {
  const runner = await Runner.newRunner<Config>();
  await runner.run(initWorkflow);
}
