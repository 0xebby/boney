import {describe, expect, it} from "vitest";
import {checkReading, describeCapability, readEventShape, type Capability} from "./capability";

/**
 * Every declaration below is one this repo has already matched against a real log — the entries in
 * `eventNames.KNOWN_EVENTS` and the verified tables in `boneyMd/*-event-sources.md`.
 */
const DECLARATIONS = {
  /** Gyndore `GyndStaking`. The staker is topic 1, the staked token topic 2. */
  staked: "Staked(address indexed user, address indexed token, uint256 amount)",
  /** ERC-20. */
  erc20Transfer: "Transfer(address indexed from, address indexed to, uint256 value)",
  /** ERC-721 indexes the token id too, so the log carries four topics and no data. */
  erc721Transfer: "Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
  /** Uniswap V3 pool. Amounts are signed and negative on one side of every swap. */
  v3Swap:
    "Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
  /** Aave V3 Pool. Three parameters are indexed, so the first data word is `user`. */
  aaveSupply:
    "Supply(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint16 indexed referralCode)",
  /** ERC-1155. The first data word is an ABI offset into the `ids` array. */
  transferBatch:
    "TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)",
  /** Uniswap V3 position manager. The id is indexed and is not a wallet. */
  increaseLiquidity:
    "IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
  /** Boney's own. No indexed parameter at all. */
  poolExhausted: "PoolExhausted(uint256 shortfall)",
} as const;

function capabilityOf(declaration: string): Capability {
  const shape = readEventShape(declaration);
  if (!shape) throw new Error(`fixture did not parse: ${declaration}`);
  return describeCapability(shape);
}

describe("readEventShape", () => {
  it("assigns topic slots to indexed parameters in declaration order", () => {
    const shape = readEventShape(DECLARATIONS.staked)!;

    expect(shape.name).toBe("Staked");
    expect(shape.compact).toBe("Staked(address,address,uint256)");
    expect(shape.params.map((p) => [p.name, p.index, p.topic])).toEqual([
      ["user", 0, 1],
      ["token", 1, 2],
      ["amount", 2, undefined],
    ]);
  });

  it("keeps declaration index and topic index apart when they diverge", () => {
    const shape = readEventShape(DECLARATIONS.aaveSupply)!;

    // `user` is declared second but is not indexed; `onBehalfOf` is declared third and is topic 2.
    expect(shape.params.map((p) => [p.name, p.index, p.topic])).toEqual([
      ["reserve", 0, 1],
      ["user", 1, undefined],
      ["onBehalfOf", 2, 2],
      ["amount", 3, undefined],
      ["referralCode", 4, 3],
    ]);
  });

  it("hashes the compact form, so the two ERC transfers differ", () => {
    const erc20 = readEventShape(DECLARATIONS.erc20Transfer)!;
    const erc721 = readEventShape(DECLARATIONS.erc721Transfer)!;

    // Same topic0 — indexing does not change the hash — but a different topic count.
    expect(erc721.topic0).toBe(erc20.topic0);
    expect(erc20.params.filter((p) => p.indexed)).toHaveLength(2);
    expect(erc721.params.filter((p) => p.indexed)).toHaveLength(3);
  });

  it("returns null rather than throwing on input that is not an event", () => {
    expect(readEventShape("")).toBeNull();
    expect(readEventShape("not an event")).toBeNull();
    expect(readEventShape("Deposit(address")).toBeNull();
  });
});

describe("describeCapability — actor topics", () => {
  it("offers only topics that hold an address", () => {
    const staked = capabilityOf(DECLARATIONS.staked);

    expect(staked.actorSlots.map((s) => [s.topic, s.param.name])).toEqual([
      [1, "user"],
      [2, "token"],
    ]);
    expect(staked.attributable).toBe(true);
  });

  it("refuses an indexed token id, which a sampled log would have passed", () => {
    const capability = capabilityOf(DECLARATIONS.increaseLiquidity);

    expect(capability.actorSlots).toEqual([]);
    expect(capability.attributable).toBe(false);
    expect(capability.blockers.map((b) => b.code)).toEqual(["no-indexed-address"]);
  });

  it("refuses an event that indexes nothing", () => {
    const capability = capabilityOf(DECLARATIONS.poolExhausted);

    expect(capability.topicSlots).toEqual([]);
    expect(capability.attributable).toBe(false);
  });
});

describe("describeCapability — the amount word", () => {
  it("accepts an unsigned integer", () => {
    const capability = capabilityOf(DECLARATIONS.staked);

    expect(capability.dataWord0.sound).toBe(true);
    expect(capability.dataWord0.param?.name).toBe("amount");
    expect(capability.dataWord0.blocker).toBeUndefined();
  });

  it("refuses a signed amount", () => {
    const capability = capabilityOf(DECLARATIONS.v3Swap);

    expect(capability.dataWord0.sound).toBe(false);
    expect(capability.dataWord0.blocker?.code).toBe("amount-is-signed");
    // Still attributable — a count KPI on this event is sound.
    expect(capability.attributable).toBe(true);
  });

  it("refuses an address sitting in the amount slot", () => {
    const capability = capabilityOf(DECLARATIONS.aaveSupply);

    expect(capability.dataWord0.param?.name).toBe("user");
    expect(capability.dataWord0.blocker?.code).toBe("amount-is-address");
  });

  it("refuses a dynamic first parameter, whose word is an offset", () => {
    const capability = capabilityOf(DECLARATIONS.transferBatch);

    expect(capability.dataWord0.param?.type).toBe("uint256[]");
    expect(capability.dataWord0.blocker?.code).toBe("amount-is-dynamic");
  });

  it("refuses an event with every parameter indexed", () => {
    const capability = capabilityOf(DECLARATIONS.erc721Transfer);

    expect(capability.dataWord0.sound).toBe(false);
    expect(capability.dataWord0.blocker?.code).toBe("no-non-indexed-param");
    // The mints-only preset counts these, which needs no data word.
    expect(capability.actorSlots.map((s) => s.topic)).toEqual([1, 2]);
  });
});

describe("checkReading", () => {
  it("passes the configuration the Gyndore fixture actually uses", () => {
    const capability = capabilityOf(DECLARATIONS.staked);

    expect(
      checkReading(capability, {actorTopic: 1, amountMode: "count", filterTopic: 2}),
    ).toEqual([]);
  });

  it("rejects an actor topic that is not an address", () => {
    const capability = capabilityOf(DECLARATIONS.increaseLiquidity);

    const blockers = checkReading(capability, {actorTopic: 1, amountMode: "count"});
    expect(blockers.map((b) => b.code)).toEqual(["no-indexed-address"]);
    expect(blockers[0]!.message).toContain("tokenId");
  });

  it("rejects a topic the event does not have", () => {
    const capability = capabilityOf(DECLARATIONS.staked);

    expect(checkReading(capability, {actorTopic: 3, amountMode: "count"})).toHaveLength(1);
  });

  it("rejects summing a signed amount but allows counting it", () => {
    const capability = capabilityOf(DECLARATIONS.v3Swap);

    expect(
      checkReading(capability, {actorTopic: 2, amountMode: "dataWord0"}).map((b) => b.code),
    ).toEqual(["amount-is-signed"]);
    expect(checkReading(capability, {actorTopic: 2, amountMode: "count"})).toEqual([]);
  });

  it("rejects a filter on a topic the event does not have", () => {
    const capability = capabilityOf(DECLARATIONS.erc20Transfer);

    expect(
      checkReading(capability, {actorTopic: 2, amountMode: "dataWord0", filterTopic: 3}),
    ).toHaveLength(1);
  });
});
