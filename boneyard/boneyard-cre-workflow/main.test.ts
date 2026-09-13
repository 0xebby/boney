import {describe, expect} from "bun:test";
import {
  Report,
  REPORT_METADATA_HEADER_LENGTH,
  bytesToHex,
} from "@chainlink/cre-sdk";
import {
  EvmMock,
  addContractMock,
  newTestRuntime,
  test,
  type ContractMock,
} from "@chainlink/cre-sdk/test";
import {decodeAbiParameters, type Address, type Hex} from "viem";
import {
  ATTRIBUTION_ABI,
  CAMPAIGN_ABI,
  CRE_REPORT_PARAMETERS,
  EVENT_VERIFIER_ABI,
  GUARD_ABI,
  RECEIVER_ABI,
  initWorkflow,
  onCronTrigger,
  parseConfig,
  type Config,
} from "./main";

const CHAIN_SELECTOR = 10344971235874465080n;
const RECEIVER = "0x1111111111111111111111111111111111111111";
const CAMPAIGN = "0x2222222222222222222222222222222222222222";
const VERIFIER = "0x3333333333333333333333333333333333333333";
const GUARD = "0x4444444444444444444444444444444444444444";
const REGISTRY = "0x5555555555555555555555555555555555555555";
const USER_A = "0x6666666666666666666666666666666666666666";
const USER_B = "0x7777777777777777777777777777777777777777";
const USER_C = "0x8888888888888888888888888888888888888888";
const PROMOTER = `0x${"ab".repeat(32)}` as Hex;
const ZERO_BYTES32 = `0x${"00".repeat(32)}` as Hex;
const NOW = 1_800_000_000n;

const config = (overrides: Partial<Config["evm"]> = {}): Config => ({
  schedule: "0 * * * * *",
  mode: "simulation",
  isTestnet: true,
  evm: {
    chainSelectorName: "ethereum-testnet-sepolia-base-1",
    receiverAddress: RECEIVER,
    campaignAddress: CAMPAIGN,
    verifierAddress: VERIFIER,
    kpiIndex: "0",
    scanLimit: "32",
    gasLimit: "3000000",
    reportLifetimeSeconds: "300",
    ...overrides,
  },
});

type SetupOptions = {
  receiverCampaign?: Address;
  receiverKpi?: bigint;
  receiverVerifier?: Address;
  receiverProduction?: boolean;
  reportVersion?: number;
  missingReportVersion?: boolean;
  authorized?: boolean;
  kpiCount?: bigint;
  aggregate?: boolean;
  kpiVerifier?: Address;
  canonicalVerifier?: Address;
  guardConfigured?: boolean;
  projectVerifier?: Address;
  eventConfigured?: boolean;
  registryAddress?: Address;
  status?: number;
  startTime?: bigint;
  endTime?: bigint;
  endedAt?: bigint;
  claimGrace?: bigint;
  cursor?: bigint;
  nonce?: bigint;
  users?: Address[];
  observed?: Record<Address, bigint>;
  credited?: Record<Address, bigint>;
  active?: Record<Address, Hex>;
  sole?: Record<Address, Hex>;
  headerMissing?: boolean;
  blockTimestamp?: bigint;
  reportThrows?: boolean;
  readThrows?: boolean;
  writeStatus?: "TX_STATUS_SUCCESS" | "TX_STATUS_REVERTED" | "TX_STATUS_FATAL";
  writeThrows?: boolean;
};

type Fixture = {
  runtime: ReturnType<typeof newTestRuntime<Config>>;
  receiver: ContractMock<typeof RECEIVER_ABI>;
  writes: {payload: Hex; gasLimit: bigint; receiver: Address}[];
  visited: bigint[];
};

const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

