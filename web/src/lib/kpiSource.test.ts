import {describe, it, expect} from "vitest";
import {encodeAbiParameters} from "viem";
import {
  AMOUNT_MODE,
  decodeEventSource,
  effectiveScale,
  encodeEventSource,
  eventSourceConflictsWithVerifier,
  eventSourceSummary,
  eventTopic,
  classifyEventSource,
  probeEventSource,
  actorTopicFindings,
  dataWordFindings,
  EVENT_PRESETS,
  WETH_BASE,
  type EventSource,
  type ProbeClient,
} from "./kpiSource";

const WETH_DEPOSIT_TOPIC =
  "0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c";

/**
 * A `getLogs` returning fixed logs.
 *
 * Cast, like `stubMetadata` below: viem types `getLogs`' return against the ABI event and block tags
 * it was called with, so no plain function satisfies that signature structurally. The probe reads
 * `topics` and `data` off the result, which is what these carry.
 */
function stubLogs(
  logs: readonly {
    topics: `0x${string}`[];
    data: `0x${string}`;
    blockNumber: bigint;
    address: `0x${string}`;
  }[],
): ProbeClient["getLogs"] {
  return (async () => logs) as unknown as ProbeClient["getLogs"];
}

const BASE_SEPOLIA = 84532;
/**
 * An address the catalog does not know, so the probe has to ask the contract itself.
 *
 * Correctly checksummed on purpose: `dataWordFindings`' tests encode it with
 * `encodeAbiParameters`, and viem rejects a mixed-case address that fails EIP-55.
 */
const SOME_TOKEN = "0x2755A4A19B9B4D3b1e9Bd1cDe3b5DB2a0f9adcc2" as const;

/**
 * A `readContract` that answers `name()`/`symbol()` and nothing else.
 *
 * Cast because viem's `readContract` is overloaded against the ABI it is handed; a stub cannot
 * satisfy that signature structurally, and the probe only ever calls it two ways.
 */
function stubMetadata(values: {name?: string; symbol?: string}): ProbeClient["readContract"] {
  return (async ({functionName}: {functionName: string}) => {
    const value = functionName === "name" ? values.name : values.symbol;
    if (value === undefined) throw new Error("execution reverted");
    return value;
  }) as unknown as ProbeClient["readContract"];
}

function src(overrides: Partial<EventSource> = {}): EventSource {
  return {
    source: WETH_BASE,
    topic0: WETH_DEPOSIT_TOPIC,
    actorTopic: 1,
    amountMode: AMOUNT_MODE.dataWord0,
    scale: BigInt(1e15),
    ...overrides,
  };
}

describe("eventTopic", () => {
  /**
   * Pinned to the value read off a real Base Sepolia log rather than recomputed, so a change to
   * the hashing (encoding the signature as bytes vs utf8, say) fails here instead of silently
   * indexing an event that never fires.
   */
  it("matches the WETH Deposit topic observed on chain", () => {
    expect(eventTopic("Deposit(address,uint256)")).toBe(WETH_DEPOSIT_TOPIC);
  });

  it("distinguishes signatures that differ only in argument types", () => {
    expect(eventTopic("Deposit(address,uint256)")).not.toBe(eventTopic("Deposit(address,uint128)"));
  });
});

describe("encode/decode round trip", () => {
  it("survives a round trip unchanged", () => {
    const decoded = decodeEventSource(encodeEventSource(src()));
    expect(decoded).toEqual(src({source: WETH_BASE}));
  });

  it("round trips every preset", () => {
    for (const preset of EVENT_PRESETS) {
      expect(decodeEventSource(encodeEventSource(preset.source))).toEqual(preset.source);
    }
  });

  it("accepts a non-checksummed source address", () => {
    // viem rejects a mixed-case address whose EIP-55 checksum does not validate, so an address
    // pasted in lowercase must not throw — it means the same 20 bytes.
    const decoded = decodeEventSource(
      encodeEventSource(src({source: WETH_BASE.toLowerCase() as `0x${string}`})),
    );
    expect(decoded?.source).toBe(WETH_BASE);
  });

  it("returns a checksummed address regardless of how it went in", () => {
    expect(decodeEventSource(encodeEventSource(src()))?.source).toBe(WETH_BASE);
  });
});

