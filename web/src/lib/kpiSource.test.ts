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
  knownSignature,
  classifyEventSource,
  probeEventSource,
  actorTopicFindings,
  EVENT_PRESETS,
  WETH_BASE,
  type EventSource,
  type ProbeClient,
  type ProbeFinding,
} from "./kpiSource";

const WETH_DEPOSIT_TOPIC =
  "0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c";

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
  it("names a known event rather than showing its hash", () => {
    expect(knownSignature(WETH_DEPOSIT_TOPIC)).toBe("Deposit(address,uint256)");
    expect(knownSignature("0x" + "11".repeat(32))).toBeUndefined();
  });

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

  it("confirms a live event", async () => {
    const topic0 = eventTopic("Deposit(address,uint256)");
    const client = stubClient({
      getLogs: async () => [
        {
          topics: [topic0, "0x" + "11".repeat(32)],
          data: "0x" + "22".repeat(32),
          blockNumber: BigInt(9500),
          address: WETH_BASE,
        } as any,
      ],
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
});