const setup = (options: SetupOptions = {}, runtimeConfig = config()): Fixture => {
  const evm = EvmMock.testInstance(CHAIN_SELECTOR);
  evm.headerByNumber = () => ({
    header: options.headerMissing
      ? undefined
      : {
          timestamp: (options.blockTimestamp ?? NOW).toString(),
          blockNumber: {absVal: base64(new Uint8Array([123])), sign: "1"},
          hash: base64(new Uint8Array(32)),
          parentHash: base64(new Uint8Array(32)),
        },
  });

  const receiver = addContractMock(evm, {address: RECEIVER, abi: RECEIVER_ABI});
  receiver.campaign = () => {
    if (options.readThrows) throw new Error("read exploded");
    return options.receiverCampaign ?? CAMPAIGN;
  };
  receiver.kpiIndex = () => options.receiverKpi ?? 0n;
  receiver.eventMetricVerifier = () => options.receiverVerifier ?? VERIFIER;
  receiver.production = () => options.receiverProduction ?? false;
  receiver.REPORT_VERSION = options.missingReportVersion
    ? undefined
    : () => options.reportVersion ?? 1;
  receiver.cursor = () => options.cursor ?? 0n;
  receiver.nonce = () => options.nonce ?? 0n;

  const campaign = addContractMock(evm, {address: CAMPAIGN, abi: CAMPAIGN_ABI});
  campaign.authorizedReporters = () => options.authorized ?? true;
  campaign.kpiCount = () => options.kpiCount ?? 1n;
  campaign.kpi = () => [
    4,
    options.kpiVerifier ?? GUARD,
    100n,
    options.aggregate ?? false,
    "0x",
  ];
  campaign.status = () => options.status ?? 1;
  campaign.startTime = () => options.startTime ?? NOW - 100n;
  campaign.endTime = () => options.endTime ?? NOW + 100n;
  campaign.endedAt = () => options.endedAt ?? NOW - 100n;
  campaign.CLAIM_GRACE = () => options.claimGrace ?? 1_200n;
  campaign.attributionRegistry = () => options.registryAddress ?? REGISTRY;
  campaign.userCreditedOf = (user) => options.credited?.[user as Address] ?? 0n;
  campaign.lastReportBlockOf = () => 10n;

  const guard = addContractMock(evm, {address: GUARD, abi: GUARD_ABI});
  guard.boneyVerifier = () => options.canonicalVerifier ?? VERIFIER;
  guard.guardOf = () => [
    options.projectVerifier ?? "0x0000000000000000000000000000000000000000",
    0,
    0,
    options.guardConfigured ?? true,
  ];

  const users = options.users ?? [USER_A];
  const visited: bigint[] = [];
  const verifier = addContractMock(evm, {address: VERIFIER, abi: EVENT_VERIFIER_ABI});
  verifier.configOf = () => [
    "0x9999999999999999999999999999999999999999",
    "Deposit(address indexed user,uint256 amount)",
    0,
    1,
    1,
    1n,
    1n,
    999n,
    options.eventConfigured ?? true,
    0n,
  ];
  verifier.observedUserCount = () => BigInt(users.length);
  verifier.observedUserAt = (_campaign, _kpi, index) => {
    visited.push(index as bigint);
    return users[Number(index)];
  };
  verifier.observedProgressOf = (_campaign, _kpi, user) => options.observed?.[user as Address] ?? 10n;

  const attribution = addContractMock(evm, {address: REGISTRY, abi: ATTRIBUTION_ABI});
  attribution.activePromoter = (_campaign, user) => options.active?.[user as Address] ?? PROMOTER;
  attribution.soleAttributionSince = (_campaign, user) => options.sole?.[user as Address] ?? PROMOTER;

  const writes: Fixture["writes"] = [];
  receiver.writeReport = ({receiver: receiverBytes, report, gasConfig}) => {
    if (options.writeThrows) throw new Error("write exploded");
    const body = bytesToHex(new Report(report).body());
    writes.push({
      payload: body,
      gasLimit: gasConfig.gasLimit,
      receiver: bytesToHex(receiverBytes) as Address,
    });
    return {txStatus: options.writeStatus ?? "TX_STATUS_SUCCESS"};
  };

  const runtime = newTestRuntime<Config>(null, {}, runtimeConfig);
  if (options.reportThrows) {
    runtime.report = () => ({
      result: () => {
        throw new Error("report exploded");
      },
    });
  }
  return {runtime, receiver, writes, visited};
};

const decodedPayload = (fixture: Fixture) =>
  decodeAbiParameters(CRE_REPORT_PARAMETERS, fixture.writes[0].payload);

const run = (fixture: Fixture) => onCronTrigger(fixture.runtime);
const zeroAddress = "0x0000000000000000000000000000000000000000" as Address;
const otherAddress = "0x9999999999999999999999999999999999999999" as Address;