describe("decodeEventSource", () => {
  /**
   * The five campaigns already live on Base Sepolia carry `params: "0x"`. The detail page decodes
   * every KPI it renders, so "not event-sourced" has to be an ordinary value, not an exception.
   */
  it("returns null for an unset params blob", () => {
    expect(decodeEventSource("0x")).toBeNull();
    expect(decodeEventSource(undefined)).toBeNull();
    expect(decodeEventSource(null)).toBeNull();
  });

  it("returns null for a blob of the wrong width", () => {
    // A bare uint64 — what TouchWindowVerifier puts in params.
    expect(decodeEventSource(encodeAbiParameters([{type: "uint64"}], [BigInt(3600)]))).toBeNull();
  });

  it("returns null rather than throwing on malformed hex", () => {
    expect(decodeEventSource("0xdeadbeef")).toBeNull();
  });

  it("rejects an actorTopic outside 1..3", () => {
    // topics[0] is always the event signature, so an actor can never live there.
    const bad = encodeAbiParameters(
      [{type: "address"}, {type: "bytes32"}, {type: "uint8"}, {type: "uint8"}, {type: "uint256"}],
      [WETH_BASE, WETH_DEPOSIT_TOPIC, 0, 1, BigInt(1)],
    );
    expect(decodeEventSource(bad)).toBeNull();

    const tooHigh = encodeAbiParameters(
      [{type: "address"}, {type: "bytes32"}, {type: "uint8"}, {type: "uint8"}, {type: "uint256"}],
      [WETH_BASE, WETH_DEPOSIT_TOPIC, 4, 1, BigInt(1)],
    );
    expect(decodeEventSource(tooHigh)).toBeNull();
  });

  it("rejects an unknown amount mode", () => {
    const bad = encodeAbiParameters(
      [{type: "address"}, {type: "bytes32"}, {type: "uint8"}, {type: "uint8"}, {type: "uint256"}],
      [WETH_BASE, WETH_DEPOSIT_TOPIC, 1, 7, BigInt(1)],
    );
    expect(decodeEventSource(bad)).toBeNull();
  });
});

describe("encodeEventSource", () => {
  it("rejects an out-of-range actorTopic at encode time", () => {
    expect(() => encodeEventSource(src({actorTopic: 0 as 1}))).toThrow(/actorTopic/);
    expect(() => encodeEventSource(src({actorTopic: 4 as 1}))).toThrow(/actorTopic/);
  });

  it("produces a 160-byte blob — five abi words", () => {
    const encoded = encodeEventSource(src());
    expect((encoded.length - 2) / 2).toBe(160);
  });
});

describe("effectiveScale", () => {
  /** An unset field decodes to 0; reading that as "no scaling" beats dividing by zero. */
  it("treats 0 as 1", () => {
    expect(effectiveScale(src({scale: BigInt(0)}))).toBe(BigInt(1));
  });

  it("passes a real scale through", () => {
    expect(effectiveScale(src({scale: BigInt(1e15)}))).toBe(BigInt(1e15));
  });
});

