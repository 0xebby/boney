import {describe, it, expect} from "vitest";
import {
  KNOWN_EVENTS,
  catalogSignature,
  describeSignature,
  resolveTrackedEvent,
  shortTopic,
  type TrackedEventInput,
} from "./eventNames";
import {AMOUNT_MODE, eventTopic, type EventSource} from "./kpiSource";

/**
 * Topics copied from `script/SeedRealKpi.s.sol`, where each is recorded as verified against the
 * chain rather than derived: Aave's against live Base Sepolia logs, Sygma's against a constant in
 * the deployed bytecode. Pinned here so a change to the catalog's signature strings fails against
 * the hash the chain actually emits, instead of quietly naming an event nothing fires.
 */
const AAVE_SUPPLY_TOPIC =
  "0x2b627736bca15cd5381dcf80b0bf11fd197d01a037c52b927a881a10fb73ba61" as const;
const SYGMA_DEPOSIT_TOPIC =
  "0x17bc3181e17a9620a479c24e6c606e474ba84fc036877b768926872e8cd0e11f" as const;
/** WETH9's, pinned the same way in `kpiSource.test.ts`. */
const WETH_DEPOSIT_TOPIC =
  "0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c" as const;

const AAVE_POOL = "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27" as const;
const BUSD = "0x2755a4A19B9B4d3B1e9Bd1cDe3B5DB2A0f9AdCc2" as const;
const BASE_SEPOLIA = 84532;

/** Aave's declaration as `SeedRealKpi` stores it on the verifier — names, `indexed`, and all. */
const AAVE_SUPPLY_DECLARATION =
  "Supply(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint16 indexed referralCode)";

function source(overrides: Partial<EventSource> = {}): EventSource {
  return {
    source: AAVE_POOL,
    topic0: AAVE_SUPPLY_TOPIC,
    actorTopic: 2,
    amountMode: AMOUNT_MODE.dataWord0,
    scale: BigInt(1e15),
    ...overrides,
  };
}

function input(overrides: Partial<TrackedEventInput> = {}): TrackedEventInput {
  return {
    source: source(overrides.source ? {...overrides.source} : undefined),
    kind: "Deposit",
    chainId: BASE_SEPOLIA,
    ...overrides,
  };
}

describe("describeSignature", () => {
  it("compacts a full declaration and reproduces the on-chain topic", () => {
    const described = describeSignature(AAVE_SUPPLY_DECLARATION);

    expect(described?.compact).toBe("Supply(address,address,address,uint256,uint16)");
    expect(described?.topic0).toBe(AAVE_SUPPLY_TOPIC);
  });

  it("accepts a signature that is already compact", () => {
    expect(describeSignature("Deposit(address,uint256)")).toEqual({
      compact: "Deposit(address,uint256)",
      topic0: WETH_DEPOSIT_TOPIC,
    });
  });

  /*
    The relayer's parser throws here on purpose — see `relayCore.parseEventSignature`. This module
    runs while a page renders, so it must degrade rather than take the panel down with it.
  */
  it("returns null rather than throwing on anything unparseable", () => {
    expect(describeSignature("not an event")).toBeNull();
    expect(describeSignature("Deposit(nosuchtype)")).toBeNull();
    expect(describeSignature("")).toBeNull();
    expect(describeSignature("   ")).toBeNull();
  });
});

describe("catalogSignature", () => {
  it("names the two protocol events this repo verified on chain", () => {
    expect(catalogSignature(AAVE_SUPPLY_TOPIC)).toBe(
      "Supply(address,address,address,uint256,uint16)",
    );
    expect(catalogSignature(SYGMA_DEPOSIT_TOPIC)).toBe(
      "Deposit(uint8,bytes32,uint64,address,bytes,bytes)",
    );
  });

  it("names the ERC-20 transfer every seeded demo campaign watches", () => {
    expect(catalogSignature(WETH_DEPOSIT_TOPIC)).toBe("Deposit(address,uint256)");
    expect(catalogSignature("0x" + "11".repeat(32) as `0x${string}`)).toBeUndefined();
  });

  /*
    Pinned rather than recomputed: this is the topic the live `Cpeg` campaign's mint KPI watches, so a
    change to the entry's types must fail here rather than send that KPI back to rendering as a hash.
  */
  it("names the ERC-1155 mint the live NFT campaign watches", () => {
    expect(
      catalogSignature("0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62"),
    ).toBe("TransferSingle(address,address,address,uint256,uint256)");
  });

  it("is case-insensitive on the topic, since sources disagree on hex casing", () => {
    expect(catalogSignature(AAVE_SUPPLY_TOPIC.toUpperCase().replace("0X", "0x") as `0x${string}`))
      .toBe("Supply(address,address,address,uint256,uint16)");
  });

  /*
    Two entries hashing to one topic would mean the later one is unreachable — and since both
    `Deposit` entries differ only in their param types, that collision is a plausible typo rather
    than a hypothetical.
  */
  it("holds no colliding entries", () => {
    const topics = KNOWN_EVENTS.map((signature) => eventTopic(signature));

    expect(new Set(topics).size).toBe(KNOWN_EVENTS.length);
    expect(new Set(KNOWN_EVENTS).size).toBe(KNOWN_EVENTS.length);
  });

  it("round-trips every entry through the lookup", () => {
    for (const signature of KNOWN_EVENTS) {
      expect(catalogSignature(eventTopic(signature))).toBe(signature);
    }
  });
});