describe("configuration", () => {
  test("parses Base Sepolia numeric strings", () => {
    const parsed = parseConfig(config());
    expect(parsed.kpiIndex).toBe(0n);
    expect(parsed.scanLimit).toBe(32n);
    expect(parsed.chainSelector).toBe(CHAIN_SELECTOR);
  });

  const invalid: [string, (value: Config) => void][] = [
    ["empty schedule", (value) => (value.schedule = "")],
    ["five-field schedule", (value) => (value.schedule = "0 * * * *")],
    ["mode", (value) => ((value as {mode: string}).mode = "bad")],
    ["testnet flag", (value) => (value.isTestnet = false)],
    ["chain", (value) => (value.evm.chainSelectorName = "ethereum-testnet-sepolia")],
    ["zero receiver", (value) => (value.evm.receiverAddress = "0x0000000000000000000000000000000000000000")],
    ["campaign address", (value) => (value.evm.campaignAddress = "bad" as Address)],
    ["verifier address", (value) => (value.evm.verifierAddress = "0x1234" as Address)],
    ["KPI number", (value) => (value.evm.kpiIndex = "01")],
    ["scan zero", (value) => (value.evm.scanLimit = "0")],
    ["scan bound", (value) => (value.evm.scanLimit = "257")],
    ["gas", (value) => (value.evm.gasLimit = "-1")],
    ["lifetime", (value) => (value.evm.reportLifetimeSeconds = "0")],
  ];

  for (const [name, mutate] of invalid) {
    test(`rejects ${name}`, () => {
      const value = config();
      mutate(value);
      expect(() => parseConfig(value)).toThrow();
    });
  }

  test("builds one cron handler", () => {
    const handlers = initWorkflow(config());
    expect(handlers).toHaveLength(1);
    expect((handlers[0].trigger as {config: {schedule: string}}).config.schedule).toBe("0 * * * * *");
  });
});

describe("preflight", () => {
  const incompatible: [string, SetupOptions, string][] = [
    ["receiver campaign", {receiverCampaign: otherAddress}, "receiver-campaign-mismatch"],
    ["receiver KPI", {receiverKpi: 1n}, "receiver-kpi-mismatch"],
    ["receiver verifier", {receiverVerifier: otherAddress}, "receiver-verifier-mismatch"],
    ["receiver mode", {receiverProduction: true}, "receiver-mode-mismatch"],
    ["report version", {reportVersion: 2}, "receiver-report-version-mismatch"],
    ["authorization", {authorized: false}, "receiver-not-authorized"],
    ["KPI count", {kpiCount: 0n}, "unknown-kpi"],
    ["aggregate KPI", {aggregate: true}, "aggregate-kpi"],
    ["ungated KPI", {kpiVerifier: zeroAddress}, "ungated-kpi"],
    ["canonical verifier", {canonicalVerifier: otherAddress}, "guard-verifier-mismatch"],
    ["guard configuration", {guardConfigured: false}, "guard-not-configured"],
    ["project verifier", {projectVerifier: otherAddress}, "guard-requires-evidence"],
    ["event verifier", {eventConfigured: false}, "event-verifier-not-configured"],
    ["pending campaign", {status: 0}, "campaign-not-reportable"],
    ["paused campaign", {status: 2}, "campaign-not-reportable"],
    ["cancelled campaign", {status: 4}, "campaign-not-reportable"],
    ["active before start", {startTime: NOW + 1n}, "campaign-outside-window"],
    ["active after end", {endTime: NOW - 1n}, "campaign-outside-window"],
    ["ended after grace", {status: 3, endedAt: NOW - 1_201n}, "campaign-claim-grace-closed"],
    ["attribution registry", {registryAddress: zeroAddress}, "missing-attribution-registry"],
  ];

  for (const [name, options, reason] of incompatible) {
    test(`rejects incompatible ${name}`, () => {
      const fixture = setup(options);
      expect(run(fixture)).toMatchObject({status: "incompatible-target", reason});
      expect(fixture.writes).toHaveLength(0);
    });
  }

  test("accepts inclusive active and ended boundaries", () => {
    const active = setup({startTime: NOW, endTime: NOW});
    expect(run(active).status).toBe("submitted");

    const ended = setup({status: 3, endedAt: NOW - 1_200n});
    expect(run(ended).status).toBe("submitted");
  });

  test("classifies missing current-bytecode selectors as incompatible", () => {
    const fixture = setup({missingReportVersion: true});
    expect(run(fixture)).toMatchObject({status: "incompatible-target"});
    expect(fixture.writes).toHaveLength(0);
  });

  test("classifies missing finalized headers as read failures", () => {
    const fixture = setup({headerMissing: true});
    expect(run(fixture)).toMatchObject({status: "read-failed"});
    expect(fixture.writes).toHaveLength(0);
  });

  test("classifies contract read exceptions", () => {
    const fixture = setup({readThrows: true});
    expect(run(fixture)).toMatchObject({status: "read-failed", reason: "read exploded"});
    expect(fixture.writes).toHaveLength(0);
  });
});