describe("eventSourceConflictsWithVerifier", () => {
  /**
   * TouchWindowVerifier reads params as a bare uint64 and returns lookback 0 unless the blob is
   * exactly 32 bytes (TouchWindowVerifier.sol:113). Pairing it with a 160-byte event blob is
   * fail-safe — strict crediting, never over-crediting — but silently not what was configured.
   */
  it("flags an event blob paired with a verifier", () => {
    expect(
      eventSourceConflictsWithVerifier(
        encodeEventSource(src()),
        "0x1111111111111111111111111111111111111111",
      ),
    ).toBe(true);
  });

  it("does not flag an event blob with no verifier", () => {
    expect(
      eventSourceConflictsWithVerifier(
        encodeEventSource(src()),
        "0x0000000000000000000000000000000000000000",
      ),
    ).toBe(false);
    expect(eventSourceConflictsWithVerifier(encodeEventSource(src()), undefined)).toBe(false);
  });

  it("does not flag a 32-byte lookback blob, which is what the verifier expects", () => {
    expect(
      eventSourceConflictsWithVerifier(
        encodeAbiParameters([{type: "uint64"}], [BigInt(3600)]),
        "0x1111111111111111111111111111111111111111",
      ),
    ).toBe(false);
  });

  it("does not flag empty params", () => {
    expect(
      eventSourceConflictsWithVerifier("0x", "0x1111111111111111111111111111111111111111"),
    ).toBe(false);
  });
});

describe("display helpers", () => {
  /*
    Naming a topic moved to `eventNames.catalogSignature`, which knows a wider set than the two
    presets this module offers — see `eventNames.test.ts`. What stays here is the formatting.
  */
  it("summarizes a source with its signature when known", () => {
    expect(eventSourceSummary(src(), "Deposit(address,uint256)")).toBe(
      "Deposit(address,uint256) on 0x4200…0006",
    );
  });

  it("falls back to the topic hash when the signature is unknown", () => {
    expect(eventSourceSummary(src())).toBe("0xe1ff…109c on 0x4200…0006");
  });
});