describe("resolveTrackedEvent — event name", () => {
  it("prefers the verifier's own configured signature", () => {
    const resolved = resolveTrackedEvent(
      input({configSignature: AAVE_SUPPLY_DECLARATION}),
    );

    expect(resolved.event).toBe("Supply(address,address,address,uint256,uint16)");
    expect(resolved.eventFrom).toBe("config");
    expect(resolved.drift).toBeUndefined();
  });

  it("falls back to the catalog when no config is set", () => {
    const resolved = resolveTrackedEvent(input());

    expect(resolved.event).toBe("Supply(address,address,address,uint256,uint16)");
    expect(resolved.eventFrom).toBe("catalog");
  });

  it("falls back to the kind label for an unrecognised topic", () => {
    const resolved = resolveTrackedEvent(
      input({source: source({topic0: `0x${"ab".repeat(32)}`}), kind: "Bridge"}),
    );

    expect(resolved.event).toBe("Bridge txs");
    expect(resolved.eventFrom).toBe("kind");
    // The topic stays available whatever the name resolved from — it is what the indexer matches.
    expect(resolved.topic0).toBe(`0x${"ab".repeat(32)}`);
  });

  it("does not present `Custom` as an event name", () => {
    const resolved = resolveTrackedEvent(
      input({source: source({topic0: `0x${"ab".repeat(32)}`}), kind: "Custom"}),
    );

    expect(resolved.event).toBe("Unnamed event");
    expect(resolved.eventFrom).toBe("kind");
  });

  /*
    The load-bearing case. `EventMetricKpiVerifier` and `KpiSpec.params` hold separate copies of the
    watched event, so a reconfigure can leave them naming different things. The params topic is what
    credits progress, so the config's name must be dropped rather than shown.
  */
  it("drops a configured signature that disagrees with the credited topic", () => {
    const resolved = resolveTrackedEvent(
      input({
        source: source({topic0: WETH_DEPOSIT_TOPIC}),
        configSignature: AAVE_SUPPLY_DECLARATION,
      }),
    );

    expect(resolved.event).toBe("Deposit(address,uint256)");
    expect(resolved.eventFrom).toBe("catalog");
    expect(resolved.drift).toContain("Supply(address,address,address,uint256,uint16)");
    expect(resolved.drift).toContain(shortTopic(WETH_DEPOSIT_TOPIC));
  });

  it("ignores a configured signature that will not parse", () => {
    const resolved = resolveTrackedEvent(input({configSignature: "Supply(bogus"}));

    expect(resolved.eventFrom).toBe("catalog");
    expect(resolved.drift).toBeUndefined();
  });
});

describe("resolveTrackedEvent — protocol name", () => {
  it("names a known protocol contract that cannot name itself", () => {
    const resolved = resolveTrackedEvent(input({campaignName: "Aave Supplies"}));

    expect(resolved.protocol).toBe("Aave V3 Pool");
    expect(resolved.protocolFrom).toBe("catalog");
  });

  it("only applies the catalog on the chain the address was verified on", () => {
    const resolved = resolveTrackedEvent(input({chainId: 1, campaignName: "Aave Supplies"}));

    expect(resolved.protocol).toBe("Aave Supplies");
    expect(resolved.protocolFrom).toBe("campaign");
  });

  /*
    Contract identity beats the campaign's own name: a campaign called "Aerodrome" watching bUSD
    transfers is watching bUSD, and saying "Aerodrome" would assert something the chain does not.
  */
  it("prefers what the contract calls itself over the campaign name", () => {
    const resolved = resolveTrackedEvent(
      input({
        source: source({source: BUSD, topic0: WETH_DEPOSIT_TOPIC}),
        scanned: {name: "Boney USD", symbol: "bUSD"},
        campaignName: "Aerodrome",
      }),
    );

    expect(resolved.protocol).toBe("Boney USD (bUSD)");
    expect(resolved.protocolFrom).toBe("chain");
  });

  it("uses whichever of name and symbol resolved", () => {
    const named = resolveTrackedEvent(
      input({source: source({source: BUSD}), scanned: {name: "Boney USD"}}),
    );
    const symboled = resolveTrackedEvent(
      input({source: source({source: BUSD}), scanned: {symbol: "bUSD"}}),
    );
    const identical = resolveTrackedEvent(
      input({source: source({source: BUSD}), scanned: {name: "bUSD", symbol: "bUSD"}}),
    );

    expect(named.protocol).toBe("Boney USD");
    expect(symboled.protocol).toBe("bUSD");
    expect(identical.protocol).toBe("bUSD");
  });

  it("treats an empty name or symbol as absent", () => {
    const resolved = resolveTrackedEvent(
      input({
        source: source({source: BUSD}),
        scanned: {name: "   ", symbol: ""},
        campaignName: "Velodrome",
      }),
    );

    expect(resolved.protocol).toBe("Velodrome");
    expect(resolved.protocolFrom).toBe("campaign");
  });

  it("falls back to a short address when nothing names the contract", () => {
    const resolved = resolveTrackedEvent(input({source: source({source: BUSD})}));

    expect(resolved.protocol).toBe("0x2755…dCc2");
    expect(resolved.protocolFrom).toBe("address");
  });
});

describe("resolveTrackedEvent — scale", () => {
  it("carries the effective scale, reading 0 as unscaled", () => {
    expect(resolveTrackedEvent(input()).scale).toBe(BigInt(1e15));
    expect(resolveTrackedEvent(input({source: source({scale: BigInt(0)})})).scale).toBe(BigInt(1));
  });
});