describe("selection and reports", () => {
  test("stays idle when the verifier has no observed users", () => {
    const fixture = setup({users: []});
    expect(run(fixture)).toEqual({status: "idle", reason: "no-observed-users", nextCursor: "0"});
    expect(fixture.writes).toHaveLength(0);
  });

  test("selects the first eligible user and encodes the receiver envelope", () => {
    const fixture = setup({
      cursor: 1n,
      nonce: 7n,
      users: [USER_A, USER_B, USER_C],
      observed: {[USER_B]: 8n, [USER_C]: 25n},
      credited: {[USER_B]: 8n, [USER_C]: 4n},
    });

    expect(run(fixture)).toMatchObject({
      status: "submitted",
      reason: "progress",
      user: USER_C,
      nextCursor: "0",
    });
    expect(fixture.visited).toEqual([1n, 2n]);
    expect(decodedPayload(fixture)).toEqual([1, 7n, NOW + 300n, 0n, USER_C, 25n, true]);
    expect(fixture.writes[0]).toMatchObject({receiver: RECEIVER, gasLimit: 3_000_000n});
    expect(fixture.writes).toHaveLength(1);
  });

  test("wraps the circular scan", () => {
    const fixture = setup({
      cursor: 2n,
      users: [USER_A, USER_B, USER_C],
      observed: {[USER_C]: 10n, [USER_A]: 20n},
      credited: {[USER_C]: 10n},
    });
    expect(run(fixture)).toMatchObject({status: "submitted", user: USER_A, nextCursor: "1"});
    expect(fixture.visited).toEqual([2n, 0n]);
  });

  test("bounds scanning and advances with a cursor-only report", () => {
    const fixture = setup(
      {
        cursor: 1n,
        users: [USER_A, USER_B, USER_C],
        observed: {[USER_B]: 10n, [USER_C]: 10n},
        credited: {[USER_B]: 10n, [USER_C]: 10n},
      },
      config({scanLimit: "2"}),
    );

    expect(run(fixture)).toMatchObject({status: "submitted", reason: "cursor-only", nextCursor: "0"});
    expect(fixture.visited).toEqual([1n, 2n]);
    expect(decodedPayload(fixture)).toEqual([1, 0n, NOW + 300n, 0n, zeroAddress, 0n, false]);
    expect(fixture.writes).toHaveLength(1);
  });

  const ambiguous: [string, SetupOptions][] = [
    ["zero active attribution", {active: {[USER_A]: ZERO_BYTES32}}],
    ["zero sole attribution", {sole: {[USER_A]: ZERO_BYTES32}}],
    ["changed attribution", {sole: {[USER_A]: `0x${"cd".repeat(32)}` as Hex}}],
  ];

  for (const [name, options] of ambiguous) {
    test(`skips ${name}`, () => {
      const fixture = setup(options);
      expect(run(fixture)).toMatchObject({status: "submitted", reason: "cursor-only"});
      expect(decodedPayload(fixture)[6]).toBe(false);
    });
  }
});

describe("failure handling", () => {
  test("rejects invalid runtime config before capabilities", () => {
    const invalid = config();
    invalid.evm.scanLimit = "0";
    const fixture = setup({}, invalid);
    expect(run(fixture)).toMatchObject({status: "config-error"});
    expect(fixture.writes).toHaveLength(0);
  });

  test("rejects report expiry overflow before signing", () => {
    const fixture = setup({
      blockTimestamp: (1n << 64n) - 1n,
      endTime: (1n << 64n) - 1n,
    });
    expect(run(fixture)).toMatchObject({status: "report-failed", reason: "report-expiry-overflow"});
    expect(fixture.writes).toHaveLength(0);
  });

  test("classifies report generation exceptions", () => {
    const fixture = setup({reportThrows: true});
    expect(run(fixture)).toMatchObject({status: "report-failed", reason: "report exploded"});
    expect(fixture.writes).toHaveLength(0);
  });

  for (const writeStatus of ["TX_STATUS_REVERTED", "TX_STATUS_FATAL"] as const) {
    test(`rejects ${writeStatus}`, () => {
      const fixture = setup({writeStatus});
      expect(run(fixture)).toMatchObject({status: "write-failed", nextCursor: "0"});
      expect(fixture.writes).toHaveLength(1);
    });
  }

  test("classifies write exceptions", () => {
    const fixture = setup({writeThrows: true});
    expect(run(fixture)).toMatchObject({status: "write-failed", reason: "write exploded"});
    expect(fixture.writes).toHaveLength(0);
  });

  test("logs exactly one structured terminal outcome", () => {
    const fixture = setup();
    const outcome = run(fixture);
    const logs = fixture.runtime.getLogs();
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0])).toEqual(outcome);
  });

  test("SDK reports contain the metadata header before the payload", () => {
    expect(REPORT_METADATA_HEADER_LENGTH).toBe(109);
  });
});