describe("classifyEventSource", () => {
  it("accepts a valid non-zero address", () => {
    const findings = classifyEventSource({source: WETH_BASE, signature: "Deposit(address,uint256)"});
    expect(findings).toEqual([]);
  });

  it("flags the zero address", () => {
    const findings = classifyEventSource({
      source: "0x0000000000000000000000000000000000000000",
      signature: "Deposit(address,uint256)",
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("error");
    expect(findings[0].message).toMatch(/zero address/i);
  });

  it("flags an invalid address", () => {
    const findings = classifyEventSource({source: "not-an-address", signature: ""});
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("error");
    expect(findings[0].message).toMatch(/not a valid address/i);
  });

  it("flags a malformed signature", () => {
    const findings = classifyEventSource({source: WETH_BASE, signature: "Deposit (address, uint256)"});
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("error");
    expect(findings[0].message).toMatch(/types only/i);
  });

  it("accepts an empty source as a no-op", () => {
    expect(classifyEventSource({source: "", signature: ""})).toEqual([]);
  });

  /*
    The lynx campaign's configuration: `count` mode at `scale: 10`, which encodes cleanly, deploys
    cleanly, credits progress, and still divided 51 WETH deposits down to 5 units.
  */
  it("warns that a scale cannot act in count mode", () => {
    const findings = classifyEventSource({
      amountMode: AMOUNT_MODE.count,
      scale: "10",
      signature: "Deposit(address,uint256)",
      source: WETH_BASE,
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("warn");
    expect(findings[0].message).toMatch(/cannot measure size/i);
    expect(findings[0].message).toMatch(/10 events per unit/i);
  });

  /*
    Reaches the half-filled form too. Someone picks a mode and types a scale before pasting a
    contract, and that is the reader with the most to gain from being told now.
  */
  it("warns before an address has been entered at all", () => {
    const findings = classifyEventSource({
      amountMode: AMOUNT_MODE.count,
      scale: "10",
      signature: "",
      source: "",
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("warn");
  });

  it("keeps errors ahead of the scale warning", () => {
    const findings = classifyEventSource({
      amountMode: AMOUNT_MODE.count,
      scale: "10",
      signature: "",
      source: "not-an-address",
    });

    // Documented as worst-first, and the form renders the list in order.
    expect(findings.map((f) => f.severity)).toEqual(["error", "warn"]);
  });

  it("says nothing about a scale that does something", () => {
    // `dataWord0` is the mode scale exists for.
    expect(
      classifyEventSource({
        amountMode: AMOUNT_MODE.dataWord0,
        scale: "1000000000000000",
        signature: "Deposit(address,uint256)",
        source: WETH_BASE,
      }),
    ).toEqual([]);
  });

  it("says nothing about a scale that is already correct", () => {
    // 0 and a blank both mean 1 to `effectiveScale`, so none of the three is worth a warning.
    for (const scale of ["1", "0", "", "   "]) {
      expect(
        classifyEventSource({
          amountMode: AMOUNT_MODE.count,
          scale,
          signature: "Deposit(address,uint256)",
          source: WETH_BASE,
        }),
        scale,
      ).toEqual([]);
    }
  });

  it("leaves an unparseable scale to the form's own validation", () => {
    expect(
      classifyEventSource({
        amountMode: AMOUNT_MODE.count,
        scale: "1e15",
        signature: "Deposit(address,uint256)",
        source: WETH_BASE,
      }),
    ).toEqual([]);
  });
});

describe("actorTopicFindings", () => {
  it("flags an event with no indexed arguments", () => {
    const findings = actorTopicFindings(1); // signature only, zero indexed
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("error");
    expect(findings[0].message).toMatch(/indexes no arguments/i);
  });

  it("flags an actorTopic beyond what the event carries", () => {
    const findings = actorTopicFindings(2, 3); // one indexed, actorTopic 3
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("error");
    expect(findings[0].message).toMatch(/actor topic 3 is empty/i);
  });

  it("accepts an actorTopic within range", () => {
    expect(actorTopicFindings(3, 1)).toEqual([]); // two indexed, actorTopic 1 is fine
    expect(actorTopicFindings(3, 2)).toEqual([]); // two indexed, actorTopic 2 is fine
  });

  it("does not flag when actorTopic is not provided", () => {
    expect(actorTopicFindings(2)).toEqual([]); // one indexed, no actorTopic check
  });
});

describe("dataWordFindings", () => {
  const word = (type: "uint256" | "address", value: bigint | `0x${string}`) =>
    encodeAbiParameters([{type}], [value]);

  const ONE_FINNEY = BigInt(10) ** BigInt(15);

  it("says nothing in count mode — there is no word to read", () => {
    expect(
      dataWordFindings({data: word("uint256", ONE_FINNEY), amountMode: AMOUNT_MODE.count}),
    ).toEqual([]);
  });

  it("says nothing when the mode is unknown", () => {
    // Every caller that predates the field omits it, and a probe cannot guess which mode is meant.
    expect(dataWordFindings({data: word("uint256", ONE_FINNEY), amountMode: undefined})).toEqual([]);
  });

  it("names the number the indexer would read, and what it credits", () => {
    const findings = dataWordFindings({
      data: word("uint256", ONE_FINNEY),
      amountMode: AMOUNT_MODE.dataWord0,
      scale: ONE_FINNEY,
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("ok");
    expect(findings[0].message).toMatch(/1,000,000,000,000,000/);
    expect(findings[0].message).toMatch(/0\.001 if it is an 18-decimal token amount/);
    expect(findings[0].message).toMatch(/1 unit of progress/);
  });

  it("reads a missing scale as 1, like effectiveScale", () => {
    for (const scale of [undefined, BigInt(0)]) {
      const findings = dataWordFindings({
        data: word("uint256", BigInt(7)),
        amountMode: AMOUNT_MODE.dataWord0,
        scale,
      });
      expect(findings[0].message, String(scale)).toMatch(/7 units of progress/);
    }
  });

  /*
    The failure the old "First data word" label hid. `log.data` holds the *unindexed* params in
    declaration order, so `Trade(address indexed user, address token, uint256 amount)` puts `token`
    at word 0 — an address read as ~1e48. The form cannot catch it from the signature, which is
    types-only and carries no `indexed` keywords, so the sampled log is the only witness.
  */
  it("flags a word shaped like an address", () => {
    const findings = dataWordFindings({
      data: word("address", SOME_TOKEN),
      amountMode: AMOUNT_MODE.dataWord0,
      scale: BigInt(1),
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("warn");
    expect(findings[0].message).toMatch(/an address, not an amount/i);
    expect(findings[0].message).toContain(SOME_TOKEN.toLowerCase());
  });

  /*
    A heuristic, so the boundary is worth pinning: an ordinary amount leaves far more than 12 leading
    bytes clear, and must not be called an address.
  */
  it("leaves ordinary amounts alone", () => {
    for (const value of [BigInt(1), ONE_FINNEY, BigInt(10) ** BigInt(27)]) {
      const findings = dataWordFindings({
        data: word("uint256", value),
        amountMode: AMOUNT_MODE.dataWord0,
      });
      expect(findings[0].severity, value.toString()).toBe("ok");
    }
  });

  it("flags an event whose data is empty", () => {
    const findings = dataWordFindings({data: "0x", amountMode: AMOUNT_MODE.dataWord0});

    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("error");
    expect(findings[0].message).toMatch(/nothing to read/i);
    expect(findings[0].message).toMatch(/Switch Amount to Count/);
  });
});

describe("probeEventSource", () => {
  function stubClient(overrides?: Partial<ProbeClient>): ProbeClient {
    return {
      getCode: async () => "0x60806040" as `0x${string}`,
      getBlockNumber: async () => BigInt(10000),
      getLogs: async () => [],
      ...overrides,
    };
  }

  it("returns structural errors without touching the chain", async () => {
    const client = stubClient();
    const findings = await probeEventSource(client, {
      source: "0x0000000000000000000000000000000000000000",
      signature: "Deposit(address,uint256)",
    });
    expect(findings.some((f) => f.severity === "error")).toBe(true);
    expect(findings[0].message).toMatch(/zero address/i);
  });

  it("flags an address with no code", async () => {
    const client = stubClient({getCode: async () => "0x"});
    const findings = await probeEventSource(client, {source: WETH_BASE, signature: ""});
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("error");
    expect(findings[0].message).toMatch(/no contract deployed/i);
  });

  it("warns when the event has not fired recently", async () => {
    const client = stubClient({getLogs: async () => []});
    const findings = await probeEventSource(client, {
      source: WETH_BASE,
      signature: "Deposit(address,uint256)",
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("warn");
    expect(findings[0].message).toMatch(/idle/i);
  });

  /*
    The scale warning describes the KPI's configuration, so nothing the chain says about the contract
    can resolve it. Every chain-probe path builds a fresh list, which is why it is appended once at
    the boundary rather than threaded through seven returns — this is the test that pins that.
  */
  it("keeps the scale warning after a successful chain probe", async () => {
    const topic0 = eventTopic("Deposit(address,uint256)");
    const client = stubClient({
      getLogs: stubLogs([
        {
          address: WETH_BASE,
          blockNumber: BigInt(9500),
          data: `0x${"22".repeat(32)}`,
          topics: [topic0, `0x${"11".repeat(32)}`],
        },
      ]),
    });

    const findings = await probeEventSource(client, {
      amountMode: AMOUNT_MODE.count,
      scale: "10",
      signature: "Deposit(address,uint256)",
      source: WETH_BASE,
    });

    expect(findings.some((f) => f.severity === "ok")).toBe(true);
    const warn = findings.find((f) => f.severity === "warn");
    expect(warn?.message).toMatch(/cannot measure size/i);
  });

  it("drops the scale warning when a structural error stops the probe", async () => {
    const client = stubClient();
    const findings = await probeEventSource(client, {
      amountMode: AMOUNT_MODE.count,
      scale: "10",
      signature: "Deposit(address,uint256)",
      source: "0x0000000000000000000000000000000000000000",
    });

    // The error short-circuits before the chain is touched, and it carries the warning with it —
    // there is no address to probe, so nothing later can re-add it.
    expect(findings.map((f) => f.severity)).toEqual(["error", "warn"]);
  });

  it("confirms a live event", async () => {
    const topic0 = eventTopic("Deposit(address,uint256)");
    const client = stubClient({
      getLogs: stubLogs([
        {
          topics: [topic0, `0x${"11".repeat(32)}`],
          data: `0x${"22".repeat(32)}`,
          blockNumber: BigInt(9500),
          address: WETH_BASE,
        },
      ]),
    });
    const findings = await probeEventSource(client, {
      source: WETH_BASE,
      signature: "Deposit(address,uint256)",
    });
    expect(findings.some((f) => f.severity === "ok")).toBe(true);
    expect(findings[0].message).toMatch(/emitting Deposit/i);
  });

  it("tolerates a getCode failure", async () => {
    const client = stubClient({
      getCode: async () => {
        throw new Error("RPC down");
      },
    });
    const findings = await probeEventSource(client, {source: WETH_BASE, signature: ""});
    expect(findings[0].severity).toBe("warn");
    expect(findings[0].message).toMatch(/could not reach/i);
  });

  /*
    Naming the contract back is the only feedback a pasted address gets: nothing about the hex tells a
    project it typed the wrong pool, and the campaign is immutable once deployed.
  */
  it("names a known contract without reading it", async () => {
    const client = stubClient();
    const findings = await probeEventSource(
      client,
      {source: WETH_BASE, signature: ""},
      {chainId: BASE_SEPOLIA},
    );

    expect(findings).toEqual([{severity: "ok", message: "Known contract: WETH."}]);
  });

  it("asks an unknown contract what it calls itself", async () => {
    const client = stubClient({readContract: stubMetadata({name: "Boney USD", symbol: "bUSD"})});
    const findings = await probeEventSource(
      client,
      {source: SOME_TOKEN, signature: ""},
      {chainId: BASE_SEPOLIA},
    );

    expect(findings).toEqual([
      {severity: "ok", message: "This contract calls itself Boney USD (bUSD)."},
    ]);
  });

  it("says nothing when the contract publishes no name", async () => {
    const client = stubClient({
      readContract: (async () => {
        throw new Error("execution reverted");
      }) as unknown as ProbeClient["readContract"],
    });

    const findings = await probeEventSource(
      client,
      {source: SOME_TOKEN, signature: ""},
      {chainId: BASE_SEPOLIA},
    );

    expect(findings).toEqual([]);
  });

  /*
    The sampled log is the only place the create form can learn its event's data layout, so the
    value-mode readout has to survive the trip out of `probeChain` — including the scale, which
    arrives as a form string rather than a bigint.
  */
  it("reports what value mode would read from the sampled log", async () => {
    const topic0 = eventTopic("Deposit(address,uint256)");
    const client = stubClient({
      getLogs: stubLogs([
        {
          topics: [topic0, `0x${"11".repeat(32)}`],
          data: encodeAbiParameters([{type: "uint256"}], [BigInt(10) ** BigInt(15)]),
          blockNumber: BigInt(9500),
          address: WETH_BASE,
        },
      ]),
    });

    const findings = await probeEventSource(client, {
      amountMode: AMOUNT_MODE.dataWord0,
      scale: "1000000000000000",
      signature: "Deposit(address,uint256)",
      source: WETH_BASE,
    });

    const value = findings.find((f) => f.message.startsWith("Value mode reads"));
    expect(value?.severity).toBe("ok");
    expect(value?.message).toMatch(/1 unit of progress/);
  });

  it("keeps the identity line below anything more important", async () => {
    const client = stubClient({
      getLogs: async () => [],
      readContract: stubMetadata({name: "Boney USD", symbol: "bUSD"}),
    });

    const findings = await probeEventSource(
      client,
      {source: SOME_TOKEN, signature: "Deposit(address,uint256)"},
      {chainId: BASE_SEPOLIA},
    );

    expect(findings.map((f) => f.severity)).toEqual(["warn", "ok"]);
    expect(findings[1].message).toMatch(/calls itself/i);
  });
});
